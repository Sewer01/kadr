"""Одна точка правды про внешние инструменты для всех проверок в tools/checks.

Здесь живут пути до python, node, ComfyUI, ffmpeg и whisper: ни одна проверка не пишет
их у себя. У всего есть понятные значения по умолчанию (та машина, где программа
собирается и запускается) и переменные окружения для другой машины:

  KADR_REPO          путь до репозитория Kadr (обычно и так виден из расположения скрипта)
  KADR_PYTHON        python, которым прогоняются проверки и импортируется app/
  KADR_NODE          node.exe для разбора скриптов страницы
  KADR_COMFY         адрес ComfyUI, по умолчанию http://127.0.0.1:8188
  KADR_COMFY_ROOT    папка переносимого ComfyUI (оттуда берётся ffmpeg)
  KADR_FFMPEG        явный путь до ffmpeg.exe
  KADR_LLM_DIR       папка с моделями Агента (в ней лежит whisper)
  KADR_WHISPER_DIR   явная папка whisper с whisper-cli.exe и/или ggml-*.bin
  KADR_SAMPLE_AUDIO  аудиофайл для живой проверки выравнивания громкости
  KADR_GIT           git.exe
  KADR_LIVE          0 - живые проверки (ComfyUI, ffmpeg, whisper) не трогать, только пропуск
  KADR_DIFF          1 - режим правки: смотреть, что ДОБАВЛЕНО незакоммиченным изменением

Правило про историю: проверки НЕ сверяют код с git HEAD и НЕ считают размер диффа. Такое
утверждение падает на любой правке, которая к нему не относится (исправили четыре мёртвых
селектора - и проверка звука падает), и молча врёт, когда правку уже закоммитили. Всё, что
смотрит в историю, живёт в режиме правки (KADR_DIFF=1) и печатает ПРОПУСК, когда выключено.
Поведение доказывается постоянными инвариантами: структурой собранного графа, обходом его
рёбер, эталонами golden и содержимым файлов - на дереве, где правка уже сделана и
закоммичена, постоянный инвариант обязан пройти.

Правило вежливого пропуска: если внешнего инструмента нет, проверка НЕ молчит - она
печатает строку «ПРОПУСК: ...» и говорит, какой переменной это задаётся. Само собой,
что пропуск не считается падением, но и чистым результатом не притворяется.

Внешние инструменты проверки только читают: в очередь ComfyUI ничего не ставится,
видеокарта не трогается, сборка не запускается.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # <репа>/tools/checks
GOLDEN_DIR = HERE / "golden"                    # эталоны графов

# запрещённые значки (одна таблица на все проверки): эмодзи и стрелки, японская кана, иероглифы
BAD_GLYPHS = re.compile("[\u2600-\u27bf\u2190-\u21ff\u3040-\u30ff\u4e00-\u9fff]")


def _env_path(name):
    """Значение переменной окружения как Path, если оно задано."""
    raw = (os.environ.get(name) or "").strip().strip('"')
    return Path(raw) if raw else None


def _first_file(candidates):
    for c in candidates:
        try:
            if c and Path(c).is_file():
                return Path(c)
        except OSError:
            continue
    return None


def _first_dir(candidates):
    for c in candidates:
        try:
            if c and Path(c).is_dir():
                return Path(c)
        except OSError:
            continue
    return None


# --- репозиторий -------------------------------------------------------------

def repo_from_script():
    """Репозиторий так, как он виден из этого файла: tools/checks -> tools -> репа."""
    return HERE.parent.parent


def looks_like_repo(path):
    """Похожа ли папка на репу Kadr: по главному файлу графов."""
    try:
        return bool(path) and (Path(path) / "app" / "workflows.py").is_file()
    except OSError:
        return False


def resolve_repo(argv=None, prog=""):
    """Путь до репы: явный аргумент, потом KADR_REPO, потом текущая папка, потом расположение скрипта.

    Так `python tools/checks/golden.py` работает из корня репы без параметра, но
    `python tools/checks/golden.py C:\\путь\\до\\репы` тоже принимается.
    """
    argv = list(argv if argv is not None else sys.argv[1:])
    for cand in argv:
        if cand.startswith("-"):
            continue
        p = Path(cand).expanduser()
        if looks_like_repo(p):
            return p.resolve()
        if p.is_file():
            continue                   # этот параметр - файл (пробное аудио), а не путь до репы
        raise SystemExit("не похоже на репу Kadr (нет app/workflows.py): %s\n"
                         "Запуск: python tools/checks/%s [путь до репы]" % (p, prog or "run.py"))
    env = resolve_repo_env()
    if env is not None:
        return env
    cwd = Path.cwd()
    if looks_like_repo(cwd):
        return cwd.resolve()
    return repo_from_script()


def resolve_repo_env():
    """Репа из переменной окружения, если она там прописана и годится."""
    p = _env_path("KADR_REPO")
    return p.resolve() if looks_like_repo(p) else None


def repo(argv=None, prog=""):
    """То же, что resolve_repo, но с понятной ошибкой, если папки нет вовсе."""
    p = resolve_repo(argv, prog)
    if not looks_like_repo(p):
        raise SystemExit("репа Kadr не найдена (%s). Задайте KADR_REPO или передайте путь параметром." % p)
    return p.resolve()


def state_files(repo):
    """Модули состояния: фасад app/server.py и модули областей app/areas/*.py.

    Методы класса состояния разнесены по областям, поэтому проверка, которой нужен текст
    обработчика, обязана смотреть все эти файлы, а не только app/server.py. Список путей нигде не
    заморожен: области можно переносить и переименовывать, а имена обработчиков и таблица
    маршрутов сторожатся отдельно (tools/checks/routes.py).
    """
    app = Path(repo) / "app"
    files = [app / "server.py"]
    areas = app / "areas"
    if areas.is_dir():
        files += sorted(p for p in areas.glob("*.py") if p.name != "__init__.py")
    return [f for f in files if f.is_file()]


def state_text(repo):
    """Исходник всех модулей состояния одним текстом - для проверок, которые ищут в коде."""
    return "\n".join(f.read_text(encoding="utf-8", errors="replace") for f in state_files(repo))


# --- внешние инструменты ----------------------------------------------------

def python():
    """Python для прогонов: по умолчанию переносимый python из ComfyUI (в нём есть aiohttp)."""
    explicit = _env_path("KADR_PYTHON")
    if explicit and explicit.is_file():
        return explicit
    default = Path(r"C:\Video\ComfyUI_windows_portable\python_embeded\python.exe")
    if default.is_file():
        return default
    return Path(sys.executable)       # ближе всего к тому, чем запустили проверку


def node():
    """node.exe: сначала явный, потом переносимый рядом с репой, потом тот, что в PATH.

    KADR_NODE задан явно и файла нет - возвращаем None: проверка сама напечатает пропуск
    с именем переменной. Молча подставить другой node было бы хуже - человек решил бы,
    что синтаксис страницы проверили настоящим node.
    """
    explicit = _env_path("KADR_NODE")
    if explicit:
        return explicit if explicit.is_file() else None
    found = _first_file([
        HERE / "node" / "node.exe",                   # рядом с проверками (tools/checks/node)
        repo_from_script().parent / "node" / "node.exe",   # .local-checks/node - отсюда node пришёл
        HERE.parent.parent / "node" / "node.exe",
    ])
    if found:
        return found
    which = shutil.which("node")
    return Path(which) if which else None


def comfy_url():
    return (os.environ.get("KADR_COMFY") or "http://127.0.0.1:8188").strip().rstrip("/")


def comfy_root():
    return _env_path("KADR_COMFY_ROOT") or Path(r"C:\Video\ComfyUI_windows_portable")


def ffmpeg():
    """Декодер ffmpeg: явный путь, потом тот же порядок, что у приложения (переносимый ComfyUI), потом PATH.

    Явный путь задан и не найден - None: живая проверка напечатает пропуск с именем
    переменной, а не возьмёт втихую другой декодер.
    """
    explicit = _env_path("KADR_FFMPEG")
    if explicit:
        return explicit if explicit.is_file() else None
    root = comfy_root()
    if root.is_dir():
        for pat in ("python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-*.exe", "**/ffmpeg.exe"):
            hits = sorted(root.glob(pat), reverse=True)
            for p in hits:
                if p.is_file():
                    return p
    which = shutil.which("ffmpeg")
    return Path(which) if which else None


