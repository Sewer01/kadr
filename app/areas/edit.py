"""Правка готового ролика: склейка полосы, зерно, плавность,
    обрезка куска и последний кадр. Всё это работает с файлом, который уже есть. Методы перенесены
    из app/server.py без правок."""

from aiohttp import web
from applog import applog
from datetime import datetime
from limits import MAX_REF_VIDEO
from pathlib import Path
import aiohttp
import asyncio
import engine
import json
import mp4info
import os
import random
import re
import shutil
import subprocess
import time
import urllib.parse
import uuid
import workflows as wf


class EditMixin:
    """Методы области «edit»."""

    async def h_video_cut(self, request):
        """POST a clip, get back the piece between start and end from the query string. Re-encoded on
        purpose: cutting on keyframes alone would leave a grey second or a frozen picture exactly where
        the person wanted the clip to begin, and a reference video is judged from its first frame."""
        ff = self._ffmpeg()
        if not ff:
            return web.json_response({"error": "декодер не найден: режьте видео в любой программе"}, status=404)
        data = await request.read()
        if not data:
            return web.json_response({"error": "пустой файл"}, status=400)
        if len(data) > 300 * 1024 * 1024:
            return web.json_response({"error": "файл больше 300 МБ"}, status=413)
        try:
            start = max(0.0, float(request.query.get("start") or 0))
            end = float(request.query.get("end") or 0)
        except ValueError:
            return web.json_response({"error": "не разобраны границы куска"}, status=400)
        if end - start < 0.5:
            return web.json_response({"error": "кусок короче полсекунды: модель его всё равно не разберёт"}, status=400)
        if end - start > MAX_REF_VIDEO + 1:
            return web.json_response({"error": "референс-видео не длиннее %d секунд" % MAX_REF_VIDEO}, status=400)
        name = urllib.parse.unquote(request.query.get("name") or "video.mp4")
        suffix = Path(name).suffix.lower()
        if suffix not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts", ".ts", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"):
            suffix = ".mp4"
        work = Path(os.environ.get("TEMP", ".")) / ("h3cut-" + uuid.uuid4().hex)
        work.mkdir(parents=True, exist_ok=True)
        src, out = work / ("in" + suffix), work / "cut.mp4"
        try:
            src.write_bytes(data)
            cmd = [str(ff), "-hide_banner", "-loglevel", "error", "-y",
                   "-ss", "%.3f" % start, "-to", "%.3f" % end, "-i", str(src),
                   "-map", "0:v:0", "-map", "0:a:0?",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-ac", "2", "-movflags", "+faststart", str(out)]
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL,
                                                        stderr=asyncio.subprocess.PIPE)
            try:
                _, err = await asyncio.wait_for(proc.communicate(), timeout=300)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except Exception:
                    pass
                return web.json_response({"error": "декодер не успел за 5 минут"}, status=500)
            if proc.returncode or not out.is_file() or out.stat().st_size < 1024:
                return web.json_response({"error": "не удалось разрезать: " +
                                          (err or b"").decode(errors="replace")[-300:]}, status=500)
            resp = web.FileResponse(out, headers={"Content-Disposition": 'attachment; filename="cut.mp4"',
                                                  "Cache-Control": "no-store"})
            # the file must survive until it is sent, so the working folder goes a minute later
            asyncio.get_event_loop().call_later(60, shutil.rmtree, work, True)
            return resp
        except Exception as e:                                  # a broken phone video must not kill the app
            shutil.rmtree(work, ignore_errors=True)
            return web.json_response({"error": "сбой разреза: %s" % e}, status=500)

    async def h_video_lastframe(self, request):
        """POST a video file, get back its last frame as a PNG. The name comes in the query string."""
        ff = self._ffmpeg()
        if not ff:
            return web.json_response({"error": "декодер не найден"}, status=404)
        data = await request.read()
        if not data:
            return web.json_response({"error": "пустой файл"}, status=400)
        if len(data) > 300 * 1024 * 1024:
            return web.json_response({"error": "файл больше 300 МБ"}, status=413)
        name = urllib.parse.unquote(request.query.get("name") or "video.mp4")
        suffix = Path(name).suffix.lower()
        if suffix not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts", ".ts", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp"):
            suffix = ".mp4"
        work = Path(os.environ.get("TEMP", ".")) / ("h3frame-" + uuid.uuid4().hex)
        work.mkdir(parents=True, exist_ok=True)
        src, out = work / ("in" + suffix), work / "last.png"
        try:
            src.write_bytes(data)
            base = [str(ff), "-hide_banner", "-loglevel", "error", "-y"]
            # the tail of the file: -sseof counts back from the end, -update writes over one picture
            for extra in (["-sseof", "-1.0", "-i", str(src), "-update", "1", "-frames:v", "1"],
                          [ "-i", str(src), "-update", "1", "-an", "-sn"]):
                try:
                    proc = await asyncio.create_subprocess_exec(*(base + extra + [str(out)]),
                                                                stdout=asyncio.subprocess.DEVNULL,
                                                                stderr=asyncio.subprocess.PIPE)
                    await asyncio.wait_for(proc.communicate(), timeout=120)
                except asyncio.TimeoutError:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                if out.is_file() and out.stat().st_size:
                    return web.Response(body=out.read_bytes(), content_type="image/png",
                                        headers={"Content-Disposition": 'inline; filename="last.png"'})
            return web.json_response({"error": "кадр не читается"}, status=422)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    SMOOTH_FPS = (48, 60)   # частоту человек выбирает кнопкой в окне Библиотеки

    def _smooth_core(self, ff, src, fps):
        """Дорисовка промежуточных кадров готового клипа: движение становится плавнее на
        экране, который показывает 48 или 60 кадров в секунду. Сначала кадры дорисовываются
        по движению - это медленно, но видно глазами; если такой путь не вышел, ролик просто
        начинают показывать чаще, повторяя кадры: плавность меньше, зато выходит всегда.
        Возвращает путь нового файла и то, каким путём он получен."""
        out_dir = self.default_results_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r'[\\/:*?"<>|]', "", src.stem)[:80] or "клип"
        out, k = out_dir / f"{stem}-{fps}.mp4", 1
        while out.exists():   # прежний ролик не затираем: ему добавляется -2, -3...
            k += 1
            out = out_dir / f"{stem}-{fps}-{k}.mp4"

        def encode(vf, secs):
            cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", vf,
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart"]
            last = None
            for tail in (["-c:a", "copy"], ["-an"]):   # звуковой дорожки у клипа может не быть вовсе
                last = subprocess.run([str(x) for x in cmd + tail + [out]], capture_output=True,
                                      text=True, encoding="utf-8", errors="replace", timeout=secs,
                                      creationflags=engine.CREATE_NO_WINDOW)
                if last.returncode == 0 and out.exists() and out.stat().st_size > 2048:
                    return last, True
                out.unlink(missing_ok=True)
            return last, False

        # дорисовка по движению занимает на процессоре примерно втрое больше, чем длится ролик
        r, ok = encode("minterpolate=fps=%d:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" % fps, 2400)
        if ok:
            return {"file": out, "how": "дорисовкой движения"}
        r, ok = encode("fps=%d" % fps, 900)
        if not ok:
            raise web.HTTPBadRequest(text="Плавность не вышла: " +
                                      ((getattr(r, "stderr", "") or "").strip().splitlines() or
                                       ["ffmpeg отказал"])[-1][:180])
        return {"file": out, "how": "повтором кадров"}

    async def h_smooth(self, req):
        """Ролик становится плавнее: промежуточные кадры дорисовываются в НОВЫЙ файл,
        исходник остаётся как был, а в Библиотеке появляется отдельная запись."""
        try:
            body = await req.json()
        except Exception:
            raise web.HTTPBadRequest(text="Не разобран запрос")
        item = self.library.get(str(body.get("id") or ""))
        if not item:
            raise web.HTTPBadRequest(text="Файл не найден")
        if item.get("kind") == "image":
            raise web.HTTPBadRequest(text="Плавность делается для видео: картинку частить нечем")
        path = self.file_path(item)
        if not path or not path.exists():
            raise web.HTTPBadRequest(text="Файл клипа не найден: возможно, папка результатов очищена")
        ff = self._ffmpeg()
        if not ff:
            raise web.HTTPBadRequest(text="Не нашли ffmpeg: он идёт в комплекте с ComfyUI - "
                                          "проверьте, что ComfyUI на месте")
        fps = body.get("fps") if body.get("fps") in self.SMOOTH_FPS else 60
        try:
            got = await asyncio.to_thread(self._smooth_core, ff, path, fps)
        except subprocess.TimeoutExpired:
            raise web.HTTPBadRequest(text="Дорисовка не успела: ролик слишком длинный для одного захода. "
                                          "Возьмите кусок короче")
        out = got["file"]
        new = dict(item)   # запись строится по образцу исходной: те же поля просят список и просмотрщик
        new.update(id=uuid.uuid4().hex[:12], name=f"{path.stem} · {fps} к/с",
                   file={"filename": out.name, "subfolder": "", "type": "local", "path": str(out)},
                   date=datetime.now().isoformat(timespec="seconds"), t=time.time(),
                   kind=item.get("kind") or "video", ext="mp4", fav=False,
                   sub="Плавность: %d кадров в секунду" % fps, smoothed={"fps": fps, "how": got["how"]})
        # адреса исходной записи новой не подходят: с ними новая запись указывала бы на прежний файл
        for k in ("local", "src", "src_file", "ref_group", "refs"):
            new.pop(k, None)
        if isinstance(new.get("size"), int):
            new["size"] = out.stat().st_size
        self.library.add(new)
        applog("плавность: %s - %d кадров в секунду, %s" % (out.name, fps, got["how"]))
        return web.json_response({"ok": True, "id": new["id"], "file": str(out),
                                  "how": got["how"], "fps": fps})

    async def h_montage(self, req):
        """Join library clips in the given order with ComfyUI (no ffmpeg in the app)."""
        form, files = {}, {}
        async for field in await req.multipart():
            if field.name.startswith("file_"):   # a clip taken from the user's computer
                files[field.name[5:]] = (field.filename or "clip.mp4", bytes(await field.read()))
            else:
                form[field.name] = await field.text()
        try:
            ids = [i for i in json.loads(form.get("ids") or "[]") if isinstance(i, str)][:30]
        except ValueError:
            ids = []
        try:
            durs = json.loads(form.get("durs") or "[]")
        except ValueError:
            durs = []
        try:                                   # where the kept piece of every clip starts, seconds
            insv = json.loads(form.get("ins") or "[]")
        except ValueError:
            insv = []
        items = []
        for i in ids:
            if i.startswith("up:"):
                k = i[3:]
                if k not in files:
                    raise web.HTTPBadRequest(text="Файл с компьютера не дошёл до программы, добавьте его ещё раз")
                try:
                    ln = float(form.get("len_" + k) or 0)
                except ValueError:
                    ln = 0.0
                items.append({"kind": "video", "_up": files[k], "res": form.get("res_" + k, ""), "len": ln,
                              "ext": (Path(files[k][0]).suffix.lstrip(".").lower() or "mp4")[:5]})
            else:
                items.append(self.library.get(i))
        # монтаж - это и видеоредактор: один клип с обрезкой это тоже готовый ролик, so two
        # clips are not required any more; what is required is at least one real video
        if not items or any(not it or it.get("kind") == "image" for it in items):
            raise web.HTTPBadRequest(text="Добавьте в монтаж хотя бы один видеоклип")
        if self.rh():
            raise web.HTTPBadRequest(text="Монтаж работает только с локальным ComfyUI, не с облаком.")
        cuts, starts = [], []
        for n_, it in enumerate(items):   # kept length of a clip (seconds) or None, and where it starts
            d = durs[n_] if n_ < len(durs) else None
            cuts.append(round(float(d), 3) if isinstance(d, (int, float)) and 0.3 <= d < 3600 else None)
            s = insv[n_] if n_ < len(insv) else 0
            starts.append(round(float(s), 3) if isinstance(s, (int, float)) and 0 <= float(s) < 3600 else 0.0)
        names, sizes, timing = [], [], []
        for it in items:
            data = it["_up"][1] if "_up" in it else await self.item_bytes(it)
            tr = mp4info.track_seconds(data)   # picture and sound seconds: the sound of every clip is fitted to its own picture
            timing.append((tr["vide"], tr.get("soun")) if tr.get("vide") else None)
            if cuts[n_] is None and starts[n_] > 0.02 and tr.get("vide"):
                # only the start is cut: the piece runs to the end of the picture, and the slice node needs its length
                cuts[n_] = round(max(0.3, tr["vide"] - starts[n_]), 3)
            name = f"h3s_m_{uuid.uuid4().hex[:10]}.{it.get('ext') or 'mp4'}"
            fd = aiohttp.FormData()
            fd.add_field("image", data, filename=name, content_type="video/mp4")
            fd.add_field("type", "input")
            status, res = await self.comfy_json("POST", "/upload/image", data=fd)
            if status != 200:
                raise web.HTTPBadGateway(text="Не удалось передать клип в ComfyUI")
            names.append(res["name"])
            mm = re.match(r"\s*(\d+)\D+(\d+)", it.get("res") or "")
            sizes.append((int(mm.group(1)), int(mm.group(2))) if mm else None)
        graph, stages = wf.montage_graph(names, sizes, cuts, timing, starts)
        total = sum((cuts[n_] if cuts[n_] is not None else max(0.3, float(it.get("len") or 0) - starts[n_])) for n_, it in enumerate(items))
        return await self.queue(graph, stages, {
            "mode": "montage", "sub": (["", "один клип", "два клипа", "три клипа", "четыре клипа"][len(items)]
                                     if len(items) < 5 else f"{len(items)} клипов"), "prompt": "", "aspect": items[0].get("aspect", ""), "q": "",
            "len": round(total, 1), "res": items[0].get("res", ""), "seed": 0}, last_output=True)

    async def h_grain(self, req):
        """Film grain on ONE clip (a library clip or a file from the computer) as a job of its own: the frames of a clip are decoded
        in memory, so doing the clips one after another keeps memory free between them (all at once, in one graph, it does not fit)."""
        form, content, name = {}, None, ""
        async for part in await req.multipart():
            if part.name == "file":
                name = part.filename or ""
                content = bytes(await part.read())
            else:
                form[part.name] = (await part.text()).strip()
        try:
            strength = min(1.0, max(0.0, float(form.get("strength") or 0) / 100))
        except ValueError:
            strength = 0.0
        if strength <= 0:
            raise web.HTTPBadRequest(text="Зерно выключено (0%)")
        if self.rh():
            raise web.HTTPBadRequest(text="Зерно работает только с локальным ComfyUI.")
        try:
            status, info = await self.comfy_json("GET", "/object_info/ImageNoiseAugmentation", timeout=aiohttp.ClientTimeout(total=15))
        except Exception:
            raise web.HTTPBadGateway(text="ComfyUI не отвечает. Проверьте, что он запущен.")
        if status != 200 or not isinstance(info, dict) or "ImageNoiseAugmentation" not in info:
            raise web.HTTPBadRequest(text="Для зерна плёнки в вашем ComfyUI нужна нода ImageNoiseAugmentation (пакет ComfyUI-KJNodes). "
                                          "Поставьте пакет (например, через ComfyUI Manager) или уберите ползунок «Зерно плёнки» в 0.")
        item = {"kind": "video", "res": form.get("res", ""), "prompt": "", "aspect": ""}
        if content is None:
            item = self.library.get(form.get("id", ""))
            if not item or item.get("kind") == "image":
                raise web.HTTPBadRequest(text="Видео не найдено")
            content = await self.item_bytes(item)
            ext = item.get("ext") or "mp4"
        else:
            ext = Path(name).suffix.lstrip(".").lower()[:5] or "mp4"
        fname = f"h3s_g_{uuid.uuid4().hex[:10]}.{ext}"
        fd = aiohttp.FormData()
        fd.add_field("image", content, filename=fname, content_type="video/mp4")
        fd.add_field("type", "input")
        status, res = await self.comfy_json("POST", "/upload/image", data=fd)
        if status != 200:
            raise web.HTTPBadGateway(text="Не удалось передать клип в ComfyUI")
        graph, stages = wf.grain_graph(res["name"], strength, random.randrange(2 ** 31))
        try:
            ln = float(item.get("len") or form.get("len") or 0)
        except ValueError:
            ln = 0.0
        return await self.queue(graph, stages, {
            "mode": "montage", "sub": "Зерно плёнки", "prompt": (item.get("prompt") or name or "")[:100], "aspect": item.get("aspect", ""), "q": "",
            "len": ln, "res": item.get("res", ""), "seed": 0}, last_output=True)
