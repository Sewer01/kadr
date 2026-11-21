"""Проверка страницы интерфейса без браузера: app/ui/index.html, app/ui/css, app/ui/js.

Что проверяем (всё статически, по тексту файлов - браузер не запускаем):
1. синтаксис: каждый инлайновый блок <script> и каждый файл app/ui/js разбирается node
   (node --check, файл не исполняется; файлы с import/export разбираются как модули);
2. нет двух элементов с одним id;
3. нет обращений getElementById / querySelector / $ / $$ к id или классу, которого нигде
   нет (разметка, стили страницы и app/ui/css, правила скрипта);
4. все пути '/api/...' со страницы и из js-файлов есть в замороженной таблице маршрутов
   tools/checks/routes.json;
5. верхние имена JS объявлены в файлах по одному разу: при переносе между модулями дубль
   означал бы, что импорт возьмёт не ту функцию;
6. каждый голый идентификатор в каждом js-файле разрешим: объявлен в этом же файле, явно
   импортирован, назначен на window или это встроенный объект браузера. Пропущенный импорт
   в ES-модулях - это падение в браузере, которое без браузера ловит только эта проверка.

Отдельно печатается список НАХОДОК: то, что стоит посмотреть человеку, но что не является
падением само по себе (например id создаётся скриптом, а не лежит в разметке).

Приложение этой проверкой НЕ правится: если находка реальна, проверка падает и честно
перечисляет места, а решение о правке принимает человек.

Запуск из корня репы:
  python tools/checks/ui.py
  python tools/checks/ui.py C:\\путь\\до\\репы
"""
import json
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

# --- исключения динамических имён -------------------------------------------
# Что считается узаконенной динамикой и НЕ проверяется (список намеренно короткий):
#   1) имя собирается из переменной: $('#x' + i), getElementById(id) - у вызова
#      не строка-литерал в кавычках, или сразу после литерала стоит '+';
#   2) имя собирается шаблоном: $(`#${it.id}`), внутри строки есть ${...};
#   3) элемент создаёт сам скрипт: id="cwBar" внутри строки-шаблона, el.id = 'x',
#      setAttribute('id', 'x') - такие id ищутся по всем скриптам и показываются в НАХОДКАХ;
#   4) класс элемент получает в раннере: mk('cmp-b', ...), classList.add('on'),
#      className = '...' - класс ищется по строковым литералам скриптов, тоже в НАХОДКАХ;
#   5) классы из стилей: .mt-item{...} в странице или в app/ui/css - элемент может
#      создаваться без class="", но стиль на него уже есть, значит имя живое.
# Всё остальное, чего нет ни в разметке, ни в стилях, ни в скрипте, - падение.
JS_ONLY_CLASSES = ()              # отдельных поблажек нет: правила выше покрывают всё

SCRIPT_BLOCK = re.compile(r"(?s)<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>")
LITERAL = r"""(["'])((?:\\.|(?!\1)[^\\])*)\1"""
API_LITERAL = re.compile(r"""(["'`])(/api/(?:\\.|(?!\1)[^\\])*)\1""")
SEL_CALL = re.compile(r"\$\$?\(\s*" + LITERAL + r"\s*(\+?)")            # $('#x') и $$('#x')
GET_BY_ID = re.compile(r"getElementById\(\s*" + LITERAL + r"\s*(\+?)")
QUERY_CALL = re.compile(r"querySelector(?:All)?\(\s*" + LITERAL + r"\s*(\+?)")
ROUTES_FILE = HERE / "routes.json"


def verdict(results, name, ok, note=""):
    print(("   OK   " if ok else "   ПАДЕНИЕ  ") + name + ((" · " + note) if note else ""))
    results.append((name, bool(ok)))


def note_list(title, items, limit=25):
    """Блок находок для человека: без него проверка молчала бы о полутонам."""
    print()
    print(title)
    if not items:
        print("   (пусто)")
        return
    for x in items[:limit]:
        print("   - " + x)
    if len(items) > limit:
        print("   ... ещё %d" % (len(items) - limit))


# --- разметка и стили --------------------------------------------------------

def markup_ids(markup):
    return re.findall(r'\bid="([\w-]+)"', markup)


