"""Ответы страницы на вопрос «что сейчас происходит»:
    статус очереди, нагрузка машины и видеокарты, сроки, журнал страницы, освобождение памяти,
    что записано внутри чужого файла. Методы перенесены из app/server.py без правок."""

from aiohttp import web
from applog import applog
from formutil import gpu_name
from paths import DATA_DIR, HOME, TIMINGS
import asyncio
import catalog
import engine
import forecast
import json
import mp4info
import re
import time


class StatusMixin:
    """Методы области «status»."""

    async def h_gpu(self, _req):
        """Живые показания видеокарты: загрузка, температура, питание. Нужны, чтобы сказать
        человеку не просто «работает», а почему работа идёт медленнее обычного."""
        now = time.time()
        if self._gpu_at and now - self._gpu_at < 2.0 and self._gpu_last is not None:
            return web.json_response(self._gpu_last)
        try:
            g = await asyncio.to_thread(self.monitor.gpu) or {}
        except Exception as e:
            return web.json_response({"error": str(e)[:120]})
        self._gpu_last, self._gpu_at = g, now
        return web.json_response(g)

    async def h_forecast(self, req):
        """Сколько такая работа обычно идёт на этой машине. Отвечаем только когда прогонов было
        достаточно: выдуманное число хуже молчания."""
        mode = (req.query.get("mode") or "").strip()
        try:
            sec = float(req.query.get("sec") or 0)
        except ValueError:
            sec = 0
        e = forecast.estimate(TIMINGS, mode, quality=(req.query.get("q") or "").strip(), sec=sec) or {}
        if e.get("secs", 0) < 20 or e.get("samples", 0) < 2:
            return web.json_response({"secs": 0, "samples": e.get("samples", 0)})
        return web.json_response(e)

    async def h_gate_off(self, _req):
        """Человек сам решает, пробовать ли при нехватке памяти. Согласие живёт три минуты и
        гаснет само: забытое «разрешить всё» оказалось бы хуже отказа."""
        self._gate_off = time.time() + 180
        return web.json_response({"ok": True, "for": 180})

    @staticmethod
    def graph_prompt(raw):
        """Внутри файла, который писал ComfyUI, лежит весь его график. Промпт оттуда - самое
        полезное, что можно сказать человеку про чужой клип."""
        try:
            g = json.loads(raw)
        except (TypeError, ValueError):
            return ""
        best = [""]

        def walk(x):
            if isinstance(x, dict):
                for k, v in x.items():
                    vals = v if isinstance(v, list) else [v]
                    if k in ("prompt", "text", "value"):
                        for it in vals:
                            if isinstance(it, str) and len(it) > len(best[0]):
                                best[0] = it
                    else:
                        walk(v)
            elif isinstance(x, list):
                for it in x:
                    walk(it)

        walk(g)
        return re.sub(r"\s+", " ", best[0]).strip()[:1200]

    async def h_mp4tag(self, req):
        """Что записано внутри присланного видео. Так чужой файл, который человек принёс
        продолживать, может рассказать, из какого он промпта и с каким сидом."""
        data = await req.read()
        if not data:
            return web.json_response({"tag": None})
        found = mp4info.tag(data[:8 << 20]) or mp4info.tag(data[-8 << 20:])
        raw = str(found.get("comment") or "")
        if raw.startswith("KADR1 "):
            try:
                return web.json_response({"tag": json.loads(raw[6:]), "made_by": "kadr"})
            except ValueError:
                pass
        # не наше: может, файл писал ComfyUI и оставил свой график с промптом внутри
        for key in ("prompt", "comment", "title"):
            val = str(found.get(key) or "")
            if val.strip().startswith("{"):
                got = self.graph_prompt(val)
                if got:
                    return web.json_response({"tag": {"prompt": got}, "made_by": "comfyui"})
        return web.json_response({"tag": None, "comment": raw[:300] or None})

    # ---------- HTTP handlers ----------

    STATUS_BUDGET = 14.0   # seconds: the page gives up at 25, so the answer must be ready before that

    async def h_status(self, _req):
        base = {"configured": bool(self.config.configured or self.comfy_override),
                "engine": self.config.get("engine"), "installing": bool(self.installer)}
        deadline = time.monotonic() + self.STATUS_BUDGET
        try:
            stats = await asyncio.wait_for(self.system_stats(), timeout=self.STATUS_BUDGET)
        except Exception:
            # ComfyUI is not up (yet): the page needs the flag and the mode list anyway, so that
            # «Настройки» is not an empty hole while the core is loading
            return web.json_response({**base, "online": False, "modes": self.modes(),
                                      "window_mode": self.config.get("window_mode") or "geo",
                "software_ui": bool(self.config.get("software_ui")),
                                      "can_restore": bool(self.config.get("setup_backup")),
                                      "probe": getattr(self, "probe", {"url": self.comfy})})
        dev = (stats.get("devices") or [{}])[0]
        self.models_error = None

        async def _models():
            try:
                await asyncio.wait_for(self.resolve_models(), timeout=12)
            except asyncio.TimeoutError:
                self.models_slow = True          # keep whatever we knew before rather than hang the page
            except Exception as e:               # a broken list is shown as a broken list, not as "no models"
                self.model_names, self.missing, self.models_error = {}, [], f"{type(e).__name__}: {e}"

        async def _relay():
            try:
                return await asyncio.wait_for(self.relay_ready(), timeout=5)
            except Exception:
                return None

        try:
            relay, _ = await asyncio.wait_for(asyncio.gather(_relay(), _models()),
                                              timeout=max(1.0, deadline - time.monotonic()))
        except asyncio.TimeoutError:
            # the core is alive but busy: what we knew before is better than a page that gives up
            relay, self.models_slow = None, True
            applog("статус: ядро отвечает, но список файлов не отдал вовремя")
        missing = {m["role"] for m in self.missing}
        needed = catalog.roles_for(self.modes())
        models = [{"role": role, "title": catalog.ROLE_TITLES.get(role, role), "name": getattr(self, "model_names", {}).get(role, ""),
                   "category": catalog.VARIANTS[role][variant]["category"],
                   "folder": catalog.VARIANTS[role][variant]["category"], "marks": catalog.marks_text(role),
                   "file": catalog.VARIANTS[role][variant]["file"], "url": engine.mirrored(catalog.VARIANTS[role][variant]["url"]),
                   "size": catalog.VARIANTS[role][variant]["size"], "have": role not in missing,
                   "needed": role in needed, "picked": role in (self.config.get("model_pick") or {}),
                   "modes": [m for m, roles in catalog.MODE_ROLES.items() if role in roles],
                   "lic": catalog.license_of(catalog.VARIANTS[role][variant]["url"])[0],
                   "lic_note": catalog.license_of(catalog.VARIANTS[role][variant]["url"])[1],
                   "variants": [{"key": k, "label": catalog.VARIANT_LABELS.get(role, {}).get(k, k), "size": v["size"],
                                 "current": k == variant, "have": v["file"] in getattr(self, "visible", {}).get(v["category"], ()),
                                  "lic": catalog.license_of(v["url"])[0], "lic_note": catalog.license_of(v["url"])[1]}
                                for k, v in catalog.VARIANTS[role].items()] if len(catalog.VARIANTS[role]) > 1 else []}
                  for role, variant in self.choice().items()
                  if role in needed or role in {r for roles in catalog.MODE_OPTIONAL.values() for r in roles}]
        choice = self.choice()
        # What a mode would really download: the roles it brings that no enabled mode brings yet,
        # minus the files that already lie in the model folders. The old estimate counted them even
        # when they were there, so «Добавить: Экшн-видео (+22,0 ГБ)» offered to fetch a model the
        # person already owns - and it looked like the models had disappeared.
        have = {str(f).rsplit("\\", 1)[-1].lower() for names in getattr(self, "visible", {}).values() for f in names}
        mine = set(catalog.roles_for(self.modes()))
        add_modes = {}
        for m in catalog.MODE_ROLES:
            if m in self.modes():
                continue
            need = 0
            for role in set(catalog.roles_for([m])) - mine:   # roles_for answers a list, mine is a set
                v = (catalog.VARIANTS.get(role) or {}).get(choice.get(role))
                if not v:
                    continue
                fname = str(v["file"]).rsplit("\\", 1)[-1].lower()
                al = {str(a).rsplit("\\", 1)[-1].lower() for a in catalog.FILE_ALIASES.get(v["file"], ())}
                if fname not in have and not (al & have):
                    need += v["size"]
            add_modes[m] = round(need / 1e9, 1)
        return web.json_response({
            **base, "online": True, "modes": self.modes(), "add_modes": add_modes,
            "hf_mirror": bool(self.config.get("hf_mirror")),
            "can_restore": bool(self.config.get("setup_backup")),
            "window_mode": self.config.get("window_mode") or "geo",
                "software_ui": bool(self.config.get("software_ui")),
            "probe": getattr(self, "probe", {"url": self.comfy}),
            "offer_modes": [{"mode": m, "gb": add_modes[m]} for m in catalog.OFFER_MODES
                            if m in add_modes and m not in (self.config.get("offered_modes") or [])],
            "gpu": gpu_name(dev.get("name", "")),
            "vram_total": dev.get("vram_total"), "vram_free": dev.get("vram_free"),
            "comfy_version": stats["system"].get("comfyui_version"),
            "relay_ok": relay,   # the UI offers the fast upscale only when the nodes exist
            "output_dir": str(self.output_dir) if self.output_dir else None, "data_dir": str(DATA_DIR),
            "paths": {"install": self.config.get("install_dir"), "models": self.config.get("models_dir"),
                      "ext_models": self.config.get("ext_models_dir"),
                      "assistant": str(self.llm.root), "data": str(DATA_DIR)},
            "models": models,
            "models_error": getattr(self, "models_error", None),
            "models_slow": bool(getattr(self, "models_slow", False)),
            "comfy": self.comfy,
        })

    async def h_system(self, _req):
        """CPU / RAM / GPU / disk readings for the sidebar.

        A sample can take seconds when the machine is busy; the sidebar asks every few seconds, and those
        requests used to stack up and make the whole window sluggish. While one is running, the previous
        answer is repeated."""
        if getattr(self, "_sys_busy", False):
            return web.json_response(getattr(self, "_sys_last", None) or {})
        self._sys_busy = True
        try:
            where = self.output_dir or self.config.get("install_dir") or HOME
            data = await asyncio.to_thread(self.monitor.sample, where)
            self._sys_last = data
            return web.json_response(data)
        finally:
            self._sys_busy = False

    async def h_ui_log(self, req):
        """One line from the page: what the studio decided, what broke in a script. Without this the
           page fails silently and the reason can only be guessed."""
        try:
            body = await req.json()
        except Exception:
            return web.json_response({"ok": False})
        text = str(body.get("text") or "").strip()[:300]
        if text:
            applog("страница: " + text)
        return web.json_response({"ok": True})

    async def h_comfy_free(self, req):
        """Hand the video memory back. BOTH holders are asked: ComfyUI keeps its models resident as a
        cache, and llama-server keeps the agent's model - either one alone can starve the other, and
        freeing only ComfyUI left the card full, which is what the person saw as «не освободилось»."""
        if getattr(self, "jobs", None):
            return web.json_response({"error": "Задание ещё идёт: память освободится, когда оно кончится"}, status=409)
        llm = False
        try:
            llm = bool(getattr(self, "llm", None) or getattr(self, "llm_proc", None) or getattr(self, "llama", None))
            await self.stop_llm()
        except Exception:
            pass
        try:
            await self.comfy_json("POST", "/free", json={"unload_models": True, "free_memory": True})
        except Exception as e:
            return web.json_response({"error": "ComfyUI не ответил: " + str(e)[:90]}, status=502)
        await asyncio.sleep(1.2)
        gpu = await asyncio.to_thread(self.monitor.gpu)
        return web.json_response({"used": (gpu or {}).get("vram_used_gb"), "llm": llm})
