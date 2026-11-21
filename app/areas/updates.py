"""Обновления: установщик приложения, ядро ComfyUI и
    паки нод, с откатом и журналом. Методы перенесены из app/server.py без правок."""

from aiohttp import web
from applog import applog
from paths import DATA_DIR
import asyncio
import catalog
import engine
import os
import subprocess
import updater
import updates


class UpdateMixin:
    """Методы области «updates»."""

    async def h_update_check(self, _req):
        info = await updater.check(self.session)
        self.update_info = info if info.get("available") else None
        return web.json_response({**{k: v for k, v in info.items() if k not in ("asset", "sha256")},
                                  "can_update": updater.can_update()})

    async def h_update_progress(self, _req):
        """How much of the installer has arrived. The update request itself only answers at the end,
        so without this the window would sit in silence for the whole download."""
        return web.json_response(dict(updater.PROGRESS))

    async def h_update_install(self, _req):
        info = getattr(self, "update_info", None)
        if not info or not updater.can_update():
            raise web.HTTPBadRequest(text="Обновление недоступно")
        if self.jobs:
            raise web.HTTPConflict(text="Сейчас идёт генерация. Дождитесь её конца и нажмите «Обновить» снова.")
        try:
            updater.PROGRESS.clear()
            updater.PROGRESS.update(done=0, total=int(info.get("size") or 0))
            installer = await updater.download(self.session, info, updater.PROGRESS)
        except Exception as e:
            raise web.HTTPBadGateway(text=str(e))
        updater.run(installer)
        # the installer is already running on its own: leave, so it can replace the files and open the app again
        asyncio.get_running_loop().call_later(3, lambda: os._exit(0))
        return web.json_response({"ok": True})

    async def h_comfy_update(self, _req):
        """Кнопка «Обновить ComfyUI»: запускает ШТАТНЫЙ update_comfyui.bat встроенной сборки -
           обычный, не _stable и не _and_python_dependencies: те могут заменить PyTorch на CPU-сборку,
           после чего ComfyUI уже не запустится с видеокартой."""
        if self.config.get("engine") != "managed":
            return web.json_response({"error": "Обновление ComfyUI из программы работает только для встроенного ComfyUI."}, status=400)
        if self.installer or getattr(self, "comfy_updating", False):
            return web.json_response({"error": "Сейчас идёт установка или обновление. Дождитесь конца."}, status=409)
        root = self.comfy_root()
        bat = root / "update" / "update_comfyui.bat"
        if not bat.exists():
            return web.json_response({"error": "Не найден файл update\\update_comfyui.bat во встроенном ComfyUI."}, status=404)
        self.comfy_updating = True
        applog("обновление ComfyUI: запускаем штатный скрипт сборки")
        try:
            before = None
            try:
                before = (await self.system_stats())["system"].get("comfyui_version")
            except Exception:
                pass
            if self.process:
                await asyncio.to_thread(self.process.stop)

            def run():
                # аргумент нужен, чтобы .bat пропустил свою «pause» в конце и не ждал нажатия кнопки
                p = subprocess.run(["cmd", "/c", "update_comfyui.bat", "nopause"], cwd=bat.parent, capture_output=True,
                                   timeout=1200, creationflags=engine.CREATE_NO_WINDOW, env=engine.local_env(root))
                return p.returncode, (p.stdout or b"").decode("cp866", "replace") + (p.stderr or b"").decode("cp866", "replace")
            try:
                code, out = await asyncio.to_thread(run)
            except Exception as e:
                code, out = -1, f"{type(e).__name__}: {e}"
            self.start_managed()
            try:
                await self.wait_comfy()
            except Exception as e:
                applog("обновление ComfyUI: после обновления ядро не поднялось - " + str(e)[:120])
            after = None
            try:
                after = (await self.system_stats())["system"].get("comfyui_version")
            except Exception:
                pass
            await self.resolve_models()
            applog(f"обновление ComfyUI: код {code} · было {before} → стало {after}")
            return web.json_response({"ok": code == 0, "code": code, "before": before, "after": after,
                                      "log": out[-3000:].replace("\r", "")})
        finally:
            self.comfy_updating = False

    # ---------- updates of the engine and of the node packs ----------

    async def h_updates_check(self, _req):
        """What is newer upstream: ComfyUI itself and the node packs pinned in the catalog."""
        return web.json_response(await updates.check(self.session, self.comfy_root(), data_dir=DATA_DIR))

    async def h_updates_state(self, _req):
        return web.json_response(getattr(self, "update_state", None) or {"stage": "idle"})

    async def h_updates_core(self, req):
        """Update the core code from the release tag, keeping models, nodes and user data.

        The portable package is two gigabytes and unpacking it over the install would also replace
        custom_nodes; the source of the same release is tens of megabytes and is exactly what a
        manual ComfyUI install updates itself with. Files we are about to overwrite go into a zip
        in the data folder first, and the same place offers to put them back.
        """
        if not self.comfy_root():
            return web.json_response({"error": "Папка ComfyUI не найдена"}, status=409)
        if self.installer:
            return web.json_response({"error": "Сначала дождитесь конца установки"}, status=409)
        if self.jobs:
            return web.json_response({"error": "Идёт генерация: дождитесь её конца"}, status=409)
        body = {}
        try:
            body = await req.json()
        except Exception:
            pass                      # an empty body is fine: the newest release is the target
        want = str(body.get("version") or "")
        if want and want != catalog.COMFY_VERSION and not body.get("ack"):
            return web.json_response({"error": f"ComfyUI {want} не проверен с нодами программы: "
                                               f"программа отвечает за {catalog.COMFY_VERSION}"}, status=409)
        self.core_update_task = asyncio.create_task(self.run_core_update(want))
        return web.json_response({"ok": True})

    async def h_updates_core_rollback(self, _req):
        root = self.comfy_root()
        if not root:
            return web.json_response({"error": "Папка ComfyUI не найдена"}, status=409)
        if self.process:
            await asyncio.to_thread(self.process.stop)
            self.process = None
        try:
            name = await asyncio.to_thread(updates.rollback, root, DATA_DIR)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        await asyncio.to_thread(self.wake_comfy)
        applog(f"ядро возвращено из копии {name}")
        return web.json_response({"ok": True, "from": name})

    async def run_core_update(self, want):
        root = self.comfy_root()
        st = self.update_state = {"stage": "checking", "pct": 0, "error": None, "version": want}
        try:
            if not st["version"]:
                # no version asked for: the one the program is built and checked with, not the newest
                st["version"] = catalog.COMFY_VERSION
            st["stage"] = "downloading"
            archive = DATA_DIR / "tmp" / f"comfyui-{st['version']}.tar.gz"
            archive.parent.mkdir(parents=True, exist_ok=True)

            async def progress(got, total):
                st["pct"] = round(got * 100 / total) if total else 0

            archive = await updates.download(self.session, updates.source_url(st["version"]), archive, progress)
            st["stage"] = "backup"
            mark = await asyncio.to_thread(updates.backup_source, root, DATA_DIR)
            st["backup"] = mark.name
            if self.process:
                await asyncio.to_thread(self.process.stop)
                self.process = None
            st["stage"] = "installing"
            files = await asyncio.to_thread(updates.apply_source, root, archive)
            archive.unlink(missing_ok=True)
            # new core code asks for newer python packages: install what its own requirements.txt pins,
            # otherwise the update leaves the engine half-broken (the fast enlargement died that way)
            st["stage"] = "deps"
            got = await engine.install_core_requirements(root)
            if not got["ok"]:
                applog(f"пакеты ядра после обновления не дошли: {got['msg'][:200]}")
            st.update(stage="done", pct=100, files=files, deps=got["ok"])
            await asyncio.to_thread(self.wake_comfy)
            applog(f"ядро обновлено до {st['version']}: файлов {files}, копия {mark.name}")
        except Exception as e:
            st.update(stage="error", error=f"{type(e).__name__}: {str(e)[:260]}")
            applog(f"обновление ядра не удалось: {type(e).__name__}: {str(e)[:200]}")
            await asyncio.to_thread(self.wake_comfy)

    async def h_updates_pack(self, req):
        """One node pack to the newest commit of its repository, keeping the old folder."""
        body = await req.json()
        name = str(body.get("name") or "")
        pack = next((x for x in catalog.NODE_PACKS if x["name"] == name), None)
        root = self.comfy_root()
        if not pack or not root:
            return web.json_response({"error": "Неизвестная нода или нет папки ComfyUI"}, status=400)
        if self.jobs:
            return web.json_response({"error": "Идёт генерация: дождитесь её конца"}, status=409)
        # the version the program was built and checked with, not the newest commit of the repository:
        # a pack from tomorrow can register routes the current ComfyUI core already has, and then the
        # engine does not start at all
        sha = pack.get("commit") or ""
        if not sha:
            head = await updates.gh_json(self.session, f"/repos/{pack['repo']}/commits?per_page=1")
            sha = ((head or [{}])[0]).get("sha") or ""
        if not sha:
            return web.json_response({"error": "GitHub не ответил"}, status=502)
        standing = ""
        try:                                   # what the folder holds now, as recorded on the last swap
            standing = ((root / "ComfyUI" / "custom_nodes" / pack["name"] / ".h3-applied").read_text(encoding="utf-8").split() or [""])[0]
        except OSError:
            pass
        if standing and sha.startswith(standing):
            return web.json_response({"ok": True, "commit": sha[:10], "already": True})
        archive = root / "downloads" / f'{pack["name"]}-{sha[:8]}.zip'
        if archive.exists() and archive.stat().st_size > 65536:
            pass                               # this commit lies here already - rewriting the same file is what failed
        else:
            try:
                archive = await updates.download(self.session, f"https://github.com/{pack['repo']}/archive/{sha}.zip", archive)
            except Exception as e:
                return web.json_response({"error": f"Скачать не удалось: {e}"}, status=502)
        if self.process:
            await asyncio.to_thread(self.process.stop)
            self.process = None
        try:
            kept = await asyncio.to_thread(updates.update_pack, root, pack, sha, archive)
        except Exception as e:
            await asyncio.to_thread(self.wake_comfy)
            return web.json_response({"error": str(e)}, status=500)
        await asyncio.to_thread(self.wake_comfy)
        applog(f"нода {name} переведена на {sha[:10]}" + (f", старая копия {kept}" if kept else ""))
        return web.json_response({"ok": True, "commit": sha[:10], "backup": kept})

    async def h_updates_pack_rollback(self, req):
        body = await req.json()
        try:
            back = await asyncio.to_thread(updates.rollback_pack, self.comfy_root(), str(body.get("name") or ""))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=404)
        if self.process:
            await asyncio.to_thread(self.process.stop)
            self.process = None
        await asyncio.to_thread(self.wake_comfy)
        applog(f"нода {body.get('name')} возвращена из {back}")
        return web.json_response({"ok": True, "from": back})

    async def h_core_log(self, _req):
        """The last lines of the ComfyUI log and of the program's own log: the screen says only
           "no answer", these two say why."""
        def tail(path, n):
            try:
                return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-n:])
            except OSError:
                return ""
        return web.json_response({"comfy": tail(DATA_DIR / "comfyui.log", 70), "app": tail(DATA_DIR / "app.log", 70),
                                  "data": str(DATA_DIR)})