def created_ids(js):
    """id, которые создаёт сам скрипт: id="x" внутри строк-шаблонов и el.id = 'x'."""
    out = set()
    out |= set(re.findall(r'\bid=\\?"([A-Za-z][\w-]*)\\?"', js))   # id="x" и id=\"x\" внутри строк-строителей
    out |= set(re.findall(r"""\.id\s*=\s*['"]([\w-]+)['"]""", js))
    out |= set(re.findall(r"""setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]""", js))
    return out


def dynamic_id_templates(js):
    """Шаблоны, по которым имена собираются в раннере: id="${...}" - это узаконенная динамика."""
    return sorted({m.group(0).strip() for m in re.finditer(r'id="[^"]*\$\{[^"]*"', js)})


def js_string_tokens(js):
    """Слова-литералы скриптов: mk('cmp-b', ...), classList.add('on'). Класс, который элемент
    получает уже в раннере, в разметке и стилях не светится: считаем его живым, но показываем
    в НАХОДКАХ."""
    return set(re.findall(r"""['"`]([A-Za-z][\w-]{1,30})['"`]""", js))


def css_classes(repo):
    """Классы из стилей: инлайновые <style> и все app/ui/css/*.css (env.ui_css - уже их
    содержимое). Берём часть до '{', чтобы не принять за класс numbers вроде 0.5rem.
    Пул - объединение: разложение стилей по файлам его не двигает."""
    pool = set()
    for sel in re.findall(r"([^{}]+)\{", env.ui_css(repo)):
        pool |= set(re.findall(r"\.([A-Za-z][\w-]*)", sel))
    return pool


def class_pool(html, repo):
    """Все классы, которые встречаются в интерфейсе: стили, class="" (разметка и шаблоны),
    classList, className."""
    pool = css_classes(repo)
    whole = html + "\n" + env.ui_js(repo)
    for m in re.finditer(r'\bclass=' + LITERAL, whole):
        pool |= {c for c in m.group(2).split() if c and "${" not in c}
    for m in re.finditer(r"classList\.(?:add|remove|toggle)\(([^)]*)\)", whole):
        pool |= set(re.findall(r"""['"]([\w-]+)['"]""", m.group(1)))
    for m in re.finditer(r"className\s*=\s*" + LITERAL, whole):
        pool |= {c for c in m.group(2).split() if c and "${" not in c}
    return pool


def selector_tokens(sel):
    """Из селектора вытаскиваем (id-имена, классы). Динамику помечаем, а не молча съедаем."""
    if "${" in sel:
        return [], [], True                          # имя собирается в раннере: сверять нечего
    ids, classes = [], []
    bare = re.sub(r"\[[^\]]*\]", " ", sel)
    for part in re.split(r"[\s>+~,]+", bare):
        for m in re.finditer(r"#([\w-]+)|\.([A-Za-z][\w-]*)", part):
            if m.group(1) and m.group(1) not in ids:
                ids.append(m.group(1))
            elif m.group(2) and m.group(2) not in classes:
                classes.append(m.group(2))
    return ids, classes, False


def norm_api(path):
    """Путь со страницы к сравнению с маршрутами: шаблонные вставки -> *, запрос отброшен."""
    p = path.split("?", 1)[0].split("#", 1)[0]
    p = re.sub(r"\$\{[^}]*\}", "*", p)
    return p


def route_matches(path, routes):
    """Совпадает ли путь с одним из маршрутов; сегмент {id} в маршруте = любое значение,
    '*' на месте страницы = любой сегмент, путь со '*' на конце = префикс маршрута."""
    segs = [s for s in path.split("/") if s != ""]
    for method, tmpl in routes:
        rsegs = [s for s in re.sub(r"\{[^}]+\}", "*", tmpl).split("/") if s != ""]
        if path.endswith("/") and tmpl.startswith(path):
            return True                                  # '/api/wf/' + id: маршрут начинается так же
        if tmpl == path:
            return True
        if len(rsegs) != len(segs):
            continue
        if all(r == "*" or s == "*" or r == s for r, s in zip(rsegs, segs)):
            return True
    return False


# --- разбор node --------------------------------------------------------------

def node_check(node, text, as_module, name):
    """Только синтаксис: node --check файл не исполняет. Модули проверяем под .mjs."""
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / (name + (".mjs" if as_module else ".js"))
        f.write_text(text, encoding="utf-8")
        r = subprocess.run([str(node), "--check", str(f)], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=180)
        return r.returncode == 0, (r.stderr or "").strip().replace("\n", " | ")[:300]