def llm_dir():
    return _env_path("KADR_LLM_DIR") or Path(r"C:\Video\llm")


def whisper_dir():
    """Папка whisper (whisper-cli.exe и/или ggml-*.bin): явная, потом та, что у приложения."""
    explicit = _env_path("KADR_WHISPER_DIR")
    if explicit and explicit.is_dir():
        return explicit
    for cand in (llm_dir() / "whisper", llm_dir(), comfy_root().parent / "whisper"):
        if cand.is_dir() and (_has_whisper(cand)):
            return cand
    return None


def _has_whisper(folder):
    try:
        if list(folder.rglob("whisper-cli.exe")):
            return True
        return any(p.name.startswith("ggml-") and p.suffix == ".bin" for p in folder.rglob("ggml-*.bin"))
    except OSError:
        return False


def whisper_cli(folder=None):
    """Полный путь до whisper-cli.exe, или None - тогда живая проверка пропускается."""
    folder = folder or whisper_dir()
    if not folder:
        return None
    hits = sorted(folder.rglob("whisper-cli.exe"))
    return hits[0] if hits else None


def sample_audio():
    """Аудиофайл для живой проверки выравнивания громкости."""
    explicit = _env_path("KADR_SAMPLE_AUDIO")
    if explicit and explicit.is_file():
        return explicit
    return _first_file([
        Path(r"C:\Video\data\long\3yi34pr7z4\refs\aud0.mp3"),
    ])


