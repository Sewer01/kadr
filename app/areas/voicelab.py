"""Voice Lab: голоса и озвучка через ноды ComfyUI-OmniVoice-TTS (и Chatterbox для «своей интонации»).

Четыре способа, все собираются здесь же графами, считает их ComfyUI:
  design - голос по описанию (пол, возраст, высота, акцент);
  clone  - образец голоса читает любой текст (длинный текст режет сама нода);
  dialog - разговор: каждую реплику читает свой голос (2-4 голоса, на каждый нужен образец);
  vc     - конверсия интонации: ваша запись переозвучивается выбранным голосом.
Сохранённые голоса (короткий образец с названием) и последние варианты живут в data/voicelab/.

Раздел не берёт модели из справочника catalog: голосовой движок качает сама нода при первой
озвучке, а пакеты её нод человек ставит кнопкой в разделе (catalog.VOICE_PACK, catalog.VC_PACK).
"""

from aiohttp import web
from applog import applog
from datetime import datetime
from netutil import comfy_error_text
from pathlib import Path
from paths import CLIENT_ID
import aiohttp
import asyncio
import catalog
import engine
import json
import re
import speech
import uuid
import zipfile


AUD_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"}
MAX_UPLOAD = 60 * 1024 * 1024
MAX_SPEAKERS = 4
SHORT_TEXT_WORDS = 45       # нода клона не режет текст: длинное отдаём ноде длинного текста
WAIT_SEC = 2400             # сколько ждём один вариант: первая озвучка качает ещё и модель

QUALITY = {"fast": 16, "normal": 32, "best": 64}

# что предлагает окно «Новый голос»: нода понимает именно эти английские слова
GENDERS = {"female": "Женский", "male": "Мужской"}
AGES = {"child": "Ребёнок", "teenager": "Подросток", "young adult": "Молодой",
        "middle-aged": "Средний возраст", "elderly": "Пожилой"}
PITCHES = {"very low pitch": "Очень низкий", "low pitch": "Низкий", "moderate pitch": "Средний",
           "high pitch": "Высокий", "very high pitch": "Очень высокий"}
ACCENTS = {"russian accent": "Русский", "american accent": "Американский", "british accent": "Британский",
           "australian accent": "Австралийский", "canadian accent": "Канадский", "indian accent": "Индийский",
           "chinese accent": "Китайский", "japanese accent": "Японский", "korean accent": "Корейский",
           "portuguese accent": "Португальский"}
VALID_WORDS = set(GENDERS) | set(AGES) | set(PITCHES) | set(ACCENTS) | {"whisper"}


def _err(text, status=400):
    return web.json_response({"error": text}, status=status)


def _num(v, lo, hi, default):
    try:
        return min(hi, max(lo, float(v)))
    except (TypeError, ValueError):
        return default


def _pick(v, options, default):
    return v if v in options else default


def _flag(v, default):
    return default if v is None else bool(v)


def settings(p):
    """Все числа ноды, приведённые к разрешённым границам (имена - это входы самой ноды)."""
    steps = int(_num(p.get("steps"), 4, 64, QUALITY.get(str(p.get("quality")), 32)))
    seed = int(_num(p.get("seed"), 0, 2 ** 31 - 1, 0)) or int(uuid.uuid4().int % (2 ** 31 - 1)) + 1
    return {"steps": steps, "speed": round(_num(p.get("speed"), 0.5, 2.0, 1.0), 2),
            "guidance_scale": round(_num(p.get("guidance"), 0.0, 10.0, 2.0), 2),
            "t_shift": round(_num(p.get("t_shift"), 0.0, 1.0, 0.1), 2),
            "duration": round(_num(p.get("duration"), 0.0, 60.0, 0.0), 1), "seed": seed,
            "device": _pick(p.get("device"), ("auto", "cuda", "cpu", "mps", "xpu"), "auto"),
            "dtype": _pick(p.get("dtype"), ("auto", "bf16", "fp16", "fp32"), "auto"),
            "attention": _pick(p.get("attention"), ("auto", "eager", "sage_attention"), "auto"),
            "position_temperature": round(_num(p.get("position_temperature"), 0.0, 20.0, 5.0), 1),
            "class_temperature": round(_num(p.get("class_temperature"), 0.0, 5.0, 0.0), 2),
            "layer_penalty_factor": round(_num(p.get("layer_penalty_factor"), 0.0, 20.0, 5.0), 1),
            "denoise": _flag(p.get("denoise"), True), "postprocess_output": _flag(p.get("postprocess_output"), True),
            # голосовую модель держим выгруженной: иначе она занимает память режимов, которые человек
            # откроет сразу после озвучки
            "keep_model_loaded": _flag(p.get("keep_model_loaded"), False)}


