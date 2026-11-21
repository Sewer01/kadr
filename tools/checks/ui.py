"""Проверка страницы интерфейса без браузера: app/ui/index.html.

Что проверяем (всё статически, по тексту файла - браузер не запускаем):
1. единственный блок <script> страницы разбирается node (node --check, файл не исполняется);
2. нет двух элементов с одним id;
3. нет обращений getElementById / querySelector / $ / $$ к id или классу, которого в файле нет;
4. все пути '/api/...' со страницы есть среди маршрутов app/server.py;
5. каждый #id из селекторов встречается в разметке страницы.

Отдельно печатается список НАХОДОК: то, что стоит посмотреть человеку, но что не является
падением само по себе (например id создаётся скриптом, а не лежит в разметке).

Приложение этой проверкой НЕ правится: если находка реальна, проверка падает и честно
перечисляет места, а решение о правке принимает человек.

Запуск из корня репы:
  python tools/checks/ui.py
  python tools/checks/ui.py C:\\путь\\до\\репы
"""
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
#   1) имя собирается из переменной: $('#x' + i), getElementById(id), $(sel) - у вызова
#      не строка-литерал в кавычках, или сразу после литерала стоит '+';
#   2) имя собирается шаблоном: $(`#${it.id}`), внутри строки есть ${...};
#   3) элемент создаёт сам скрипт: id="cwBar" внутри строки-шаблона, el.id = 'x',
#      setAttribute('id', 'x') - такие id ищутся по всему файлу и показываются в НАХОДКАХ;
#   4) класс элемент получает в раннере: mk('cmp-b', ...), classList.add('on'),
#      className = '...' - класс ищется по строковым литералам скрипта, тоже в НАХОДКАХ;
#   5) классы из стилей страницы: .mt-item{...} - элемент может создаваться без class="",
#      но стиль на него уже есть, значит имя живое.
# Всё остальное, чего нет ни в разметке, ни в стилях, ни в скрипте, - падение: ровно та
# поломка, которую должна ловить эта проверка после переноса кода между файлами.
JS_ONLY_CLASSES = ()              # отдельных поблажек нет: правила выше покрывают всё

ROUTE_ROUTES = re.compile(r'web\.(get|post|put|patch|delete|static)\(\s*"([^"]+)"')
SCRIPT_BLOCK = re.compile(r"(?s)<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>")
LITERAL = r"""(["'])((?:\\.|(?!\1)[^\\])*)\1"""
# хвост (\+?) ловит склейку строки с переменной: $('#view-' + name) - имя собирается
# в раннере, сверять его не с чем, это узаконенная динамика
API_LITERAL = re.compile(r"""(["'`])(/api/(?:\\.|(?!\1)[^\\])*)\1""")
SEL_CALL = re.compile(r"\$\$?\(\s*" + LITERAL + r"\s*(\+?)")            # $('#x') и $$('#x')
GET_BY_ID = re.compile(r"getElementById\(\s*" + LITERAL + r"\s*(\+?)")
QUERY_CALL = re.compile(r"querySelector(?:All)?\(\s*" + LITERAL + r"\s*(\+?)")


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


# --- разбор страницы --------------------------------------------------------

def split_page(html):
    """Разметка до первого <script> и сам скрипт страницы."""
    i = html.find("<script")
    return (html[:i] if i > 0 else html), (html[i:] if i > 0 else "")


def markup_ids(markup):
    return re.findall(r'\bid="([\w-]+)"', markup)


def created_ids(js):
    """id, которые создаёт сам скрипт: id="x" внутри строк-шаблонов и el.id = 'x'."""
    out = set()
    out |= set(re.findall(r'\bid="([A-Za-z][\w-]*)"', js))
    out |= set(re.findall(r"""\.id\s*=\s*['"]([\w-]+)['"]""", js))
    out |= set(re.findall(r"""setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]""", js))
    return out


def dynamic_id_templates(js):
    """Шаблоны, по которым имена собираются в раннере: id="${...}" - это узаконенная динамика."""
    return sorted({m.group(0).strip() for m in re.finditer(r'id="[^"]*\$\{[^"]*"', js)})


def js_string_tokens(js):
    """Слова, которые в скрипте стоят отдельными строковыми литералами: mk('cmp-b', ...),
    classList.add('on'). Класс, который элемент получает уже в раннере, в разметке и в стилях
    не светится, поэтому считаем его живым, но показываем в НАХОДКАХ.
    Берём целые короткие литералы: парить кавычки в 900 КБ скрипта - дело неблагодарное."""
    return set(re.findall(r"""['"`]([A-Za-z][\w-]{1,30})['"`]""", js))


def css_classes(whole):
    """Классы, которые объявлены в стилях страницы: .mt-item{...}, #view-montage .mt-item{...}.
    В CSS берём только часть до '{', чтобы не принять за класс numbers вроде 0.5rem."""
    pool = set()
    for css in re.findall(r"(?s)<style[^>]*>(.*?)</style>", whole):
        for sel in re.findall(r"([^{}]+)\{", css):
            pool |= set(re.findall(r"\.([A-Za-z][\w-]*)", sel))
    return pool


def class_pool(whole):
    """Все классы, которые встречаются в файле: стили, class="" (разметка и шаблоны), classList."""
    pool = css_classes(whole)
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
    # атрибутные части [data-x="y"] выкидываем: там свои правила, и они не про id/класс
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


