"""Сторож таблицы маршрутов: (метод, путь, обработчик) заморожена и сверяется побайтово.

Зачем: app/server.py разносят по областям, и главный риск - молча потерянный, переименованный или
переставленный маршрут. Страница дёрнет адрес, которого больше нет, и узнает об этом только человек.
Таблица маршрутов - это то, что сервер обещает интерфейсу, поэтому она один раз записана в
tools/checks/routes.json и сверяется побайтово: поменялся путь, метод, имя обработчика или порядок -
проверка падает и называет конкретный маршрут.

Порядок в списке - порядок регистрации в build_app(), а не алфавит: он же решает, какой маршрут
выиграет при пересечении шаблонов ('/api/wf/list' обязан быть зарегистрирован раньше '/api/wf/{id}',
иначе список графов начнёт отвечать содержимым графа). Значит порядок - тоже часть обещания, и он
заморожен вместе с путями.

Заморожено два списка:
  routes   - [метод, путь, обработчик] в порядке регистрации (обработчик как в коде: state.h_index,
             а у маршрутов без обработчика-метода - выражение целиком, например lambda);
  handlers - имена всех обработчиков h_*, объявленных в модулях состояния, по алфавиту.
Где именно объявлены обработчики, эталон НЕ запоминает: их можно переносить между файлами,
имена и таблица при этом обязаны остаться.

Запуск из корня репы:
  python tools/checks/routes.py            # сверить с эталоном (так делает run.py)
  python tools/checks/routes.py --write    # заморозить заново: только когда изменение маршрутов задумано
                                           # и названо в коммите; молча пересоздавать эталон нельзя
"""
import ast
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True        # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

ROUTES_FILE = HERE / "routes.json"
VERBS = ("get", "post", "put", "patch", "delete", "static")

fails = []


def check(name, ok, note=""):
    print(("   OK   " if ok else "   ПАДЕНИЕ  ") + name + ((" · " + note) if note else ""))
    if not ok:
        fails.append(name)


def state_files(repo):
    """Модули состояния: где сейчас живут методы класса состояния (env.state_files).

    Эталон не хранит эти пути: проверка находит обработчик там, где он лежит, но требует, чтобы
    он был.
    """
    return env.state_files(repo)


def expr_text(node):
    """Выражение-обработчик в каноническом виде: отступы и переносы строк не в счёт."""
    return " ".join(ast.unparse(node).split())


def handler_name(node):
    """Имя обработчика из таблицы: state.h_index -> h_index; прочее - выражение как есть."""
    if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "state":
        return "state." + node.attr
    return expr_text(node)


def route_table(repo):
    """Таблица маршрутов из app/server.py: (маршруты, обработчики-имена, пояснение об ошибке)."""
    path = repo / "app" / "server.py"
    if not path.is_file():
        return None, [], "нет app/server.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    build = next((n for n in tree.body
                  if isinstance(n, ast.FunctionDef) and n.name == "build_app"), None)
    if build is None:
        return None, [], "в app/server.py нет функции build_app: искать маршруты негде"

    registered, tables = [], []
    for node in ast.walk(build):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) \
                and fn.value.id == "web" and fn.attr in VERBS:
            registered.append(node)
        if isinstance(fn, ast.Attribute) and fn.attr == "add_routes" and node.args:
            tables.append(node.args[0])

    table = []
    for elt in [e for t in tables for e in getattr(t, "elts", [])]:
        fn = elt.func if isinstance(elt, ast.Call) else None
        if not (isinstance(fn, ast.Attribute) and fn.attr in VERBS and len(elt.args) >= 2
                and isinstance(elt.args[0], ast.Constant)):
            check("каждая строка таблицы маршрутов - web.<метод>(\"/путь\", обработчик)", False,
                  ast.unparse(elt)[:90] if isinstance(elt, ast.Call) else type(elt).__name__)
            continue
        table.append([fn.attr, elt.args[0].value, handler_name(elt.args[1])])

    if len(table) != len(registered):
        check("маршруты зарегистрированы только в одном списке build_app()", False,
              "в таблице %d, вызовов web.<метод> в файле %d" % (len(table), len(registered)))
    names = sorted({h[len("state."):] for _m, _p, h in table if h.startswith("state.")})
    return table, names, ""


def defined_handlers(repo):
    """Имена всех h_*, объявленных в модулях состояния (в классе состояния или вне его)."""
    found = set()
    for f in state_files(repo):
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError as e:
            check("модуль состояния разбирается: %s" % f.name, False, str(e)[:100])
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("h_"):
                found.add(node.name)
    return sorted(found)