def hint(p):
    """Свободный текст «как сказать» нод клона (манера, эмоция): по-английски, одной строкой."""
    return re.sub(r"\s+", " ", str(p.get("instruct") or "")).strip()[:300]


def instruct(p):
    """Описание придумываемого голоса: выбранные слова по-английски или свой английский текст."""
    own = re.sub(r"\s+", " ", str(p.get("custom") or "")).strip()[:300]
    if own:
        return own
    words = [str(p.get(k) or "") for k in ("gender", "age", "pitch", "accent")]
    words = [w for w in words if w in VALID_WORDS]
    if p.get("whisper"):
        words.append("whisper")
    return ", ".join(words) or "female, moderate pitch"


def _save(g, src, p=None, prefix="kadr/voicelab/voice"):
    """Куда нода кладёт звук: имя с префиксом, чтобы варианты не смешивались с роликами."""
    q = _pick((p or {}).get("mp3"), ("V0", "128k", "320k"), "V0")
    g["90"] = {"class_type": "SaveAudioMP3", "inputs": {"audio": [src, 0], "filename_prefix": prefix, "quality": q}}
    return g


def design_graph(model, text, p):
    g = {"1": {"class_type": "OmniVoiceVoiceDesignTTS",
               "inputs": {"model": model, "text": text, "voice_instruct": instruct(p), **settings(p)}}}
    return _save(g, "1", p)


def clone_graph(model, text, p, ref_name, ref_text=""):
    s = settings(p)
    g = {"2": {"class_type": "LoadAudio", "inputs": {"audio": ref_name}}}
    if len(text.split()) > SHORT_TEXT_WORDS:
        g["1"] = {"class_type": "OmniVoiceLongformTTS", "inputs": {
            "model": model, "text": text, "ref_text": ref_text, "ref_audio": ["2", 0],
            "words_per_chunk": int(_num(p.get("words_per_chunk"), 0, 500, 100)),
            "preprocess_prompt": _flag(p.get("preprocess_prompt"), True), "instruct": hint(p), **s}}
    else:
        g["1"] = {"class_type": "OmniVoiceVoiceCloneTTS", "inputs": {
            "model": model, "text": text, "ref_text": ref_text, "ref_audio": ["2", 0],
            "preprocess_prompt": _flag(p.get("preprocess_prompt"), True), "instruct": hint(p), **s}}
    return _save(g, "1", p)


def dialog_graph(model, text, p, speakers):
    """speakers: [(имя файла в ComfyUI, что сказано в образце)] по одному на голос, по порядку [Speaker_N]."""
    s = settings(p)
    inputs = {"model": model, "text": text, "num_speakers": str(len(speakers)),
              "pause_between_speakers": round(_num(p.get("pause"), 0.0, 3.0, 0.3), 1),
              "preprocess_prompt": _flag(p.get("preprocess_prompt"), True),
              **{k: v for k, v in s.items() if k != "duration"}}
    g = {}
    for i, (name, ref_text) in enumerate(speakers, 1):
        g[f"a{i}"] = {"class_type": "LoadAudio", "inputs": {"audio": name}}
        inputs[f"num_speakers.speaker_{i}_audio"] = [f"a{i}", 0]
        inputs[f"num_speakers.speaker_{i}_ref_text"] = ref_text
    g["1"] = {"class_type": "OmniVoiceMultiSpeakerTTS", "inputs": inputs}
    return _save(g, "1", p)


def _default(spec):
    """Значение по умолчанию из описания входа ноды: явный default, а иначе первый вариант списка."""
    try:
        t = spec[0]
        cfg = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        if "default" in cfg:
            return cfg["default"]
        opts = t if isinstance(t, list) else cfg.get("options") or []
        return opts[0] if opts else None
    except (TypeError, IndexError):
        return None


