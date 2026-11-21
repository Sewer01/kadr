"""Звук: отделение голоса от музыки и сборка звука всей
    полосы - фон играет фоном, а не заменяет речь. Методы перенесены из app/server.py без
    правок."""

from aiohttp import web
from applog import applog
from netutil import comfy_error_text
from pathlib import Path
from paths import CLIENT_ID
import aiohttp
import asyncio
import os
import shutil
import uuid


class SoundMixin:
    """Методы области «sound»."""

    # ---------- audio: voice / music separation (MelBand RoFormer through ComfyUI) ----------

    async def separation_ready(self):
        """(ok, reason) - is the node pack there and is the model visible to ComfyUI."""
        if self.rh():
            return False, "Отделение голоса работает на этом компьютере, а сейчас включено облако."
        try:
            _, node = await self.comfy_json("GET", "/object_info/MelBandRoFormerSampler")
        except aiohttp.ClientError:
            return False, "ComfyUI не запущен."
        if not node:
            return False, "В ComfyUI нет ноды MelBandRoFormer (ComfyUI-MelBandRoFormer)."
        if not self.model_names:
            await self.resolve_models()
        if "vocal_model" in {m["role"] for m in self.missing}:
            return False, "Не найдена модель MelBandRoformer_fp16.safetensors (папка diffusion_models)."
        return True, ""

    async def h_audio_info(self, _req):
        ok, reason = await self.separation_ready()
        return web.json_response({"available": ok, "reason": reason})

    async def h_audio_separate(self, req):
        """WAV in -> the voice only (FLAC) out. Blocks until ComfyUI is done (usually well under a minute)."""
        ok, reason = await self.separation_ready()
        if not ok:
            return web.json_response({"error": reason}, status=400)
        name = None
        async for field in await req.multipart():
            if field.name == "file" and field.filename:
                name = await self.upload_input(field)
        if not name:
            return web.json_response({"error": "Нет аудио"}, status=400)
        await self.stop_llm()  # the agent's model would compete for video memory
        graph = {
            "1": {"class_type": "LoadAudio", "inputs": {"audio": name}},
            "2": {"class_type": "MelBandRoFormerModelLoader", "inputs": {"model_name": self.model_names["vocal_model"]}},
            "3": {"class_type": "MelBandRoFormerSampler", "inputs": {"model": ["2", 0], "audio": ["1", 0]}},
            "4": {"class_type": "SaveAudio", "inputs": {"audio": ["3", 0], "filename_prefix": "H3Workspace/audio/vocals"}},
        }
        status, res = await self.comfy_json("POST", "/prompt", json={"prompt": graph, "client_id": CLIENT_ID})
        if status != 200:
            return web.json_response({"error": comfy_error_text(res)}, status=400)
        pid = res["prompt_id"]
        loop = asyncio.get_running_loop()
        end = loop.time() + 600
        while loop.time() < end:
            await asyncio.sleep(1.5)
            _, hist = await self.comfy_json("GET", f"/history/{pid}")
            entry = (hist or {}).get(pid)
            if not entry:
                continue
            st = entry.get("status", {})
            if st.get("status_str") == "error":
                msgs = [m[1].get("exception_message", "") for m in st.get("messages", []) if m[0] == "execution_error"]
                return web.json_response({"error": "Не удалось отделить голос: " + (msgs[0].strip() if msgs else "ошибка ComfyUI")}, status=500)
            audio = next((f for out in entry.get("outputs", {}).values() for f in out.get("audio", [])), None)
            if audio:
                async with self.session.get(self.comfy + "/view", params={
                        "filename": audio["filename"], "subfolder": audio.get("subfolder", ""), "type": audio.get("type", "output")}) as r:
                    data = await r.read()
                return web.Response(body=data, content_type="audio/flac")
        return web.json_response({"error": "Отделение голоса заняло слишком много времени"}, status=504)

    async def h_montage_sound(self, request):
        """The sound of the whole montage as it stands in the strip: every clip in its order and with its
        own cut. A person keeps the voice or the music of the finished piece, not of one clip - the strip
        is what they looked at, and one clip's sound would be a different work."""
        ff = self._ffmpeg()
        if not ff:
            return web.json_response({"error": "декодер не найден: звук собрать нечем"}, status=404)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "не разобран состав ленты"}, status=400)
        # the strip sends {"parts": [...]}, but a bare list is just as honest about what it means
        parts = (body if isinstance(body, list) else (body.get("parts") or []))[:24]
        if not parts:
            return web.json_response({"error": "лента пуста"}, status=400)
        picked = []
        for p in parts:
            item = self.library.get(str(p.get("id") or ""))
            path = self.file_path(item) if item else None
            if not path or not path.exists():
                return web.json_response({"error": "одного клипа уже нет на диске"}, status=422)
            try:
                s = max(0.0, float(p.get("start") or 0))
                e = float(p.get("end") or 0)
            except (TypeError, ValueError):
                return web.json_response({"error": "не разобраны границы куска"}, status=400)
            if e - s < 0.05:
                return web.json_response({"error": "один из кусков пустой: сначала отрежьте меньше"}, status=400)
            # a fade of this clip, asked for in the strip: from the marker to the far end ('r')
            # or from the marker back to the beginning ('l'); measured inside the kept piece
            # a piece can die at both ends at once: fade_out from the marker to the end, fade_in
            # from the beginning up to the marker; the old single-side words still arrive, so they
            # are read as well
            fade_out, fade_in = None, None
            if str(p.get("fade") or "") == "r":
                fade_out = max(0.0, float(p.get("fade_at") or 0))
            if p.get("fade_in") is not None:
                fade_in = max(0.0, float(p.get("fade_in") or 0))
            if p.get("at_out") is not None:
                fade_out = max(0.0, float(p.get("at_out") or 0))
            if p.get("at_in") is not None:
                fade_in = max(0.0, float(p.get("at_in") or 0))
            if fade_out is not None and (e - s) - fade_out < 0.05:
                fade_out = None
            if fade_in is not None and fade_in < 0.05:
                fade_in = None
            picked.append((path, s, e, fade_out, fade_in))
        work = Path(os.environ.get("TEMP", ".")) / ("h3mtsnd-" + uuid.uuid4().hex)
        work.mkdir(parents=True, exist_ok=True)
        out = work / "montage.mp3"
        try:
            cmd = [str(ff), "-hide_banner", "-loglevel", "error", "-y"]
            for path, s, e, fade_out, fade_in in picked:
                cmd += ["-ss", "%.3f" % s, "-to", "%.3f" % e, "-i", str(path)]
            # the same sample rate and channels everywhere: pieces of different clips must stitch silently.
            # A fade rides on the same chain: out to the right end, in from the left one.
            def seg(i, path, s, e, fade, fade_at):
                f = "[%d:a]aformat=sample_rates=44100:channel_layouts=stereo" % i
                if fade_out is not None:      # the two are chained: a clip may die at both ends
                    f += ",afade=t=out:st=%.3f:d=%.3f" % (fade_out, max(0.05, (e - s) - fade_out))
                if fade_in is not None:
                    f += ",afade=t=in:st=0:d=%.3f" % max(0.05, fade_in)
                return f + "[a%d];" % i
            chain = "".join(seg(i, *p) for i, p in enumerate(picked))
            chain += "".join("[a%d]" % i for i in range(len(picked))) + "concat=n=%d:v=0:a=1[out]" % len(picked)
            cmd += ["-filter_complex", chain, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "3", str(out)]
            err = b""
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL,
                                                        stderr=asyncio.subprocess.PIPE)
            _, err = await asyncio.wait_for(proc.communicate(), timeout=300)
            if proc.returncode != 0 or not out.exists() or out.stat().st_size < 512:
                return web.json_response({"error": "в ленте нет общего звука: " +
                                          (err or b"")[-260:].decode("utf-8", "replace").strip()[-180:]},
                                         status=422)
            return web.Response(body=out.read_bytes(), content_type="audio/mpeg",
                                headers={"Content-Disposition": 'attachment; filename="montage.mp3"'})
        finally:
            asyncio.get_running_loop().call_later(60, shutil.rmtree, work, True)

    async def h_montage_fade(self, request):
        """The fade of the strip lands on the joined film - and nowhere else. The clips the film was
        made of are not read for writing at all: this takes the file the montage has just produced,
        copies its picture without re-encoding and rewrites only its sound, so the frames a person
        has already approved stay byte for byte the same."""
        ff = self._ffmpeg()
        if not ff:
            return web.json_response({"error": "декодер не найден: затухание наложить нечем"}, status=404)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "не разобран план затухания"}, status=400)
        item = self.library.get(str(body.get("id") or ""))
        path = self.file_path(item) if item else None
        if not path or not path.exists():
            return web.json_response({"error": "собранный ролик не найден на диске"}, status=422)
        if path.suffix.lower() not in (".mp4", ".mov", ".mkv", ".webm"):
            return web.json_response({"error": "ролик не похож на видеофайл"}, status=422)
        # What the strip says: what every clip keeps, and where the marker stood inside it
        segs, t0 = [], 0.0
        for seg in (body.get("timeline") or [])[:40]:
            try:
                dur = float(seg.get("dur") or 0)
                at = float(seg.get("at") or 0)
                way = str(seg.get("dir") or "")
            except (TypeError, ValueError):
                continue
            if dur <= 0:
                continue
            # a clip may die at both ends (the single "dir" word of an older page is still read)
            fo = fi = None
            if way == "r" or seg.get("at_out") is not None:
                fo = max(0.0, min(dur, at if seg.get("at_out") is None else float(seg["at_out"])))
            if way == "l" or seg.get("at_in") is not None:
                fi = max(0.0, min(dur, at if seg.get("at_in") is None else float(seg["at_in"])))
            if fo is not None and dur - fo <= 0.05:
                fo = None      # the marker stands at the end: no room to descend
            if fi is not None and fi <= 0.05:
                fi = None      # the marker stands at the start: nothing to fill up to
            segs.append({"s": t0, "e": t0 + dur, "out": fo, "in": fi})
            t0 += dur
        total = t0
        filters = [x for x in segs if x["out"] is not None or x["in"] is not None]
        why = ""
        if not filters and segs:
            asked = [s for s in (body.get("timeline") or []) if (s.get("at_in") is not None or s.get("at_out") is not None)]
            why = (" · спуск просили на %d сегмент(ах), но не на одном нет места: длины %s"
                   % (len(asked), ", ".join(str(s.get("dur")) for s in asked[:5]) or "нет"))
        applog("монтаж: прошу затухание на %s - план %d сегмент(а), спусков %d%s"
               % (item.get("id"), len(body.get("timeline") or []), len(filters), why))
        if not filters:
            return web.json_response({"ok": True, "fades": 0, "seconds": round(total, 2)})
        # A descent written once over the joined file would be wrong: ffmpeg's "fade out" does not
        # stop when the clip ends, it keeps the sound silent to the end of the file - a fade at the
        # end of the first clip had killed the second one whole. So the sound is cut at the clip
        # borders, every piece descends only inside its own borders, and the pieces are glued back.
        # The picture is still copied, frame for frame.
        chain = ["[0:a]asplit=%d%s" % (len(segs), "".join("[sp%d]" % k for k in range(len(segs))))]
        for k, x in enumerate(segs):
            f = ("atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS,"
                 "aformat=sample_rates=44100:channel_layouts=stereo" % (x["s"], x["e"]))
            if x["in"] is not None:
                f += ",afade=t=in:st=0:d=%.3f" % x["in"]
            if x["out"] is not None:
                f += ",afade=t=out:st=%.3f:d=%.3f" % (x["out"], max(0.05, (x["e"] - x["s"]) - x["out"]))
            chain.append("[sp%d]%s[a%d]" % (k, f, k))
        chain.append("".join("[a%d]" % k for k in range(len(segs))) + "concat=n=%d:v=0:a=1[aout]" % len(segs))
        graph = ";".join(chain)
        out = path.with_name(path.stem + "-fade" + path.suffix)
        cmd = [str(ff), "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
               "-filter_complex", graph, "-map", "0:v", "-map", "[aout]",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", str(out)]
        try:
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL,
                                                        stderr=asyncio.subprocess.PIPE)
            _, err = await asyncio.wait_for(proc.communicate(), timeout=600)
        except asyncio.TimeoutError:
            out.unlink(missing_ok=True)
            return web.json_response({"error": "затухание не успело закончиться"}, status=500)
        except OSError as exc:
            return web.json_response({"error": "декодер не запустился: " + str(exc)[:120]}, status=500)
        if proc.returncode != 0 or not out.exists() or out.stat().st_size < 1024:
            out.unlink(missing_ok=True)
            return web.json_response({"error": "затухание не леглось: " + (err or b"")[-200:].decode("utf-8", "replace")[-160:]},
                                     status=422)
        out.replace(path)   # only the film the montage made is rewritten; its sources stay as they were
        # the program keeps its own copy of every finished film, and that is what a browser may be
        # served after ComfyUI's output folder is cleaned: an unfaded copy there would quietly
        # undo the work, so it gets the same file
        other = item.get("local")
        if other and Path(other).exists() and Path(other) != path:
            try:
                shutil.copy2(path, other)
            except OSError:
                pass
        if isinstance(item.get("size"), int):
            item["size"] = path.stat().st_size
        self.library.save()
        applog("монтаж: затухание легло на собранный ролик - %d спуск(ов) на %.1f с" % (len(filters), total))
        return web.json_response({"ok": True, "fades": len(filters), "seconds": round(total, 2)})
