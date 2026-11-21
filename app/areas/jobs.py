"""Задание и его очередь: как расчёт попадает в ComfyUI или в
    облако, как очередь переживает закрытие программы, как приходит прогресс и как задание
    завершается - копия файла в папку результатов, метка внутри файла, копии картинок. Прерывание
    задания тоже здесь. Методы перенесены из app/server.py без правок."""

from aiohttp import web
from datetime import datetime
from graphrefs import _graph_refs
from netutil import comfy_error_text
from pathlib import Path
from paths import CLIENT_ID, DATA_DIR, LONG_DIR, QUEUE_FILE, REF_DIR, TIMINGS
import asyncio
import catalog
import cloud
import forecast
import json
import mp4info
import re
import struct
import subprocess
import time
import uuid


# ComfyUI binary websocket event types
BIN_PREVIEW = 1


BIN_PREVIEW_META = 4


class QueueMixin:
    """Методы области «jobs»."""

    async def on_comfy_binary(self, data):
        if len(data) < 8:
            return
        kind = struct.unpack(">I", data[:4])[0]
        if kind == BIN_PREVIEW:
            image = data[8:]
        elif kind == BIN_PREVIEW_META:
            meta_len = struct.unpack(">I", data[4:8])[0]
            meta = json.loads(data[8:8 + meta_len])
            if meta.get("prompt_id") not in self.jobs:
                return
            image = data[8 + meta_len:]
        else:
            return
        if not any(j["state"] == "running" for j in self.jobs.values()):
            return
        for b in list(self.browsers):
            try:
                await b.send_bytes(image)
            except Exception:
                self.browsers.discard(b)

    async def on_comfy_event(self, msg):
        t, d = msg.get("type"), msg.get("data") or {}
        if t == "kj_preview_override":   # animated live preview of KJNodes (no prompt id in it: it belongs to the running job)
            run = next((j for j in self.jobs.values() if j["state"] == "running"), None)
            if run and d.get("image"):
                await self.broadcast({"type": "preview_anim", "prompt_id": run["prompt_id"], "image": d["image"],
                                      "mime": d.get("mime") or "image/jpeg", "step": d.get("step"), "total": d.get("total")})
            return
        job = self.jobs.get(d.get("prompt_id"))
        if not job:
            return
        pid = job["prompt_id"]
        if t == "execution_start":
            job["state"] = "running"
            await self.send_stage(job, "load")
        elif t == "executing" and d.get("node"):
            stage = job["stages"].get(d["node"])
            if stage:
                await self.send_stage(job, stage, node=d["node"])
        elif t == "progress":
            stage = job["stages"].get(str(d.get("node")), job.get("stage"))
            if stage in ("sample", "sample2"):
                await self.send_stage(job, stage, d.get("value"), d.get("max"), node=str(d.get("node")))
        elif t == "execution_success":
            await self.finish_job(job)
        elif t == "execution_error":
            job["state"] = "error"
            em = str(d.get("exception_message") or "")
            # нехватка памяти, зафиксированная при известном свободном месте, - единственное
            # основание отказать в следующий раз: своих выдуманных нормативов у нас нет
            if job.get("free0") is not None and any(k in em.lower() for k in
                                                    ("out of memory", "oom", "not enough memory", "allocated", "exceeds")):
                try:
                    forecast.record(TIMINGS, (job.get("meta") or {}).get("mode", ""), 0, ok=False,
                                    free=job.get("free0"), reason=em[:120])
                except Exception:
                    pass
            self.note_error(f'Ошибка генерации, узел {d.get("node_type", "")}: {d.get("exception_message", "").strip()}')
            hint = self.model_hint((job.get("meta") or {}).get("mode", ""), d.get("exception_message", ""))
            await self.broadcast({"type": "error", "prompt_id": pid,
                                  "message": f'{d.get("node_type", "")}: {d.get("exception_message", "").strip()}' + hint})
            self.jobs.pop(pid, None)
        elif t == "execution_interrupted":
            await self.broadcast({"type": "interrupted", "prompt_id": pid})
            self.jobs.pop(pid, None)

    async def send_stage(self, job, stage, step=None, total=None, node=None):
        job["stage"] = stage
        msg = {"type": "stage", "prompt_id": job["prompt_id"], "stage": stage, "step": step, "max": total,
               "eta": job.get("eta") or 0}   # «примерно столько это обычно идёт»
        sc = job.get("scenes")
        if sc and node is not None and str(node) in sc.get("map", {}):
            job["scene_now"] = sc["map"][str(node)] + 1
        if sc and job.get("scene_now"):
            msg.update(scene=job["scene_now"], scenes=sc["n"])
        await self.broadcast(msg)

    async def finish_job(self, job):
        pid = job["prompt_id"]
        self.jobs.pop(pid, None)
        # ComfyUI writes the history a moment after the job ends; asking once made a finished render look like
        # "returned nothing", so a clip that took twenty minutes was reported lost while the file sat on disk
        hist = {}
        for _wait in range(5):
            try:
                _, hist = await self.comfy_json("GET", f"/history/{pid}")
            except Exception:
                hist = {}
            if (hist or {}).get(pid):
                break
            await asyncio.sleep(1.2)
        outputs = (hist or {}).get(pid, {}).get("outputs", {})
        tagged = [(nid, f) for nid, out in outputs.items() for lst in out.values() if isinstance(lst, list)
                  for f in lst if isinstance(f, dict) and "filename" in f]
        files = [f for _, f in tagged]
        node_of = {id(f): nid for nid, f in tagged}
        videos = [f for f in files if f["filename"].lower().endswith((".mp4", ".webm", ".mkv", ".mov"))]
        videos = [f for f in videos if f.get("type", "output") == "output"] or videos  # not the previews of loaded clips
        lg = (job.get("meta") or {}).get("long")
        if lg and not lg.get("test"):  # a scene of the long video: keep the tail of its latent for the next scene (not for a size test)
            lat = next((f for f in files if f["filename"].lower().endswith(".latent")), None)
            if lat and videos:
                try:
                    async with self.session.get(self.comfy + "/view", params={
                            "filename": lat["filename"], "subfolder": lat.get("subfolder", ""), "type": lat.get("type", "output")}) as r:
                        body = await r.read()
                    if r.status == 200 and body:
                        d = LONG_DIR / lg["run"]
                        d.mkdir(parents=True, exist_ok=True)
                        sfx = "_d" if lg.get("draft") else ""
                        (d / f"state_{lg['part']}{sfx}.latent").write_bytes(body)
                        (d / f"state_{lg['part']}{sfx}.json").write_text(
                            json.dumps({"res": (job.get("meta") or {}).get("res", "")}, ensure_ascii=False), encoding="utf-8")
                except Exception as e:
                    self.note_error(f"Не удалось сохранить состояние сцены: {e}")
        images = [f for f in files if f["filename"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
                  and f.get("type", "output") == "output"]
        if not videos and not images:
            self.note_error("ComfyUI закончил работу, но не вернул ни видео, ни изображение")
            await self.broadcast({"type": "error", "prompt_id": pid, "message": "ComfyUI не вернул ни видео, ни изображение"})
            return
        if videos:
            picked = [videos[-1] if job.get("last_output") else videos[0]]
        else:  # a workflow that makes pictures: every saved picture goes to the library
            picked = images[:12]
            def order(f):  # the glued sheet first, then the frames 1, 2, 3...
                t = str((job.get("titles") or {}).get(node_of.get(id(f)), ""))
                return (0 if t.startswith("Лист") else 1, t)
            picked.sort(key=order)
        items = []
        for f in picked:
            item = dict(job["meta"], id=uuid.uuid4().hex[:12], prompt_id=pid,
                        date=datetime.now().isoformat(timespec="seconds"), fav=False, file=f,
                        ext=Path(f["filename"]).suffix.lstrip(".").lower() or "mp4")
            if not videos:
                item["kind"] = "image"
                title = (job.get("titles") or {}).get(node_of.get(id(f)), "")  # "Результат: апскейл (после…)" -> "апскейл"
                label = re.split(r"\s*[(\[]", title.split(":")[-1].strip())[0].strip()[:24]
                if label:
                    item["label"] = label
            meta = f.get("metadata") or {}
            if meta.get("width") and meta.get("height") and not (item.get("mode") == "upscale" and item.get("res")):
                item["res"] = f'{meta["width"]}×{meta["height"]}'
            item["refs"] = await self.stash_refs(item, _graph_refs(job.get("graph")))
            self.library.add(item)
            await self.archive_item(item)
            await self.stamp(item)      # клип должен помнить промпт и сид, пока он сам на диске
            items.append(self.public(item))
        self.remember(job)
        await self.broadcast({"type": "done", "prompt_id": pid, "item": items[0], "items": items})

    def remember(self, job):
        """Сколько шло задание, без ожидания в очереди: очередь зависит от соседних работ,
        и в прогнозе ей не место."""
        try:
            t0 = job.get("t0")
            took = time.time() - t0 if t0 else 0
            if took and 2 < took < 24 * 3600:
                m = job.get("meta") or {}
                forecast.record(TIMINGS, m.get("mode", ""), took, quality=str(m.get("q") or ""),
                                sec=m.get("len") or 0, res=str(m.get("res") or ""))
        except Exception as e:
            self.note_error(f"Не удалось запомнить время работы: {e}")

    def tag_text(self, item):
        """Строка, которая вписывается в сам файл: режим, сид, размер и промпт. Читается и нами,
        и любой программой, которая показывает метаданные видео."""
        prompt = re.sub(r"\s+", " ", str(item.get("prompt") or ""))[:900]
        return "KADR1 " + json.dumps({"v": 1, "mode": item.get("mode"), "seed": item.get("seed"),
                                      "res": item.get("res"), "sec": item.get("len"),
                                      "q": item.get("q"), "prompt": prompt}, ensure_ascii=False)

    async def stamp(self, item):
        """Вписать строку в готовый файл, ничего не пережимая. Не получилось - файл остаётся
        как есть: копия происхождения стоит куда меньше испорченного клипа.

        Пишем только в свою копию в папке результатов: чужой вывод ComfyUI не трогаем."""
        try:
            path = item.get("local")
            if not path or not str(path).lower().endswith((".mp4", ".mov", ".m4v")):
                return False
            ff = self._ffmpeg()
            if not ff or not Path(path).exists():
                return False
            if str(mp4info.tag_of(Path(path)).get("comment") or "").startswith("KADR1"):
                return True
            tmp = Path(str(path) + ".tmp.mp4")
            proc = await asyncio.to_thread(
                subprocess.run,
                [str(ff), "-y", "-i", str(path), "-c", "copy", "-movflags", "+faststart",
                 "-metadata", "comment=" + self.tag_text(item), str(tmp)],
                capture_output=True, timeout=240)
            if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1024:
                tmp.unlink(missing_ok=True)
                return False
            tmp.replace(path)
            return True
        except Exception as e:
            self.note_error(f"Не удалось вписать в файл, как он сделан: {e}")
            return False

    async def stash_refs(self, item, refs):
        """Keep a copy of the files a result was made from, so "repeat with these settings" can put
        them back. One folder per calculation: repeating a scene of one project does not multiply copies.
        Nothing is promised when ComfyUI is silent - an empty answer simply means the old behaviour."""
        refs = [r for r in (refs or []) if isinstance(r, dict) and isinstance(r.get("name"), str)]
        if not refs or not self.keep_copies() or not item.get("prompt_id"):
            return []
        key = re.sub(r"[^A-Za-z0-9]", "", str(item["prompt_id"]))[:40]
        if not key:
            return []
        d = REF_DIR / key
        item["ref_group"] = key          # the address the interface reads the kept pictures from
        saved = []
        for i, ref in enumerate(refs):
            name, kind = ref["name"], ref.get("kind") or "image"
            # the name is often "h3studio/h3s_ab12cd34.png": ComfyUI wants the folder separately,
            # and answering with an empty file list when it is not split was exactly the old mistake
            folder, _, base = name.rpartition("/")
            dest = d / f"{i}_{kind}_{base}"
            if dest.is_file() and dest.stat().st_size:
                saved.append(dest.name)
                continue
            data = None
            try:   # the file usually lies next to us: reading it from the disk works even when ComfyUI is asleep
                src = self.comfy_root() / "ComfyUI" / "input" / folder / (base or name)
                if src.is_file() and src.stat().st_size <= 60 * 1024 * 1024:
                    data = src.read_bytes()
            except (OSError, TypeError, ValueError):
                data = None
            if data is None:
                try:
                    async with self.session.get(self.comfy + "/view", params={"filename": base or name, "subfolder": folder, "type": "input"}) as r:
                        if r.status != 200:
                            continue
                        data = await r.content.read(60 * 1024 * 1024)   # a picture or a short clip, not a disk
                except Exception:
                    continue
            if not data:
                continue
            try:
                d.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                saved.append(dest.name)
            except OSError:
                pass
            await asyncio.sleep(0)
        return saved

    def model_hint(self, mode, text):
        """After a ComfyUI error that smells like a wrong model file: say which models of this mode to check."""
        if not re.search(r"shape|size|conv|dtype|mat1|mat2|cannot be|expected|mismatch|tensor|dimension|state_dict|missing key|unexpected key|invalid", text or "", re.I):
            return ""
        roles = catalog.MODE_ROLES.get(mode, [])
        if not roles or not self.model_names:
            return ""
        picked = self.config.get("model_pick") or {}
        sus = [r for r in roles if r in self.model_names and (r in picked or not catalog.looks_right(r, self.model_names[r]))]
        bad = [r for r in sus if not catalog.looks_right(r, self.model_names[r])]
        lines = ["", "Подсказка: похоже, одна из моделей этого раздела не подходит (ошибка про размеры или формат данных)."]
        for r in bad:
            lines.append(f"• «{catalog.ROLE_TITLES.get(r, r)}»: сейчас стоит {self.model_names[r].replace('/', chr(92)).split(chr(92))[-1]}, "
                         f"а в названии нужного файла есть {catalog.marks_text(r)}.")
        for r in sus:
            if r not in bad:
                lines.append(f"• «{catalog.ROLE_TITLES.get(r, r)}»: вы выбирали файл вручную, это "
                             f"{self.model_names[r].replace('/', chr(92)).split(chr(92))[-1]}. Проверьте его.")
        lines.append("Откройте «Настройки» и для нужной строки нажмите «Заменить…», выберите файл «как по умолчанию» или тот, "
                     "что указан в подсказке строки. Если непонятно, нажмите «Отчёт для разработчика» и пришлите файл.")
        return "\n".join(lines)

    def load_queue(self):
        try:
            data = json.loads(QUEUE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        week = datetime.now().timestamp() - 7 * 86400
        return [j for j in data if isinstance(j, dict) and j.get("graph") and j.get("saved", 0) > week]

    def save_queue(self):
        items = list(self.saved_queue) + [
            {"graph": j["graph"], "stages": j.get("stages") or {}, "meta": j.get("meta") or {}, "last_output": j.get("last_output", False),
             "titles": j.get("titles") or {}, "pid": j.get("prompt_id"), "saved": datetime.now().timestamp()}
            for j in dict.values(self.jobs) if j.get("graph")]
        try:
            if items:
                QUEUE_FILE.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
            elif QUEUE_FILE.exists():
                QUEUE_FILE.unlink()
        except OSError:
            pass

    async def h_queue_saved(self, _req):
        return web.json_response({"count": len(self.saved_queue),
                                  "items": [{"mode": j["meta"].get("mode"), "prompt": (j["meta"].get("prompt") or "")[:80]} for j in self.saved_queue]})

    async def h_queue_resume(self, _req):
        items, self.saved_queue = list(self.saved_queue), []
        self.save_queue()
        out = []
        try:  # a job that ComfyUI still has (or already finished) while only the program was closed is not run twice
            _, q = await self.comfy_json("GET", "/queue")
            alive = {str(x[1]) for key in ("queue_running", "queue_pending") for x in (q or {}).get(key, []) if len(x) > 1}
        except Exception:
            alive = set()
        for j in items:
            if j.get("pid") and (j["pid"] in alive):
                continue
            resp = await self.queue(j["graph"], j.get("stages") or {}, j.get("meta") or {}, j.get("last_output", False), j.get("titles"))
            pid = json.loads(resp.text)["prompt_id"]
            out.append({"prompt_id": pid, "mode": j["meta"].get("mode"), "prompt": j["meta"].get("prompt", "")})
        return web.json_response({"jobs": out})

    async def h_queue_discard(self, _req):
        self.saved_queue = []
        self.save_queue()
        return web.json_response({"ok": True})

    async def queue_cloud(self, rh, graph, stages, meta):
        if not self.config.get("rh_workflow_id"):
            return web.json_response({"error": "Укажите ID любого вашего workflow на RunningHub (раздел «Настройки» → «Облако»)"},
                                     status=400)
        if getattr(self, "rh_models", None) is None:
            try:
                self.rh_models = await rh.model_names(self.config.get("rh_workflow_id"))
            except cloud.CloudError:
                self.rh_models = set()
        cloud.remap_models(graph, self.rh_models)
        try:
            task = await rh.create(graph, self.config.get("rh_workflow_id"), self.config.get("rh_instance", "default"))
        except cloud.CloudError as e:
            return web.json_response({"error": str(e)}, status=400)
        pid = "rh-" + task
        self.jobs[pid] = {"prompt_id": pid, "state": "queued", "stages": {}, "stage": None,
                          "meta": dict(meta, cloud=True), "task": task}
        asyncio.create_task(self.poll_cloud(rh, pid))
        return web.json_response({"prompt_id": pid, "seed": meta["seed"]})

    async def poll_cloud(self, rh, pid):
        job = self.jobs.get(pid)
        last = None
        try:
            while pid in self.jobs:
                status = await rh.status(job["task"])
                if status != last:
                    last = status
                    stage = {"QUEUED": "cloud_queued", "RUNNING": "cloud_run"}.get(status)
                    if stage:
                        await self.send_stage(job, stage)
                if status == "SUCCESS":
                    outs = await rh.outputs(job["task"]) or []
                    video = next((o for o in outs if str(o.get("fileType", "")).lower() in ("mp4", "webm", "mov", "mkv")
                                  or str(o.get("fileUrl", "")).lower().split("?")[0].endswith((".mp4", ".webm", ".mov"))), None)
                    if not video:
                        raise cloud.CloudError("RunningHub не вернул видео")
                    dest = DATA_DIR / "cloud" / f'{pid}.mp4'
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    async with self.session.get(video["fileUrl"]) as r:
                        dest.write_bytes(await r.read())
                    self.jobs.pop(pid, None)
                    item = dict(job["meta"], id=uuid.uuid4().hex[:12], prompt_id=pid,
                                date=datetime.now().isoformat(timespec="seconds"), fav=False,
                                file={"type": "local", "path": str(dest), "filename": dest.name})
                    if video.get("consumeCoins"):
                        item["sub"] = f'{item.get("sub", "")} · ☁ {video["consumeCoins"]} RH'.strip(" ·")
                    self.library.add(item)
                    await self.stamp(dict(item, local=str(dest)))
                    self.remember(job)
                    await self.broadcast({"type": "done", "prompt_id": pid, "item": self.public(item)})
                    return
                if status == "FAILED":
                    await rh.outputs(job["task"])  # raises with the failure reason
                    raise cloud.CloudError("Задание на RunningHub завершилось ошибкой")
                await asyncio.sleep(5)
        except Exception as e:
            if pid in self.jobs:
                self.jobs.pop(pid, None)
                await self.broadcast({"type": "error", "prompt_id": pid, "message": str(e)})

    async def queue(self, graph, stages, meta, last_output=False, titles=None):
        scenes = stages.pop("__scenes__", None)   # which sampler is which scene (long video), for the progress text
        rh = self.rh()
        if rh:
            return await self.queue_cloud(rh, graph, stages, meta)
        await self.stop_llm()  # the agent's model and H3 do not fit in VRAM together
        mode_key = (meta or {}).get("mode", "")
        same = mode_key == getattr(self, "last_mode", None) and mode_key in ("krea", "kreareal", "qwen", "flux")
        self.last_mode = mode_key
        # nothing is running or waiting: drop the previous job's models and cache so each job starts clean.
        # Not between pictures of the same mode: the same big models would just be loaded from disk again.
        if not self.jobs and not same:
            try:
                await self.comfy_json("POST", "/free", json={"unload_models": True, "free_memory": True})
                await asyncio.sleep(1.5)
                gpu = await asyncio.to_thread(self.monitor.gpu)
                used = (gpu or {}).get("vram_used_gb")
                if used is not None and used > 2.5:  # right after /free ComfyUI itself holds well under this
                    await self.broadcast({"type": "notice", "text": (
                        f"Перед заданием занято {used:g} ГБ видеопамяти. Скорее всего, её держат другие программы "
                        "(браузер, Adobe, игры). Закройте их, иначе генерация может идти медленнее.")})
            except Exception:
                pass
        # Сколько видеопамяти свободно прямо сейчас и сколько такая работа обычно идёт на этой
        # машине. Первое нужно, чтобы не начинать то, что уже падало: программа помнит свои падения.
        # Второе - чтобы сказать «примерно 4 минуты» по делу, а не по инструкции.
        free0, m = None, meta or {}
        try:
            g = await asyncio.to_thread(self.monitor.gpu)
            if g and g.get("vram_total_gb") is not None:
                free0 = round(g["vram_total_gb"] - (g.get("vram_used_gb") or 0), 2)
        except Exception:
            pass
        stop = forecast.gate(TIMINGS, mode_key, free0)
        if stop and time.time() > getattr(self, "_gate_off", 0):   # «рискнуть» снимает запрет на три минуты
            return web.json_response({
                "low_memory": True,
                "error": (f"Свободно {stop['have']:g} ГБ видеопамяти, а этот режим уже прерывался на нехватке памяти, "
                          f"когда свободно было {stop['need']:g} ГБ. Закройте программы, которые держат память "
                          "(браузер с видео, Adobe, игры), или освободите память в разделе «Агент» и начните снова."),
                "have": stop["have"], "need": stop["need"]}, status=409)
        eta = forecast.estimate(TIMINGS, mode_key, quality=str(m.get("q") or ""),
                                sec=m.get("len") or 0, res=str(m.get("res") or ""))
        status, res = await self.comfy_json("POST", "/prompt", json={
            "prompt": graph, "client_id": CLIENT_ID,
            "extra_data": {"preview_method": "auto"}})
        if status != 200:
            return web.json_response({"error": comfy_error_text(res)}, status=400)
        pid = res["prompt_id"]
        self.jobs[pid] = {"prompt_id": pid, "state": "queued", "stages": stages, "stage": None, "meta": meta, "last_output": last_output, "titles": titles or {},
                          "graph": graph, "scenes": scenes,
                          "t0": time.time(), "free0": free0, "eta": (eta or {}).get("secs", 0)}
        return web.json_response({"prompt_id": pid, "seed": meta["seed"], "queue_number": res.get("number"),
                                  "eta": (eta or {}).get("secs", 0), "eta_samples": (eta or {}).get("samples", 0)})

    async def h_interrupt(self, req):
        pid = (await req.json()).get("prompt_id")
        job = self.jobs.get(pid)
        if job and job.get("task"):  # cloud task
            self.jobs.pop(pid, None)
            rh = self.rh()
            if rh:
                try:
                    await rh.cancel(job["task"])
                except cloud.CloudError:
                    pass
            await self.broadcast({"type": "interrupted", "prompt_id": pid})
        elif job and job["state"] == "queued":
            await self.comfy_json("POST", "/queue", json={"delete": [pid]})
            self.jobs.pop(pid, None)
            await self.broadcast({"type": "interrupted", "prompt_id": pid})
        else:
            await self.comfy_json("POST", "/interrupt", json={"prompt_id": pid})
            task = asyncio.create_task(self.interrupt_watch(pid))
            self._bg.add(task)
            task.add_done_callback(self._bg.discard)
        return web.json_response({"ok": True})

    async def interrupt_watch(self, pid, wait=15):
        """ComfyUI sometimes ignores «Cancel» (stuck on a heavy step). If the job is still there after `wait` seconds:
        managed engine - restart it; the user's own ComfyUI - only tell the user."""
        await asyncio.sleep(wait)
        if pid not in self.jobs:
            return
        if not self.process:
            text = ("ComfyUI не отвечает на «Отмена» уже больше 15 секунд. Это ваш собственный ComfyUI: "
                    "закройте его окно и запустите заново.")
            self.note_error(text)
            await self.broadcast({"type": "notice", "text": text})
            return
        text = "ComfyUI не отвечает на «Отмена». Перезапускаем движок, это займёт около минуты."
        self.note_error(text)
        await self.broadcast({"type": "notice", "text": text})
        try:
            await asyncio.to_thread(self.process.stop)
            await asyncio.to_thread(self.process.start)
            await self.wait_comfy()
        except Exception as e:
            self.note_error(f"Не удалось перезапустить движок после отмены: {e}")
        # the restarted engine has an empty queue: nothing of what was running or waiting is there any more
        for jid in [j for j, job in self.jobs.items() if not job.get("task")]:
            self.jobs.pop(jid, None)
            await self.broadcast({"type": "interrupted", "prompt_id": jid})
