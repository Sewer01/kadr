"""Модели и ноды ComfyUI: что видно, что подходит
    режиму, что докачать и какой вариант выбрать. Методы перенесены из app/server.py без
    правок."""

from aiohttp import web
from pathlib import Path
from paths import ROOT
import aiohttp
import asyncio
import catalog
import engine
import webbrowser


class ModelsMixin:
    """Методы области «models»."""

    async def h_nodes(self, _req):
        try:
            return web.json_response({"nodes": await self.nodes_status()})
        except aiohttp.ClientError:
            return web.json_response({"error": "ComfyUI не отвечает"}, status=503)

    async def h_models_files(self, req):
        """Files ComfyUI sees in the folder this model role lives in, for picking one by hand."""
        role = req.query.get("role", "")
        if role not in catalog.VARIANTS:
            raise web.HTTPBadRequest(text="Неизвестная модель")
        cat = next(iter(catalog.VARIANTS[role].values()))["category"]
        try:
            _, lst = await self.comfy_json("GET", f"/models/{cat}")
        except Exception:
            raise web.HTTPServiceUnavailable(text="ComfyUI не отвечает")
        return web.json_response({"files": lst or [], "folder": cat})

    async def h_models_download(self, req):
        """Own ComfyUI: download missing model files of the app's catalog into the user's models folder (resumable)."""
        body = await req.json()
        managed = self.config.get("engine") == "managed"
        if managed:  # the app's own ComfyUI: the folder is known
            folder = str(Path(self.config.get("install_dir") or "") / catalog.COMFY_DIRNAME / "ComfyUI" / "models")
        else:
            folder = (body.get("folder") or self.config.get("ext_models_dir") or "").strip()
        p = Path(folder) if folder else None
        if not p or not p.is_dir():
            raise web.HTTPBadRequest(text="Папка не найдена. Укажите папку models вашего ComfyUI.")
        if not any((p / sub).is_dir() for sub in ("diffusion_models", "loras", "vae", "text_encoders", "checkpoints")):
            raise web.HTTPBadRequest(text="Это не похоже на папку models ComfyUI: внутри нет diffusion_models, loras, vae. Выберите папку, где они лежат.")
        if getattr(self, "dl_task", None) and not self.dl_task.done():
            raise web.HTTPConflict(text="Скачивание уже идёт. Дождитесь окончания или остановите его.")
        choice = self.choice()
        roles = [r for r in (body.get("roles") or [body.get("role")]) if r in catalog.VARIANTS and r in choice]
        if not roles:
            raise web.HTTPBadRequest(text="Неизвестная модель")
        if not managed:
            self.config.update(ext_models_dir=str(p))
        entries = [catalog.model_entry(r, choice[r]) for r in roles]

        async def emit(ev):
            await self.broadcast({"type": "mdl", "state": ev.get("state"), "label": ev.get("label"),
                                  "done": ev.get("overall_done", ev.get("done")), "total": ev.get("overall_total", ev.get("total")),
                                  "index": ev.get("index"), "count": ev.get("count")})

        inst = engine.Installer(ROOT, self.session, emit)
        self.dl_installer = inst

        async def run():
            total = sum(e["size"] for e in entries)
            base = 0
            try:
                for i, e in enumerate(entries):
                    dest = p / e["category"] / Path(e["name"].replace("\\", "/"))
                    label = catalog.ROLE_TITLES.get(e["role"], e["role"])

                    async def emit_overall(ev, base=base, idx=i, label=label):
                        if ev.get("done") is not None:
                            ev = dict(ev, overall_done=base + ev["done"], overall_total=total, index=idx + 1, count=len(entries), label=label)
                        await emit(ev)
                    inst.emit = emit_overall
                    await inst.download(e["url"], dest, "models", label, e["size"], sha256=catalog.file_sha256(e["url"]))
                    base += e["size"]
                await self.resolve_models()
                await self.broadcast({"type": "mdl", "state": "done", "label": "Готово: файлы скачаны и лежат в вашей папке моделей"})
            except engine.Cancelled:
                await self.broadcast({"type": "mdl", "state": "error", "label": "Скачивание остановлено. Скачанное сохранено: нажмите «Скачать» снова, и оно продолжится."})
            except Exception as ex:
                await self.broadcast({"type": "mdl", "state": "error", "label": str(ex)[:300]})
        self.dl_task = asyncio.create_task(run())
        return web.json_response({"ok": True, "folder": str(p), "count": len(entries), "size": sum(e["size"] for e in entries)})

    async def h_models_download_cancel(self, _req):
        inst = getattr(self, "dl_installer", None)
        if inst:
            inst.cancelled = True
        return web.json_response({"ok": True})

    async def h_models_open(self, req):
        """Open the download page of a model in the browser (only links of the app's own catalog)."""
        body = await req.json()
        role = body.get("role")
        if role not in catalog.VARIANTS:
            raise web.HTTPBadRequest(text="Неизвестная модель")
        url = catalog.VARIANTS[role][self.choice().get(role) or next(iter(catalog.VARIANTS[role]))]["url"]
        url = engine.mirrored(url)
        webbrowser.open(url)
        return web.json_response({"ok": True, "url": url})

    async def h_models_compat(self, req):
        """Does an own model file fit the mode it is picked in (the speed-up files are made for one family of models)."""
        role, name, mode = req.query.get("role", ""), req.query.get("name", ""), req.query.get("mode", "")
        if role not in catalog.VARIANTS:
            raise web.HTTPBadRequest(text="Неизвестная модель")
        if self.hw is None:
            self.hw = await asyncio.to_thread(engine.detect_hardware)
        notes = catalog.compat_notes(mode, role, name or self.model_names.get(role, ""), self.hw.get("compute_cap") or 0)
        missing = {m["role"] for m in self.missing}
        want = catalog.MODE_ROLES.get(mode, []) + catalog.MODE_OPTIONAL.get(mode, [])
        if any(r in missing for r in want):
            # the scan happens once at start: a file downloaded since then is on the disk, and the
            # chips kept offering "Скачать" for a LoRA that is already there
            await self.resolve_models()
            missing = {m["role"] for m in self.missing}
        picked = self.config.get("model_pick") or {}
        loras = [{"role": r, "title": catalog.ROLE_TITLES.get(r, r), "name": self.model_names.get(r, ""), "have": r not in missing,
                  "must": r in catalog.MODE_ROLES.get(mode, []), "mine": r in picked}
                 for r in catalog.MODE_ROLES.get(mode, []) + catalog.MODE_OPTIONAL.get(mode, []) if r.endswith("_lora") and r in self.model_names]
        if any(not l["have"] for l in loras):
            # the list of files is scanned once at start, and while the core is loading a model that
            # scan is skipped to keep the answer fast: a chip then kept offering to download a LoRA
            # that had long been on the disk. Asked about a LoRA we believe is missing, look again -
            # with a real timeout and by file name, so a subfolder does not hide it
            _, seen = await self.comfy_json("GET", "/models/loras", timeout=aiohttp.ClientTimeout(total=25))
            names = {str(x).replace("/", "\\").split("\\")[-1].lower() for x in (seen or [])}
            gone = set()
            for l in loras:
                e = None
                if l.get("role") and l["role"] in catalog.VARIANTS:
                    e = catalog.model_entry(l["role"], self.choice().get(l["role"]) or next(iter(catalog.VARIANTS[l["role"]])))
                if not l["have"] and e and {e["file"].lower(), *catalog.FILE_ALIASES.get(e["file"], ())} & names:
                    l["have"] = True
                    gone.add(l["role"])
            if gone:
                self.missing = [m for m in self.missing if m["role"] not in gone]
        loras += [{"title": "Своя LoRA", "name": x["file"], "have": True, "must": False, "mine": True, "custom": True,
                   "fits": mode in (x.get("also") or []) or catalog.lora_fits_mode(x["file"], mode),
                   "family": catalog.lora_family(x["file"]) or "неизвестная",
                   "off": mode in (x.get("skip") or [])
                          or (mode not in (x.get("also") or []) and not catalog.lora_fits_mode(x["file"], mode))}
                  for x in self.unique_loras() if x.get("on", True)]
        return web.json_response({"notes": [{"level": lv, "text": t} for lv, t in notes], "loras": loras,
                                  "picked": picked.get(role), "name": self.model_names.get(role),
                                  "unknown": not self.model_names})

    async def h_models_have(self, req):
        """Is one role's file present right now. A section asks this before it offers a download:
        guessing from the list of own LoRA said "missing" for a file that was on disk, and the offer
        came back again and again."""
        role = req.query.get("role") or ""
        if role not in catalog.VARIANTS:
            raise web.HTTPBadRequest(text="Неизвестная модель")
        if req.query.get("fresh") or not self.model_names or role not in self.model_names:
            await self.resolve_models()
        have = role in (self.model_names or {}) and role not in {m["role"] for m in self.missing}
        entry = catalog.model_entry(role, self.choice()[role])
        return web.json_response({"have": have, "role": role, "name": (self.model_names or {}).get(role, ""),
                                  "size": entry["size"], "slow": bool(getattr(self, "models_slow", False))})

    async def h_models_pick(self, req):
        body = await req.json()
        role, name = body.get("role"), body.get("name") or ""
        if role not in catalog.VARIANTS:
            raise web.HTTPBadRequest(text="Неизвестная модель")
        if name and not body.get("force") and not catalog.looks_right(role, name):
            title = catalog.ROLE_TITLES.get(role, role)
            return web.json_response({"ok": False, "warn": (
                f"Название файла «{name.replace('/', chr(92)).split(chr(92))[-1]}» не похоже на нужное для «{title}». "
                f"В названии обычно есть {catalog.marks_text(role)}. Если выбрать не тот файл, генерация сломается с "
                f"непонятной ошибкой. Всё равно выбрать этот файл?")})
        picks = dict(self.config.get("model_pick") or {})
        if name:
            picks[role] = name
        else:
            picks.pop(role, None)
        self.config.update(model_pick=picks)
        await self.resolve_models()
        return web.json_response({"ok": True})

    async def h_models_variant(self, req):
        """Use another version of the same model (Singularity v1.3 -> v2, a lighter one...). The file is fetched by "Докачать"."""
        body = await req.json()
        role, variant = body.get("role"), body.get("variant") or ""
        if role not in catalog.VARIANTS or (variant and variant not in catalog.VARIANTS[role]):
            raise web.HTTPBadRequest(text="Неизвестная версия модели")
        over = dict(self.config.get("choice_override") or {})
        if variant:
            over[role] = variant
        else:
            over.pop(role, None)
        picks = dict(self.config.get("model_pick") or {})
        picks.pop(role, None)  # a file picked by hand belonged to the old choice
        self.config.update(choice_override=over, model_pick=picks)
        await self.resolve_models()
        entry = catalog.model_entry(role, self.choice()[role])
        have = role not in {m["role"] for m in self.missing}
        return web.json_response({"ok": True, "have": have, "size": entry["size"], "file": entry["file"]})
