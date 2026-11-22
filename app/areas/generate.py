"""Запуск расчётов: картинки и видео по форме
    раздела, свои workflow человека и его собственные LoRA. Как собрать запрос и поставить его в
    очередь - общее, оно в базовом mixin; здесь разбор формы и выбор графа. Методы перенесены из
    app/server.py без правок."""

from aiohttp import web
from formutil import lora_strength, round_size
from limits import H3IMG_MAX_PX, MAX_SECONDS
from pathlib import Path
from paths import WORKFLOWS_DIR
from srt import split_frames
import aiohttp
import asyncio
import catalog
import customwf
import json
import random
import uuid
import workflows as wf


class GenerateMixin:
    """Методы области «generate»."""

    # ---------- the user's own workflows (API format), for those with their own ComfyUI ----------

    def wf_path(self, wid):
        if not wid.isalnum():
            raise web.HTTPNotFound()
        return WORKFLOWS_DIR / f"{wid}.json"

    def wf_load(self, wid):
        p = self.wf_path(wid)
        if not p.exists():
            raise web.HTTPNotFound(text="Workflow не найден")
        return json.loads(p.read_text(encoding="utf-8"))

    async def h_wf_list(self, _req):
        items = []
        for p in sorted(WORKFLOWS_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True) if WORKFLOWS_DIR.exists() else []:
            try:
                items.append({"id": p.stem, "name": json.loads(p.read_text(encoding="utf-8")).get("name", p.stem)})
            except (OSError, ValueError):
                pass
        return web.json_response(items)

    async def h_wf_add(self, req):
        body = await req.json()
        graph = body.get("graph")
        try:
            customwf.validate_api(graph)
        except ValueError as e:
            raise web.HTTPBadRequest(text=str(e))
        WORKFLOWS_DIR.mkdir(parents=True, exist_ok=True)
        wid = uuid.uuid4().hex[:10]
        name = (body.get("name") or "Мой workflow").strip()[:80]
        self.wf_path(wid).write_text(json.dumps({"name": name, "graph": graph}, ensure_ascii=False), encoding="utf-8")
        return web.json_response({"id": wid, "name": name})

    async def h_wf_delete(self, req):
        p = self.wf_path(req.match_info["id"])
        p.unlink(missing_ok=True)
        return web.json_response({"ok": True})

    async def wf_infos(self, graph):
        """/object_info of every node class the workflow uses (a class ComfyUI does not know is left out)."""
        async def one(cls):
            try:
                status, data = await self.comfy_json("GET", f"/object_info/{cls}", timeout=aiohttp.ClientTimeout(total=15))
            except Exception:
                raise web.HTTPServiceUnavailable(text="ComfyUI не отвечает")
            return cls, (data[cls] if status == 200 and isinstance(data, dict) and cls in data else None)
        pairs = await asyncio.gather(*(one(c) for c in {n["class_type"] for n in graph.values()}))
        return {c: i for c, i in pairs if i is not None}

    async def h_wf_get(self, req):
        wf_file = self.wf_load(req.match_info["id"])
        report = customwf.analyze(wf_file["graph"], await self.wf_infos(wf_file["graph"]))
        return web.json_response({"id": req.match_info["id"], "name": wf_file["name"], **report})

    async def h_generate_custom(self, req):
        form, uploads = {}, {}
        async for field in await req.multipart():
            if field.name.startswith("f:") and field.filename:
                uploads[field.name[2:]] = await self.upload_input(field)
            else:
                form[field.name] = await field.text()
        wf_file = self.wf_load(form.get("wf", ""))
        graph = wf_file["graph"]
        report = customwf.analyze(graph, await self.wf_infos(graph))
        if report["missing_nodes"]:
            raise web.HTTPBadRequest(text="В вашем ComfyUI нет нод: " + ", ".join(sorted({m["cls"] for m in report["missing_nodes"]})))
        try:
            values = json.loads(form.get("values") or "{}")
        except ValueError:
            values = {}
        graph = customwf.apply_values(graph, values, uploads)
        await self.stop_llm()
        prompt = next((str(values.get(w["key"], w["value"])) for w in report["widgets"] if w["role"] == "prompt"), "")
        seed = next((values.get(w["key"], w["value"]) for w in report["widgets"] if w["role"] == "seed"), None)
        return await self.queue(graph, customwf.stage_map(graph), {
            "mode": "custom", "sub": wf_file["name"], "wf": form.get("wf"), "cw_values": values,
            "prompt": prompt, "aspect": "", "q": "", "len": 0.0, "res": "",
            "seed": seed if isinstance(seed, (int, float)) else None}, last_output=True,
            titles={nid: (n.get("_meta") or {}).get("title", "") for nid, n in graph.items() if n["class_type"].startswith("Save")})

    async def read_image_form(self, req):
        """Multipart form of the picture sections: text fields plus one optional file `image`."""
        if self.rh():
            raise web.HTTPBadRequest(text="Изображения работают только на своём ComfyUI (не в облаке RunningHub).")
        form, image, extra = {}, None, {}
        async for field in await req.multipart():
            if field.name == "image" and field.filename:
                image = await self.upload_input(field)
            elif field.name in ("image2", "image3", "image4", "image5", "image6") and field.filename:
                # MiniMax H3 Image takes up to five pictures; they are handed over in the order of the slots
                extra[int(field.name[-1]) - 1] = await self.upload_input(field)
            else:
                form[field.name] = await field.text()
        form["_extra"] = [extra[i] for i in sorted(extra)]
        seed = int(form["seed"]) if form.get("seed", "").isdigit() else random.randrange(2 ** 50)
        return form, image, seed

    async def h_upscale(self, req):
        """Improve the quality of a finished video or picture from the library (SeedVR2), the sound stays."""
        peek = await req.json()
        soft = peek.get("method") == "soft2k"  # "up to 2K", soft (pictures only)
        relay = peek.get("engine") == "relay"   # the fast RelayVSR x2 (video only) instead of SeedVR2
        if relay and not await self.relay_ready():
            raise web.HTTPBadRequest(text="Быстрое увеличение требует более нового ComfyUI: в вашей версии узлов "
                                          "RelayVSR ещё нет. Обновите ComfyUI (раздел «Модели») или выберите "
                                          "«Качественнее» — он работает сейчас.")
        await self.need_models("relayvsr" if relay else "upscale")
        if self.rh():
            raise web.HTTPBadRequest(text="Увеличение работает только на своём ComfyUI (не в облаке RunningHub).")
        body = peek
        item = self.library.get(body.get("id", ""))
        if not item:
            raise web.HTTPBadRequest(text="Файл не найден")
        if soft and item.get("kind") != "image":
            raise web.HTTPBadRequest(text="«До 2К» работает для изображений. Для видео выберите «Увеличить в 1,5 или 2 раза».")
        path = self.file_path(item)
        content = None
        if path and path.exists():
            content = path.read_bytes()
            suffix = path.suffix
        else:
            # output folder unknown (own ComfyUI without --output-directory): take the file from ComfyUI itself
            f = item["file"]
            params = {"filename": f.get("filename", ""), "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
            try:
                async with self.session.get(self.comfy + "/view", params=params) as r:
                    if r.status == 200:
                        content = await r.read()
            except aiohttp.ClientError:
                content = None
            suffix = Path(f.get("filename", "")).suffix
        if not content:
            raise web.HTTPBadRequest(text="Файл не найден")
        return await self._upscale_core(body, item, content, suffix, relay, soft)

    async def h_upscale_file(self, req):
        """The same enlarge for ANY file of the user (made elsewhere): the file comes with the request, not from the library."""
        form, content, name = {}, None, ""
        async for part in await req.multipart():
            if part.name == "file":
                name = part.filename or ""
                content = await part.read()
            else:
                form[part.name] = (await part.text()).strip()
        if not content:
            raise web.HTTPBadRequest(text="Файл не получен")
        suffix = Path(name).suffix.lower()
        pic = suffix in (".png", ".jpg", ".jpeg", ".webp", ".bmp")
        relay = form.get("engine") == "relay"
        soft = form.get("method") == "soft2k"
        if relay and not await self.relay_ready():
            raise web.HTTPBadRequest(text="Быстрое увеличение требует более нового ComfyUI: в вашей версии узлов "
                                          "RelayVSR ещё нет. Обновите ComfyUI (раздел «Модели») или выберите "
                                          "«Качественнее» — он работает сейчас.")
        await self.need_models("relayvsr" if relay else "upscale")
        if self.rh():
            raise web.HTTPBadRequest(text="Увеличение работает только на своём ComfyUI (не в облаке RunningHub).")
        if soft and not pic:
            raise web.HTTPBadRequest(text="«До 2К» работает для изображений. Для видео выберите «Увеличить в 1,5 или 2 раза».")
        item = {"id": "", "kind": "image" if pic else "video", "res": form.get("res", ""), "len": float(form.get("len") or 0),
                "prompt": "Увеличение: " + name[:60], "aspect": "", "q": ""}
        return await self._upscale_core(form, item, content, suffix, relay, soft)

    async def _upscale_core(self, body, item, content, suffix, relay, soft):
        pic = item.get("kind") == "image"
        if relay:
            if pic:
                raise web.HTTPBadRequest(text="Быстрое увеличение работает только для видео. Для изображения выберите SeedVR2.")
            try:
                w0, h0 = (int(x) for x in str(item.get("res", "")).split("×"))
                secs = float(item.get("len") or 0)
            except ValueError:
                w0 = h0 = 0; secs = 0.0
            if w0 and secs and w0 * h0 * secs > wf.RELAY_PIXEL_SECONDS:   # decoded in memory as a whole: longer clips do not fit
                ok_secs = wf.RELAY_PIXEL_SECONDS / (w0 * h0)
                raise web.HTTPBadRequest(text=f"Видео слишком большое для быстрого увеличения: оно целиком загружается в память. "
                                              f"При размере {w0}×{h0} можно не больше {ok_secs:.0f} с (у вас {secs:.0f} с). "
                                              f"Выберите SeedVR2 или сделайте ролик короче.")
        scale = 2.0 if relay else wf.UPSCALE_SCALES.get(str(body.get("scale")), 1.5)
        data = aiohttp.FormData()
        name = f"h3s_{uuid.uuid4().hex[:8]}{suffix or ('.png' if pic else '.mp4')}"
        data.add_field("image", content, filename=name, content_type="image/png" if pic else "video/mp4")
        data.add_field("subfolder", "h3studio")
        data.add_field("type", "input")
        status, res = await self.comfy_json("POST", "/upload/image", data=data)
        if status != 200:
            raise web.HTTPBadGateway(text="Не удалось передать файл в ComfyUI")
        video = f'{res["subfolder"]}/{res["name"]}' if res.get("subfolder") else res["name"]
        src_file = {"filename": res["name"], "subfolder": res.get("subfolder", ""), "type": "input"}  # the "before" of the before/after slider
        seed = random.randrange(2 ** 40)
        try:
            w, h = (int(x) for x in str(item.get("res", "")).split("×"))
            res = f"{round(w * scale / 2) * 2}×{round(h * scale / 2) * 2}"
        except ValueError:
            res = ""
        if soft:  # long side 2048, SeedVR2 mixed half with the plain enlarge
            try:
                w0, h0 = (int(x) for x in str(item.get("res", "")).split("×"))
            except ValueError:
                raise web.HTTPBadRequest(text="Не знаю размер изображения, увеличить до 2К не получится.")
            scale = max(1.0, 2048 / max(w0, h0))
            graph, stages = wf.upscale_image_graph(self.model_names, video, scale, seed, soften=0.5)
            return await self.queue(graph, stages, {
                "mode": "upscale", "sub": "До 2К, мягко", "prompt": item.get("prompt", "") or "Увеличение до 2К",
                "aspect": item.get("aspect", ""), "q": "2K", "len": 0.0, "res": f"{round(w0 * scale / 2) * 2}×{round(h0 * scale / 2) * 2}", "seed": seed, "src": item.get("id", ""), "src_file": src_file})
        def num(key, default):   # a slider value 0..1 from the window (a string when it comes with an uploaded file)
            try:
                return min(1.0, max(0.0, float(body.get(key))))
            except (TypeError, ValueError):
                return default
        if relay:
            graph, stages = wf.relay_graph(self.model_names, video, seed, detail=num("detail", 0.7))
        else:
            soften = round(1.0 - num("sharp", 1.0), 2)   # 0 = full sharpness of SeedVR2, more = mixed with the plain enlarge
            graph, stages = (wf.upscale_image_graph if pic else wf.upscale_graph)(self.model_names, video, scale, seed, soften=soften)
        return await self.queue(graph, stages, {
            "mode": "upscale", "sub": "Быстрое увеличение ×2 (RelayVSR)" if relay else f"Увеличение ×{body.get('scale', '1.5')}", "prompt": item.get("prompt", "") or "Увеличение",
            "aspect": item.get("aspect", ""), "q": item.get("q", ""), "len": item.get("len", 0.0), "res": res, "seed": seed,
            "src": item.get("id", ""), "src_file": src_file})

    async def h_generate_krea(self, req):
        await self.need_models("krea")
        form, _, seed = await self.read_image_form(req)
        prompt = form.get("prompt", "").strip()
        if not prompt:
            raise web.HTTPBadRequest(text="Напишите промпт")
        lab = {"label": form["batch_label"][:20]} if form.get("batch_label") else {}  # "3 из 8" for a series from a prompt list
        aspect = form.get("aspect", "16:9")
        if aspect not in wf.KREA_SIZES:
            raise web.HTTPBadRequest(text="Неизвестный формат")
        width, height = wf.KREA_SIZES[aspect]
        custom = round_size(form)
        if custom:
            width, height = custom
        engine = form.get("engine", "krea")
        if engine == "h3img":   # MiniMax H3 Image: размер берётся из формата и площади (МП), а не из таблицы 1 МП
            await self.need_models("h3img")
            mp = wf.H3IMG_MP.get(form.get("mp", "4"), 4.0)
            width, height = round_size(form, high=8192, max_px=H3IMG_MAX_PX) or wf.h3img_size(aspect, mp)
            graph, stages = wf.h3img_t2i_graph(self.model_names, prompt, width, height, seed)
            return await self.queue(graph, stages, {
                "mode": "krea", "sub": "Изображение (MiniMax H3 Image)", "prompt": prompt, "aspect": aspect,
                "q": "4K" if mp >= 8 else "2K", "len": 0.0, "res": f"{width}×{height}", "seed": seed, **lab})
        if engine == "flux":
            await self.need_models("flux")
            graph, stages = wf.flux_t2i_graph(self.model_names, prompt, width, height, seed)
            return await self.queue(graph, stages, {
                "mode": "krea", "sub": "Изображение (FLUX.2)", "prompt": prompt, "aspect": aspect, "q": "1K",
                "len": 0.0, "res": f"{width}×{height}", "seed": seed, **lab})
        if engine == "qwen":
            await self.need_models("qwen")
            graph, stages = wf.qwen_t2i_graph(self.model_names, prompt, form.get("negative", "").strip()[:600], width, height, seed)
            return await self.queue(graph, stages, {
                "mode": "krea", "sub": "Изображение (Qwen 2.1)", "prompt": prompt, "aspect": aspect, "q": "1K",
                "len": 0.0, "res": f"{width}×{height}", "seed": seed, **lab})
        if form.get("style") == "real":
            await self.need_models("kreareal")
            scale = wf.KREA_REAL_SCALES.get(form.get("scale", "2k"), 1.5)
            graph, stages = wf.krea_real_graph(self.model_names, prompt, width, height, seed, scale)
            return await self.queue(graph, stages, {
                "mode": "krea", "sub": "Изображение: реализм", "prompt": prompt, "aspect": aspect, "q": "4K" if scale > 2 else "2K",
                "len": 0.0, "res": f"{int(width * scale)}×{int(height * scale)}", "seed": seed, **lab})
        graph, stages = wf.krea_graph(self.model_names, prompt, width, height, seed)
        return await self.queue(graph, stages, {
            "mode": "krea", "sub": "Изображение по тексту", "prompt": prompt, "aspect": aspect, "q": "1K",
            "len": 0.0, "res": f"{width}×{height}", "seed": seed, **lab})

    async def h_generate_qwen(self, req):
        form, image, seed = await self.read_image_form(req)
        flux = form.get("kind") != "sheet" and form.get("engine") == "flux"
        # MiniMax H3 Image ведёт себя так же в трёх задачах: правка, раскадровка, лист персонажа; картинок до 5
        h3 = form.get("engine") == "h3img" and form.get("kind", "edit") in ("edit", "story", "sheet")
        await self.need_models("h3img" if h3 else "flux" if flux else "qwen")
        if form.get("kind") == "story" and form.get("frames") == "1":
            # storyboard frame by frame (FLUX.2 klein): every frame is its own picture, the sheet is glued from them
            use_qwen = form.get("engine") == "qwen"
            await self.need_models("qwen" if use_qwen else "flux")
            frames = split_frames(form.get("prompt", ""))
            if len(frames) not in wf.FRAME_COLS:
                raise web.HTTPBadRequest(text=f"Нужно 2, 3, 4, 6, 8 или 9 кадров, а в описании их {len(frames)}. Напишите каждый кадр с новой строки: «1: ...», «2: ...».")
            refs = [x for x in ([image] if image else []) + list(form.get("_extra") or [])]
            build = wf.h3img_frames_graph if h3 else wf.qwen_frames_graph if use_qwen else wf.flux_frames_graph
            fsize = (round_size(form, high=8192, max_px=H3IMG_MAX_PX)
                     or (wf.h3img_size("16:9", min(wf.H3IMG_MP.get(form.get("size", "4"), 4.0), 8.0)) if h3 else wf.FRAME_SIZE))
            graph, stages, titles = build(self.model_names, refs, frames, seed, size=fsize, line=form.get("line", "white"))
            return await self.queue(graph, stages, {
                "mode": "qwen", "sub": "Раскадровка по кадрам", "prompt": form.get("prompt", "").strip(), "aspect": "",
                "q": "", "len": 0.0, "res": "", "seed": seed}, titles=titles)
        if not image:
            raise web.HTTPBadRequest(text="Загрузите изображение")
        if form.get("kind") == "story":
            prompt = form.get("prompt", "").strip()
            if not prompt:
                raise web.HTTPBadRequest(text="Опишите историю по кадрам")
            refs = [image] + list(form.get("_extra") or [])
            sz = round_size(form, high=8192, max_px=H3IMG_MAX_PX) or (
                wf.h3img_size("16:9", wf.H3IMG_MP.get(form.get("size", "4"), 4.0)) if h3 else wf.STORY_SIZE)
            if h3:
                graph, stages = wf.h3img_story_graph(self.model_names, refs, prompt, seed, sz)
            elif flux:
                graph, stages = wf.flux_story_graph(self.model_names, refs, prompt, seed, sz)
            else:
                graph, stages = wf.qwen_story_graph(self.model_names, refs, prompt, seed, sz)
            return await self.queue(graph, stages, {
                "mode": "qwen", "sub": "Раскадровка по изображениям", "prompt": prompt, "aspect": "",
                "q": "", "len": 0.0, "res": "%d×%d" % wf.STORY_SIZE, "seed": seed})
        if h3 and form.get("kind") != "sheet":   # лист персонажа идёт своей веткой: текст правки ему не нужен
            prompt = form.get("prompt", "").strip()
            if not prompt:
                raise web.HTTPBadRequest(text="Напишите, что изменить на изображении")
            mp = wf.H3IMG_MP.get(form.get("size", "4"), 4.0)
            size = round_size(form, high=8192, max_px=H3IMG_MAX_PX) or (
                wf.h3img_size(form["aspect"], mp) if form.get("aspect") else None)
            graph, stages = wf.h3img_edit_graph(self.model_names, prompt, [image] + list(form.get("_extra") or ()),
                                                mp, seed, size, min(mp, 4.0))
            return await self.queue(graph, stages, {
                "mode": "qwen", "sub": "Изменение изображения (MiniMax H3 Image)", "prompt": prompt, "aspect": "",
                "q": "", "len": 0.0, "res": "%d×%d" % size if size else "", "seed": seed})
        if flux:
            prompt = form.get("prompt", "").strip()
            if not prompt:
                raise web.HTTPBadRequest(text="Напишите, что изменить на изображении")
            mp = wf.QWEN_MP.get(form.get("size", "1"), 1.0)
            graph, stages = wf.flux_edit_graph(self.model_names, prompt, image, mp, seed, form.get("_extra") or (), round_size(form))
            return await self.queue(graph, stages, {
                "mode": "qwen", "sub": "Изменение изображения (FLUX.2)", "prompt": prompt, "aspect": "",
                "q": "", "len": 0.0, "res": "", "seed": seed})
        if form.get("kind") == "sheet" and h3:
            panels = 6 if form.get("panels") == "6" else 4
            graph, stages, prompt = wf.h3img_sheet_graph(
                self.model_names, image, seed, headless=form.get("headless", "1") != "0",
                background=form.get("background", "grey"), marks=form.get("marks", "")[:300], panels=panels)
            sub_, res = "Лист персонажа (MiniMax H3 Image)", "%d×%d" % (
                wf.H3IMG_SHEET6_SIZE if panels == 6 else wf.H3IMG_SHEET_SIZE)
            prompt = "Лист персонажа · MiniMax H3 Image" + (" (6 панелей)" if panels == 6 else "") + (
                ": " + form["marks"].strip()[:80] if form.get("marks", "").strip() else "")
            return await self.queue(graph, stages, {
                "mode": "qwen", "sub": sub_, "prompt": prompt, "aspect": "", "q": "4K", "len": 0.0,
                "res": res, "seed": seed})
        if form.get("kind") == "sheet":
            panels = 6 if form.get("panels") == "6" else 4
            graph, stages, prompt = wf.qwen_sheet_graph(
                self.model_names, image, seed, headless=form.get("headless", "1") != "0",
                background=form.get("background", "grey"), marks=form.get("marks", "")[:300], panels=panels)
            sub, res = "Лист персонажа", "%d×%d" % (wf.SHEET6_SIZE if panels == 6 else wf.SHEET_SIZE)
            prompt = "Лист персонажа" + (" (6 панелей)" if panels == 6 else "") + (": " + form["marks"].strip()[:80] if form.get("marks", "").strip() else "")
        else:
            prompt = form.get("prompt", "").strip()
            if not prompt:
                raise web.HTTPBadRequest(text="Напишите, что изменить на изображении")
            mp = wf.QWEN_MP.get(form.get("size", "1"), 1.0)
            size = round_size(form) or wf.qwen_edit_size(form.get("aspect", ""), mp)
            graph, stages = wf.qwen_edit_graph(self.model_names, prompt, image, mp, seed, size, form.get("_extra") or ())
            sub, res = "Изменение изображения", ("%d×%d" % size if size else "")
        return await self.queue(graph, stages, {
            "mode": "qwen", "sub": sub, "prompt": prompt, "aspect": form.get("aspect", "") if form.get("kind") != "sheet" else "",
            "q": "", "len": 0.0, "res": res, "seed": seed})

    async def h_generate_video(self, req):
        await self.need_models("video")
        form, images, prompt, aspect, quality, seed = await self.read_form(req, ("first", "last"))
        seconds = min(MAX_SECONDS, max(3.0, float(form.get("duration", 5))))
        width, height = wf.resolution(aspect, quality, form)
        first, last = images.get("first"), images.get("last") if images.get("first") else None
        loop = bool(first) and form.get("loop") == "1"
        if loop:  # seamless loop (live wallpaper): the video ends on the same picture it starts with
            last = first

        fast = None
        if form.get("accel") == "sla":
            miss = {mm["role"] for mm in self.missing}
            if "sla_lora" in miss or "sla_lora" not in self.model_names:
                raise web.HTTPBadRequest(text="Для быстрого режима нужен файл Turbo-SLA (около 2 ГБ). Нажмите «Скачать» под переключателем «Ускорение» "
                                              "или выберите «Обычное».")
            fast = self.model_names["sla_lora"]
        graph, stages = wf.video_graph(self.model_names, prompt, width, height, seconds, seed, first, last, self.custom_loras("video"), fast)
        sub = "Зацикленное видео" if loop else "Кадр -> кадр" if last else "Изображение -> видео" if first else "Текст -> видео"
        if fast:
            sub += " · быстрый черновик"
        return await self.queue(graph, stages, {
            "mode": "video", "sub": sub, "prompt": prompt, "note": (form.get("note") or "").strip(), "aspect": aspect, "q": quality,
            "len": seconds, "res": f"{width}×{height}", "seed": seed})

    async def h_generate_lipsync(self, req):
        await self.need_models("lipsync")
        ref_fields = tuple(f"ref{i}" for i in range(9))
        form, files, prompt, aspect, quality, seed = await self.read_form(req, ref_fields + ("audio",))
        if "audio" not in files:
            raise web.HTTPBadRequest(text="Загрузите аудио")
        refs = [files[f] for f in ref_fields if f in files]
        if not refs:
            raise web.HTTPBadRequest(text="Добавьте хотя бы один референс — лицо персонажа")
        seconds = float(form.get("audio_len", 0))
        if not 1 <= seconds <= 15:
            raise web.HTTPBadRequest(text="Фрагмент аудио должен быть от 1 до 15 секунд")

        ref_size = form.get("ref_size") if form.get("ref_size") in ("match", "max") else "max"
        scale = wf.lipsync_scale(quality)
        out_w, out_h = wf.resolution(aspect, quality, form)
        width, height = wf.r32(out_w / scale), wf.r32(out_h / scale)
        extra = self.optional_loras(form, (("realism", "realism_lora"),)) + self.custom_loras("lipsync")
        graph, stages = wf.lipsync_graph(self.model_names, wf.lipsync_prompt(prompt, len(refs)), width, height,
                                         seconds, seed, files["audio"], refs, scale, ref_size, extra)
        speed = "максимум" if ref_size == "max" else "быстро"
        return await self.queue(graph, stages, {
            "mode": "lipsync", "sub": f"{len(refs)} реф. ({speed}) · аудио {seconds:.1f} с", "prompt": prompt, "note": (form.get("note") or "").strip(), 
            "aspect": aspect, "q": quality, "len": seconds, "res": f"{out_w}×{out_h}", "seed": seed,
            "ref_size": ref_size})

    async def read_ref_form(self, req, max_images, frames=False):
        fields = tuple(f"img{i}" for i in range(max_images)) + tuple(f"vid{i}" for i in range(3)) + \
            tuple(f"aud{i}" for i in range(3))
        if frames:
            fields += ("first", "last")   # картинки первого и последнего кадра: те же имена полей, что в режиме «Видео»
        form, files, prompt, aspect, quality, seed = await self.read_form(req, fields)
        pick = lambda p, n: [files[f"{p}{i}"] for i in range(n) if f"{p}{i}" in files]
        images, videos, audios = pick("img", max_images), pick("vid", 3), pick("aud", 3)
        if frames:
            # кадры - не референсы: они не входят в счётчик 12 и не заменяют требование
            # прикрепить хоть что-то; поле не прислали - будет None
            form["_frames"] = (files.get("first"), files.get("last"))
        if not images and not videos:
            raise web.HTTPBadRequest(text="Добавьте хотя бы одно референс-изображение")
        if len(images) + len(videos) + len(audios) > 12:
            raise web.HTTPBadRequest(text="Всего не больше 12 референсов (изображения + видео + аудио)")
        seconds = min(MAX_SECONDS, max(3.0, float(form.get("duration", 6))))
        return form, prompt, aspect, quality, seed, images, videos, audios, seconds

    async def h_loras_custom_mode(self, req):
        """Switch an own LoRA on / off for ONE mode (from the «Модель» row of that mode)."""
        body = await req.json()
        file, mode = body.get("file"), body.get("mode")
        if mode not in catalog.MODE_ROLES:
            raise web.HTTPBadRequest(text="Неизвестный режим")
        items = self.unique_loras()
        hit = next((x for x in items if x.get("file") == file), None)
        if not hit:
            raise web.HTTPBadRequest(text="Такой LoRA нет в списке")
        skip = [m for m in (hit.get("skip") or []) if m != mode]
        also = [m for m in (hit.get("also") or []) if m != mode]
        if not body.get("on"):
            skip.append(mode)
        elif not catalog.lora_fits_mode(file, mode):
            also.append(mode)   # the person insists on a foreign-family LoRA in this section
        hit["skip"] = skip
        hit["also"] = also
        self.config.update(custom_loras=items)
        return web.json_response({"ok": True})

    async def h_loras_custom(self, _req):
        try:
            _, files = await self.comfy_json("GET", "/models/loras")
        except Exception:
            raise web.HTTPServiceUnavailable(text="ComfyUI не отвечает")
        return web.json_response({"files": files or [], "items": self.unique_loras()})

    async def h_loras_custom_set(self, req):
        items = []
        for x in (await req.json()).get("items", [])[:10]:
            try:
                strength = max(-4.0, min(4.0, float(x.get("strength", 0.8))))
            except (TypeError, ValueError):
                strength = 0.8
            skip = [m for m in (x.get("skip") or []) if isinstance(m, str)][:20]
            if isinstance(x.get("file"), str) and x["file"]:
                items.append({"file": x["file"], "strength": strength, "on": bool(x.get("on", True)),
                              **({"skip": skip} if skip else {})})
        self.config.update(custom_loras=items)
        return web.json_response({"ok": True})

    def optional_loras(self, form, pairs):
        """(file name, strength) for the optional LoRAs the user switched on and this ComfyUI has."""
        missing = {m["role"] for m in self.missing}
        out = []
        for key, role in pairs:
            v = lora_strength(form, key, None)
            if v is not None and role not in missing and role in self.model_names:
                out.append((self.model_names[role], v))
        return out

    async def h_generate_refs(self, req):
        await self.need_models("refs")
        form, prompt, aspect, quality, seed, images, videos, audios, seconds = await self.read_ref_form(req, 9, frames=True)
        first, last = form.get("_frames") or (None, None)
        steps = int(form.get("steps", 6)) if form.get("steps", "6").isdigit() else 6
        steps = min(8, max(4, steps))
        ref_size = form.get("ref_size") if form.get("ref_size") in ("match", "max") else "max"
        extra = self.optional_loras(form, (("realism", "realism_lora"), ("motion", "motion_repair_lora"))) + self.custom_loras("refs")
        width, height = wf.resolution(aspect, quality, form)
        pika = None
        if form.get("accel") == "pika":
            if "pika_lora" in {m["role"] for m in self.missing}:
                raise web.HTTPBadRequest(text="Файл Pika (pika_h3_flex_turbo_8step_hd_ref2va) не найден в ComfyUI. "
                                              "Скачайте его в разделе «Настройки» или выберите прежнее ускорение.")
            pika, steps = self.model_names["pika_lora"], max(6, steps)
        graph, stages = wf.ref_graph(self.model_names, wf.lipsync_prompt(prompt, len(images), len(videos)), width, height, seconds, seed, images, videos, audios,
                                     steps, ref_size, extra, pika, first=first, last=last)
        sub = f"{len(images)} карт." + (f", {len(videos)} видео" if videos else "") + (f", {len(audios)} аудио" if audios else "") \
            + f" · {steps} шагов" + (" · Pika" if pika else "") \
            + (" · первый кадр" if first else "") + (" · последний кадр" if last else "")
        return await self.queue(graph, stages, {
            "mode": "refs", "sub": sub, "prompt": prompt, "note": (form.get("note") or "").strip(), "aspect": aspect, "q": quality, "len": seconds,
            "res": f"{width}×{height}", "seed": seed, "steps": steps, "ref_size": ref_size})

    async def h_generate_actor(self, req):
        await self.need_models("actor")
        form, prompt, aspect, quality, seed, images, videos, audios, seconds = await self.read_ref_form(req, 3)
        realism = None
        v = lora_strength(form, "realism", 0.7)  # on by default, as in the original workflow
        missing = {m["role"] for m in self.missing}
        if v is not None and "realism_lora" not in missing and "realism_lora" in self.model_names:
            realism = (self.model_names["realism_lora"], v)
        width, height = wf.resolution(aspect, quality, form)
        graph, stages = wf.actor_graph(self.model_names, wf.lipsync_prompt(prompt, len(images)), width, height, seconds, seed,
                                       images, audios, realism, self.custom_loras("actor"))
        sub = f"{len(images)} карт." + (f", голос ({len(audios)})" if audios else ", без голоса") + " · 10 шагов"
        return await self.queue(graph, stages, {
            "mode": "actor", "sub": sub, "prompt": prompt, "note": (form.get("note") or "").strip(), "aspect": aspect, "q": quality, "len": seconds,
            "res": f"{width}×{height}", "seed": seed})

    async def h_generate_swap(self, req):
        """Preset «Замена персонажа»: one video + up to two character pictures, the app writes the prompt."""
        await self.need_models("swap")
        form, prompt, aspect, quality, seed, images, videos, audios, seconds = await self.read_ref_form(req, 2)
        if not videos:
            raise web.HTTPBadRequest(text="Добавьте видео, в котором нужно заменить человека")
        if not images:
            raise web.HTTPBadRequest(text="Добавьте изображение персонажа, на которого заменяем")
        shots = []
        if form.get("shots"):   # several plans (shots): every one is swapped on its own, then they are joined
            try:
                for x in json.loads(form["shots"])[:12]:
                    s0, e0 = float(x["s"]), float(x["e"])
                    if e0 - s0 < 0.5:
                        continue
                    shots.append({"s": s0, "e": e0, "pic": int(x.get("pic", 0)), "who": str(x.get("who") or "").strip(),
                                  "a_end": float(x["a_end"]) if x.get("a_end") not in (None, "") else None})
            except (ValueError, KeyError, TypeError):
                raise web.HTTPBadRequest(text="Не удалось разобрать список планов")
            if any(0 <= x["pic"] and x["e"] - x["s"] < 2 for x in shots):
                raise web.HTTPBadRequest(text="Каждый план для замены должен быть не короче 2 секунд: объедините короткие планы с соседними")
        whos = [(form.get(f"who{i}") or (form.get("who") if i == 0 else "") or "").strip() for i in range(len(images))]
        try:
            cuts = [float(x) for x in (form.get("cuts") or "").replace(";", ",").split(",") if x.strip()]
        except ValueError:
            cuts = []
        text = wf.swap_prompt(whos, (form.get("extra") or "").strip(), cuts, form.get("prompt_style") != "plain")
        if form.get("raw_prompt", "").strip():   # a prompt written by hand in the MiniMax format (tests, experts): used as it is
            text = form["raw_prompt"].strip()
        pika = None
        if form.get("accel") == "pika":
            if "pika_lora" in {m["role"] for m in self.missing}:
                raise web.HTTPBadRequest(text="Файл Pika (pika_h3_flex_turbo_8step_hd_ref2va) не найден в ComfyUI. "
                                              "Скачайте его в разделе «Настройки» или выберите обычное ускорение.")
            pika = self.model_names["pika_lora"]
        names = self.model_names
        if form.get("unet"):   # another base model for this job (tests): only a file this ComfyUI really has
            try:
                _, have = await self.comfy_json("GET", "/models/diffusion_models")
            except Exception:
                have = []
            pick = next((f for f in (have or []) if f.replace("/", "\\") == form["unet"].replace("/", "\\")), None)
            if not pick:
                raise web.HTTPBadRequest(text="Такой модели нет в ComfyUI: " + form["unet"])
            names = {**self.model_names, "lipsync_unet": pick}
        width, height = wf.resolution(aspect, quality, form)
        seconds = min(15.0, max(3.0, seconds))
        loras = self.optional_loras(form, (("realism", "realism_lora"), ("motion", "motion_repair_lora"))) + self.custom_loras("swap")
        if shots:
            snd = form.get("sound") if form.get("sound") in ("original", "lock") else "original"
            graph, stages = wf.swap_shots_graph(names, shots, width, height, seed, images, videos[0],
                                                (form.get("extra") or "").strip(), pika, loras, snd,
                                                form.get("small_ref") == "1")
            seconds = max(x["e"] for x in shots) - min(x["s"] for x in shots)
        else:
            snd = form.get("sound") if form.get("sound") in ("original", "lock", "model") else "original"
            graph, stages = wf.swap_graph(names, text, width, height, seconds, seed, images, videos[0], loras, pika, snd,
                                             small_ref=form.get("small_ref") == "1")
        return await self.queue(graph, stages, {
            "mode": "swap", "sub": "Замена персонажа" + (f", планов: {len(shots)}" if shots else (f" ({len(images)})" if len(images) > 1 else "")) + (" · Pika" if pika else ""),
            "prompt": text, "note": (form.get("note") or "").strip(), "whos": whos, "cuts": cuts,
            "aspect": aspect, "q": quality, "len": seconds,
            "res": f"{width}×{height}", "seed": seed})

    async def h_generate_action(self, req):
        await self.need_models("action")
        form, prompt, aspect, quality, seed, images, videos, audios, seconds = await self.read_ref_form(req, 6)
        if self.rh():
            # on RunningHub only built-in nodes are assumed; LoRAs are used if the user's RH workflow has them
            rh_files = {n.replace("\\", "/").split("/")[-1].lower(): n for n in (getattr(self, "rh_models", None) or [])}
            speed = rh_files.get(catalog.VARIANTS["speed_slider_lora"]["v1.1"]["file"].lower())
            dmad = next((n for b, n in rh_files.items() if catalog.is_action_dmad(b)), None)
            s = {"faithful": False, "dmad": dmad, "speed": speed}
        else:
            s = await self.action_setup()
        loras = []
        for key, name, default in (("dmad", s["dmad"], 0.8), ("speed", s["speed"], 4.0)):
            v = lora_strength(form, key, default)  # the user can switch them off or change the strength
            if name and v is not None:
                loras.append((name, v))
        loras += self.custom_loras("action")
        names = dict(self.model_names)
        width, height = wf.resolution(aspect, quality, form)
        graph, stages = wf.action_graph(names, wf.lipsync_prompt(prompt, len(images)), width, height, seconds, seed, images, audios,
                                        s["faithful"], loras, min(6, max(1, int(form.get("usarp") or 2))))
        if s["faithful"]:
            # the refiner's input names come from the installed node; values as in the original workflow
            req_inputs = [k for k in (s["refiner_def"]["input"].get("required") or {}) if k != "sigmas"]
            graph["13"]["inputs"] = {"sigmas": ["10", 0], **dict(zip(req_inputs, [1, 0.7, 0.0, "cosine"]))}
        sub = ("точная копия workflow" if s["faithful"] else "упрощённая схема") + f" · {len(images)} карт."
        return await self.queue(graph, stages, {
            "mode": "action", "sub": sub, "prompt": prompt, "aspect": aspect, "q": quality, "len": seconds,
            "res": f"{width}×{height}", "seed": seed, "faithful": s["faithful"]})