# --- разрешения имён между js-файлами ----------------------------------------

GLOBAL_WORDS = set("""
window document console localStorage sessionStorage navigator location history performance
fetch setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame
alert confirm prompt structuredClone queueMicrotask atob btoa
Math JSON Object Array String Number Boolean Date RegExp Error TypeError RangeError SyntaxError
Promise Set Map WeakMap WeakSet Symbol Proxy Reflect Iterator Generator globalThis self top parent
Image Audio AudioContext OfflineAudioContext Video Blob File FileList FileReader FormData Headers Request Response URL URLSearchParams
WebSocket Worker SharedWorker BroadcastChannel EventTarget Event CustomEvent CloseError
KeyboardEvent MouseEvent PointerEvent WheelEvent DragEvent InputEvent FocusEvent AnimationEvent
DataTransfer MediaRecorder MediaStream getUserMedia getUserMedia createImageBitmap CanvasRenderingContext2D
addEventListener removeEventListener dispatchEvent postMessage atob btoa getSelection
MutationObserver ResizeObserver IntersectionObserver PerformanceObserver
Notification ClipboardItem ClipboardReadingError TextEncoder TextDecoder
Uint8Array Int8Array Uint16Array Int16Array Uint32Array Int32Array Float32Array Float64Array
ArrayBuffer DataView BigInt BigInt64Array BigUint64Array Uint8ClampedArray
Element HTMLElement HTMLInputElement HTMLInputElement HTMLTextAreaElement HTMLSelectElement
HTMLVideoElement HTMLAudioElement HTMLImageElement HTMLCanvasElement HTMLDivElement Node NodeList
HTMLCollection DOMParser XPathResult SVGElement SVGElement NodeFilter DOMException AbortController
AbortSignal getComputedStyle matchMedia screen innerWidth innerHeight devicePixelRatio isFinite isNaN
parseFloat parseInt encodeURI decodeURI encodeURIComponent decodeURIComponent undefined null true
false NaN Infinity this arguments module exports require process chrome crypto indexedDB IDBKeyRange
localStorage CSS DOMRect DOMMatrix Path2D OffscreenCanvas CanvasRenderingContext2D WebGLRenderingContext
webkitAudioContext webkitSpeechRecognition SpeechRecognition TrustedTypes trustedTypes
""".split())

RESERVED = set("""
await async break case catch class const continue debugger default delete do else enum export
extends false finally for function if in instanceof interface new null package private protected
public return static super switch this throw true try typeof var void while with yield let of get set
undefined NaN Infinity arguments globalThis import from
""".split())


def _skip_string(src, i):
    """Позиция за закрывающей кавычкой строки '..."/"...; i стоит на кавычке."""
    q, n = src[i], len(src)
    i += 1
    while i < n:
        if src[i] == "\\":
            i += 2
            continue
        if src[i] == q:
            return i + 1
        i += 1
    return n


def _skip_regex(src, i):
    """Позиция за regex-литералом; i стоит на '/'. Учитывает классы [...] и флаги."""
    n, cls = len(src), False
    i += 1
    while i < n:
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == "\n":
            break
        if c == "[":
            cls = True
        elif c == "]":
            cls = False
        elif c == "/" and not cls:
            i += 1
            while i < n and src[i].isalpha():     # флаги gimsuy
                i += 1
            return i
        i += 1
    return i


def _brace_end(src, i):
    """Индекс за парной '}' для '{' на позиции i: строки, шаблоны, комментарии и regex не в счёт."""
    depth, n = 0, len(src)
    prev = ""
    while i < n:
        c = src[i]
        if c == "/" and src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in "\"'":
            i = _skip_string(src, i)
            prev = "x"
            continue
        if c == "`":
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == "`":
                    i += 1
                    break
                if src.startswith("${", i):
                    i = _brace_end(src, i + 1)
                    continue
                i += 1
            prev = "x"
            continue
        if c == "/" and prev and prev in "(,=:[!&|?{};+~%^*<>" and not src.startswith("//", i):
            i = _skip_regex(src, i)
            prev = "x"
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        if not c.isspace():
            prev = c
        i += 1
    return n