def git():
    return shutil.which(os.environ.get("KADR_GIT") or "git")


def live_allowed():
    """KADR_LIVE=0 - живые проверки (ComfyUI, ffmpeg, whisper) не трогать: печать пропуск."""
    return (os.environ.get("KADR_LIVE") or "1").strip().lower() not in ("0", "off", "no", "false")


# --- режим правки: только он смотрит в историю ------------------------------

DIFF_VAR = "KADR_DIFF"


def diff_mode():
    """KADR_DIFF=1 - режим правки: проверка смотрит, что ДОБАВЛЕНО незакоммиченным изменением.

    По умолчанию выключен. Сравнение с git HEAD и подсчёт размера диффа - не про поведение
    приложения, а про состояние рабочего дерева: на дереве без незакоммиченной правки такое
    сравнение не о чём вести, а на дереве с ЛЮБОЙ другой правкой оно врёт. Отключено -
    проверка печатает ПРОПУСК, а не проходит молча и не падает.
    """
    return (os.environ.get(DIFF_VAR) or "0").strip().lower() in ("1", "on", "yes", "true")


def added_lines(repo, paths=()):
    """Новые строки незакоммиченной правки: (строки, причина_пропуска).

    Строки возвращаются только в режиме правки, когда git нашёлся и правка есть. Иначе
    вместо строк - None и одной фразой, почему (её печатают как ПРОПУСК): молча вернуть
    пустой список значило бы «проверили и всё хорошо».

    Кроме git diff смотрятся и новые файлы (git status ??): git diff их не показывает вовсе, а
    правка, которая добавила модуль, обязана проверяться наравне с правкой существующего.
    """
    if not diff_mode():
        return None, "режим правки выключен; включите %s=1, чтобы смотреть добавленные строки" % DIFF_VAR
    tool = git()
    if not tool:
        return None, "нет git.exe; задайте KADR_GIT"
    cmd = [tool, "-C", str(repo), "diff", "-U0", "--"] + list(paths)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        return None, "git diff не запустился: %s" % str(e)[:80]
    if r.returncode != 0:
        return None, "git diff не вышел: %s" % ((r.stderr or "").strip()[:80] or "код %d" % r.returncode)
    added = [ln[1:] for ln in (r.stdout or "").splitlines() if ln.startswith("+") and not ln.startswith("+++")]
    # Строки, которые этой же правкой убраны из существующих файлов. Если такой же строки нет в
    # новом файле - это правда новая строка; если есть - код просто переехал, и требовать от него
    # чего-то нового нельзя: иначе разбор большого файла на равные части падал бы на значках,
    # которые в нём были всегда.
    moved = {ln[1:].strip() for ln in (r.stdout or "").splitlines()
             if ln.startswith("-") and not ln.startswith("---") and ln.strip() != "-"}
    # новые файлы: git diff их не видит, поэтому читаем целиком
    st = subprocess.run([tool, "-C", str(repo), "status", "--porcelain", "--untracked-files=all",
                         "--"] + list(paths), capture_output=True, text=True,
                        encoding="utf-8", errors="replace")
    if st.returncode == 0:
        for line in (st.stdout or "").splitlines():
            if not line.startswith("?? "):
                continue
            rel = line[3:].strip().strip('"')
            f = Path(repo) / rel.replace("/", os.sep)
            try:
                if f.is_file() and f.stat().st_size < 4_000_000:
                    added += [ln for ln in f.read_text(encoding="utf-8", errors="replace").splitlines()
                              if ln.strip() not in moved]
            except OSError:
                continue
    if not added:
        where = (" в " + ", ".join(paths)) if paths else ""
        return None, "незакоммиченной правки%s нет (git diff пуст): искать добавленные строки негде" % where
    return added, ""