def convert_graph(info, src_name, ref_name, p):
    """ChatterboxVC: запись src_name переозвучивается голосом ref_name; прочие нужные входы получают свои значения."""
    req = ((info or {}).get("input") or {}).get("required") or {}
    packs = (req.get("model_pack_name") or [[]])[0]
    packs = packs if isinstance(packs, list) else ((req.get("model_pack_name") or [None, {}])[1] or {}).get("options") or []
    pack = "chatterbox" if "chatterbox" in packs else (_default(req.get("model_pack_name") or []) or (packs[0] if packs else "chatterbox"))
    inputs = {"model_pack_name": pack, "source_audio": ["2", 0], "target_voice_audio": ["3", 0],
              "n_timesteps": int(_num(p.get("steps"), 2, 50, 10)), "flow_cfg_scale": round(_num(p.get("cfg"), 0.0, 2.0, 1.0), 2),
              "refinement_passes": int(_num(p.get("passes"), 1, 5, 2)),
              "temperature": round(_num(p.get("temperature"), 0.0, 2.0, 1.0), 2), "use_watermark": False}
    for name, spec in req.items():
        if name not in inputs:
            v = _default(spec)
            if v is not None:
                inputs[name] = v
    g = {"2": {"class_type": "LoadAudio", "inputs": {"audio": src_name}},
         "3": {"class_type": "LoadAudio", "inputs": {"audio": ref_name}},
         "1": {"class_type": "ChatterboxVC", "inputs": inputs}}
    return _save(g, "1", p)


def pick_model(options):
    """Какое имя модели взять из списка ноды: сначала лёгкая, которую уже качали, потом большая, потом лёгкая."""
    opts = [str(o) for o in options or []]
    for want in ("OmniVoice-bf16", "OmniVoice"):
        if want in opts:
            return want
    return next((o for o in opts if "bf16" in o), opts[0] if opts else "OmniVoice-bf16 (auto download)")


def dialog_text(text, n):
    """Нода хочет префикс [Speaker_N]: перед каждой строкой. Если человек сам не расставил - голоса идут по очереди."""
    lines = [ln.strip() for ln in str(text or "").splitlines() if ln.strip()]
    if any(re.match(r"\[speaker_\d+\]\s*:", ln, re.I) for ln in lines):
        return "\n".join(lines)
    return "\n".join(f"[Speaker_{i % n + 1}]: {ln}" for i, ln in enumerate(lines))


def pack_url(pack):
    """Два адреса одного архива: одну точку иногда закрыта сеть."""
    return (f'https://github.com/{pack["repo"]}/archive/{pack["commit"]}.zip',
            f'https://codeload.github.com/{pack["repo"]}/zip/{pack["commit"]}')