def strip_code(src):
    """Код без строк, шаблонов, regex-литералов и комментариев; выражения внутри ${...}
    остаются кодом. Переводы строк сохраняются, чтобы номера строк в падении были настоящие."""
    out = []
    i, n = 0, len(src)
    prev = ""                        # по предыдущему значимому символу решаем regex-vs-деление
    while i < n:
        c = src[i]
        if c == "/" and src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append("\n" * src.count("\n", i, j))
            i = j
            continue
        if c == "/" and src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("\n" * src.count("\n", i, j))
            i = j
            continue
        if c in "\"'":
            j = _skip_string(src, i)
            out.append(" " + "\n" * src.count("\n", i, j))
            i = j
            prev = "x"
            continue
        if c == "`":                  # шаблон: текст выбрасываем (переводы строк бережём), ${выражения} чистим
            out.append(" ")
            i += 1
            while i < n:
                if src[i] == "\\":
                    out.append(" " * 2 if "\n" not in src[i:i + 2] else "\n")
                    i += 2
                    continue
                if src[i] == "`":
                    i += 1
                    break
                if src.startswith("${", i):
                    e = _brace_end(src, i + 1)
                    out.append(" " + strip_code(src[i + 2:e - 1]) + " ")
                    i = e
                    continue
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            prev = "x"
            continue
        if c == "/" and prev in "(,=:[!&|?{};+~%^*<>\n":
            out.append(" ")
            i = _skip_regex(src, i)
            prev = "x"
            continue
        out.append(c)
        if not c.isspace():
            prev = c
        i += 1
    return "".join(out)


def _declarator_names(code, kw_end):
    """Имена после const/let/var до ';' на глубине 0: 'let a = 1, b = 2' даёт a и b;
    деструктуризации {a, b: c} и [x, y] дают a, c, x, y."""
    names = []
    i, n, depth = kw_end, len(code), 0
    buf = ""
    def take(segment):
        segment = segment.strip()
        m = re.match(r"[A-Za-z_$][\w$]*", segment)
        if m:
            names.append(m.group(0))
        for dstr in re.findall(r"\{([^{}]*)\}|\[([^\[\]]*)\]", segment):
            inner = dstr[0] or dstr[1]
            for piece in inner.split(","):
                piece = piece.strip().split(":")[-1].split("=")[0].strip()
                if re.fullmatch(r"[A-Za-z_$][\w$]*", piece or ""):
                    names.append(piece)
    while i < n:
        c = code[i]
        if c in "\"'":
            i = _skip_string(code, i)
            buf += " "
            continue
        if c == "`":
            j = i + 1
            while j < n:
                if code[j] == "\\":
                    j += 2
                    continue
                if code[j] == "`":
                    j += 1
                    break
                if code.startswith("${", j):
                    j = _brace_end(code, j + 1)
                    continue
                j += 1
            buf += " "
            i = j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == ";" and depth == 0:
            break
        elif c == "," and depth == 0:
            take(buf)
            buf = ""
            i += 1
            continue
        elif c == "=" and depth == 0 and not code.startswith(("=>", "=="), i):
            j = i
            depth_i = 0
            while j < n:
                cj = code[j]
                if cj in "([{":
                    depth_i += 1
                elif cj in ")]}":
                    depth_i -= 1
                elif cj == "," and depth_i == 0:
                    break
                elif cj == ";" and depth_i == 0:
                    break
                j += 1
            take(buf)
            buf = ""
            i = j
            continue
        buf += c
        i += 1
    take(buf)
    return names


def _match_close(src, i, open_c, close_c):
    depth, n = 0, len(src)
    prev = ""
    while i < n:
        c = src[i]
        if c == "/" and src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if c == "/" and src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if c in "\"'":
            i = _skip_string(src, i); prev = "x"; continue
        if c == "`":
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2; continue
                if src[i] == "`":
                    i += 1; break
                if src.startswith("${", i):
                    i = _brace_end(src, i + 1); continue
                i += 1
            prev = "x"; continue
        if c == "/" and prev and prev in "(,=:[!&|?{};+~%^*<>" and not src.startswith("//", i):
            i = _skip_regex(src, i); prev = "x"; continue
        if c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return i + 1
        if not c.isspace():
            prev = c
        i += 1
    return n


def _split_params(inner):
    """Имена из '(a, b = 1, [x, y], {k: v}, rest)' на верхнем уровне."""
    names = []
    depth = 0
    buf = ""
    for ch in inner:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            names += _param_names(buf)
            buf = ""
        else:
            buf += ch
    names += _param_names(buf)
    return names


