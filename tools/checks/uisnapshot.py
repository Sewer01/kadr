"""Снимок интерфейса без браузера: вкладки, контролы по разделам, динамические классы, вызовы API.

Зачем: интерфейс Kadr переезжает из одногоindex.html в страницу с модулями. Поведение
обязано не измениться, а проверить это без живого окна нечем. Поэтому интерфейс один раз
замораживается побайтово в tools/checks/uisnapshot.json, и после каждого шага переноса
снимок обязан совпасть байт в байт: не совпал - значит что-то правят, а не переносят.

Что заморожено:
  tabs            - вкладки: ключ, подпись, раздел («Создать», «Студия», «Система»), порядок,
                    признаки sub/active/hidden;
  nav_html        - точный текст блока навигации из страницы: когда навигацию начнёт строить
                    js/core/tabs.js, отрисованная таблица обязана совпасть с ним побайтово
                    (проверяется прогоном renderNavHtml() в node - без браузера);
  regions         - по каждому разделу (view-*) и по остальным контейнерам - отсортированный
                    список контролов: тег, id, классы, тип поля, текстовая подпись, hidden;
  dynamic_classes - классы, которые даёт только JS (атрибуты class в шаблонах, classList,
                    className), а в разметке и стилях их нет: .lm-bed, классы at-*, li-tag;
  api_calls       - все строковые литералы '/api/...' из скриптов страницы (fetch, postJSON).

Источники читаются так, чтобы перенос кода не двигал снимок: скрипты - инлайновые блоки
страницы и все файлы app/ui/js (объединение); стили - инлайновые блоки <style> и все
файлы app/ui/css (объединение). Вкладки - из разметки страницы, а когда появится
js/core/tabs.js - оттуда, и обязаны совпасть с замороженным списком.

Запуск из корня репы:
  python tools/checks/uisnapshot.py            # сверить с эталоном (так делает run.py)
  python tools/checks/uisnapshot.py --write    # заморозить заново: один раз, до начала правок;
                                               # после заморозки пересоздавать эталон нельзя
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True        # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

SNAP_FILE = HERE / "uisnapshot.json"

CONTROL_TAGS = ("button", "input", "textarea", "select")
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
             "meta", "param", "source", "track", "wbr"}
TAG_RX = re.compile(r"<(/?)([a-zA-Z][\w:-]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*)>", re.S)
COMMENT_RX = re.compile(r"<!--.*?-->", re.S)
SVG_RX = re.compile(r"(?s)<svg\b.*?</svg>")
SPAN_RX = re.compile(r"(?s)<span\b.*?</span>")
SCRIPT_RX = re.compile(r"(?s)<script\b[^>]*>.*?</script>")
STYLE_RX = re.compile(r"(?s)<style\b[^>]*>.*?</style>")
ATTR_RX = re.compile(r"""([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+)))?""")

fails = []


def check(name, ok, note=""):
    print(("   OK   " if ok else "   ПАДЕНИЕ  ") + name + ((" · " + note) if note else ""))
    if not ok:
        fails.append(name)


# --- чтение источников: страница, все скрипты, все стили ---------------------

def page_html(repo):
    f = repo / "app" / "ui" / "index.html"
    if not f.is_file():
        raise SystemExit("нет страницы: %s" % f)
    return f.read_text(encoding="utf-8")


def js_sources(repo, skip_markup=False):
    """Весь JS интерфейса одним текстом: инлайновые блоки страницы + app/ui/js/**/*.js.
    skip_markup - вырезать помеченные блоки статической разметки (js/core/tabs.js хранит
    строки прежней навигации: их классы лежат в nav_html, раннер их не назначает)."""
    html = page_html(repo)
    parts = [m.group(0) for m in SCRIPT_RX.finditer(html)]
    jsdir = repo / "app" / "ui" / "js"
    if jsdir.is_dir():
        for f in sorted(jsdir.rglob("*.js")):
            t = f.read_text(encoding="utf-8")
            if skip_markup:
                t = re.sub(r"/\*UISNAP:DATA-BEGIN\*/[\s\S]*?/\*UISNAP:DATA-END\*/", " ", t)
            parts.append(t)
    return "\n".join(parts)


def css_sources(repo):
    """Весь CSS одним текстом: инлайновые блоки <style> + app/ui/css/**/*.css."""
    html = page_html(repo)
    parts = [m.group(0) for m in STYLE_RX.finditer(html)]
    cssdir = repo / "app" / "ui" / "css"
    if cssdir.is_dir():
        for f in sorted(cssdir.rglob("*.css")):
            parts.append(f.read_text(encoding="utf-8"))
    return "\n".join(parts)


def markup_only(html):
    """Разметка без инлайновых скриптов и стилей: в них class= стоит внутри строк JS."""
    return STYLE_RX.sub("", SCRIPT_RX.sub("", html))


# --- разметка: вкладки, контролы по регионам, текст блока навигации -----------

def attrs_of(raw):
    out = {}
    for m in ATTR_RX.finditer(raw or ""):
        val = m.group(2) if m.group(2) is not None else (m.group(3) if m.group(3) is not None
                                                         else (m.group(4) or ""))
        out[m.group(1).lower()] = val
    return out


def cap_from(html_fragment, keep_spans):
    """Текстовая подпись: без иконок-svg; у кнопки ещё и без врезок-badge (span)."""
    t = SVG_RX.sub(" ", html_fragment)
    if not keep_spans:
        t = SPAN_RX.sub(" ", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", t.replace("\xa0", " ")).strip()


def parse_markup(markup):
    """Один проход по разметке: вкладки, регионы контролов, блок nav_html.

    Регион контрола - ближайший enclosing <section id=...>; иначе ближайший id; иначе 'aside',
    если контрол внутри aside; иначе 'page'. Имена регионов - только из самой страницы.
    """
    body = markup[markup.find("<body"):] if "<body" in markup else markup
    body = COMMENT_RX.sub(" ", body)
    stack = []                       # (tag, attrs, open_pos)
    controls = {}                    # region -> list[str]
    tabs = []
    nav_label = ""
    nav_start = nav_end = -1
    pos, n = 0, len(body)
    pending_inputs = []              # (end_pos, region, tag_attrs, label_start)
    label_ranges = []                # (start, end)
    while pos < n:
        m = TAG_RX.search(body, pos)
        if not m:
            break
        closing, tag, raw = m.group(1) == "/", m.group(2).lower(), m.group(3) or ""
        start, end = m.start(), m.end()
        pos = end
        a = attrs_of(raw)
        if not closing and "data-scenarobox" in a:
            # сюда поле поставит модуль окна «Сценарий»: ставим метку, чтобы снимок
            # вставил контрол ровно на это место, а не в конец списка раздела
            controls.setdefault(region_of(stack), []).append("\x00сценарий:" + a["data-scenarobox"])
        if closing:
            for i in range(len(stack) - 1, -1, -1):
                if stack[i][0] == tag:
                    if stack[i][0] == "label":
                        label_ranges.append((stack[i][2], start))
                    del stack[i:]
                    break
            continue
        if tag == "input":
            reg = region_of(stack)
            lab = next((s for t2, _a2, s in stack if t2 == "label"), None)
            pending_inputs.append((start, reg, a, lab))
        if tag == "button":
            close = body.find("</button>", end)
            if close < 0:
                continue
            inner = body[end:close]
            pos = close + len("</button>")
            cls = a.get("class", "")
            if "nav" in cls.split() and "data-view" in a:
                tabs.append({"order": len(tabs) + 1, "section": nav_label,
                             "key": a["data-view"], "caption": cap_from(inner, False),
                             "sub": 1 if "sub" in cls.split() else 0,
                             "active": 1 if "active" in cls.split() else 0,
                             "hidden": 1 if "hidden" in a else 0})
                continue
            cap = cap_from(inner, False) or a.get("title", "") or a.get("aria-label", "")
            add_control(controls, region_of(stack), "button", a, cap)
            continue                       # тело кнопки уже прочитано: на стек её не кладём
        if tag == "textarea":
            close = body.find("</textarea>", end)
            ph = a.get("placeholder", "")
            add_control(controls, region_of(stack), "textarea", a, ph)
            pos = close + len("</textarea>")
            continue
        if tag == "select":
            close = body.find("</select>", end)
            ph = a.get("placeholder", "")
            add_control(controls, region_of(stack), "select", a, ph)
            pos = close + len("</select>")
            continue
        if tag == "div" and "nav-label" in a.get("class", ""):
            close = body.find("</div>", end)
            nav_label = cap_from(body[end:close], True)
            if nav_start < 0:
                nav_start = start
        if tag == "div" and "nav-ver" in a.get("class", "") and nav_start >= 0 and nav_end < 0:
            nav_end = body.rfind("</button>", 0, start)
        if tag not in VOID_TAGS and raw.rstrip().endswith("/"):
            continue
        if tag not in VOID_TAGS:
            stack.append((tag, a, start))
    for p, reg, a, lab in pending_inputs:
        cap = a.get("placeholder", "") or a.get("title", "") or a.get("aria-label", "")
        if not cap and lab is not None:
            rng = next(((s, e) for s, e in label_ranges if s == lab), None)
            if rng:
                frag = body[rng[0]:rng[1]]
                frag = re.sub(r"(?s)<input\b[^>]*>", " ", frag)
                cap = cap_from(frag, True)
        add_control(controls, reg, "input", a, cap)
    nav_html = ""
    if nav_start >= 0 and nav_end > nav_start:
        nav_html = body[nav_start:nav_end + len("</button>")].rstrip() + "\n"
    return tabs, {k: sorted(v) for k, v in sorted(controls.items())}, nav_html


def region_of(stack):
    for tag, a, _s in reversed(stack):
        if tag == "section" and a.get("id"):
            return a["id"]
    for tag, a, _s in reversed(stack):
        if a.get("id"):
            return a["id"]
    return "aside" if any(t == "aside" for t, _a, _s in stack) else "page"


def add_control(controls, region, tag, a, cap):
    cls = [c for c in a.get("class", "").split() if c]
    name = tag
    if a.get("id"):
        name += "#" + a["id"]
    for c in cls:
        name += "." + c
    if tag == "input":
        name += " type=" + (a.get("type") or "text")
    if cap:
        name += " [" + cap + "]"
    if "hidden" in a:
        name += " hidden"
    controls.setdefault(region, []).append(name)


# --- таблица вкладок из js/core/tabs.js (когда она появится) -------------------

TAB_ROW_RX = re.compile(
    r"\{\s*order:\s*(\d+),\s*section:\s*\"([^\"]*)\",\s*key:\s*\"([^\"]*)\",\s*"
    r"caption:\s*\"([^\"]*)\",\s*sub:\s*(true|false),\s*active:\s*(true|false),\s*hidden:\s*(true|false)\s*\}")


def tabs_from_registry(repo):
    f = repo / "app" / "ui" / "js" / "core" / "tabs.js"
    if not f.is_file():
        return None
    src = f.read_text(encoding="utf-8")
    rows = [{"order": int(m.group(1)), "section": m.group(2), "key": m.group(3),
             "caption": m.group(4), "sub": 1 if m.group(5) == "true" else 0,
             "active": 1 if m.group(6) == "true" else 0, "hidden": 1 if m.group(7) == "true" else 0}
            for m in TAB_ROW_RX.finditer(src)]
    return rows or None


def rendered_nav(repo):
    """HTML, который строит js/core/tabs.js: прогоняем renderNavHtml() в node, без браузера."""
    f = repo / "app" / "ui" / "js" / "core" / "tabs.js"
    node = env.node()
    if not f.is_file() or not node:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        wrap = Path(tmp) / "wrap.mjs"
        wrap.write_text("import { renderNavHtml } from %r;\nprocess.stdout.write(renderNavHtml());\n"
                        % f.resolve().as_uri(), encoding="utf-8")
        r = subprocess.run([str(node), "--input-type=module", "-e", wrap.read_text(encoding="utf-8")],
                           capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=120)
        if r.returncode != 0:
            return "ПАДЕНИЕ node: " + (r.stderr or "").strip()[:200]
        return r.stdout


# --- динамические классы и вызовы API из скриптов ------------------------------

def js_dynamic_classes(js, static_pool):
    pool = set()
    for m in re.finditer(r"class\s*=\s*\\?[\"']([^\"'`]*)[\"'`]", js):
        pool |= {c for c in m.group(1).split() if c and "${" not in c and not c.startswith("\\")}
    for m in re.finditer(r"class\s*=\s*`([^`]*)`", js):
        pool |= {c for c in re.sub(r"\$\{[^}]*\}", " ", m.group(1)).split() if c}
    for m in re.finditer(r"className\s*=\s*[\"'`]([^\"'`]*)[\"'`]", js):
        pool |= {c for c in m.group(1).split() if c}
    for m in re.finditer(r"classList\.(?:add|remove|toggle)\(([^)]*)\)", js):
        pool |= set(re.findall(r"""["']([\w-]+)["']""", m.group(1)))
    # классы, которые окну «Сценарий» передают настройкой: само поле, ряд плашек, обёртка
    for m in re.finditer(r"""\b(?:cls|chipsCls|wrap)\s*:\s*["'`]([^"'`]*)["'`]""", js):
        pool |= {c for c in m.group(1).split() if c and "${" not in c}
    return sorted(pool - static_pool)


def static_pool_of(markup, css):
    pool = set()
    for m in re.finditer(r'\bclass="([^"]*)"', markup):
        pool |= {c for c in m.group(1).split() if c}
    for sel in re.findall(r"[^{};{}]+\{", css):
        pool |= set(re.findall(r"\.([A-Za-z][\w-]*)", sel))
    return pool


def api_calls(js):
    return sorted({m.group(2) for m in re.finditer(r"([\"'`])(/api/[^\"'`]*)\1", js)})


def fill_scenario_fields(regions, js):
    """Поля окна «Сценарий» строит модуль, в разметке остаётся только место под него.

    Снимок читает, чем модуль настраивают (id поля, его класс, подсказка), и вписывает
    контрол на место метки. Без этого проверка ослепла бы: пропало бы id поля или его
    подсказка - и ни один сторож не поднялся бы."""
    for names in regions.values():
        for i, name in enumerate(names):
            if not name.startswith("\x00сценарий:"):
                continue
            kind = name.split(":", 1)[1]
            mark = '[data-scenarobox="%s"]' % kind
            body = js[js.find(mark):][:2600] if mark in js else ""
            # cls поля и cls счётчика в настройке окна разные: счётчик вычитаем, чтобы
            # он не притворился классом поля (у поля класса может и не быть)
            body = re.sub(r"counter:\s*\{[^}]*\}", " ", body)
            tid = re.search(r"""ta\.id\s*=\s*["']([^"']+)["']""", body)
            ph = re.search(r"""placeholder:\s*["'`]([^"'`]*)""", body)
            cls = re.search(r"""\bcls:\s*["'`]([^"'`]*)""", body)
            out = "textarea" + ("#" + tid.group(1) if tid else "")
            for c in (cls.group(1).split() if cls else []):
                out += "." + c
            if ph:
                out += " [" + ph.group(1) + "]"
            names[i] = out


# --- снимок целиком и сверка ----------------------------------------------------

def build_snapshot(repo):
    html = page_html(repo)
    markup = markup_only(html)
    js = js_sources(repo)
    css = css_sources(repo)
    tabs, regions, nav_html = parse_markup(markup)
    fill_scenario_fields(regions, js)      # поля, которые строит модуль окна «Сценарий»
    if not nav_html:                       # навигацию строит реестр js/core/tabs.js
        nav_html = rendered_nav(repo) or ""
    reg_tabs = tabs_from_registry(repo)
    source = "js/core/tabs.js" if reg_tabs is not None else "index.html"
    snap = {
        "tabs": reg_tabs if reg_tabs is not None else tabs,
        "nav_html": nav_html,
        "regions": regions,
        "dynamic_classes": js_dynamic_classes(js_sources(repo, skip_markup=True), static_pool_of(markup, css)),
        "api_calls": api_calls(js),
    }
    return snap, source


def render(snap):
    return json.dumps(snap, ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def diff_report(want, have):
    """Что разошлось - словами, с указанием вкладки/раздела и имени."""
    notes = []
    if want["tabs"] != have["tabs"]:
        wk = {t["key"]: t for t in want["tabs"]}
        hk = {t["key"]: t for t in have["tabs"]}
        lost = sorted(set(wk) - set(hk))
        extra = sorted(set(hk) - set(wk))
        if lost:
            notes.append("пропали вкладки: %s" % ", ".join(lost[:5]))
        if extra:
            notes.append("новые вкладки: %s" % ", ".join(extra[:5]))
        for k in sorted(set(wk) & set(hk)):
            if wk[k] != hk[k]:
                d = {f: (wk[k][f], hk[k][f]) for f in wk[k] if wk[k][f] != hk[k][f]}
                notes.append("вкладка '%s' (%s): %s" % (k, wk[k]["caption"], d))
    if want["nav_html"] != have["nav_html"]:
        notes.append("блок навигации разошёлся с замороженным (раздел nav_html)")
    for region in sorted(set(want["regions"]) | set(have["regions"])):
        w = want["regions"].get(region, [])
        h = have["regions"].get(region, [])
        if w == h:
            continue
        lost = [x for x in w if x not in h]
        extra = [x for x in h if x not in w]
        sec = region if region.startswith("view-") else "раздел '" + region + "'"
        if lost:
            notes.append("в %s пропали контролы: %s" % (sec, "; ".join(lost[:5])))
        if extra:
            notes.append("в %s появились контролы: %s" % (sec, "; ".join(extra[:5])))
    for field, label in (("dynamic_classes", "динамические классы"), ("api_calls", "вызовы API")):
        if want[field] != have[field]:
            lost = sorted(set(want[field]) - set(have[field]))
            extra = sorted(set(have[field]) - set(want[field]))
            bits = []
            if lost:
                bits.append("пропали: " + ", ".join(lost[:6]))
            if extra:
                bits.append("добавились: " + ", ".join(extra[:6]))
            notes.append("%s: %s" % (label, " | ".join(bits) or "порядок/состав различаются"))
    return " | ".join(notes)


def main(argv):
    repo = env.repo([a for a in argv if not a.startswith("-")], "uisnapshot.py")
    write = "--write" in argv
    snap, source = build_snapshot(repo)
    text = render(snap)

    print("=== снимок интерфейса: вкладки, контролы, динамические классы, API ===")
    n_ctrl = sum(len(v) for v in snap["regions"].values())
    print("   вкладок: %d · регионов контролов: %d · контролов: %d · "
          "динамических классов: %d · вызовов /api/: %d · вкладки берёт: %s"
          % (len(snap["tabs"]), len(snap["regions"]), n_ctrl,
             len(snap["dynamic_classes"]), len(snap["api_calls"]), source))

    if write:
        SNAP_FILE.write_text(text, encoding="utf-8", newline="\n")
        check("эталон заморожен: %s" % SNAP_FILE.name, True,
              "%d байт - после заморозки пересоздавать его нельзя без явного согласия" % len(text))
    else:
        if not SNAP_FILE.is_file():
            check("есть эталон %s" % SNAP_FILE.name, False,
                  "нет файла - заморозьте: python tools/checks/uisnapshot.py --write")
        else:
            old = SNAP_FILE.read_text(encoding="utf-8").replace("\r\n", "\n")
            check("снимок интерфейса совпал с эталоном побайтово (%d байт)" % len(text),
                  old == text, "" if old == text else diff_report(json.loads(old), snap))
        # если таблица вкладок живёт в js/core/tabs.js, её отрисовка обязана дать исходный HTML
        if source != "index.html":
            got = rendered_nav(repo)
            if got is None:
                env.missing("проверка отрисовки навигации", "KADR_NODE", "(renderNavHtml)")
            else:
                same = got.rstrip() + "\n" == snap["nav_html"]
                check("навигация из js/core/tabs.js рисуется байт в байт как замороженная",
                      same, "" if same else diff_report({"nav_html": snap["nav_html"]},
                                                        {"nav_html": got if not got.startswith("ПАДЕНИЕ")
                                                         else snap["nav_html"]})[:300])
    print()
    print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
