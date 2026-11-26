"""Minimax H3 Workspace local server.

Serves the UI and talks to ComfyUI over its HTTP/WebSocket API: uploads inputs,
queues workflows, relays progress and live previews to the browser, and keeps a
small library of finished videos. On first run it either connects to the user's
own ComfyUI or installs one (plus node packs and models) and manages it.

    python app/server.py [--port 8765] [--open]

Файл остался тонким фасадом: здесь приложение, таблица маршрутов и инициализация
состояния. Обработчики живут по областям в app/areas/*.py и собираются в класс App
из mixin-ов; поля и вызовы self при этом не изменились.
"""

from areas.jobs import QueueMixin
from areas.status import StatusMixin
from areas.library import LibraryMixin
from areas.generate import GenerateMixin
from areas.studio import StudioMixin
from areas.edit import EditMixin
from areas.sound import SoundMixin
from areas.subtitles import SubtitlesMixin
from areas.models import ModelsMixin
from areas.setup import SetupMixin
from areas.updates import UpdateMixin
from areas.cloud import CloudMixin
from areas.agent import AgentMixin
from areas.window import WindowMixin
from areas.core import CoreMixin
from areas.actors import ActorsMixin
from areas.refsheet import RefsheetMixin
from areas.voicelab import VoicelabMixin
from areas.reflab import ReflabMixin
from aiohttp import web
from applog import applog
from pathlib import Path
from paths import DATA_DIR, UI_DIR
from version import APP_VERSION
import argparse
import asyncio
import clipboard
import single
import sys
import time
import webbrowser


class App(QueueMixin,
          StatusMixin,
          LibraryMixin,
          GenerateMixin,
          StudioMixin,
          EditMixin,
          SoundMixin,
          SubtitlesMixin,
          ModelsMixin,
          SetupMixin,
          UpdateMixin,
          CloudMixin,
          AgentMixin,
          WindowMixin,
          CoreMixin,
ActorsMixin,
RefsheetMixin,
VoicelabMixin,
ReflabMixin):
    """Класс состояния собран из mixin-ов областей: поля и __init__ в areas/core.py,
    обработчики - по файлам app/areas/. Имя, поля и все вызовы self остались теми же,
    поэтому таблица маршрутов ниже обращается к state.h_* ровно как раньше."""


clipboard.data_dir = DATA_DIR   # the clipboard helper and its temporary PNG live with the app's own files


def build_stamp():
    """Date and time of this build, for the sidebar: the number changes only at a release, so
    without the stamp of the exe itself a person cannot tell yesterday's build from today's."""
    from datetime import datetime
    try:
        p = Path(sys.executable) if getattr(sys, "frozen", False) else Path(__file__)
        return datetime.fromtimestamp(p.stat().st_mtime).strftime("%d.%m.%Y %H:%M")
    except (OSError, ValueError):
        return ""


def _same_origin(request):
    """Is the request from the window that shows this program (or from the program itself)?"""
    origin = request.headers.get("Origin") or request.headers.get("Referer") or ""
    if not origin:
        return True
    here = f"{request.scheme}://{request.headers.get('Host', '')}"
    return origin == here or origin.startswith(here + "/")


def _guard(state):
    """Only the program's own window may ask the local server to do something.

    The server listens on 127.0.0.1 only, but that does not stop a web page: a plain form or fetch POST
    reaches the handler before CORS has anything to say, so any site the user opens could queue jobs,
    start downloads of tens of gigabytes, point the program at someone else's ComfyUI or open its windows.
    The event stream is worse - a cross-origin WebSocket is not a CORS request at all, and through it a
    foreign page reads prompts, modes and folder paths. Every request that changes something therefore
    carries the key of this session in the X-H3-Token header (a foreign page cannot add a header without a
    preflight this server never answers), the event stream carries it in its address, and a request whose
    origin is not ours is refused outright.
    """
    async def middleware(request, handler):
        if request.path.startswith("/api/"):
            if not _same_origin(request):
                return web.json_response({"error": "Запрос не из окна программы"}, status=403)
            if request.method == "GET":
                if request.path == "/api/events" and request.query.get("token") != state.token \
                        and request.cookies.get("h3token") != state.token:
                    return web.json_response({"error": "Нет ключа сеанса: обновите окно программы"}, status=403)
            elif request.headers.get("X-H3-Token") != state.token:
                return web.json_response({"error": "Нет ключа сеанса: обновите окно программы"}, status=403)
        return await handler(request)
    return web.middleware(middleware)   # aiohttp 3.14: without the mark the handler gets (app, handler)