def bad_glyphs(text):
    """Запрещённые значки в тексте: список «знак U+КОД» без повторов."""
    return sorted({"%s U+%04X" % (c, ord(c)) for c in text if BAD_GLYPHS.match(c)})


# --- вежливый пропуск -------------------------------------------------------

def skip(what, how):
    """Печатает пропуск так, чтобы его было видно в отчёте, и возвращает False для вызывающего."""
    print("   ПРОПУСК: %s - не выполнено (%s)" % (what, how))
    return False


def missing(what, var, extra=""):
    """Пропуск по причине «нет внешнего инструмента»: обязательно говорит, чем задать."""
    return skip(what, "нет инструмента; задайте %s%s" % (var, (" " + extra) if extra else ""))


def comfy_object_info(timeout=60):
    """Список нод ядра с запущенного ComfyUI (только GET object_info), или None, если он не отвечает.

    Ничего в очередь не ставится: это чтение. 404/500 тоже считаются «нет данных» - проверка
    тогда печатает пропуск, а не падает.
    """
    if not live_allowed():
        return None
    import json
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(comfy_url() + "/object_info", timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        return data if isinstance(data, dict) and data else None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def banner(repo_path=None):
    """Короткая шапка: какая репа и что из внешнего нашлось - чтобы пропуск всегда был виден."""
    print("репа: %s" % (repo_path or repo_from_script()))
    print("python: %s" % python())
    print("node: %s" % (node() or "не найден (задайте KADR_NODE) - проверки синтаксиса страницы пропустят себя"))
    print("ComfyUI: %s%s" % (comfy_url(), "" if live_allowed() else " · живые проверки выключены (KADR_LIVE=0)"))
    print("ffmpeg: %s" % (ffmpeg() or "не найден (задайте KADR_FFMPEG)"))
    print("whisper: %s" % (whisper_dir() or "не найден (задайте KADR_WHISPER_DIR)"))
    print("режим правки (KADR_DIFF): %s"
          % ("включён - проверки смотрят добавленные строки незакоммиченной правки"
             if diff_mode() else
             "выключен - проверки, смотрящие в git, напечатают ПРОПУСК"))
    print()


def add_repo_arg(parser):
    parser.add_argument("repo", nargs="?", default=None,
                        help="путь до репы Kadr (по умолчанию текущая папка или та, где лежит проверка)")
    return parser
