"""Ядро состояния: поля, запуск и остановка, дорога до ComfyUI,
    поток событий в окно и разбор формы. Здесь же то, чем пользуются несколько областей сразу:
    отправка файлов, путь к результату, имена режимов, вариант модели Сценариста. Общее живёт в базовом
    mixin, а не повторяется в областях; жизнь самого задания - в areas/jobs.py. Методы перенесены
    из app/server.py без правок."""

from aiohttp import web
from applog import applog
from datetime import datetime
from netutil import _ssl_context
from pathlib import Path
from paths import CLIENT_ID, DATA_DIR, LIBRARY_FILE, ROOT
from store import JobStore, Library
import agent as ag
import aiohttp
import asyncio
import catalog
import cloud
import datadir
import engine
import json
import monitor
import random
import re
import shutil
import sys
import time
import updates
import urllib.parse
import uuid
import workflows as wf


class CoreMixin:
    """Методы области «core»."""

    def __init__(self, comfy_override=None):
        self.config = engine.Config(DATA_DIR / "config.json")
        self.comfy_override = comfy_override.rstrip("/") if comfy_override else None
        self.session = None
        self.browsers = set()
        self.saved_queue = self.load_queue()  # unfinished jobs of the previous run (asked about at start)
        self.jobs = JobStore(self.save_queue)  # prompt_id -> job dict
        self.library = Library(LIBRARY_FILE)
        self.output_dir = None
        self.comfy_online = False
        self._relay_ok = None  # does this ComfyUI know the RelayVSR nodes (cached, see relay_ready)
        self._relay_at = 0.0
        self.token = uuid.uuid4().hex   # the key of this session: only our own window may ask the server to act
        self._index = None              # index.html with that key in it
        self._gpu_last = None           # последние показания видеокарты: опрашивать её каждый кадр дорого
        self._gpu_at = 0.0
        self._index_at = 0.0            # when that file was read: a fresh page must not need a restart
        self.process = None  # engine.ComfyProcess in managed mode
        self._bg = set()  # background tasks (kept so they are not garbage collected)
        self.installer = None
        self.setup_log = []  # last setup events, replayed to a reopened window
        self.model_names = {}  # role -> name as ComfyUI lists it
        self.missing = []  # catalog entries ComfyUI does not see
        self.skills = ag.Skills(ROOT / "skills", DATA_DIR / "skills", self.config)
        self.llm = ag.LlamaServer(self.llm_root(), DATA_DIR / "llama.log")
        self.agent_installer = None
        self.hw = None
        self.rh_models = None  # model paths found in the user's RunningHub workflow
        self.monitor = monitor.Monitor()
        self.recent_errors = []  # last problems, for the report to the author

    def llm_root(self):
        if self.config.get("llm_dir"):
            return Path(self.config.get("llm_dir"))
        if self.config.get("engine") == "managed" and self.config.get("install_dir"):
            return Path(self.config.get("install_dir")) / "llm"
        return DATA_DIR.parent / "llm"

    async def llm_variant(self):
        if not self.llm.alive():
            self.llm.root = self.llm_root()  # follows the install folder chosen in setup
            self.llm.custom = self.config.get("llm_custom")
        if self.config.get("llm_variant") in ag.LLM_VARIANTS:
            return self.config.get("llm_variant")
        if self.hw is None:
            self.hw = await asyncio.to_thread(engine.detect_hardware)
        return ag.pick_variant(self.hw)

    async def stop_llm(self):
        if self.llm.alive():
            await asyncio.to_thread(self.llm.stop)

    @property
    def comfy(self):
        if self.comfy_override:
            return self.comfy_override
        if self.process:
            return self.process.url
        return self.config.get("comfy_url", "http://127.0.0.1:8188").rstrip("/")

    def comfy_root(self):
        d = self.config.get("install_dir")
        if not d:
            return None
        fixed = datadir.normalise_install_dir(d)
        if fixed != d:   # the folder named in the settings IS ComfyUI: remember its parent once
            self.config.data["install_dir"] = fixed
            applog(f"путь установки поправлен: {d} → {fixed} (там лежит ComfyUI, а не куда ставить)")
        return Path(fixed) / catalog.COMFY_DIRNAME

    def _ffmpeg(self):
        """The decoder that ships with the ComfyUI portable: the browser window cannot read HEVC or
        an unusual container, so the picture a video continues from is taken with a real ffmpeg."""
        r = self.comfy_root()
        if not r:
            return None
        for pat in ("python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-*.exe", "**/ffmpeg.exe"):
            for p in sorted(r.glob(pat), reverse=True):
                if p.is_file():
                    return p
        w = shutil.which("ffmpeg")
        return Path(w) if w else None

    def choice(self):
        raw = {**catalog.DEFAULT_CHOICE, **(self.config.get("choice") or {}), **(self.config.get("choice_override") or {})}
        # a role or a variant renamed in catalog used to raise KeyError in /api/status (the interface then said
        # "engine offline") and the same KeyError was swallowed in the ComfyUI loop: drop what catalog does not
        # know and fall back to the default variant of that role
        out = {}
        for role, variant in raw.items():
            variants = catalog.VARIANTS.get(role)
            if not variants:
                continue
            out[role] = variant if variant in variants else catalog.DEFAULT_CHOICE.get(role, next(iter(variants)))
        return out

    def modes(self):
        modes = [m for m in (self.config.get("modes") or catalog.MODE_ROLES) if m in catalog.MODE_ROLES]
        if "actor" not in modes and ("refs" in modes or "lipsync" in modes):
            modes.append("actor")  # same models, so set-ups made before this mode existed get it too
        if "swap" not in modes and "refs" in modes:
            modes.append("swap")   # character-swap preset: References models + a 0.16 GB LoRA, fetched by "Докачать"
        return modes + [m for m in getattr(self, "auto_modes", ()) if m not in modes]

    # ---------- ComfyUI connection ----------

    def apply_mirror(self):
        engine.HF_MIRROR = "hf-mirror.com" if self.config.get("hf_mirror") else ""

    def awake_loop(self):
        """While generations are queued or running (and for ten minutes after the last one), Windows is not allowed to go to sleep:
        a long video made scene after scene overnight must not be stopped by the power plan. The screen may still switch off."""
        import ctypes
        import time
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        last_busy = 0.0
        while True:
            if self.jobs:
                last_busy = time.time()
            keep = time.time() - last_busy < 600
            try:
                ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if keep else 0))
            except Exception:
                return
            time.sleep(15)

    async def start(self, _app):
        if sys.platform == "win32":
            import threading
            threading.Thread(target=self.awake_loop, daemon=True, name="keep-awake").start()
        self.apply_mirror()
        trace = aiohttp.TraceConfig()

        async def _comfy_key(_s, _c, params):
            # key of a rented server: sent only to the ComfyUI address, never to other sites
            key = self.config.get("comfy_key")
            if key and params.url.host and params.url.host == urllib.parse.urlparse(self.comfy).hostname:
                params.headers["X-API-Key"] = key
                params.headers["Authorization"] = f"Bearer {key}"
        trace.on_request_start.append(_comfy_key)
        self.session = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=_ssl_context()), trace_configs=[trace])
        if self.config.get("engine") == "managed" and self.config.get("setup_done") and not self.comfy_override:
            if self.missing_node_packs():
                self.packs_task = asyncio.create_task(self.install_missing_packs())
            else:
                await asyncio.to_thread(self.start_managed)
        self.ws_task = asyncio.create_task(self.comfy_ws_loop())

    def missing_node_packs(self):
        """Own ComfyUI: node packs from the catalog that are not in its custom_nodes yet (a newer app version may need more)."""
        root = self.comfy_root()
        if not root:
            return []
        nodes_dir = root / "ComfyUI" / "custom_nodes"
        if not nodes_dir.is_dir():
            return []
        return [p["name"] for p in catalog.NODE_PACKS if not (nodes_dir / p["name"]).exists()]

    async def install_missing_packs(self):
        """Put the missing node packs in place, then start ComfyUI. Runs in the background so the app opens at once;
        ComfyUI is started even when the download fails (no internet), only the new sections stay unavailable."""
        async def quiet(_ev):
            pass
        try:
            await engine.Installer(ROOT, self.session, quiet).install_nodes(self.comfy_root())
        except Exception as e:
            print(f"Не удалось докачать ноды ({type(e).__name__}): {e}", file=sys.stderr)
        if not self.process:
            await asyncio.to_thread(self.start_managed)

    async def stop(self, _app):
        self.ws_task.cancel()
        if self.installer:
            self.installer.cancelled = True
        if self.process:
            await asyncio.to_thread(self.process.stop)
        await asyncio.to_thread(self.llm.stop)
        await self.session.close()

    def start_managed(self):
        root = self.comfy_root()
        if self.process and self.process.alive():   # replacing the handle would forget a live core: it
            self.process.stop()                     # keeps the port and the weights in video memory
            applog("перезапуск ядра: предыдущий процесс остановлен")
        self.process = engine.ComfyProcess(root, DATA_DIR / "comfyui.log")
        self.process.start()
        self.output_dir = root / "ComfyUI" / "output"

    async def wait_comfy(self, timeout=300):
        """Wait until ComfyUI answers; raise with its log if the process died."""
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            if self.process and not self.process.alive():
                tail = self.process.log_tail()
                hint = ("\n\nПохоже, проблема в драйвере видеокарты. Обновите драйвер NVIDIA (nvidia.com/drivers), "
                        "перезагрузите компьютер и нажмите «Продолжить».") if re.search(r"cuda|nvidia|driver", tail, re.I) else ""
                raise RuntimeError("ComfyUI не запустился:\n" + tail + hint)
            try:
                await self.system_stats()
                return
            except Exception:
                await asyncio.sleep(2)
        raise RuntimeError("ComfyUI долго не отвечает:\n" + (self.process.log_tail() if self.process else ""))

    async def resolve_models(self):
        """Match the chosen model files against what ComfyUI sees (any subfolder)."""
        visible = {}
        slow = False
        for cat in {v["category"] for variants in catalog.VARIANTS.values() for v in variants.values()}:
            try:
                # a short timeout on purpose: a core that is still booting answers slowly, and waiting
                # for it here is what used to freeze the whole status answer for minutes
                _, lst = await self.comfy_json("GET", f"/models/{cat}", timeout=aiohttp.ClientTimeout(total=6))
            except Exception:
                slow, lst = True, []
            visible[cat] = lst or []
        if slow and self.model_names:      # a core busy loading a model answers these slowly or not
            self.models_slow = True        # at all: keep what we knew rather than call every file
            return self.model_names, self.missing   # missing - that is what made the lists lie
        self.models_slow = slow
        self.visible = {cat: {n.replace("/", "\\").split("\\")[-1] for n in lst} for cat, lst in visible.items()}
        names, found, entries = {}, set(), {}
        for role, variant in self.choice().items():
            entry = entries[role] = catalog.model_entry(role, variant)
            picked = (self.config.get("model_pick") or {}).get(role)  # a file the user chose by hand
            def seen(file):
                ok = {file, *catalog.FILE_ALIASES.get(file, ())}  # same file under another name (e.g. upscaler from Hugging Face)
                return next((n for n in visible[entry["category"]] if n.replace("/", "\\").split("\\")[-1] in ok), None)
            others = {v["file"] for r, vs in catalog.VARIANTS.items() if r != role for v in vs.values()}
            if picked and picked.replace("/", "\\").split("\\")[-1] in others:  # the file of ANOTHER model of the app: never feed it to this role
                picked = None
            hit = picked if picked in visible[entry["category"]] else seen(entry["file"])
            if not hit and role not in (self.config.get("choice_override") or {}):  # another variant the user already has (v1.3 instead of v2); never for a version picked by hand
                hit = next(filter(None, (seen(v["file"]) for v in catalog.VARIANTS[role].values())), None)
            names[role] = hit or entry["name"]
            if hit:
                found.add(role)
        # modes added after a set-up was made: with your own ComfyUI they switch on by themselves when the files are there
        self.auto_modes = {m for m in ("krea", "kreareal", "qwen", "flux", "h3img", "upscale", "long") if self.config.get("engine") == "external"
                           and all(r in found for r in catalog.MODE_ROLES[m])}
        needed = catalog.roles_for(self.modes())
        missing = [entries[r] for r in needed if r in entries and r not in found]
        self.model_names, self.missing = names, missing
        return names, missing

    async def comfy_json(self, method, path, **kw):
        async with self.session.request(method, self.comfy + path, **kw) as r:
            body = await r.text()
            data = json.loads(body) if body else None
            return r.status, data

    def probe_note(self, ok, err=""):
        """What the last contact with ComfyUI gave: address, time, reason. The settings page shows
           it, so a silent blank becomes a fact a person can read and repeat to me."""
        prev = getattr(self, "probe", None) or {}
        self.probe = {"ok": bool(ok), "err": err, "at": time.strftime("%H:%M:%S"),
                      "fails": 0 if ok else (prev.get("fails") or 0) + 1, "url": self.comfy}
        if prev.get("ok") is not self.probe["ok"] or (not ok and self.probe["fails"] in (1, 5, 15, 40)):
            applog(f'ComfyUI {self.comfy}: ' + ("отвечает" if ok else f"нет ответа — {err}"))

    async def system_stats(self):
        try:
            status, data = await self.comfy_json("GET", "/system_stats", timeout=aiohttp.ClientTimeout(total=6))
            if status != 200 or not isinstance(data, dict) or "system" not in data:
                raise ValueError("no stats")
        except Exception as e:
            # some builds hide or slow down /system_stats; a queue answer still means ComfyUI is alive
            try:
                status, _ = await self.comfy_json("GET", "/queue", timeout=aiohttp.ClientTimeout(total=4))
            except Exception as e2:
                self.probe_note(False, f"{type(e2).__name__}: {e2}"[:200])
                raise
            if status != 200:
                self.probe_note(False, f"ComfyUI ответил HTTP {status}"[:200])
                raise
            self.probe_note(True)
            data = {"system": {}, "devices": []}
        self.probe_note(True)
        argv = data["system"].get("argv", [])
        if "--output-directory" in argv:
            self.output_dir = Path(argv[argv.index("--output-directory") + 1])
        return data

    async def comfy_ws_loop(self):
        while True:
            if not self.config.get("setup_done") and not self.comfy_override:
                await asyncio.sleep(2)
                continue
            ws_url = self.comfy.replace("http", "ws", 1) + f"/ws?clientId={CLIENT_ID}"
            try:
                async with self.session.ws_connect(ws_url, max_msg_size=0, heartbeat=20) as ws:
                    self.comfy_online = True
                    await self.resolve_models()
                    await self.broadcast({"type": "engine", "online": True})
                    await self.warn_weak_gpu()
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                await self.on_comfy_event(json.loads(msg.data))
                            except asyncio.CancelledError:
                                raise
                            except Exception as exc:
                                # a broken event must not drop the connection: the task would keep
                                # showing "running" in the window until the program restarts
                                self.note_error(f"Событие ComfyUI: {exc}")
                                await self.broadcast({"type": "notice", "text": "Программа не поняла сообщение ComfyUI"})
                        elif msg.type == aiohttp.WSMsgType.BINARY:
                            await self.on_comfy_binary(msg.data)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            if self.comfy_online:
                self.comfy_online = False
                await self.broadcast({"type": "engine", "online": False})
            await asyncio.sleep(2)

    async def warn_weak_gpu(self):
        """The 'max' profile (full ~32 GB Singularity) is meant for 24 GB cards. Say so once per run on a weaker card."""
        if getattr(self, "_weak_warned", False) or self.config.get("choice", {}).get("lipsync_unet") != "full":
            return
        try:
            if self.hw is None:
                self.hw = await asyncio.to_thread(engine.detect_hardware)
            vram = self.hw.get("vram_gb") or 0
        except Exception:
            return
        if 0 < vram < 24:
            self._weak_warned = True
            text = (f"Выбрана самая тяжёлая модель (профиль «Максимум»), а у видеокарты {vram:g} ГБ памяти: "
                    "генерация может зависать на первом шаге. Откройте «Настройки», выберите для «Клипа» и «Видеостудии» "
                    "облегчённую версию (pruned) и скачайте её.")
            self.note_error(text)
            await self.broadcast({"type": "notice", "text": text})

    async def broadcast(self, payload):
        text = json.dumps(payload, ensure_ascii=False)
        for b in list(self.browsers):
            try:
                await b.send_str(text)
            except Exception:
                self.browsers.discard(b)

    # ---------- helpers ----------

    def public(self, item):
        p = self.file_path(item)
        # a video deleted from disk stays in the list until the user removes it, but is marked
        return {k: v for k, v in item.items() if k != "file"} | {"url": f"/api/file/{item['id']}",
                                                                 "missing": bool(p) and not p.exists()}

    def file_path(self, item):
        if item["file"].get("type") == "local":
            return Path(item["file"]["path"])
        orig = None
        if self.output_dir and item["file"].get("type") == "output":
            orig = self.output_dir / item["file"].get("subfolder", "") / item["file"]["filename"]
        if orig and orig.exists():
            return orig
        local = item.get("local")   # the program's own copy: it stays when ComfyUI's output folder is cleaned
        if local and Path(local).exists():
            return Path(local)
        return orig

    # ---------- own copies of the results (they must not vanish when ComfyUI's output folder is cleaned) ----------

    def default_results_dir(self):
        """Videos\\Minimax H3\\output in the user's folder: it does not depend on where the program lies and survives updates."""
        return Path.home() / "Videos" / "Minimax H3" / "output"

    def results_dir(self):
        d = self.config.get("results_dir")
        return Path(d) if d else self.default_results_dir()

    def keep_copies(self):
        return self.config.get("keep_copies") is not False

    async def archive_item(self, item):
        """Copy the finished file of a library item into the program's own results folder."""
        if not self.keep_copies() or item.get("local") and Path(item["local"]).exists():
            return False
        f = item["file"]
        if f.get("type") == "local":
            return False
        try:
            dest_dir = self.results_dir()
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / f"{str(item.get('date', ''))[:10].replace('-', '')}_{item['id']}_{f['filename']}"
            src = self.output_dir / f.get("subfolder", "") / f["filename"] if self.output_dir and f.get("type") == "output" else None
            if src and src.exists():
                await asyncio.to_thread(shutil.copy2, src, dest)
            else:   # output folder unknown (own ComfyUI): take the file from ComfyUI itself
                params = {"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}
                async with self.session.get(self.comfy + "/view", params=params) as r:
                    if r.status != 200:
                        return False
                    with open(dest, "wb") as out:
                        async for chunk in r.content.iter_chunked(1 << 20):
                            out.write(chunk)
            item["local"] = str(dest)
            self.library.save()
            return True
        except Exception as e:
            self.note_error(f"Не удалось сохранить копию результата: {e}")
            return False

    async def put_input(self, name, raw, content_type, rh=None):
        """Кладёт готовые байты в папку input/h3studio своего ComfyUI (или отдаёт RunningHub) и
        возвращает имя, под которым файл видит ядро. Имя здесь своё, а не из формы: так им можно
        поделиться с графом, не имея за спиной загружаемой страницы."""
        if rh:
            try:
                return await rh.upload(name, raw, content_type)
            except cloud.CloudError as e:
                raise web.HTTPBadGateway(text=str(e))
        data = aiohttp.FormData()
        data.add_field("image", raw, filename=name, content_type=content_type)
        data.add_field("subfolder", "h3studio")
        data.add_field("type", "input")
        status, res = await self.comfy_json("POST", "/upload/image", data=data)
        if status != 200:
            raise web.HTTPBadGateway(text="Не удалось загрузить файл в ComfyUI")
        return f'{res["subfolder"]}/{res["name"]}' if res.get("subfolder") else res["name"]

    async def upload_input(self, field, rh=None):
        """Put an image/audio/video file into ComfyUI's input/h3studio folder (or upload it to RunningHub)."""
        name = f"h3s_{uuid.uuid4().hex[:8]}{Path(field.filename or 'img.png').suffix or '.png'}"
        content_type = field.headers.get("Content-Type", "application/octet-stream")
        raw = await field.read()
        if getattr(self, "_capture", None) is not None:
            self._capture[field.name] = (Path(field.filename or "x.png").suffix.lower() or ".png", raw)
        return await self.put_input(name, raw, content_type, rh)

    async def nodes_status(self):
        """Which custom nodes the chosen sections need, and whether this ComfyUI knows them."""
        modes = set(self.modes())
        out = []
        for c in catalog.NODE_CHECKS:
            used = [m for m in c["modes"] if m in modes]
            if not used:
                continue
            have = True
            for cls in c["classes"]:
                try:
                    status, data = await self.comfy_json("GET", f"/object_info/{cls}", timeout=aiohttp.ClientTimeout(total=8))
                    have = have and status == 200 and isinstance(data, dict) and cls in data
                except Exception:
                    have = False
            repo = catalog.node_repo(c["pack"])
            out.append({"pack": c["pack"], "have": have, "optional": c["optional"], "why": c["why"], "modes": used,
                        "url": f"https://github.com/{repo}"})
        return out

    async def relay_ready(self):
        """Does the running ComfyUI know the fast RelayVSR nodes?

        They belong to the ComfyUI core, but not to every build: an installed 0.43.0 and 0.44.0 do not have
        them. Nothing else checks this, so the mode used to send the graph and fail with "Node not found"
        deep in the queue, which looks to the user like a broken program. Checked once a minute.
        """
        now = time.monotonic()
        if self._relay_ok is not None and now - self._relay_at < 60:
            return self._relay_ok
        ok = True
        for cls in catalog.RELAY_CLASSES:
            try:
                status, data = await self.comfy_json("GET", f"/object_info/{cls}", timeout=aiohttp.ClientTimeout(total=8))
                ok = ok and status == 200 and isinstance(data, dict) and cls in data
            except Exception:
                ok = False
        self._relay_ok, self._relay_at = ok, now
        return ok

    def note_error(self, text):
        self.recent_errors = (self.recent_errors + [f"{datetime.now():%H:%M:%S} {text}"])[-15:]

    def wake_comfy(self):
        """Bring the local ComfyUI up if it is not up: the same path the app takes at start.
           Runs in a worker thread, so it only touches the process, never the event loop."""
        try:   # a copy of a pack left inside custom_nodes makes the engine refuse to start
            swept = updates.tidy_nodes(self.comfy_root())
            if swept:
                applog("убрал дубли нод из custom_nodes: " + ", ".join(swept))
        except Exception:
            pass
        if self.config.get("engine") != "managed" or self.comfy_override or self.installer:
            return False
        if self.process and self.process.alive():
            return False
        applog("запускаю ComfyUI по просьбе программы")
        self.start_managed()
        return True

    async def read_form(self, req, file_fields, need_prompt=True):
        form, files = {}, {}
        rh = self.rh()
        async for field in await req.multipart():
            if field.name in file_fields and field.filename:
                files[field.name] = await self.upload_input(field, rh)
            else:
                form[field.name] = await field.text()
        prompt = form.get("prompt", "").strip()
        aspect, quality = form.get("aspect", "16:9"), form.get("quality", "720p")
        if not prompt and need_prompt:
            raise web.HTTPBadRequest(text="Напишите промпт")
        if aspect not in wf.ASPECTS or quality not in wf.QUALITY:
            raise web.HTTPBadRequest(text="Неизвестный формат или качество")
        seed = int(form["seed"]) if form.get("seed", "").isdigit() else random.randrange(2 ** 50)
        return form, files, prompt, aspect, quality, seed

    async def need_models(self, mode):
        if self.rh():  # models live on RunningHub
            if not self.model_names:
                self.model_names = {r: catalog.VARIANTS[r][v]["name"] for r, v in self.choice().items()}
            return
        # FLUX.3 klein brings its own text encoder: the one the FLUX.2 mode uses gives embeddings of a
        # different width, and the core fails on the very first matrix multiply
        self.model_names["flux_clip3"] = catalog.VARIANTS["flux_clip"]["flux3_qwen"]["name"]
        if mode not in self.modes():
            raise web.HTTPBadRequest(text="Этот режим не установлен. Добавьте его в разделе «Настройки».")
        if not self.model_names:
            await self.resolve_models()
        lost = [m["file"] for m in self.missing if m["role"] in catalog.MODE_ROLES[mode]]
        if lost:
            raise web.HTTPBadRequest(text="ComfyUI не видит модели: " + ", ".join(lost)
                                     + ". Откройте раздел «Настройки».")

    def custom_loras(self, mode=None):
        """(file, strength) for the LoRAs the user added by hand on the Models screen (not used with the cloud).

        A LoRA can be switched off in one mode only - from the «Модель» row of that mode; the modes
        it skips live in its `skip` list.
        """
        if self.rh():
            return []
        return [(x["file"], float(x["strength"])) for x in self.unique_loras()
                if x.get("on", True) and x.get("file") and mode not in (x.get("skip") or [])
                and (mode in (x.get("also") or []) or catalog.lora_fits_mode(x["file"], mode))]

    def unique_loras(self):
        """The user's own LoRAs, one entry per file: older versions let the same file be added
        twice, and then it was mixed into the picture again and again."""
        seen, out = set(), []
        for x in self.config.get("custom_loras") or []:
            key = str(x.get("file") or "").replace("/", "\\").lower()
            if key and key not in seen:
                seen.add(key)
                out.append(x)
        return out

    async def item_bytes(self, item):
        """The file of a library item: from disk, or from ComfyUI when its output folder is not known to the app."""
        p = self.file_path(item)
        if p and p.exists():
            return await asyncio.to_thread(p.read_bytes)
        f = item["file"]
        async with self.session.get(self.comfy + "/view", params={
                "filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")}) as r:
            if r.status != 200:
                raise web.HTTPBadRequest(text="Не удалось найти один из клипов: он удалён с диска?")
            return await r.read()

    async def action_setup(self):
        """What the original action workflow needs and what this ComfyUI has."""
        if not self.model_names:
            await self.resolve_models()
        _, oi = await self.comfy_json("GET", "/object_info/SelfLiftH3Sampler")
        _, oi2 = await self.comfy_json("GET", "/object_info/H3SigmaRefiner")
        _, loras = await self.comfy_json("GET", "/models/loras")
        dmad = next((n for n in loras or [] if catalog.is_action_dmad(n)), None)
        missing = {m["role"] for m in self.missing}
        have_up = "action_upscaler" not in missing
        nodes = bool(oi) and bool(oi2)
        return {
            "faithful": nodes and have_up,
            "selflift": bool(oi), "refiner": bool(oi2), "refiner_def": (oi2 or {}).get("H3SigmaRefiner"),
            "upscaler": have_up, "dmad": dmad,
            "speed": None if "speed_slider_lora" in missing else self.model_names.get("speed_slider_lora"),
        }

    async def h_events(self, req):
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(req)
        self.browsers.add(ws)
        await ws.send_str(json.dumps({"type": "engine", "online": self.comfy_online}))
        try:
            async for _ in ws:
                pass
        finally:
            self.browsers.discard(ws)
        return ws

    def agent_ctx(self):
        """Context the agent runs with: the person's dial first, the model's shipped size else."""
        try:
            v = int(self.config.get("llm_ctx") or 0)
        except (TypeError, ValueError):
            return None
        return v if 8192 <= v <= 262144 else None
