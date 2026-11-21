"""Первый запуск и настройки: свой ComfyUI, установка
    недостающего, режимы, зеркало, окно и запуск движка. Методы перенесены из app/server.py без
    правок."""

from aiohttp import web
from applog import applog
from netutil import clean_comfy_url, comfy_is_local
from pathlib import Path
from paths import CLIENT_ID, ROOT
import asyncio
import catalog
import engine
import urllib.parse
import webbrowser


class SetupMixin:
    """Методы области «setup»."""

    async def h_mirror(self, req):
        on = bool((await req.json()).get("on"))
        self.config.update(hf_mirror=on)
        self.apply_mirror()
        return web.json_response({"ok": True, "on": on})

    # ---------- first-run setup ----------

    async def setup_emit(self, ev):
        if ev.get("state") == "error":
            self.note_error(f'Установка, шаг {ev.get("step")}: {ev.get("label")}')
        if ev.get("state") != "progress" or ev.get("step") != getattr(self, "_last_step", None):
            self.setup_log = (self.setup_log + [ev])[-40:]
        self._last_step = ev.get("step")
        self.setup_last = ev
        await self.broadcast(ev)

    async def h_setup_info(self, req):
        install_dir = req.query.get("install_dir") or self.config.get("install_dir") or engine.default_install_dir()
        modes = [m for m in (req.query.get("modes") or ",".join(catalog.MODE_ROLES)).split(",") if m in catalog.MODE_ROLES]
        hw = await asyncio.to_thread(engine.detect_hardware, install_dir)
        choice, notes, verdict, profile = catalog.choose_models(hw, req.query.get("profile"))
        plan = [catalog.model_entry(r, choice[r]) for r in catalog.roles_for(modes or ["video"])]
        need_gb = round((catalog.COMFY_SIZE * 2.5 + sum(m["size"] for m in plan)) / 1e9)
        # download size of each profile for each set of modes, for the size picker
        sizes = {}
        for p in catalog.PROFILES:
            c = catalog.choose_models(hw, p)[0]
            sizes[p] = {m: round(catalog.plan_size(c, [m]) / 1e9) for m in catalog.MODE_ROLES}
            sizes[p]["selected"] = round(catalog.plan_size(c, modes or ["video"]) / 1e9)
        return web.json_response({
            "hardware": hw, "choice": choice, "notes": notes, "verdict": verdict,
            "profile": profile, "recommended": catalog.recommended_profile(hw), "modes": modes,
            "profiles": {k: {"title": v["title"], "about": v["about"], "sizes": sizes[k]} for k, v in catalog.PROFILES.items()},
            "install_dir": install_dir, "need_gb": need_gb,
            "relay_ok": await self.relay_ready() if self.comfy_online else None,  # can this ComfyUI do the fast upscale
            "plan": [{k: m[k] for k in ("role", "title", "file", "size", "variant")} for m in plan],
            "config": {k: self.config.get(k) for k in ("engine", "install_dir", "models_dir", "comfy_url", "setup_done")},
            "can_restore": bool(self.config.get("setup_backup")),
            "installing": bool(self.installer), "log": self.setup_log,
            "last": getattr(self, "setup_last", None),
        })

    async def h_setup_external(self, req):
        body = await req.json()
        url = (body.get("url") or "http://127.0.0.1:8188").strip().rstrip("/")
        if not url.startswith("http"):
            url = "http://" + url
        old, old_key = self.config.get("comfy_url"), self.config.get("comfy_key")
        key = (body.get("key") or "").strip()
        pu = urllib.parse.urlparse(url)
        tok = (urllib.parse.parse_qs(pu.query).get("token") or [""])[0]
        remote = pu.hostname not in ("127.0.0.1", "localhost", "::1")
        base = f"{pu.scheme}://{pu.netloc}"
        if tok and not key:   # the whole link of a rented server was pasted («http://IP/?token=...»): take the key out of it
            key = tok
            if remote and not pu.port:
                base = f"{pu.scheme}://{pu.hostname}:8000"   # such a link opens the page; the API of the Immers.Cloud image is on port 8000
        url = base + ("/api" if pu.path.rstrip("/").endswith("/api") else "")   # a path or a query in the pasted address is dropped
        url, err = clean_comfy_url(url)   # the address is checked before a single line is written into the config
        if err:
            raise web.HTTPBadRequest(text=err)
        if not comfy_is_local(url) and not body.get("confirm"):
            # not this computer and not the local network: the user should know what leaves the machine
            return web.json_response({"need_confirm": f"{url} — это не этот компьютер и не локальная сеть. Программа "
                                      f"будет отправлять туда ваши промпты, картинки и аудио и выполнять то, что он "
                                      f"ответит. Подключить?"})
        self.config.data["comfy_key"] = key
        if self.process:   # switching to someone else's ComfyUI: the core WE started must not stay
                           # in the background holding all the video memory with nobody owning it
            await asyncio.to_thread(self.process.stop)
            applog("переключение на внешний ComfyUI: своё ядро остановлено")
        self.process = None
        stats, last_err, used = None, None, url
        # a rented server may publish the API only under «/api» (as the Immers.Cloud image does): try both
        for cand in ([url] + ([url + "/api"] if remote and not url.rstrip("/").endswith("/api") else [])):
            self.config.data["comfy_url"] = cand
            try:
                stats = await self.system_stats()
                used = cand
                break
            except Exception as e:
                last_err = e
        if stats is None:
            self.config.data["comfy_url"] = old
            self.config.data["comfy_key"] = old_key
            hint = " Если сервер арендован: проверьте ключ, что порт открыт в брандмауэре самой машины (для Immers.Cloud это порт 8000) и что адрес вида http://IP:8000." if remote else ""
            return web.json_response({"error": f"ComfyUI не отвечает по адресу {url} ({type(last_err).__name__}). Откройте этот адрес "
                                      "в браузере: если страница ComfyUI не открывается, проверьте адрес и порт в окне, "
                                      "где запущен ComfyUI." + hint}, status=400)
        url = used
        ws_ok = True
        try:   # progress and «done» of every job come over the WebSocket: with a rented server it may be blocked by its proxy
            async with self.session.ws_connect(url.replace("http", "ws", 1) + f"/ws?clientId={CLIENT_ID}", timeout=8) as _ws:
                pass
        except Exception:
            ws_ok = False
        if self.process:  # the ComfyUI the program started itself: stop it instead of forgetting about it
            await asyncio.to_thread(self.process.stop)
            self.process = None
        self.config.update(comfy_key=key)
        modes = [m for m in (body.get("modes") or []) if m in catalog.MODE_ROLES] or list(catalog.MODE_ROLES)
        self.config.update(engine="external", comfy_url=url, setup_done=True, choice=catalog.DEFAULT_CHOICE, modes=modes)
        names, missing = await self.resolve_models()
        try:
            nodes = [n["pack"] for n in await self.nodes_status() if not n["have"] and not n["optional"]]
        except Exception:
            nodes = []
        return web.json_response({"ok": True, "version": stats["system"].get("comfyui_version"), "url": url, "ws_ok": ws_ok,
                                  "missing": [m["file"] for m in missing], "nodes_missing": nodes})

    async def h_mode_offered(self, req):
        mode = (await req.json()).get("mode")
        self.config.update(offered_modes=sorted(set(self.config.get("offered_modes") or []) | {mode}))
        return web.json_response({"ok": True})

    async def h_mode_add(self, req):
        """Own ComfyUI: switch on a mode added after the set-up, so its model files show up in Models (with download buttons)."""
        mode = (await req.json()).get("mode")
        if mode not in catalog.MODE_ROLES:
            return web.json_response({"error": "Неизвестный режим"}, status=400)
        modes = sorted(set(self.modes()) | {mode}, key=list(catalog.MODE_ROLES).index)
        self.config.update(modes=modes)
        await self.resolve_models()
        return web.json_response({"ok": True})

    async def h_setup_install(self, req):
        if self.installer:
            return web.json_response({"error": "Установка уже идёт"}, status=409)
        body = await req.json()
        install_dir = str(Path(body.get("install_dir") or engine.default_install_dir()))
        models_dir = (body.get("models_dir") or "").strip() or None
        if models_dir and not Path(models_dir).is_dir():
            return web.json_response({"error": f"Папка не найдена: {models_dir}"}, status=400)
        hw = await asyncio.to_thread(engine.detect_hardware, install_dir)
        profile = body.get("profile") or self.config.get("profile")
        choice, _, verdict, profile = catalog.choose_models(hw, profile)
        choice = {**choice, **(self.config.get("choice_override") or {})}  # a version the user picked by hand stays
        modes = [m for m in (body.get("modes") or self.modes()) if m in catalog.MODE_ROLES] or ["video"]
        if body.get("add_mode"):
            modes = sorted(set(self.modes()) | {body["add_mode"]}, key=list(catalog.MODE_ROLES).index)
        self.config.update(engine="managed", install_dir=install_dir, models_dir=models_dir,
                           choice=choice, profile=profile, modes=modes, setup_done=False)
        self.setup_log = []
        self.installer = engine.Installer(ROOT, self.session, self.setup_emit)
        self.installer.task = asyncio.create_task(self.run_install(install_dir, models_dir))
        return web.json_response({"ok": True})

    async def run_install(self, install_dir, models_dir):
        inst = self.installer
        try:
            Path(install_dir).mkdir(parents=True, exist_ok=True)
            root = await inst.install_comfy(install_dir)
            await inst.install_nodes(root)
            if models_dir:
                inst.write_extra_paths(root, models_dir)
            await inst.step("start", "progress", label="Запускаем ComfyUI…")
            if self.process:
                await asyncio.to_thread(self.process.stop)
            await asyncio.to_thread(self.start_managed)
            await self.wait_comfy()
            await inst.step("start", "done", label="ComfyUI запущен")
            _, missing = await self.resolve_models()
            # shared files and the video mode first, so the first mode is usable sooner
            order = ["text_encoder", "video_vae", "audio_vae", "preview", "fast_unet"]
            missing.sort(key=lambda m: order.index(m["role"]) if m["role"] in order else len(order))
            if missing:
                gb = sum(m["size"] for m in missing) / 1e9
                await inst.step("models", "progress", label=f"Скачиваем модели: {len(missing)} файлов, {gb:.0f} ГБ")
                await inst.download_models(root / "ComfyUI" / "models", missing)
                await self.resolve_models()
            else:
                await inst.step("models", "done", label="Все модели уже есть")
            self.config.update(setup_done=True)
            await self.setup_emit({"type": "setup", "step": "finish", "state": "done", "label": "Готово!"})
        except engine.Cancelled:
            await self.setup_emit({"type": "setup", "step": "finish", "state": "cancelled",
                                   "label": "Установка остановлена. Скачанное сохранено — можно продолжить позже."})
        except Exception as e:
            await self.setup_emit({"type": "setup", "step": "finish", "state": "error", "label": str(e)})
        finally:
            self.installer = None

    async def h_open_driver(self, _req):
        webbrowser.open("https://www.nvidia.com/Download/index.aspx?lang=ru")
        return web.json_response({"ok": True})

    async def h_search_web(self, req):
        """Open a web search in the user's browser (missing model file / custom node in 'Свои workflow')."""
        body = await req.json()
        q = str(body.get("q", "")).strip()[:200]
        if not q:
            raise web.HTTPBadRequest(text="Пустой запрос")
        webbrowser.open("https://www.google.com/search?q=" + urllib.parse.quote_plus(q))
        return web.json_response({"ok": True})

    async def h_setup_cancel(self, _req):
        if self.installer:
            self.installer.cancelled = True
        return web.json_response({"ok": True})

    KEEP_ON_RESET = ("engine", "install_dir", "models_dir", "comfy_url", "comfy_key", "modes",
                     "choice", "choice_override", "profile")

    async def h_setup_reset(self, _req):
        """Back to the first-run wizard; installed files stay where they are, and so does the
           previous set-up: it goes into setup_backup, and /api/setup/restore puts it back. Without
           that way out one careless click on the «rent» card throws a working program to the wizard."""
        if self.installer:
            return web.json_response({"error": "Сначала остановите установку"}, status=409)
        if self.process:
            await asyncio.to_thread(self.process.stop)
            self.process = None
        if self.config.configured:
            self.config.update(setup_backup={k: self.config.get(k) for k in self.KEEP_ON_RESET})
        self.config.update(setup_done=False)
        return web.json_response({"ok": True})

    async def h_window_gpu_get(self, _req):
        return web.json_response({"software": bool(self.config.get("software_ui"))})

    async def h_window_gpu_set(self, req):
        body = await req.json()
        self.config.update(software_ui=bool(body.get("software")))   # main.py reads it at the next start
        return await self.h_window_gpu_get(req)

    async def h_window_mode(self, req):
        """How the window should open next time (the choice lives in Настройки → Интерфейс)."""
        try:
            body = await req.json()
        except Exception:
            return web.json_response({"error": "Не понял запрос"}, status=400)
        mode = str((body or {}).get("mode") or "")
        if mode not in ("geo", "max", "window", "fullscreen"):
            return web.json_response({"error": "Неизвестный режим окна"}, status=400)
        self.config.update(window_mode=mode)
        applog(f"окно при запуске: {mode}")
        return web.json_response({"ok": True, "mode": mode})

    async def h_engine_start(self, _req):
        """Start the local ComfyUI without restarting the whole program. Before this the core was
           started exactly once, at the app start, so after a set-up reset — which stops it — the
           screen said "engine not running" and the models list stayed empty until a restart."""
        if not (self.config.configured or self.comfy_override):
            return web.json_response({"error": "Сначала завершите настройку программы"}, status=409)
        if self.config.get("engine") != "managed":
            online = False
            try:
                await self.system_stats()
                online = True
            except Exception:
                pass
            return web.json_response({"ok": True, "online": online,
                                      "note": "ComfyUI запускаете вы сами: он внешний. "
                                              + ("Он отвечает." if online else "Он сейчас не отвечает.")})
        started = await asyncio.to_thread(self.wake_comfy)
        if started and self.missing_node_packs():   # node packs may be added by a newer app version
            self.packs_task = asyncio.create_task(self.install_missing_packs())
        return web.json_response({"ok": True, "starting": started,
                                  "note": "Запускаю ComfyUI: обычно с полминуты." if started else "ComfyUI уже работает."})

    async def h_setup_restore(self, _req):
        """Cancel the wizard: the set-up that was in place before it was opened."""
        backup = self.config.get("setup_backup") or {}
        if not backup:
            return web.json_response({"error": "Прежних настроек не найдено"}, status=409)
        self.config.update(**{k: v for k, v in backup.items() if v is not None}, setup_done=True)
        self.config.forget("setup_backup")
        # the reset stopped the core; without this the restored set-up would show an empty
        # model list until the person restarted the program
        await asyncio.to_thread(self.wake_comfy)
        return web.json_response({"ok": True, "starting": True})