def _param_names(seg):
    seg = seg.strip()
    m = re.match(r"[A-Za-z_$][\w$]*", seg)
    out = [m.group(0)] if m else []
    for dstr in re.findall(r"\{([^{}]*)\}|\[([^\[\]]*)\]", seg.split("=")[0]):
        inner = dstr[0] or dstr[1]
        for piece in inner.split(","):
            piece = piece.strip().split(":")[-1].split("=")[0].strip()
            if re.fullmatch(r"[A-Za-z_$][\w$]*", piece or ""):
                out.append(piece)
    return out


def declared_names(code):
    """Имена, объявленные где-либо в файле (без ложных падений): объявления со всеми
    деклараторами, имена функций/классов, catch, все параметры (включая деструктуризации
    со вложениями), стрелочные параметры."""
    decl = set()
    for m in re.finditer(r"\b(?:const|let|var)\s+", code):
        decl |= set(_declarator_names(code, m.end()))
    for m in re.finditer(r"\b(?:function|class)\s+([A-Za-z_$][\w$]*)", code):
        decl.add(m.group(1))
    for m in re.finditer(r"\bcatch\s*\(\s*([A-Za-z_$][\w$]*)", code):
        decl.add(m.group(1))
    # все сбалансированные "( ... )", за которыми следует '=>' или '{': списки параметров;
    # внутренние скобки тоже разбираем (континуем со следующей '('), иначе теряем
    # параметры вложенных стрелочных: map((_, i) => ...)
    i = 0
    while True:
        i = code.find("(", i)
        if i < 0:
            break
        j = _match_close(code, i, "(", ")")
        tail = code[j:j + 40].lstrip()
        if tail.startswith("=>") or tail.startswith("{"):
            decl |= set(_split_params(code[i + 1:j - 1]))
        i += 1
    for m in re.finditer(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>", code):
        decl.add(m.group(1))
    for m in re.finditer(r"\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+", code):
        decl |= {nm for nm in _declarator_names(code, m.end())}
    return decl


IMPORT_RX = re.compile(r"^\s*import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?"
                       r"(?:\{([^}]*)\}|\*\s*as\s+([A-Za-z_$][\w$]*))?\s*(?:from\s.*)?;", re.M)


def imported_names(code):
    """Имена из import: {a, b as c}, * as ns, default."""
    names = set()
    for m in IMPORT_RX.finditer(code):
        if m.group(1):
            names.add(m.group(1))
        if m.group(2):
            for piece in m.group(2).split(","):
                piece = piece.strip()
                if not piece:
                    continue
                names.add(piece.split(" as ")[-1].strip())
        if m.group(3):
            names.add(m.group(3))
    return names


def window_props(js_all):
    """Имена, которые скрипты вешают на window: они живут в глобальной области и при
    переносе кода в модули не теряются."""
    return set(re.findall(r"window\.([A-Za-z_$][\w$]*)\s*=", js_all))


def unresolved_names(name, code, allowed):
    """Голые идентификаторы файла, которые ничем не разрешены. Имя берётся целиком
    (?![\\w$]): без этого регулярка недоедала хвосты у 'HEAD :' и т.п. Имя перед ':' -
    свойство литерала или метка: ссылкой не считается."""
    bad = {}
    for m in re.finditer(r"(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])", code):
        ident = m.group(1)
        if ident in allowed or ident in RESERVED:
            continue
        if re.match(r"\s*:", code[m.end():m.end() + 4]):
            continue                                  # ключ литерала {a: ...}, метка, case-двоеточие
        if code[m.end():m.end() + 1] == "(":           # объявление метода класса: name() { - не ссылка
            j = _match_close(code, m.end(), "(", ")")
            if code[j:j + 40].lstrip().startswith("{"):
                continue
        line = code.count("\n", 0, m.start()) + 1
        bad.setdefault(ident, []).append(line)
    return bad


def assigned_imports(code, imports):
    """Присваивание импортированному имени в ES-модуле - TypeError прямо в браузере."""
    hits = []
    for m in re.finditer(r"(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])\s*=(?!=|>)", code):
        if m.group(1) in imports:
            hits.append("%s на строке %d" % (m.group(1), code.count("\n", 0, m.start()) + 1))
    for m in re.finditer(r"(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])\s*(?:\+\+|--|\+=|-=|\*=|/=)", code):
        if m.group(1) in imports:
            hits.append("%s на строке %d" % (m.group(1), code.count("\n", 0, m.start()) + 1))
    return hits


# --- сама проверка ----------------------------------------------------------

def main(argv):
    repo = env.repo([a for a in argv if not a.startswith("-")], "ui.py")
    page = repo / "app" / "ui" / "index.html"
    if not page.is_file():
        raise SystemExit("нет страницы: %s" % page)
    html = page.read_text(encoding="utf-8")
    js_all = env.ui_js(repo)
    js_files = env.ui_js_files(repo)
    results = []

    print("страница: %s (%d строк) · js-файлов: %d" % (page, html.count("\n") + 1, len(js_files)))
    print()

    # 1. синтаксис: инлайновые блоки и каждый js-файл по отдельности
    print("=== 1. скрипты страницы и js-файлы разбираются ===")
    blocks = SCRIPT_BLOCK.findall(html)
    node = env.node()
    if not node:
        env.missing("разбор скриптов", "KADR_NODE", "(node --check)")
        results.append(("синтаксис скриптов", True))
    else:
        todo = [("блок <script> %d" % i, b, False) for i, b in enumerate(blocks, 1)]
        for f in js_files:
            src = f.read_text(encoding="utf-8")
            as_mod = bool(re.search(r"(?m)^\s*(import|export)\b", src))
            todo.append(("js/%s" % f.relative_to(page.parent).as_posix(), src, as_mod))
        bad = []
        for name, text, as_mod in todo:
            ok, err = node_check(node, text, as_mod, "chk")
            if not ok:
                bad.append("%s: %s" % (name, err[:160]))
        verdict(results, "разобрались все скрипты (блоков %d, файлов %d)" % (len(blocks), len(js_files)),
                not bad, "; ".join(bad)[:400])

    # 2. id в разметке: один элемент - один id
    print()
    print("=== 2. id элементов ===")
    i0 = html.find("<script")
    markup = (html[:i0] if i0 > 0 else html)
    ids = markup_ids(markup)
    dups = [(x, n) for x, n in Counter(ids).items() if n > 1]
    known = set(ids) | created_ids(js_all)
    verdict(results, "нет двух элементов с одним id", not dups, str(dups)[:200])
    print("   (справка) id в разметке: %d · ещё %d имён дают скрипты (элементы создаются в раннере)"
          % (len(set(ids)), len(known - set(ids))))

    # 3. обращения к элементам: по странице И по всем js-файлам
    print()
    print("=== 3. обращения к id и классам ===")
    calls = []
    whole = html + "\n" + js_all
    for rx, kind in ((SEL_CALL, "$"), (GET_BY_ID, "getElementById"), (QUERY_CALL, "querySelector")):
        for m in rx.finditer(whole):
            calls.append((kind, m.group(2), (m.group(3) == "+")))
    pool = class_pool(html, repo)
    js_tokens = js_string_tokens(js_all)
    dyn_templates = dynamic_id_templates(js_all)
    miss_ids, miss_classes, dynamic_calls = [], [], 0
    js_ids, js_classes = set(), set()
    markup_ids_set = set(ids)
    for kind, sel, joined in calls:
        sids, sclasses, dynamic = selector_tokens(sel)
        if dynamic or joined:
            dynamic_calls += 1                       # '#view-' + name, `#${it.id}` и т.п.
            continue
        for x in sids:
            if x in known:
                if x not in markup_ids_set:
                    js_ids.add(x)                    # элемент создаёт скрипт: в разметке его нет
            else:
                miss_ids.append("%s('%s') - такого id нигде нет" % (kind, sel))
        for c in sclasses:
            if c in pool or c in JS_ONLY_CLASSES:
                continue
            if c in js_tokens:
                js_classes.add(c)                    # класс присваивается уже в раннере
            else:
                miss_classes.append("%s('%s') - класса '%s' нет ни в стилях, ни в разметке" % (kind, sel, c))
    verdict(results, "каждый #id из селекторов существует: в разметке, в стилях или создан скриптом "
                     "(вызовов %d, динамических %d)" % (len(calls), dynamic_calls),
            not miss_ids, "; ".join(dict.fromkeys(miss_ids))[:400])
    verdict(results, "каждый класс из селекторов упоминается (разметка, стили, скрипты)",
            not miss_classes, "; ".join(dict.fromkeys(miss_classes))[:400])

    # 4. маршруты: замороженная таблица routes.json
    print()
    print("=== 4. таблица маршрутов (замороженная routes.json) ===")
    if not ROUTES_FILE.is_file():
        verdict(results, "есть таблица маршрутов routes.json", False,
                "заморозьте: python tools/checks/routes.py --write")
    else:
        table = json.loads(ROUTES_FILE.read_text(encoding="utf-8")).get("routes", [])
        routes = [(m, p) for m, p, _h in table]
        api = sorted({norm_api(m.group(2)) for m in API_LITERAL.finditer(whole)})
        lost = [p for p in api if not route_matches(p, routes)]
        verdict(results, "каждый '/api/...' со страницы и из js знает сервер (путей: %d, маршрутов: %d)"
                % (len(api), len(routes)), not lost, "нет в таблице: " + ", ".join(lost)[:300])

    # 5. верхние имена js: объявлены один раз во всех файлах
    print()
    print("=== 5. верхние имена js-файлов уникальны ===")
    if not js_files:
        print("   (js-файлов пока нет - единственная проверка - инлайновый блок)")
        results.append(("верхние имена js уникальны", True))
    else:
        owners = {}
        dup = []
        for f in js_files:
            code = strip_code(f.read_text(encoding="utf-8"))
            for m in re.finditer(r"(?m)^(?:export\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)", code):
                nm = m.group(2)
                if nm in owners and owners[nm] != f.name:
                    dup.append("%s: %s и %s" % (nm, owners[nm], f.name))
                owners.setdefault(nm, f.name)
        verdict(results, "нет имени, объявленного в двух js-файлах (имён: %d)" % len(owners),
                not dup, "; ".join(dup)[:300])

    # 6. разрешения имён: каждый голый идентификатор обязан быть объявлен/импортирован/на window
    print()
    print("=== 6. каждый идентификатор в js разрешим (пропуск импорта падает здесь) ===")
    if not js_files:
        print("   (js-файлов пока нет - проверка включится вместе с модулями)")
        results.append(("идентификаторы js разрешимы", True))
    else:
        allowed_common = GLOBAL_WORDS | window_props(js_all)
        problems = []
        assigns = []
        for f in js_files:
            raw = f.read_text(encoding="utf-8")
            code = strip_code(raw)
            imports = imported_names(code)
            allowed = allowed_common | declared_names(code) | imports
            bad = unresolved_names(f.name, code, allowed)
            for nm, lines in sorted(bad.items()):
                problems.append("%s: '%s' не объявлен и не импортирован (строки %s)"
                                % (f.name, nm, ", ".join(map(str, lines[:3]))))
            for hit in assigned_imports(code, imports):
                assigns.append("%s: %s" % (f.name, hit))
        verdict(results, "голые идентификаторы всех js-файлов разрешимы", not problems,
                " | ".join(problems)[:500])
        verdict(results, "нет присваиваний импортированным именам (в браузере это TypeError)",
                not assigns, " | ".join(assigns)[:300])

    def names(seq, limit=18):
        s = sorted(seq)
        return ", ".join(s[:limit]) + (", ... ещё %d" % (len(s) - limit) if len(s) > limit else "")

    findings = []
    if js_ids:
        findings.append("id создаёт скрипт, в разметке их нет (%d): %s" % (len(js_ids), names(js_ids)))
    if js_classes:
        findings.append("класс присваивается в раннере, в стилях его нет (%d): %s"
                        % (len(js_classes), names(js_classes)))
    findings += ["имена собираются по шаблону: %s" % t for t in dyn_templates]
    note_list("НАХОДКИ (смотреть человеку, падением не считается):", findings)
    if miss_ids:
        note_list("ПАДАЮЩИЕ НАХОДКИ - обращений к несуществующим id:", list(dict.fromkeys(miss_ids)))
    if miss_classes:
        note_list("ПАДАЮЩИЕ НАХОДКИ - обращений к несуществующим классам:", list(dict.fromkeys(miss_classes)))
    if "lost" in dir() and lost:
        note_list("ПАДАЮЩИЕ НАХОДКИ - маршрутов нет в routes.json:", lost)

    fails = [n for n, ok in results if not ok]
    print()
    print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
