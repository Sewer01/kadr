"""Библиотека готового: записи, папка результатов,
    удаление в корзину и копии картинок, из которых сделан результат. Методы перенесены из
    app/server.py без правок."""

from aiohttp import web
from datetime import datetime
from pathlib import Path
from paths import DATA_DIR, REF_DIR
from recycle import send_to_recycle_bin
import asyncio
import json
import re
import shutil
import uuid


class LibraryMixin:
    """Методы области «library»."""

    @staticmethod
    def ref_group(item):
        """Which folder of kept pictures this result points to."""
        pid = re.sub(r"[^A-Za-z0-9]", "", str(item.get("prompt_id") or ""))[:40]
        return pid or None

    async def cleanup_refs(self, removed):
        """A folder of kept pictures leaves when the last result that points to it is deleted."""
        alive = {g for g in (self.ref_group(x) for x in self.library.items) if g}
        for group in {g for g in (self.ref_group(x) for x in removed) if g}:
            if group in alive:
                continue
            d = REF_DIR / group
            if d.is_dir():
                await asyncio.to_thread(shutil.rmtree, d, True)

    async def h_ref_file(self, req):
        """One kept picture of a result: the interface takes it back into its place on repeat."""
        group = re.sub(r"[^A-Za-z0-9]", "", req.match_info["group"])[:40]
        name = Path(req.match_info["name"]).name
        base = (REF_DIR / group).resolve()
        p = (base / name).resolve()
        if not group or not str(p).startswith(str(base)) or not p.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(p)

    async def h_library(self, _req):
        return web.json_response([self.public(x) for x in self.library.items])

    async def h_library_patch(self, req):
        item = self.library.get(req.match_info["id"])
        if not item:
            raise web.HTTPNotFound()
        body = await req.json()
        if "fav" in body:
            item["fav"] = bool(body["fav"])
            self.library.save()
        return web.json_response(self.public(item))

    async def h_library_add(self, request):
        """A frame taken in the video bench becomes a library item. People pull a frame out of one video to
        put it into another, and they clear projects on the way: what was made by hand must not disappear
        with the project, so the keepsake goes to the library, not only into a slot."""
        data = await request.read()
        if not data:
            return web.json_response({"error": "пустой файл"}, status=400)
        # the kind is decided first: how big the file may be and which ending it gets depend on it, and
        # reading a variable before it is set is exactly what broke this handler in the first build
        q = request.query
        kind = (q.get("kind") or "image").lower()
        if kind not in ("image", "audio"):
            kind = "image"
        cap = 60 if kind == "audio" else 25
        if len(data) > cap * 1024 * 1024:
            return web.json_response({"error": "файл больше %d МБ" % cap}, status=413)
        ok_ext = (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac") if kind == "audio" \
            else (".png", ".jpg", ".jpeg", ".webp")
        dflt = "звук.mp3" if kind == "audio" else "кадр.png"
        name = re.sub(r"[^\w.\- ]+", "", (q.get("name") or dflt))[:80].strip().lstrip(".") or dflt
        if not name.lower().endswith(ok_ext):
            name += ok_ext[0]
        where = DATA_DIR / "keeps"
        where.mkdir(parents=True, exist_ok=True)
        target = where / (datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4] + "-" + name)
        target.write_bytes(data)
        item = {"id": uuid.uuid4().hex[:12], "prompt_id": "",
                "date": datetime.now().isoformat(timespec="seconds"), "fav": False,
                "file": {"type": "local", "path": str(target), "filename": target.name},
                "ext": target.suffix.lstrip(".").lower(), "kind": kind,
                "mode": "frame" if kind == "image" else "sound",
                "label": "кадр" if kind == "image" else "звук", "title": name,
                "prompt": (q.get("note") or "")[:400],
                "source": (q.get("from") or "")[:120], "at": (q.get("at") or "")[:24]}
        self.library.add(item)
        return web.json_response(self.public(item))

    async def h_library_delete_many(self, req):
        """Several library items at once: their files go to the Recycle Bin in one call."""
        ids = [str(i) for i in ((await req.json()).get("ids") or [])][:200]
        gone, failed, paths, by_id, cards = [], [], [], {}, []
        for i in ids:
            item = self.library.get(i)
            if not item:
                failed.append(i)
                continue
            cards.append(dict(item))     # remembered before it leaves: its kept pictures may leave with it
            cand = [p for p in {self.file_path(item), Path(item["local"]) if item.get("local") else None} if p and p.exists()]
            if not cand:                      # the file is already gone: the record goes too
                self.library.remove(i)
                gone.append(i)
                continue
            by_id[i] = cand
            paths += cand
        removed = {str(p) for p in (await asyncio.to_thread(send_to_recycle_bin, paths) if paths else [])}
        for i, cand in by_id.items():
            if all(str(p) in removed for p in cand):
                self.library.remove(i)
                gone.append(i)
            else:                             # the file stayed where it was: so does the record
                failed.append(i)
        if cards:
            await self.cleanup_refs(cards)
        return web.json_response({"gone": gone, "failed": failed})

    async def h_library_delete(self, req):
        item = self.library.get(req.match_info["id"])
        if not item:
            raise web.HTTPNotFound()
        recycled = False
        for path in {p for p in (self.file_path(item), Path(item["local"]) if item.get("local") else None) if p}:
            if path.exists():   # the original and the program's own copy both go to the Recycle Bin
                ok = await asyncio.to_thread(send_to_recycle_bin, path)
                recycled = recycled or ok
                if not ok:
                    return web.json_response({"error": "Не удалось переместить файл в корзину"}, status=500)
        self.library.remove(item["id"])
        await self.cleanup_refs([item])
        return web.json_response({"ok": True, "recycled": recycled})

    async def h_results_get(self, _req):
        items = self.library.items
        lost = sum(1 for x in items if (p := self.file_path(x)) and not p.exists())
        nocopy = sum(1 for x in items if not (x.get("local") and Path(x["local"]).exists()) and (p := self.file_path(x)) and p.exists())
        return web.json_response({"dir": str(self.results_dir()), "keep": self.keep_copies(), "lost": lost, "nocopy": nocopy,
                                  "default": str(self.default_results_dir())})

    async def h_results_set(self, req):
        body = await req.json()
        if "keep" in body:
            self.config.update(keep_copies=bool(body["keep"]))
        d = (body.get("dir") or "").strip().strip('"')
        if d:
            try:
                Path(d).mkdir(parents=True, exist_ok=True)
            except OSError:
                return web.json_response({"error": "Не получается создать папку. Проверьте путь и диск"}, status=400)
            self.config.update(results_dir=d)
        elif body.get("reset"):
            self.config.update(results_dir=None)
        return await self.h_results_get(req)

    async def h_results_backfill(self, req):
        """Make copies of the files that are still in ComfyUI's output folder but have no copy of their own yet."""
        n = 0
        for x in list(self.library.items):
            p = self.file_path(x)
            if p and p.exists() and not (x.get("local") and Path(x["local"]).exists()):
                n += 1 if await self.archive_item(x) else 0
        return web.json_response({"copied": n, **json.loads((await self.h_results_get(req)).text)})

    async def h_results_clean(self, req):
        """Remove the Library records whose files are gone from the disk (nothing on the disk is touched)."""
        gone = [x["id"] for x in self.library.items if (p := self.file_path(x)) and not p.exists()]
        for i in gone:
            self.library.remove(i)
        return web.json_response({"removed": len(gone), **json.loads((await self.h_results_get(req)).text)})

    async def h_file(self, req):
        item = self.library.get(req.match_info["id"])
        if not item:
            raise web.HTTPNotFound()
        f = item["file"]
        headers = {}
        if req.query.get("download"):
            headers["Content-Disposition"] = f'attachment; filename="{f["filename"]}"'
        path = self.file_path(item)
        if path and path.exists():
            return web.FileResponse(path, headers=headers)
        # output folder unknown: stream through ComfyUI
        params = {"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
        async with self.session.get(self.comfy + "/view", params=params) as r:
            if r.status != 200:
                raise web.HTTPNotFound(text="Файл не найден")
            resp = web.StreamResponse(headers={"Content-Type": r.headers.get("Content-Type", "video/mp4"), **headers})
            await resp.prepare(req)
            async for chunk in r.content.iter_chunked(1 << 16):
                await resp.write(chunk)
            return resp

    async def h_srcfile(self, req):
        """The file an enlarged result was made from (the 'before' of the before/after slider)."""
        item = self.library.get(req.match_info["id"])
        if not item:
            raise web.HTTPNotFound()
        src = self.library.get(item.get("src") or "")
        if src and (p := self.file_path(src)) and p.exists():
            return web.FileResponse(p)
        f = item.get("src_file")
        if not f:
            raise web.HTTPNotFound()
        async with self.session.get(self.comfy + "/view", params=f) as r:
            if r.status != 200:
                raise web.HTTPNotFound(text="Исходный файл не найден")
            body = await r.read()
            return web.Response(body=body, content_type=r.headers.get("Content-Type", "application/octet-stream"))