def node_parse(js_path):
    """Только синтаксис: node --check файл не исполняет."""
    node = env.node()
    if not node:
        return None, "нет node.exe; задайте KADR_NODE"
    r = subprocess.run([str(node), "--check", str(js_path)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=180)
    return r, None


# --- сама проверка ----------------------------------------------------------

def main(argv):
    repo = env.repo([a for a in argv if not a.startswith("-")], "ui.py")
    page = repo / "app" / "ui" / "index.html"
    server = repo / "app" / "server.py"
    if not page.is_file():
        raise SystemExit("нет страницы: %s" % page)
    html = page.read_text(encoding="utf-8")
    markup, js = split_page(html)
    results = []
    findings = []

    print("страница: %s (%d строк)" % (page, html.count("\n") + 1))
    print()

    # 1. синтаксис единственного блока <script>
    blocks = SCRIPT_BLOCK.findall(html)
    print("=== 1. скрипт страницы разбирается ===")
    if not blocks:
        verdict(results, "найти блок <script>", False, "в файле нет ни одного блока")
    else:
        verdict(results, "блок <script> ровно один", len(blocks) == 1, "блоков: %d" % len(blocks))
        node = env.node()
        if not node:
            env.missing("разбор скрипта страницы", "KADR_NODE", "(node --check)")
            results.append(("синтаксис скрипта страницы", True))
        else:
            with tempfile.TemporaryDirectory() as tmp:
                f = Path(tmp) / "page.js"
                f.write_text("\n;\n".join(blocks), encoding="utf-8")
                r, err = node_parse(f)
                if r is None:
                    env.missing("разбор скрипта страницы", "KADR_NODE", err)
                    results.append(("синтаксис скрипта страницы", True))
                else:
                    bad = (r.stderr or "").strip().replace("\n", " | ")
                    verdict(results, "скрипт страницы (%d знаков) разбирается node" % len(blocks[0]),
                            r.returncode == 0, "код %d · %s" % (r.returncode, bad[:300]) if r.returncode else "")

    # 2. id в разметке: один элемент - один id
    print()
    print("=== 2. id элементов ===")
    ids = markup_ids(markup)
    dups = [(i, n) for i, n in Counter(ids).items() if n > 1]
    known = set(ids) | created_ids(js)
    verdict(results, "нет двух элементов с одним id", not dups, str(dups)[:200])
    print("   (справка) id в разметке: %d · ещё %d имён даёт скрипт (элементы создаются в раннере)"
          % (len(set(ids)), len(known - set(ids))))

    # 3-4. обращения к элементам
    print()
    print("=== 3. обращения к id и классам ===")
    calls = []
    for rx, kind in ((SEL_CALL, "$"), (GET_BY_ID, "getElementById"), (QUERY_CALL, "querySelector")):
        for m in rx.finditer(html):
            calls.append((kind, m.group(2), (m.group(3) == "+"), html.count("\n", 0, m.start()) + 1))
    pool = class_pool(html)
    js_tokens = js_string_tokens(js)
    dyn_templates = dynamic_id_templates(js)
    miss_ids, miss_classes, dynamic_calls = [], [], 0
    js_ids, js_classes = set(), set()
    for kind, sel, joined, line in calls:
        sids, sclasses, dynamic = selector_tokens(sel)
        if dynamic or joined:
            dynamic_calls += 1                       # '#view-' + name, `#${it.id}` и т.п.
            continue
        for i in sids:
            if i in known:
                if i not in set(ids):
                    js_ids.add(i)                    # элемент создаёт скрипт: в разметке его нет
            else:
                miss_ids.append("%s('%s') на строке %d - такого id в файле нет" % (kind, sel, line))
        for c in sclasses:
            if c in pool or c in JS_ONLY_CLASSES:
                continue
            if c in js_tokens:
                js_classes.add(c)                    # класс присваивается уже в раннере
            else:
                miss_classes.append("%s('%s') на строке %d - класса '%s' нет ни в стилях, ни в разметке"
                                    % (kind, sel, line, c))
    verdict(results, "каждый #id из селекторов существует: в разметке, в стилях или создан скриптом "
                     "(вызовов %d, динамических %d)" % (len(calls), dynamic_calls),
            not miss_ids, "; ".join(miss_ids)[:400])
    verdict(results, "каждый класс из селекторов упоминается на странице",
            not miss_classes, "; ".join(miss_classes)[:400])

    # 5. #id из селекторов обязан быть в разметке (или честно создаваться скриптом)
    print()
    print("=== 4. маршруты сервера ===")
    routes = [(m.group(1), m.group(2)) for m in ROUTE_ROUTES.finditer(server.read_text(encoding="utf-8"))]
    api = sorted({norm_api(m.group(2)) for m in API_LITERAL.finditer(html)})
    lost = [p for p in api if not route_matches(p, routes)]
    verdict(results, "каждый '/api/...' со страницы знает сервер (путей: %d, маршрутов: %d)"
            % (len(api), len(routes)), not lost, "нет в сервере: " + ", ".join(lost)[:300])

    def page_calls(tmpl):
        """Зовёт ли страница этот маршрут (с совпадением сегментов-параметров)."""
        return any(route_matches(p, [(None, tmpl)]) for p in api)

    unused = sorted({t for _m, t in routes if t.startswith("/api/") and not page_calls(t)})
    print("   (справка) маршрутов, которые страница не зовёт: %d · %s"
          % (len(unused), ", ".join(unused[:4]) if unused else "нет"))

    def uniq(seq):
        return list(dict.fromkeys(seq))              # одно и то же место не печатаем трижды

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
        note_list("ПАДАЮЩИЕ НАХОДКИ - обращений к несуществующим id:", uniq(miss_ids))
    if miss_classes:
        note_list("ПАДАЮЩИЕ НАХОДКИ - обращений к несуществующим классам:", uniq(miss_classes))
    if lost:
        note_list("ПАДАЮЩИЕ НАХОДКИ - маршрутов нет в app/server.py:", lost)

    fails = [n for n, ok in results if not ok]
    print()
    print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
