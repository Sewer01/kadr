"""Where the app keeps its own small files (settings, library list, chats, logs, window cache).

Nothing is left in the Windows profile:
  - before the first setup they live next to the program (<app>\\data), so uninstalling removes them;
  - once the user has chosen an install folder, they move to <install folder>\\data, and the program folder
    keeps only a one-line pointer (data_location.txt), so deleting that folder removes everything.
Older versions kept them in %LOCALAPPDATA%\\MinimaxH3Workspace; they are moved on the first start.
"""
import json
import shutil
from pathlib import Path


def move_all(src, dst):
    dst.mkdir(parents=True, exist_ok=True)
    for item in list(src.iterdir()):
        target = dst / item.name
        if not target.exists():
            shutil.move(str(item), str(target))
    try:
        src.rmdir()
    except OSError:
        pass


def normalise_install_dir(value):
    """install_dir means the PARENT of ComfyUI_windows_portable. If somebody points it at the portable
       folder itself (its python_embeded and ComfyUI are right there), take the parent instead: a wrong
       value here hides the whole engine and sends the setup screen to download another copy."""
    if not value:
        return value
    try:
        p = Path(value)
        if (p / "python_embeded" / "python.exe").exists() and (p / "ComfyUI").is_dir():
            return str(p.parent)
    except (OSError, ValueError):
        pass
    return value


def managed_install_dir(data_dir):
    try:
        cfg = json.loads((data_dir / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if cfg.get("engine") == "managed" and cfg.get("install_dir") and Path(cfg["install_dir"]).is_dir():
        # the parent, never the portable folder itself: data must not end up inside ComfyUI
        return Path(normalise_install_dir(cfg["install_dir"]))
    return None


def write_pointer(path, folder):
    """One line: where the data lives. Written in two places on purpose (see locate)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(folder), encoding="utf-8")
    except OSError:
        pass


def locate(app_dir, local_appdata):
    app_dir, legacy = Path(app_dir), Path(local_appdata) / "MinimaxH3Workspace"
    pointer, default = app_dir / "data_location.txt", app_dir / "data"
    # A copy of the pointer outside the program folder: it survives "uninstall, install again" and an
    # update that replaced the folder. Without it the new copy of the program does not know where the
    # settings are, shows the first start, and offers to download every model onto drive C.
    spare = Path(local_appdata) / "Kadr" / "data_location.txt" if local_appdata else None
    cur = None
    try:
        if pointer.exists():
            p = Path(pointer.read_text(encoding="utf-8").strip())
            if p.is_dir():
                cur = p
        if cur is None and spare is not None and spare.exists():
            p = Path(spare.read_text(encoding="utf-8").strip())
            if (p / "config.json").exists():
                cur = p
                pointer.write_text(str(cur), encoding="utf-8")
        if cur is None:
            cur = default
            if (legacy / "data").is_dir() and not default.exists():
                move_all(legacy / "data", default)
                if (legacy / "webview").is_dir():
                    move_all(legacy / "webview", default / "webview")
                if (legacy / "llm").is_dir():  # an assistant downloaded by an older version stays where it is
                    cfg_path = default / "config.json"
                    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
                    if not cfg.get("llm_dir") and cfg.get("engine") != "managed":
                        cfg["llm_dir"] = str(legacy / "llm")
                        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=1), encoding="utf-8")
                try:
                    legacy.rmdir()
                except OSError:
                    pass
        inst = managed_install_dir(cur)
        if inst and cur != inst / "data":
            move_all(cur, inst / "data")
            cur = inst / "data"
            write_pointer(pointer, cur)
            write_pointer(spare, cur)
    except OSError:
        if cur is None or not cur.exists():
            cur = legacy / "data" if (legacy / "data").is_dir() else default
    try:
        # both copies are refreshed on every start: the one in the profile is what a reinstalled
        # program reads when the folder next to the exe was replaced by the installer
        if cur and cur.is_dir():
            write_pointer(spare, cur) if spare is not None else None
            if not pointer.exists() or pointer.read_text(encoding="utf-8").strip() != str(cur):
                write_pointer(pointer, cur)
    except OSError:
        pass
    return cur