class VoicelabMixin:
    """Область «voicelab»: ноды голоса, озвучка, сохранённые голоса и варианты."""

    # ---------- что умеет движок ----------

    async def voice_model_options(self):
        """(знает ли нода, какие модели она предлагает). Список меняется, когда человек докачал модель."""
        try:
            _, oi = await self.comfy_json("GET", f"/object_info/{catalog.VOICE_CLASS}",
                                          timeout=aiohttp.ClientTimeout(total=15))
        except aiohttp.ClientError:
            return None, []
        info = (oi or {}).get(catalog.VOICE_CLASS)
        if not info:
            return False, []
        try:
            return True, list(info["input"]["required"]["model"][0])
        except (KeyError, IndexError, TypeError):
            return True, []

    async def voice_vc_info(self):
        """Описание ноды преобразования голоса (ChatterboxVC) или None, когда пакета не стоит."""
        try:
            _, oi = await self.comfy_json("GET", f"/object_info/{catalog.VC_CLASS}",
                                          timeout=aiohttp.ClientTimeout(total=15))
        except aiohttp.ClientError:
            return None
        return (oi or {}).get(catalog.VC_CLASS) or None

    def voice_nodes_dir(self):
        """Папка custom_nodes того ComfyUI, с которым работаем. None - когда папка неизвестна.

        Управляемый ComfyUI лежит в папке установки программы. Свой ComfyUI человек называет сам в
        разделе: программа не ходит по чужим процессам, а запоминает указанную папку в config.
        """
        if self.config.get("engine") == "managed" and self.comfy_root():
            return self.comfy_root() / "ComfyUI" / "custom_nodes"
        raw = str(self.config.get("voice_comfy_dir") or "").strip().strip('"')
        return self._voice_nodes_of(Path(raw)) if raw else None

    @staticmethod
    def _voice_nodes_of(base):
        """Где внутри указанной папки лежит custom_nodes: то там, то на уровень глубже."""
        return next((c for c in (base / "custom_nodes", base / "ComfyUI" / "custom_nodes") if c.is_dir()), None)

    def voice_python(self, nodes_dir):
        """Python того ComfyUI, которому ставим пакет (он же ставит и свои пакеты)."""
        root = self.comfy_root() if self.config.get("engine") == "managed" else None
        cands = [root / "python_embeded" / "python.exe"] if root else []
        if nodes_dir:
            cands += [nodes_dir.parent.parent / "python_embeded" / "python.exe",
                      nodes_dir.parent / "python_embeded" / "python.exe"]
        return next((c for c in cands if c.is_file()), None)

    async def h_voice_status(self, _req):
        """Отвечает разделу: можно ли озвучивать, какие модели есть и что ещё не установлено."""
        if self.rh():
            return web.json_response({"ready": False, "state": "cloud",
                                      "reason": "Раздел работает на этом компьютере, а сейчас включено облако RunningHub."})
        have, models = await self.voice_model_options()
        if have is None:
            return web.json_response({"ready": False, "state": "offline",
                                      "reason": "ComfyUI не отвечает. Откройте раздел «Настройки» и запустите движок."})
        if not have:
            nd = self.voice_nodes_dir()
            if nd and (nd / catalog.VOICE_PACK["name"]).is_dir():
                # файлы на месте, но нода не загрузилась: говорим почему (про это пишет журнал движка)
                tail = self.process.log_tail(400) if self.process else ""
                why = next((ln.strip() for ln in reversed(tail.splitlines())
                            if "[OmniVoice]" in ln and ("fail" in ln.lower() or "missing" in ln.lower())), "")
                return web.json_response({"ready": False, "state": "nonode", "installed": True, "restart": True,
                                          "reason": "Модуль голоса установлен, но не запускается" + (f": {why}" if why else "")
                                          + ". Нажмите «Установить модуль голоса» - программа доустановит недостающее, "
                                            "а потом перезапустите ComfyUI."})
            return web.json_response({"ready": False, "state": "nonode", "nodes_known": bool(nd),
                                      "reason": "Для голоса нужен модуль OmniVoice. Его можно поставить кнопкой ниже."})
        local = [m for m in models if "auto download" not in m]
        return web.json_response({"ready": True, "model": pick_model(models), "models": models,
                                  "downloaded": bool(local), "vc": bool(await self.voice_vc_info()),
                                  "restart": self.config.get("engine") == "managed"})

    # ---------- установка пакетов нод ----------

    async def h_voice_install(self, req):
        """Кладёт пакет нод в custom_nodes и ставит то, что пакет просит. ComfyUI после этого нужно перезапустить."""
        try:
            body = await req.json()
        except (ValueError, UnicodeDecodeError):
            body = {}
        nodes_dir = self.voice_nodes_dir()
        if not nodes_dir and body.get("dir"):
            raw = str(body.get("dir")).strip().strip('"')
            found = self._voice_nodes_of(Path(raw)) if raw else None
            if not found:
                return _err("Не нашлась папка custom_nodes вашего ComfyUI. Укажите папку ComfyUI - ту, внутри которой лежит custom_nodes.")
            self.config.update(voice_comfy_dir=raw)
            nodes_dir = found
        if not nodes_dir:
            return _err("Не известно, куда класть модуль: в разделе «Настройки» выбран ваш собственный ComfyUI. "
                        "Укажите ниже его папку - ту, внутри которой лежит custom_nodes.")
        pack = catalog.VC_PACK if body.get("pack") == "vc" else catalog.VOICE_PACK
        target = nodes_dir / pack["name"]
        if not target.is_dir():
            zpath = nodes_dir.parent / f'_kadr_{pack["name"]}.zip'
            got = False
            for url in pack_url(pack):
                try:
                    async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=300)) as r:
                        if r.status != 200:
                            continue
                        zpath.write_bytes(await r.read())
                    with zipfile.ZipFile(zpath) as z:
                        top = z.namelist()[0].split("/")[0]
                        z.extractall(nodes_dir)
                    if (nodes_dir / top) != target:
                        (nodes_dir / top).rename(target)
                    got = True
                    break
                except (OSError, ValueError, zipfile.BadZipFile, aiohttp.ClientError) as e:
                    applog(f"Voice Lab: пакет {pack['name']} не скачался: {type(e).__name__}: {str(e)[:200]}")
            zpath.unlink(missing_ok=True)
            if not got:
                return _err("Не удалось скачать модуль голоса. Проверьте интернет и попробуйте ещё раз.", 502)
        # что пакет просит у python: у OmniVoice есть свой install.py, у Chatterbox - только требования
        py = self.voice_python(nodes_dir)
        script = ["-s", str(target / "install.py")] if (target / "install.py").is_file() else \
            (["-s", "-m", "pip", "install", "-r", str(target / "requirements.txt")] if (target / "requirements.txt").is_file() else None)
        pip_ok = None
        if py and script:
            root = self.comfy_root() if self.config.get("engine") == "managed" else None
            extra = {"env": engine.local_env(root)} if root else {}
            proc = await asyncio.create_subprocess_exec(str(py), *script, cwd=str(target),
                                                        stdout=asyncio.subprocess.DEVNULL,
                                                        stderr=asyncio.subprocess.DEVNULL,
                                                        creationflags=engine.CREATE_NO_WINDOW, **extra)
            try:
                await asyncio.wait_for(proc.wait(), 1500)
                pip_ok = proc.returncode == 0
            except asyncio.TimeoutError:
                proc.kill()
                pip_ok = False
        if py and pack is catalog.VOICE_PACK:
            pip_ok = await self.voice_pip_fix(py, self.comfy_root() if self.config.get("engine") == "managed" else None)
        return web.json_response({"ok": True, "pip": pip_ok, "python_found": bool(py), "restart": True})

    async def voice_pip_fix(self, py, root):
        """Доучивает то, что пакет голоса сам не доучил. True - когда всё на месте.

        Нода ставит «omnivoice» без зависимостей: в Python 3.13 нет встроенного «audioop» (pydub падает
        с «No module named pyaudioop» - его возвращает audioop-lts), а transformers для загрузки модели
        на нужное устройство просит «accelerate». Дальше досматриваем импорт и доучиваем то, о чём он
        сам скажет («No module named X»).
        """
        extra = {"env": engine.local_env(root)} if root else {}
        ok = True

        async def run_py(*args, timeout=600):
            p = await asyncio.create_subprocess_exec(str(py), "-s", *args, stdout=asyncio.subprocess.DEVNULL,
                                                     stderr=asyncio.subprocess.PIPE,
                                                     creationflags=engine.CREATE_NO_WINDOW, **extra)
            _, err = await asyncio.wait_for(p.communicate(), timeout)
            return p.returncode, err.decode("utf-8", "ignore")
        try:
            for pkg, mod in (("audioop-lts", "audioop"), ("accelerate", "accelerate")):
                if (await run_py("-c", f"import {mod}", timeout=120))[0] != 0:
                    if (await run_py("-m", "pip", "install", pkg))[0] != 0:
                        ok = False
            tried = set()
            for _ in range(6):
                rc, err = await run_py("-c", "import omnivoice", timeout=300)
                m = re.search(r"No module named '([A-Za-z0-9_\-]+)", err)
                if rc == 0 or not m or m.group(1) in tried:
                    ok = ok and rc == 0
                    break
                if m.group(1) in ("omnivoice", "torch", "torchaudio", "torchvision"):
                    # сюда не тянем: omnivoice притащит свой torch и заменит сборку под видеокарту
                    ok = False
                    break
                name = {"pyaudioop": "audioop-lts", "yaml": "pyyaml", "cv2": "opencv-python-headless"}.get(m.group(1), m.group(1))
                tried.add(m.group(1))
                applog(f"Voice Lab: модулю голоса не хватало {name} - доучиваем")
                if (await run_py("-m", "pip", "install", name))[0] != 0:
                    ok = False
                    break
        except (OSError, asyncio.TimeoutError) as e:
            applog(f"Voice Lab: служебные пакеты голоса не доучены: {type(e).__name__}: {str(e)[:200]}")
            ok = False
        return ok

    async def h_voice_progress(self, _req):
        """Насколько скачалась модель преобразования голоса: она ложится в <ComfyUI>/models/tts/chatterbox,
        недокачанные файлы кончаются на .incomplete."""
        root = self.comfy_root() if self.config.get("engine") == "managed" else None
        if not root:
            raw = str(self.config.get("voice_comfy_dir") or "").strip().strip('"')
            root = Path(raw) if raw else None
        d = (root / "ComfyUI" / "models" / "tts" / "chatterbox") if root else None
        if not d or not d.is_dir():
            return web.json_response({"downloading": False, "bytes": 0, "total": 0})
        size, busy = 0, False
        for f in d.rglob("*"):
            if not f.is_file():
                continue
            try:
                size += f.stat().st_size
            except OSError:
                continue
            busy = busy or f.name.endswith(".incomplete")
        return web.json_response({"downloading": busy, "bytes": size, "total": 3_200_000_000})

    async def h_voice_restart(self, _req):
        """Перезапускает тот ComfyUI, которым управляет программа: custom_nodes читаются только на старте."""
        if self.config.get("engine") != "managed" or not self.process:
            return _err("Программа не управляет этим ComfyUI: перезапустите его сами.")
        if self.jobs:
            return _err("Идёт расчёт: перезапустите ComfyUI, когда очередь освободится.")
        applog("Voice Lab: перезапускаю ComfyUI, чтобы он увидел новые ноды")
        await asyncio.to_thread(self.process.stop)
        self.start_managed()
        return web.json_response({"ok": True})

    # ---------- озвучка ----------

    async def h_voice_cancel(self, _req):
        """Кнопка «Стоп»: снимает вариант и из очереди движка, и из работы."""
        self.voice_stop = True
        pid = getattr(self, "voice_pid", None)
        if pid:
            await self.comfy_json("POST", "/queue", json={"delete": [pid]})
            await self.comfy_json("POST", "/interrupt", json={"prompt_id": pid})
        else:
            await self.comfy_json("POST", "/interrupt", json={})
        return web.json_response({"ok": True})

    async def voice_upload(self, raw, suffix):
        """Образец голоса в папку input движка: возвращает имя, которым его видит нода."""
        data = aiohttp.FormData()
        name = f"kadr_v_{uuid.uuid4().hex[:8]}"
        data.add_field("image", raw, filename=name + (suffix or ".wav"), content_type="application/octet-stream")
        data.add_field("subfolder", "kadr")
        data.add_field("type", "input")
        status, res = await self.comfy_json("POST", "/upload/image", data=data)
        if status != 200:
            raise web.HTTPBadGateway(text="Не удалось передать звук в ComfyUI")
        return f'{res["subfolder"]}/{res["name"]}' if res.get("subfolder") else res["name"]

    async def h_voice_generate(self, req):
        """Один вариант озвучки: режимы design / clone / dialog / vc. Ждёт, пока ComfyUI закончит.

        Первый запуск качает ещё и голосовую модель (несколько минут), поэтому ответ приходит не сразу:
        интерфейс на это время показывает свой счётчик и кнопку «Стоп».
        """
        if self.rh():
            return _err("Раздел работает на этом компьютере, а сейчас включено облако.", 400)
        p, files = {}, {}
        try:
            async for field in await req.multipart():
                if field.name == "params":
                    p = json.loads((await field.read()).decode("utf-8"))
                elif field.name and field.filename:
                    raw = bytes(await field.read())
                    if len(raw) > MAX_UPLOAD:
                        return _err("Файл слишком большой (до 60 МБ)")
                    files[field.name] = (Path(field.filename).suffix.lower(), raw)
        except (ValueError, UnicodeDecodeError):
            return _err("Не удалось прочитать данные")
        mode = p.get("mode")
        text = str(p.get("text") or "").strip()
        if not text and mode != "vc":
            return _err("Напишите, что должен сказать голос")
        if len(text) > 20000:
            return _err("Текст слишком длинный (до 20 000 знаков)")
        vc_info = None
        if mode == "vc":
            vc_info = await self.voice_vc_info()
            if not vc_info:
                return _err("В ComfyUI нет модуля преобразования голоса (Chatterbox), или ComfyUI не запущен. "
                            "Поставьте его на вкладке «Своя интонация».")
            models = []
        else:
            have, models = await self.voice_model_options()
            if not have:
                return _err("В ComfyUI нет модуля OmniVoice, или ComfyUI не запущен.")
        model = p.get("model") if p.get("model") in models else pick_model(models)
        raws = {}

        async def sample(key, saved_id):
            """Образец голоса: файл из окна, сохранённый голос или уже готовый вариант - и имя внутри ComfyUI."""
            if saved_id and str(saved_id).startswith("take:"):
                f = self.voices.out_path(str(saved_id)[5:])
                if not f:
                    raise web.HTTPBadRequest(text="Этого варианта больше нет: он удалён")
                raws[key] = f.read_bytes()
                return await self.voice_upload(raws[key], f.suffix)
            if saved_id:
                f = self.voices.path(str(saved_id))
                if not f:
                    raise web.HTTPBadRequest(text="Этого сохранённого голоса больше нет")
                raws[key] = f.read_bytes()
                return await self.voice_upload(raws[key], f.suffix)
            if key in files:
                if files[key][0] not in AUD_EXT:
                    raise web.HTTPBadRequest(text="Нужен звуковой файл (mp3, wav, flac, m4a, ogg)")
                raws[key] = files[key][1]
                return await self.voice_upload(raws[key], files[key][0])
            return ""

        async def words_of(key, typed):
            """Что сказано в образце: вписанные слова или наше распознавание речи.

            Сама нода за этим качает отдельный Whisper - минуты ожидания и лишняя папка; у программы
            модель распознавания уже есть (раздел «Сценарист»), поэтому спрашиваем её.
            """
            typed = str(typed or "").strip()[:1000]
            if typed or key not in raws:
                return typed
            await self.llm_variant()
            if not self.speech_status()["ready"]:
                raise web.HTTPBadRequest(text="Программа не может сама понять слова в образце: модель распознавания "
                                              "речи ещё не скачана (карточка «Модель» в разделе «Сценарист»). "
                                              "Впишите, что сказано в образце, вручную.")
            try:
                words, _, _ = await speech.transcribe(self.llm.root, raws[key], "auto", self.config.get("whisper_dir"))
            except Exception as e:                                    # noqa: BLE001 - ответ человек читает как есть
                raise web.HTTPBadRequest(text="Не удалось распознать слова в образце (" + str(e)[:200] + "). Впишите их вручную.")
            if not words:
                raise web.HTTPBadRequest(text="В образце не слышно слов. Возьмите запись с чистой речью или впишите слова вручную.")
            return words[:1000]

        try:
            if mode == "design":
                graph = design_graph(model, text, p)
            elif mode == "clone":
                ref = await sample("ref", p.get("ref_saved"))
                if not ref:
                    return _err("Выберите образец голоса: загрузите файл или возьмите сохранённый голос")
                graph = clone_graph(model, text, p, ref, await words_of("ref", p.get("ref_text")))
            elif mode == "vc":
                src = await sample("src", p.get("src_saved"))
                if not src:
                    return _err("Загрузите свою запись: то, что вы наговорили с нужной интонацией")
                ref = await sample("ref", p.get("ref_saved"))
                if not ref:
                    return _err("Выберите, чьим голосом сказать: загрузите образец или возьмите сохранённый голос")
                graph = convert_graph(vc_info, src, ref, p)
            elif mode == "dialog":
                speakers = []
                for i, sp in enumerate((p.get("speakers") or [])[:MAX_SPEAKERS], 1):
                    nm = await sample(f"sp{i}", sp.get("saved"))
                    if not nm:
                        return _err(f"Для голоса {i} выберите образец: файл или сохранённый голос")
                    speakers.append((nm, await words_of(f"sp{i}", sp.get("ref_text"))))
                if len(speakers) < 2:
                    return _err("В диалоге нужно минимум два голоса")
                graph = dialog_graph(model, dialog_text(text, len(speakers)), p, speakers)
            else:
                return _err("Неизвестный режим")
        except web.HTTPException as e:
            return _err(e.text or "Ошибка", e.status)
        await self.stop_llm()      # модель сценариста не должна делить с голосом видеопамять
        status, res = await self.comfy_json("POST", "/prompt", json={"prompt": graph, "client_id": CLIENT_ID})
        if status != 200:
            return _err(comfy_error_text(res))
        pid = res["prompt_id"]
        self.voice_pid, self.voice_stop = pid, False
        loop = asyncio.get_running_loop()
        end = loop.time() + WAIT_SEC
        try:
            while loop.time() < end:
                await asyncio.sleep(1.5)
                if self.voice_stop:
                    return _err("Остановлено", 499)
                _, hist = await self.comfy_json("GET", f"/history/{pid}")
                entry = (hist or {}).get(pid)
                if not entry:
                    continue
                st = entry.get("status", {})
                if st.get("status_str") == "error":
                    msgs = [m[1].get("exception_message", "") for m in st.get("messages", []) if m[0] == "execution_error"]
                    m0 = (msgs[0].strip() if msgs else "ошибка ComfyUI")
                    if "nterrupt" in m0:
                        return _err("Остановлено", 499)
                    if re.search(r"requires .accelerate|No module named|pyaudioop", m0):
                        # не хватает служебной библиотеки: доучить её и попросить перезапустить движок
                        py = self.voice_python(self.voice_nodes_dir())
                        root = self.comfy_root() if self.config.get("engine") == "managed" else None
                        if py and await self.voice_pip_fix(py, root):
                            return web.json_response({"error": "Голосу не хватало служебной библиотеки, программа "
                                       "её доучила. Перезапустите ComfyUI и повторите озвучку.", "fixed": True}, status=500)
                    return _err("Не удалось сделать голос: " + m0[:600], 500)
                audio = next((f for out in entry.get("outputs", {}).values() for f in out.get("audio", [])), None)
                if audio:
                    async with self.session.get(self.comfy + "/view", params={
                            "filename": audio["filename"], "subfolder": audio.get("subfolder", ""),
                            "type": audio.get("type", "output")}) as r:
                        data = await r.read()
                    meta = {"mode": mode, "text": text[:4000], "model": model,
                            "seed": settings(p)["seed"], "params": {k: v for k, v in p.items() if k != "text"}}
                    return web.json_response(self.voices.add_take(data, Path(audio["filename"]).suffix.lower() or ".mp3", meta))
        finally:
            self.voice_pid = None
        return _err("ComfyUI не успел сделать голос (40 минут). Попробуйте ещё раз или возьмите текст короче.", 504)

    # ---------- сохранённые голоса ----------

    async def h_voice_saved_list(self, _req):
        return web.json_response([self.voices.public(x) for x in reversed(self.voices.items)])

    async def h_voice_saved_file(self, req):
        f = self.voices.path(req.match_info["id"])
        if not f:
            raise web.HTTPNotFound()
        return web.FileResponse(f)

    async def h_voice_saved_save(self, req):
        """Название голоса и либо результат раздела ('out'), либо загруженный образец ('file')."""
        name, note, out, data, ext = "", "", "", None, ".mp3"
        try:
            async for field in await req.multipart():
                if field.name == "name":
                    name = (await field.read()).decode("utf-8").strip()
                elif field.name == "note":
                    note = (await field.read()).decode("utf-8").strip()
                elif field.name == "out":
                    out = (await field.read()).decode("utf-8").strip()
                elif field.name == "file" and field.filename:
                    ext = Path(field.filename).suffix.lower()
                    data = bytes(await field.read())
        except (ValueError, UnicodeDecodeError):
            return _err("Не удалось прочитать данные")
        name = name.replace("@", "")[:60]
        if not name:
            return _err("Напишите название голоса")
        if out:
            f = self.voices.out_path(out)
            if not f:
                return _err("Этот результат уже удалён: сделайте озвучку заново")
            data, ext = f.read_bytes(), f.suffix.lower()
        if not data:
            return _err("Нет звука: загрузите файл или сначала сделайте озвучку")
        if ext not in AUD_EXT:
            return _err("Нужен звуковой файл (mp3, wav, flac, m4a, ogg)")
        if len(data) > MAX_UPLOAD:
            return _err("Файл слишком большой (до 60 МБ)")
        self.voices.ready()
        # имя голоса остаётся только подписью: адрес в URL держим на латинице и цифрах
        vid = uuid.uuid4().hex[:10]
        (self.voices.vdir / f"{vid}{ext}").write_bytes(data)
        self.voices.items.append({"id": vid, "name": name, "note": note[:300], "file": f"{vid}{ext}",
                                 "date": datetime.now().isoformat(timespec="seconds")})
        self.voices.save()
        return web.json_response(self.voices.public(self.voices.items[-1]))

    async def h_voice_saved_delete(self, req):
        it = self.voices.get(req.match_info["id"])
        if not it:
            raise web.HTTPNotFound()
        (self.voices.vdir / it["file"]).unlink(missing_ok=True)
        self.voices.items = [x for x in self.voices.items if x["id"] != it["id"]]
        self.voices.save()
        return web.json_response({"ok": True})

    # ---------- варианты озвучки ----------

    async def h_voice_takes(self, _req):
        return web.json_response(self.voices.live_takes())

    async def h_voice_out(self, req):
        f = self.voices.out_path(req.match_info["name"])
        if not f:
            raise web.HTTPNotFound()
        return web.FileResponse(f, headers={"Cache-Control": "no-store"})

    async def h_voice_take_star(self, req):
        it = self.voices.take(req.match_info["id"])
        if not it:
            raise web.HTTPNotFound()
        it["star"] = not it.get("star")
        self.voices.save_takes()
        return web.json_response({"star": it["star"]})

    async def h_voice_take_rename(self, req):
        it = self.voices.take(req.match_info["id"])
        if not it:
            raise web.HTTPNotFound()
        try:
            name = str((await req.json()).get("name") or "").strip()[:60]
        except (ValueError, UnicodeDecodeError):
            name = ""
        if name:
            it["name"] = name
            self.voices.save_takes()
        return web.json_response({"name": it["name"]})

    async def h_voice_take_delete(self, req):
        it = self.voices.take(req.match_info["id"])
        if not it:
            raise web.HTTPNotFound()
        (self.voices.odir / it["id"]).unlink(missing_ok=True)
        self.voices.takes["items"] = [x for x in self.voices.takes["items"] if x is not it]
        self.voices.save_takes()
        return web.json_response({"ok": True})

    async def h_voice_takes_clear(self, _req):
        """Убрать немеченые варианты: помеченные человеком всегда остаются."""
        gone = [x for x in self.voices.takes["items"] if not x.get("star")]
        for it in gone:
            (self.voices.odir / it["id"]).unlink(missing_ok=True)
        self.voices.takes["items"] = [x for x in self.voices.takes["items"] if x.get("star")]
        self.voices.save_takes()
        return web.json_response({"removed": len(gone)})