def render(routes, handlers):
    """Текст эталона: один и тот же всегда, чтобы сверка была побайтовой."""
    return json.dumps({"routes": routes, "handlers": handlers},
                      ensure_ascii=False, indent=1, sort_keys=False) + "\n"


def first_difference(want, have):
    """Первое расхождение двух таблиц словами."""
    for i, (a, b) in enumerate(zip(want, have)):
        if a != b:
            return "строка %d: ждали %s %s -> %s, видим %s %s -> %s" % (
                i + 1, a[0], a[1], a[2], b[0], b[1], b[2])
    if len(want) != len(have):
        extra = want[len(have):] or have[len(want):]
        return "разное число маршрутов (%d против %d), лишнее: %s" % (len(want), len(have), extra[:3])
    return ""


def main(argv):
    repo = env.repo([a for a in argv if not a.startswith("-")], "routes.py")
    write = "--write" in argv

    routes, route_handlers, why = route_table(repo)
    if routes is None:
        print("ИТОГ: падений: 1 -> [%s]" % why)
        return 1
    handlers = defined_handlers(repo)

    print("=== маршруты сервера: таблица заморожена ===")
    files = state_files(repo)
    print("   таблица: %s" % (repo / "app" / "server.py"))
    print("   модулей состояния: %d · %s" % (len(files), ", ".join(f.name for f in files)))
    print("   маршрутов: %d · обработчиков h_* объявлено: %d · на маршрутах: %d"
          % (len(routes), len(handlers), len(route_handlers)))

    check("нет одинаковых метод+путь дважды",
          len({(m, p) for m, p, _h in routes}) == len(routes),
          str(sorted({(m, p) for m, p, _h in routes
                      if [(x[0], x[1]) for x in routes].count((m, p)) > 1}))[:120])

    lost = sorted(set(route_handlers) - set(handlers))
    check("каждый обработчик из таблицы определён в модулях состояния", not lost, str(lost)[:160])
    orphan = sorted(set(handlers) - set(route_handlers))
    if orphan:
        print("   (справка) обработчиков не висит ни на одном маршруте: %d · %s"
              % (len(orphan), ", ".join(orphan[:6])))

    text = render(routes, handlers)
    if write:
        ROUTES_FILE.write_text(text, encoding="utf-8", newline="\n")
        check("эталон заморожен: %s" % ROUTES_FILE, True,
              "%d маршрутов, %d имён обработчиков - изменение таблицы должно быть названо в коммите"
              % (len(routes), len(handlers)))
    else:
        if not ROUTES_FILE.is_file():
            check("есть эталон %s" % ROUTES_FILE.name, False,
                  "нет файла - заморозьте его: python tools/checks/routes.py --write")
        else:
            old = ROUTES_FILE.read_text(encoding="utf-8").replace("\r\n", "\n")
            check("таблица маршрутов совпала с эталоном побайтово (%d байт)" % len(text),
                  old == text, "" if old == text else _diff_report(old, text))
    print()
    print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
    return 1 if fails else 0


def _split_routes(text):
    """Таблица из текста эталона: чтобы показать человеку конкретный маршрут, а не разницу байтов."""
    try:
        data = json.loads(text)
        return data.get("routes", []), data.get("handlers", [])
    except ValueError:
        return None, None


def _diff_report(old, new):
    """Что именно разошлось с эталоном: порядок, путь, метод, имя обработчика или список имён."""
    want_routes, want_handlers = _split_routes(old)
    have_routes, have_handlers = _split_routes(new)
    if want_routes is None:
        return "эталон не разбирается как JSON"
    notes = []
    if len(want_routes) != len(have_routes):
        gone = [f"{m} {p}" for m, p, _h in want_routes if (m, p) not in {(x[0], x[1]) for x in have_routes}]
        added = [f"{m} {p}" for m, p, _h in have_routes if (m, p) not in {(x[0], x[1]) for x in want_routes}]
        notes.append("маршрутов: эталон %d, сейчас %d · пропали %s · добавились %s"
                     % (len(want_routes), len(have_routes), gone[:5], added[:5]))
    else:
        d = first_difference(want_routes, have_routes)
        if d:
            notes.append(d)
    if want_handlers != have_handlers:
        lost = sorted(set(want_handlers) - set(have_handlers))
        extra = sorted(set(have_handlers) - set(want_handlers))
        notes.append("имена обработчиков: пропали %s · добавились %s" % (lost[:6], extra[:6]))
    return " | ".join(notes)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
