"""Сессии студий, которые идут по сценам: проект длинного
    ролика, сохранённые точки продолжения, референсы проекта, ровный фон и живой предпросмотр.
    Методы перенесены из app/server.py без правок."""

from aiohttp import web
from applog import applog
from ffrun import loudnorm_bed
from formutil import bed_level, lora_strength
from netutil import comfy_error_text
from pathlib import Path
from paths import CLIENT_ID, LONG_DIR
import aiohttp
import asyncio
import catalog
import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
import workflows as wf


class StudioMixin:
    """Методы области «studio»."""

    async def upload_state(self, path, name):
        """Put a saved scene state (.latent) into ComfyUI's input folder, where its LoadLatent node looks for it."""
        data = aiohttp.FormData()
        data.add_field("image", path.read_bytes(), filename=name, content_type="application/octet-stream")
        data.add_field("type", "input")
        data.add_field("overwrite", "true")
        status, res = await self.comfy_json("POST", "/upload/image", data=data)
        if status != 200:
            raise web.HTTPBadGateway(text="Не удалось передать состояние сцены в ComfyUI")
        return res["name"]

    # NOTE: the exact action scheme (SelfLift) cannot take the mask of a continued scene: from the
    # second scene on the latent arrives as ComfyUI's NestedTensor, and SelfLiftH3Sampler answers
    # "isfinite(): argument 'input' must be Tensor, not NestedTensor" - a limitation of that node pack
    # (comfyui-SelfLift reads mask.shape straight away). Continuation scenes therefore run on the plain
    # sampler, which the core does support with nested masks; the first scene keeps the exact scheme.

    # the number of steps of the FLUX modes is decided in workflows.flux_steps: it follows the weights
    # chosen in Settings, so the server does not carry a second copy of that rule

    async def has_node(self, cls):
        """Does this ComfyUI know the node class? Used to keep the exact action scheme working on a core
           without the LTXVideo pack: without that node the scene is still made, just with one mask for
           the whole clip instead of one per frame."""
        try:
            status, _ = await self.comfy_json("GET", f"/object_info/{cls}", timeout=aiohttp.ClientTimeout(total=10))
            return status == 200
        except Exception:
            return False

    async def long_source(self, item_id, uploaded, first_sec):
        """A video the user already has (from the library, or a file from the computer) to continue from: put it into ComfyUI and
        find out how many frames it has. Returns (file name in ComfyUI input, frames)."""
        if uploaded:
            name = uploaded   # read_form already uploaded it to ComfyUI
        else:
            it = self.library.get(item_id)
            if not it or it.get("kind") == "image":
                raise web.HTTPBadRequest(text="Видео для продолжения не найдено в Библиотеке")
            data = await self.item_bytes(it)
            fd = aiohttp.FormData()
            nm = f"h3s_c_{uuid.uuid4().hex[:10]}.{it.get('ext') or 'mp4'}"
            fd.add_field("image", data, filename=nm, content_type="video/mp4")
            fd.add_field("type", "input")
            status, res = await self.comfy_json("POST", "/upload/image", data=fd)
            if status != 200:
                raise web.HTTPBadGateway(text="Не удалось передать видео в ComfyUI")
            name = res["name"]
        # how long is it: a tiny job that only opens the video and reports its number of frames
        probe = {"L": {"class_type": "LoadVideo", "inputs": {"file": name}},
                 "G": {"class_type": "GetVideoComponents", "inputs": {"video": ["L", 0]}},
                 "Z": {"class_type": "GetImageSize", "inputs": {"image": ["G", 0]}},
                 "N": {"class_type": "PreviewAny", "inputs": {"source": ["Z", 2]}},
                 "F": {"class_type": "PreviewAny", "inputs": {"source": ["G", 2]}}}
        status, res = await self.comfy_json("POST", "/prompt", json={"prompt": probe, "client_id": CLIENT_ID})
        if status != 200:
            raise web.HTTPBadRequest(text="ComfyUI не смог открыть это видео: " + comfy_error_text(res))
        pid = res["prompt_id"]
        loop = asyncio.get_running_loop()
        end = loop.time() + 180
        meta = None
        while loop.time() < end and not meta:
            await asyncio.sleep(0.7)
            _, hist = await self.comfy_json("GET", f"/history/{pid}")
            e = (hist or {}).get(pid)
            if e:
                if e.get("status", {}).get("status_str") == "error":
                    break
                try:
                    meta = {"frame_count": int(float(e["outputs"]["N"]["text"][0])), "fps": float(e["outputs"]["F"]["text"][0])}
                except (KeyError, IndexError, ValueError):
                    break
        if not meta:
            raise web.HTTPBadRequest(text="Не удалось прочитать это видео. Подойдёт обычный mp4.")
        frames = int(meta["frame_count"])
        need = wf.long_plan([first_sec], cont_first=True)[0]["ov"]
        if frames < need:
            raise web.HTTPBadRequest(text=f"Видео слишком короткое для продолжения: в нём {frames} кадров, нужно не меньше {need} (около 2,5 секунд).")
        return (name, frames)

    async def preview_opts(self):
        """Settings for the animated live preview, or None when ComfyUI has no KJNodes' Model Preview Override."""
        return None   # switched off: the animated preview made generation noticeably slower; the usual single-frame preview is used
        try:
            status, oi = await self.comfy_json("GET", "/object_info/ModelPreviewOverrideKJ")
        except Exception:
            return None
        node = (oi or {}).get("ModelPreviewOverrideKJ") if status == 200 else None
        if not node:
            return None
        tiny = "none"
        try:
            spec = node["input"].get("optional", {}).get("tiny_vae") or []
            options = (spec[1] or {}).get("options") if len(spec) > 1 and isinstance(spec[1], dict) else spec[0]
            tiny = next((o for o in options or [] if o.replace("\\", "/").split("/")[-1].startswith("taeh3")), "none")
        except Exception:
            pass
        return {"tiny_vae": tiny}

    def keep_long_refs(self, run, captured):
        """The reference pictures (and the sound) of a long video project, next to its saved scene states."""
        if not run:
            return
        d = LONG_DIR / run / "refs"
        d.mkdir(parents=True, exist_ok=True)
        for key, (ext, raw) in captured.items():
            if key.startswith(("img", "aud", "simg", "saudio")) and len(raw) < 80_000_000:
                for old in d.glob(key + ".*"):
                    old.unlink(missing_ok=True)
                (d / (key + ext)).write_bytes(raw)

    async def bed_norm(self, run, raw, suffix, rh=None):
        """Ровная по громкости копия общего аудио фильма: её слышит ролик, а модель - подлинный файл.
        Делается из тех же байтов, что пришли в форме, кладётся в папку refs проекта под именем
        aud0n.wav и отдаёт имя, которым её видит ядро (именно его несут графы). Не вышло - вместо
        имени короткий текст по-русски: фон тогда берётся из подлинного файла, задание не падает."""
        ff = self._ffmpeg()
        if not ff:
            return None, "декодера нет - громкость не выровнена"

        def once():   # ffmpeg вне цикла событий; временное живёт в tempfile и после не остаётся
            root = Path(os.environ.get("TEMP") or ".")
            tmp = Path(tempfile.mkdtemp(prefix="h3bed-", dir=str(root)))
            try:
                src = tmp / ("in" + (suffix or ".mp3"))
                src.write_bytes(raw)
                dst = tmp / "aud0n.wav"
                ok, _lufs, why = loudnorm_bed(ff, src, dst)
                return (dst.read_bytes() if ok and dst.is_file() else None), why
            finally:
                shutil.rmtree(tmp, ignore_errors=True)

        try:
            wav, why = await asyncio.to_thread(once)
        except Exception as e:   # выравнивание дороже пары децибел разницы: считаем, как считали
            return None, "выравнивание не вышло (%s) - музыка играет как есть" % type(e).__name__
        if not wav:
            return None, why or "выравнивание не вышло - музыка играет как есть"
        if run:
            try:
                d = LONG_DIR / run / "refs"
                d.mkdir(parents=True, exist_ok=True)
                (d / "aud0n.wav").write_bytes(wav)   # копия живёт вместе с проектом
            except OSError as e:
                applog(f"ровная копия музыки не сохранена в проект: {e}")
        try:   # ядро читает файл по своему имени, поэтому копия лежит в его папке input
            return await self.put_input(f"h3s_{uuid.uuid4().hex[:8]}_aud0n.wav", wav, "audio/wav", rh), ""
        except web.HTTPBadGateway:
            return None, "ровную копию не принял ComfyUI - музыка играет как есть"

    async def h_long_project(self, req):
        """The project of a long video (scenes, settings) is kept on disk too, so it survives anything that happens to the browser storage."""
        if req.method == "POST":
            body = await req.json()
            run = re.sub(r"[^A-Za-z0-9]", "", str(body.get("run", "")))[:32]
            if not run or not isinstance(body.get("project"), dict):
                raise web.HTTPBadRequest(text="bad project")
            d = LONG_DIR / run
            d.mkdir(parents=True, exist_ok=True)
            (d / "project.json").write_text(json.dumps(body["project"], ensure_ascii=False), encoding="utf-8")
            return web.json_response({"ok": True})
        run = re.sub(r"[^A-Za-z0-9]", "", req.query.get("run", ""))[:32]
        if not run and req.query.get("last"):   # the most recently saved project OF THIS SECTION
            want = re.sub(r"[^a-z]", "", str(req.query.get("sec") or "long")) or "long"
            files = sorted(LONG_DIR.glob("*/project.json"), key=lambda f: f.stat().st_mtime, reverse=True) if LONG_DIR.is_dir() else []
            for f in files:
                try:
                    # projects saved before sections existed belong to the video studio
                    got = re.sub(r"[^a-z]", "", str(json.loads(f.read_text(encoding="utf-8")).get("sec") or "long")) or "long"
                except (OSError, ValueError):
                    got = "long"
                if got == want:
                    run = f.parent.name
                    break
        f = LONG_DIR / run / "project.json" if run else None
        if not f or not f.exists():
            return web.json_response({})
        refs = sorted(p.name for p in (LONG_DIR / run / "refs").glob("*")) if (LONG_DIR / run / "refs").is_dir() else []
        return web.json_response({"run": run, "project": json.loads(f.read_text(encoding="utf-8")), "refs": refs})

    async def h_long_stage(self, req):
        """A saved stage of a long video: the scene continuation points and the reference pictures are copied aside, so redoing a
        scene later does not spoil the stage. action: save | restore | delete."""
        body = await req.json()
        run = re.sub(r"[^A-Za-z0-9]", "", str(body.get("run", "")))[:32]
        sid = re.sub(r"[^A-Za-z0-9]", "", str(body.get("id", "")))[:32]
        act = body.get("action")
        if not run or not sid or act not in ("save", "restore", "delete"):
            raise web.HTTPBadRequest(text="bad stage")
        base = LONG_DIR / run
        st = base / "stages" / sid
        names = ("state_*.latent", "state_*.json")

        def work():
            if act == "save":
                if st.exists():
                    shutil.rmtree(st)
                st.mkdir(parents=True, exist_ok=True)
                n = 0
                for pat in names:
                    for f in base.glob(pat):
                        shutil.copy2(f, st / f.name)
                        n += 1
                if (base / "refs").is_dir():
                    shutil.copytree(base / "refs", st / "refs")
                return {"ok": True, "states": n, "refs": (st / "refs").is_dir()}
            if act == "delete":
                if st.exists() and st.parent.name == "stages":
                    shutil.rmtree(st)
                return {"ok": True}
            if not st.is_dir():   # a stage saved by an older version: only the texts and settings come back
                return {"ok": False}
            for pat in names:
                for f in base.glob(pat):
                    f.unlink(missing_ok=True)
            for f in st.glob("state_*"):
                shutil.copy2(f, base / f.name)
            if (st / "refs").is_dir():
                if (base / "refs").is_dir():
                    shutil.rmtree(base / "refs")
                shutil.copytree(st / "refs", base / "refs")
            return {"ok": True, "refs": (st / "refs").is_dir()}
        return web.json_response(await asyncio.to_thread(work))

    async def h_long_ref(self, req):
        run = re.sub(r"[^A-Za-z0-9]", "", req.match_info["run"])[:32]
        name = Path(req.match_info["name"]).name
        f = LONG_DIR / run / "refs" / name
        if not f.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(f)

    async def h_generate_actionsc(self, req):
        """The action studio: the same scene-by-scene road, the action model underneath."""
        self._studio_mode = "actionsc"
        return await self.h_generate_long(req)

    async def h_generate_long(self, req):
        # one door for both studios; the address says which one, the form is only a fallback
        if getattr(self, "_studio_mode", None) != "actionsc":
            self._studio_mode = "long"
        await self.need_models(self._studio_mode)
        self._capture = {}
        try:
            return await self.generate_long(req)
        finally:
            captured, self._capture = self._capture or {}, None
            self._studio_mode = None   # the next request decides again
            run = getattr(self, "_long_run", None)
            if run:
                self.keep_long_refs(run, captured)
                self._long_run = None

    async def generate_long(self, req):
        form, files, prompt, aspect, quality, seed = await self.read_form(req, ("img0", "img1", "img2", "img3", "img4", "aud0", "srcvid", "srcframe") + tuple(f"simg{i}_{j}" for i in range(catalog.LONG_MAX_SCENES) for j in range(9)) + tuple(f"saudio{i}_{j}" for i in range(catalog.LONG_MAX_SCENES) for j in range(3)), need_prompt=False)   # the texts are in the scenes, there is no single prompt
        act = getattr(self, "_studio_mode", "long") == "actionsc"
        self._long_run = re.sub(r"[^A-Za-z0-9]", "", form.get("run", ""))[:32]   # the references are kept even if the request is refused later
        try:
            scenes = [(str(x.get("prompt", "")).strip(), float(x.get("sec", 10)), bool(x.get("fresh")), bool(x.get("lng")))
                    for x in json.loads(form.get("scenes") or "[]")]
        except (ValueError, TypeError, AttributeError):
            scenes = []
        sc_audios = [[files.get(f"saudio{i}_{j}") for j in range(3)] for i in range(len(scenes))]   # по сценам, места не сдвигаются
        scenes = [(p, min(wf.LONG_MAX_SCENE_LONG if lg else wf.LONG_MAX_SCENE, max(3.0, sec)),
                   [files.get(f"simg{i}_{j}") for j in range(9)], fr)
                  # the places are kept: an empty place stays empty and does not shift the numbers
                  for i, (p, sec, fr, lg) in enumerate(scenes) if p][:catalog.LONG_MAX_SCENES]
                  # every scene may bring its own references (instead of the common ones)
        fresh = [fr for *_, fr in scenes]   # a scene marked as a NEW SHOT does not continue the previous one (no quality loss)
        scenes = [(p, sec, extra) for p, sec, extra, _ in scenes]
        test = form.get("test") == "1"   # a size test of one scene: stand-alone, does not touch the other scenes
        draft = form.get("draft") == "1" and not test   # quick draft: 4 steps, smaller frame; the finished row is made later with the same seed
        sfx = "_d" if draft else ""
        if form.get("run") and not form.get("seed"):   # one seed for the whole project: the draft and the finished version look alike
            seed = int(hashlib.md5(form["run"].encode()).hexdigest()[:12], 16)
        try:   # «redo this scene»: every redo is another variant, otherwise the same seed would give the same clip again
            seed += max(0, min(1000, int(form.get("variant") or 0))) * 1000003
        except ValueError:
            pass
        if act and not (form.get("part", "").isdigit()) and not test:
            raise web.HTTPBadRequest(text="Экшн-видеостудия считает по частям: включите режим «По частям» - каждая сцена продолжает предыдущую.")
        if not scenes:
            raise web.HTTPBadRequest(text="Напишите хотя бы одну сцену")
        images = [files.get(f"img{i}") for i in range(5)]   # by place, not by order: the numbers in the texts stay true
        # the reference sizing the person picked in «Параметры» ("max" keeps a face readable, "match"
        # shrinks every reference to the frame area - a postage stamp in a draft). The scene graphs
        # used to ignore this and always pass "match".
        ref_size = form.get("ref_size") if form.get("ref_size") in ("match", "max") else "max"
        audio = files.get("aud0")
        # Уровень музыки в готовом ролике берётся с ползунка (децибелы), а не захардкожен. С флагом
        # «выровнять громкость» фон берётся из ровной копии файла: положение ползунка тогда значит
        # одно и то же в тихом и в громком файле. Модель при этом слушает подлинный файл.
        bed_db = bed_level(form)
        bed_file, bed_note = None, ""
        if audio and form.get("bed_norm") == "1":
            got = (self._capture or {}).get("aud0")
            if got:
                bed_file, bed_note = await self.bed_norm(self._long_run, got[1], got[0], self.rh())
        bed_say = (" · " + bed_note) if bed_note else ""   # короткая правда о выравнивании - в задании и в Библиотеке
        try:
            start = max(0.0, float(form.get("start") or 0))
        except ValueError:
            start = 0.0
        vocals = None
        if audio and form.get("vocals") == "1":
            if "vocal_model" in {m["role"] for m in self.missing} or "vocal_model" not in self.model_names:
                raise web.HTTPBadRequest(text="Для «Только вокал» нужна модель MelBand. Скачайте её в разделе «Настройки».")
            vocals = self.model_names["vocal_model"]
        if "pika_lora" in {m["role"] for m in self.missing}:
            raise web.HTTPBadRequest(text="Файл Pika (pika_h3_flex_turbo_8step_hd_ref2va) не найден. Скачайте его в разделе «Настройки».")
        width, height = wf.resolution(aspect, quality, form)
        dmad = None
        if draft:
            pass   # a draft has the size the user chose (it may be enough for a clip that is only to be enlarged)
            _, loras = await self.comfy_json("GET", "/models/loras")
            dmad = self.model_names.get("dmad_lora") if "dmad_lora" not in {m["role"] for m in self.missing} else None
            dmad = dmad or next((n for n in loras or [] if re.search(r"dmad[_\-\s]?4[_\-\s]?step", n, re.I)), None)
            if not dmad:
                raise web.HTTPBadRequest(text="Для черновика нужен файл ускорения DMAD на 4 шага. Скачайте его в разделе «Настройки», в списке моделей "
                                              "(он помечен «по желанию»), или положите в папку loras вашего ComfyUI. Без него делайте сцену сразу в хорошем качестве.")
        # The head of the structured prompt must count the pictures that REALLY travel to the node.
        # Both rows are kept with their holes on purpose - a hole keeps its number, so the tags in
        # the texts stay true - and len() of such a row said 9 while a single file was sent. The
        # model was told nine references exist, and it answered with invented faces and its own song.
        filled_common = [i + 1 for i, x in enumerate(images or []) if x]
        part = form.get("part", "")
        only = int(part) if part.isdigit() else -1   # по частям: спрашиваем только про ту сцену, что сейчас считается
        wrapped, gaps = [], []
        for idx, (p, sec, own) in enumerate(scenes):
            tags = (filled_common + [10 * (idx + 1) + j for j, x in enumerate(own or []) if x])[:9]
            # Номер в тексте без файла - самая частая причина «герои получились другие»: движок
            # читает <Picture 20>, не находит под этим номером картинки и берёт свою. Не мигаем
            # предупреждением, а спрашиваем окном: «Продолжить» (force=1) или «Прервать».
            g = wf.scene_gaps(p, images, own, base=10 * (idx + 1),
                              auds=(sc_audios[idx] if idx < len(sc_audios) else ()), track=bool(audio))
            if g and (only < 0 or only == idx):
                gaps.append(f"Сцена {idx + 1}: " + ", ".join(g))
            wrapped.append((wf.lipsync_prompt(p, 0, ref_tags=tags), sec, own))
        scenes = wrapped
        if gaps and form.get("force") != "1":
            return web.json_response({"gaps": gaps, "error": "Текст ссылается на пустые места"}, status=409)
        if part.isdigit():  # one scene at a time: scene k continues from the saved tail of scene k-1
            k = int(part)
            run = re.sub(r"[^A-Za-z0-9]", "", form.get("run", ""))[:32]
            self._long_run = run
            if not run or k >= len(scenes):
                raise web.HTTPBadRequest(text="Неверный номер сцены")
            state, cont = None, None
            if k == 0 and (form.get("src_item") or files.get("srcvid")):
                cont = await self.long_source(form.get("src_item"), files.get("srcvid"), scenes[0][1])
            if test:
                fresh = list(fresh); fresh[k] = True
            if k and not fresh[k]:
                src = LONG_DIR / run / f"state_{k - 1}{sfx}.latent"
                if not src.exists():
                    raise web.HTTPBadRequest(text=f"Сначала сделайте сцену {k}: следующая продолжает её конец.")
                try:  # the saved tail only fits a scene of the same frame size
                    was = json.loads(src.with_suffix(".json").read_text(encoding="utf-8")).get("res")
                except (OSError, ValueError):
                    was = None
                if was and was != f"{width}×{height}":
                    raise web.HTTPBadRequest(text=f"Сцена {k} сделана в формате {was}, а сейчас выбран {width}×{height}. "
                                                  "Верните прежний формат и качество или переделайте сцену 1 в новом.")
                state = await self.upload_state(src, f"h3s_long_{run}_{k - 1}.latent")
            if act:
                # the same scene road on the action model: the LoRAs and the exact scheme are taken the
                # way the single action mode takes them, so both doors agree
                if self.rh():
                    rh_files = {n.replace("\\", "/").split("/")[-1].lower(): n for n in (getattr(self, "rh_models", None) or [])}
                    speed = rh_files.get(catalog.VARIANTS["speed_slider_lora"]["v1.1"]["file"].lower())
                    dmad_a = next((n for b, n in rh_files.items() if catalog.is_action_dmad(b)), None)
                    s = {"faithful": False, "dmad": dmad_a, "speed": speed}
                else:
                    s = await self.action_setup()
                aloras = []
                for key, name, default in (("dmad", s["dmad"], 0.8), ("speed", s["speed"], 4.0)):
                    v = lora_strength(form, key, default)
                    if name and v is not None:
                        aloras.append((name, v))
                aloras += self.custom_loras("action")
                faithful = bool(s.get("faithful")) and form.get("faithful") != "0"
                usarp = min(6, max(1, int(form.get("usarp") or 2)))   # sharpness of the second pass (2D upscaler)
                plan_a = wf.long_plan([sc[1] for sc in scenes], fresh=fresh)   # where this scene sits on the track
                audio_at = round(max(0.0, (plan_a[k]["acc_before"] - plan_a[k]["ov"]) / wf.FPS), 3) if audio else 0.0
                graph, stages = wf.action_part_graph(self.model_names, scenes, k, width, height, seed, images, aloras,
                                                     audio=audio, audio_at=audio_at, audio_dur=float(form.get("audio_dur") or 0),
                                                     loop=form.get("music_loop") == "1", vocals=vocals, scene_audios=sc_audios,
                                                     bed_db=bed_db, bed_file=bed_file,
                                                     preview=await self.preview_opts(), state=state, fresh=fresh,
                                                     faithful=faithful and k == 0, usarp=usarp,
                ltxv=await self.has_node("LTXVSetVideoLatentNoiseMasks"))
                if faithful and s.get("refiner_def"):
                    # the refiner's input names come from the installed node; values as in the original workflow
                    for nid, node in graph.items():
                        if node.get("class_type") == "H3SigmaRefiner":
                            req_inputs = [x for x in (s["refiner_def"]["input"].get("required") or {}) if x != "sigmas"]
                            node["inputs"] = {**node.get("inputs", {}), **dict(zip(req_inputs, [1, 0.7, 0.0, "cosine"]))}
            else:
                graph, stages = wf.long_part_graph(self.model_names, scenes, k, width, height, seed, images, audio, start,
                                                   dmad if draft else self.model_names["pika_lora"], self.custom_loras("long"), ref_size, vocals, state,
                                                   await self.preview_opts(), cont, form.get("src_project") == "1", fresh, draft,
                                                   loop=form.get("music_loop") == "1", audio_dur=float(form.get("audio_dur") or 0),
                                                   scene_audios=sc_audios, bed_db=bed_db, bed_file=bed_file)
            plan = wf.long_plan([sc[1] for sc in scenes], cont_first=bool(cont) or form.get("src_project") == "1", fresh=fresh)
            sub = f"сцена {k + 1} из {len(scenes)}" + (" · музыка" if audio else " · звук от модели") + bed_say
            return await self.queue(graph, stages, {
                "mode": "actionsc" if act else "long", "sub": sub + (" · черновик" if draft else f" · проба {width}×{height}" if test else ""), "prompt": scenes[k][0], "aspect": aspect, "q": quality,
                "bed_db": bed_db, "bed_note": bed_note,   # уровень музыки и честно про выравнивание: попадут в запись Библиотеки
                "len": round((plan[k]["total"] - plan[k]["ov"]) / wf.FPS, 1), "res": f"{width}×{height}", "seed": seed,
                "long": {"run": run, "part": k, "n": len(scenes), "draft": draft, "test": test},
                "ref_size": ref_size})
        graph, stages = wf.long_graph(self.model_names, scenes, width, height, seed, images, audio, start,
                                      dmad if draft else self.model_names["pika_lora"], self.custom_loras("long"), ref_size, vocals, await self.preview_opts(), fresh, False, draft,
                                      frame=files.get("srcframe"), loop=form.get("music_loop") == "1", audio_dur=float(form.get("audio_dur") or 0),
                                      scene_audios=sc_audios, bed_db=bed_db, bed_file=bed_file)   # the continued video's last frame: a picture of its own
        run = re.sub(r"[^A-Za-z0-9]", "", form.get("run", ""))[:32]
        self._long_run = run
        total = wf.long_plan([sc[1] for sc in scenes], fresh=fresh)[-1]["acc"] / wf.FPS
        sub = f"{len(scenes)} сцен · {len(images)} карт." + (", музыка" if audio else ", звук от модели") + (" · черновик" if draft else "") + bed_say
        meta = {"mode": "long", "sub": sub, "prompt": "\n\n".join(sc[0] for sc in scenes), "aspect": aspect, "q": quality,
                "bed_db": bed_db, "bed_note": bed_note,   # то же, что у сцен по частям: уровень музыки и честно про выравнивание
                "len": round(total, 1), "res": f"{width}×{height}", "seed": seed}
        if run:
            meta["long"] = {"run": run, "part": len(scenes) - 1, "n": len(scenes), "all": True}
        return await self.queue(graph, stages, meta)

    async def h_long_state(self, req):
        """Which scenes of a long video project have a saved continuation point (so the project can go on after a restart)."""
        run = re.sub(r"[^A-Za-z0-9]", "", req.query.get("run", ""))[:32]
        d = LONG_DIR / run
        names = [f.name for f in d.glob("state_*.latent")] if run and d.is_dir() else []
        parts = sorted(int(m.group(1)) for n in names if (m := re.match(r"state_(\d+)\.latent$", n)))
        dparts = sorted(int(m.group(1)) for n in names if (m := re.match(r"state_(\d+)_d\.latent$", n)))
        return web.json_response({"parts": parts, "draft_parts": dparts})

    async def h_action_info(self, _req):
        try:
            s = await self.action_setup()
        except aiohttp.ClientError:
            return web.json_response({"error": "ComfyUI не отвечает"}, status=503)
        s.pop("refiner_def", None)
        return web.json_response(s)