def _slowlog():
    """A line in app.log for every request of the page that took over three seconds. Long-lived
       streams (the event socket, file downloads) are not slowness, they are their normal state."""
    async def middleware(request, handler):
        t0 = time.monotonic()
        try:
            return await handler(request)
        finally:
            dt = time.monotonic() - t0
            if dt > 3 and request.path.startswith("/api/") and request.path not in ("/api/events",):
                applog(f"{request.method} {request.path} — {dt:.1f} с")
    return web.middleware(middleware)


def build_app(comfy_override=None):
    state = App(comfy_override)
    app = web.Application(client_max_size=300 * 1024 * 1024, middlewares=[_slowlog(), _guard(state)])
    app.on_startup.append(state.start)
    app.on_cleanup.append(state.stop)
    app.add_routes([
        web.get("/", state.h_index),
        web.get("/api/status", state.h_status),
        web.get("/api/clipboard/has-image", state.h_clipboard_has_image),
    web.get("/api/clipboard/image", state.h_clipboard_image),
    web.post("/api/clipboard/image", state.h_clipboard_image),
    web.get("/api/focus", state.h_focus),   # a second copy asks the running one to show its window
        web.get("/api/system", state.h_system),
        web.get("/api/audio/info", state.h_audio_info),
        web.post("/api/audio/separate", state.h_audio_separate),
        web.post("/api/video/lastframe", state.h_video_lastframe),   # the browser cannot decode everything
        web.post("/api/video/cut", state.h_video_cut),
        web.post("/api/montage/fade", state.h_montage_fade),  # the fade lands on the joined film, not on its clips
        web.post("/api/montage/sound", state.h_montage_sound),   # the sound of the whole strip   # the sound of a piece, to keep it
        web.post("/api/library/add", state.h_library_add),   # a frame from the bench becomes a keepsake   # reference video is trimmed here, not in the browser
        web.get("/api/setup/info", state.h_setup_info),
        web.post("/api/setup/external", state.h_setup_external),
        web.post("/api/setup/install", state.h_setup_install),
        web.post("/api/mode/add", state.h_mode_add),
        web.post("/api/settings/mirror", state.h_mirror),
        web.post("/api/mode/offered", state.h_mode_offered),
        web.post("/api/setup/cancel", state.h_setup_cancel),
        web.post("/api/open-driver-page", state.h_open_driver),
        web.post("/api/clipboard", state.h_clipboard),
                web.post("/api/rent/open", state.h_rent_open),
        web.get("/api/rent/info", state.h_rent_info),
        web.get("/api/queue/saved", state.h_queue_saved),
        web.post("/api/queue/resume", state.h_queue_resume),
        web.post("/api/queue/discard", state.h_queue_discard),
        web.post("/api/search-web", state.h_search_web),
                web.post("/api/setup/reset", state.h_setup_reset),
    web.post("/api/setup/restore", state.h_setup_restore),
    web.post("/api/engine/start", state.h_engine_start),
    web.get("/api/core-log", state.h_core_log),
    web.get("/api/updates/check", state.h_updates_check),
    web.get("/api/updates/state", state.h_updates_state),
    web.post("/api/updates/core", state.h_updates_core),
    web.post("/api/updates/core/rollback", state.h_updates_core_rollback),
    web.post("/api/updates/pack", state.h_updates_pack),
    web.post("/api/updates/pack/rollback", state.h_updates_pack_rollback),
    web.post("/api/window_mode", state.h_window_mode),
    web.get("/api/window-gpu", state.h_window_gpu_get),
    web.post("/api/window-gpu", state.h_window_gpu_set),
    web.get("/api/keep_models", state.h_keep_models_get),
    web.post("/api/keep_models", state.h_keep_models_set),
        web.post("/api/generate/video", state.h_generate_video),
        web.post("/api/generate/krea", state.h_generate_krea),
        web.post("/api/upscale", state.h_upscale),
        web.post("/api/subtitles", state.h_subtitles),
        web.post("/api/smooth", state.h_smooth),
        web.post("/api/upscale_file", state.h_upscale_file),
        web.post("/api/grain", state.h_grain),
        web.get("/api/version", lambda _req: web.json_response({"version": APP_VERSION, "built": build_stamp()})),
        web.get("/api/update/check", state.h_update_check),
        web.get("/api/update/progress", state.h_update_progress),
        web.post("/api/update/install", state.h_update_install),
        web.post("/api/generate/qwen", state.h_generate_qwen),
        web.post("/api/generate/lipsync", state.h_generate_lipsync),
        web.get("/api/nodes", state.h_nodes),
        web.get("/api/models/files", state.h_models_files),
        web.get("/api/models/compat", state.h_models_compat),
        web.get("/api/models/have", state.h_models_have),
        web.post("/api/models/pick", state.h_models_pick),
        web.post("/api/models/open", state.h_models_open),
        web.post("/api/models/download", state.h_models_download),
        web.post("/api/models/download/cancel", state.h_models_download_cancel),
        web.post("/api/models/variant", state.h_models_variant),
        web.get("/api/wf/list", state.h_wf_list),
        web.post("/api/wf/add", state.h_wf_add),
        web.get("/api/wf/{id}", state.h_wf_get),
        web.delete("/api/wf/{id}", state.h_wf_delete),
        web.post("/api/generate/custom", state.h_generate_custom),
        web.get("/api/loras/custom", state.h_loras_custom),
        web.post("/api/loras/custom", state.h_loras_custom_set),
        web.post("/api/loras/custom/mode", state.h_loras_custom_mode),
        web.post("/api/generate/refs", state.h_generate_refs),
        web.post("/api/generate/actor", state.h_generate_actor),
        web.post("/api/generate/swap", state.h_generate_swap),
        web.post("/api/generate/long", state.h_generate_long),
        web.post("/api/generate/actionsc", state.h_generate_actionsc),
        web.post("/api/montage", state.h_montage),
        web.get("/api/long/state", state.h_long_state),
        web.get("/api/long/project", state.h_long_project),
        web.post("/api/long/project", state.h_long_project),
        web.get("/api/long/ref/{run}/{name}", state.h_long_ref),
        web.post("/api/long/stage", state.h_long_stage),
        web.post("/api/generate/action", state.h_generate_action),
        web.get("/api/action/info", state.h_action_info),
        web.post("/api/log", state.h_ui_log),
        web.post("/api/comfy/update", state.h_comfy_update),
        web.get("/api/cloud", state.h_cloud_get),
        web.post("/api/cloud", state.h_cloud_set),
        web.post("/api/cloud/test", state.h_cloud_test),
        web.post("/api/setup/cloud", state.h_setup_cloud),
        web.post("/api/interrupt", state.h_interrupt),
        web.get("/api/agent/status", state.h_agent_status),
        web.post("/api/agent/translate", state.h_agent_translate),
        web.post("/api/agent/install", state.h_agent_install),
        web.post("/api/agent/install/cancel", state.h_agent_install_cancel),
        web.post("/api/agent/model", state.h_agent_model),
        web.post("/api/agent/variant", state.h_agent_variant),
        web.post("/api/agent/variant_delete", state.h_agent_variant_delete),
        web.post("/api/agent/ctx", state.h_agent_ctx),
        web.post("/api/agent/spell", state.h_agent_spell),
        web.post("/api/mp4tag", state.h_mp4tag),
        web.get("/api/gpu", state.h_gpu),
        web.get("/api/forecast", state.h_forecast),
        web.post("/api/gate/off", state.h_gate_off),
        web.post("/api/speech/transcribe", state.h_transcribe),
        web.post("/api/speech/folder", state.h_speech_folder),
        web.post("/api/speech/model", state.h_speech_model),
        # Voice Lab: голоса и озвучка (see areas/voicelab.py). Ноды человек ставит кнопкой в разделе,
        # поэтому порядок такой: сначала узнать состояние, потом ставить, озвучивать и смотреть варианты.
        web.get("/api/voice/status", state.h_voice_status),
        web.post("/api/voice/install", state.h_voice_install),
        web.get("/api/voice/progress", state.h_voice_progress),
        web.post("/api/voice/restart", state.h_voice_restart),
        web.post("/api/voice/generate", state.h_voice_generate),
        web.post("/api/voice/cancel", state.h_voice_cancel),
        web.get("/api/voice/saved", state.h_voice_saved_list),
        web.post("/api/voice/saved", state.h_voice_saved_save),
        web.get("/api/voice/saved/{id}/file", state.h_voice_saved_file),
        web.delete("/api/voice/saved/{id}", state.h_voice_saved_delete),
        web.get("/api/voice/takes", state.h_voice_takes),
        web.post("/api/voice/takes/clear", state.h_voice_takes_clear),
        web.post("/api/voice/takes/{id}/star", state.h_voice_take_star),
        web.post("/api/voice/takes/{id}/rename", state.h_voice_take_rename),
        web.delete("/api/voice/takes/{id}", state.h_voice_take_delete),
        web.get("/api/voice/out/{name}", state.h_voice_out),
        web.post("/api/agent/chat", state.h_agent_chat),
        web.post("/api/comfy/free", state.h_comfy_free),
        web.get("/api/agent/chats", state.h_chats),
        web.delete("/api/agent/chats", state.h_chats_clear),
        web.get("/api/agent/chats/{id}", state.h_chat_get),
        web.put("/api/agent/chats/{id}", state.h_chat_put),
        web.delete("/api/agent/chats/{id}", state.h_chat_delete),
        web.post("/api/agent/skills", state.h_skill_upload),
        web.patch("/api/agent/skills/{id}", state.h_skill_patch),
        web.delete("/api/agent/skills/{id}", state.h_skill_delete),
        web.get("/api/results", state.h_results_get),
        web.post("/api/results", state.h_results_set),
        web.post("/api/results/backfill", state.h_results_backfill),
        web.post("/api/results/clean", state.h_results_clean),
        web.get("/api/library", state.h_library),
        web.patch("/api/library/{id}", state.h_library_patch),
        web.delete("/api/library/{id}", state.h_library_delete),
        web.post("/api/library/delete", state.h_library_delete_many),
        web.get("/api/file/{id}", state.h_file),
        web.get("/api/refs/{group}/{name}", state.h_ref_file),
        web.get("/api/srcfile/{id}", state.h_srcfile),
        web.get("/api/actors", state.h_actors_list),
        web.post("/api/actors", state.h_actors_save),
        web.delete("/api/actors/{id}", state.h_actors_delete),
        web.get("/api/actors/{id}/file/{name}", state.h_actors_file),
        web.get("/api/refsheet/presets", state.h_refsheet_presets),
        web.post("/api/refsheet", state.h_refsheet_make),
        # Студия референсов: листы референсов из одного ролика (see areas/reflab.py). Порядок такой:
        # взять наборы ракурсов и собрать текст, ролик делает режим «Видео по референсам», а кадры,
        # лист и история работ живут здесь.
        web.get("/api/reflab/presets", state.h_reflab_presets),
        web.post("/api/reflab/prompt", state.h_reflab_prompt),
        web.post("/api/reflab/presets", state.h_reflab_preset_save),
        web.delete("/api/reflab/presets/{id}", state.h_reflab_preset_delete),
        web.get("/api/reflab/runs", state.h_reflab_list),
        web.post("/api/reflab/runs", state.h_reflab_save),
        web.post("/api/reflab/runs/clear", state.h_reflab_clear),
        web.post("/api/reflab/runs/{id}/rate", state.h_reflab_rate),
        web.delete("/api/reflab/runs/{id}", state.h_reflab_delete),
        web.get("/api/reflab/file/{id}/{name}", state.h_reflab_file),
        web.post("/api/reflab/describe", state.h_reflab_describe),
        web.get("/api/events", state.h_events),
        web.static("/ui", UI_DIR),
    ])
    # файлы интерфейса обязаны проверять свежесть у сервера: без этого браузер
    # держит в кэше старый код неделями, и починки до человека просто не доходят
    @web.middleware
    async def _ui_no_cache(request, handler):
        response = await handler(request)
        if request.path.startswith("/ui/"):
            response.headers["Cache-Control"] = "no-cache"
        return response
    app.middlewares.append(_ui_no_cache)
    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--comfy", help="always use this ComfyUI URL (skips the setup wizard)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--open", action="store_true", help="open the UI in the default browser")
    args = ap.parse_args()

    busy = single.hold(DATA_DIR, args.port)  # the same guard as in main.py: two copies spoil settings, queue and ComfyUI
    if busy is not None:
        print("Программа уже работает с этой папкой данных" + (f", адрес: {busy}" if busy else "") + ".")
        raise SystemExit(1)
    try:
        app = build_app(args.comfy)
        if args.open:
            async def open_browser(_app):
                asyncio.get_running_loop().call_later(1, webbrowser.open, f"http://127.0.0.1:{args.port}")
            app.on_startup.append(open_browser)
        web.run_app(app, host="127.0.0.1", port=args.port, print=lambda *_: print(f"Minimax H3 Workspace: http://127.0.0.1:{args.port}"))
    finally:
        single.release(DATA_DIR)


if __name__ == "__main__":
    main()
