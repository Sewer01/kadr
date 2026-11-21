#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Граф импортов интерфейса: узлы - файлы app/ui/js, рёбра - import, плюс все циклы.

Зачем. ESM переживает цикл, но только пока ничто не читается на уровне верхнего уровня
до инициализации модуля-источника: let/const в таком цикле дают «Cannot access before
initialization», а ещё вчерашнюю функцию-стрелку браузер назовёт «is not a function».
Отсюда правило: значение, через которое цикл идёт, обязано жить в core/ (он не должен
импортировать views/ и ui/), а не ходить по кругу между views/.

Что печатает:
  - узлы, рёбра, strongly connected компоненты и число простых циклов;
  - базис циклов (замыкающие рёбра) и пары встречных импортов;
  - все циклы цепочкой A -> B -> A (--all печатает их дословно, без среза);
  - рёбра, где имя читается на уровне верхнего уровня, а модуль-источник ещё не
    инициализирован, - это и есть настоящая поломка;
  - сверку импортов и экспортов: какое импортируемое имя не экспортируется файлом.

Запуск из корня репы:  python tools/checks/uigraph.py [путь до репы] [--all] [--json]
Только чтение: ничего не меняется, приложение не запускается.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402

RE_IMPORT = re.compile(
    r"""^\s*import\s+(?:(?P<clause>[\w{*][^'"]*?)\s+from\s+)?['"](?P<path>[^'"]+)['"]""",
    re.M)
RE_EXPORT_NAME = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)", re.M)
RE_EXPORT_LET = re.compile(r"^export\s+(?:let|const|var)\s+(.*)$", re.M)
RE_EXPORT_LIST = re.compile(r"export\s*\{([^}]*)\}", re.S)

PRINT_CAP = 120        # сколько циклов показывать на экране без --all


def strip_code(s, keep_strings=False):
    """Код без строк, шаблонов, комментариев и регулярных литералов: для глубины и имён.

    Символы заменжаются пробелами, переносы строк сохраняются, поэтому номера строк не
    съезжают. Вложенность разобрана честно: `${ ... }` внутри шаблона - снова код, и
    шаблон внутри `${ ... }` - снова шаблон (в интерфейсах такие вложения по три уровня).
    keep_strings - строки оставить как есть (разбор import/export: путь лежит в кавычках).
    """
    n = len(s)

    def blank(i, in_tpl, stop_brace):
        """Заглушает символы с позиции i. in_tpl - мы внутри `...`; stop_brace - остановиться
        на фигурной скобке, которая закрывает ${ } снаружи."""
        out, prev, depth = [], "", 0
        while i < n:
            c = s[i]
            two = s[i:i + 2]
            if in_tpl and c == "`":
                out.append(" ")
                return "".join(out), i + 1
            if stop_brace and c == "}" and depth == 0:
                return "".join(out), i
            if in_tpl:
                # текст шаблона - не код: глушим весь, а ${ ... } внутри него снова код
                if two == "${":
                    out.append("  ")
                    sub, i = blank(i + 2, False, True)
                    out.append(sub)
                    if i < n and s[i] == "}":
                        out.append(" ")
                        i += 1
                    continue
                if c == "\\":
                    out.append("  ")
                    i += 2
                    continue
                out.append("\n" if c == "\n" else " ")
                i += 1
                continue
            if two == "//":
                while i < n and s[i] != "\n":
                    out.append(" ")
                    i += 1
                continue
            if two == "/*":
                out.append("  ")
                i += 2
                while i < n and s[i:i + 2] != "*/":
                    out.append("\n" if s[i] == "\n" else " ")
                    i += 1
                out.append("  ")
                i += 2
                continue
            if c in "\"'`":
                quote = c
                if keep_strings:
                    j = i + 1
                    while j < n:
                        if s[j] == "\\":
                            j += 2
                            continue
                        if s[j] == quote:
                            break
                        j += 1
                    out.append(s[i:min(j + 1, n)])
                    i = j + 1
                    prev = "s"
                    continue
                if quote == "`":
                    sub, i = blank(i + 1, True, False)     # содержимое шаблона
                    out.append(sub)
                    prev = "`"
                    continue
                out.append(" ")
                i += 1
                while i < n and s[i] != quote and s[i] != "\n":
                    if s[i] == "\\":
                        i += 1
                    i += 1
                if i < n:
                    out.append("\n" if s[i] == "\n" else " ")
                    i += 1
                prev = "s"
                continue
            if c == "/" and prev in "(,=:[!&|?{};":
                # возможен регулярный литерал /.../ флаги - внутри него свои скобки и кавычки
                j, ok, cls = i + 1, False, False
                while j < n and s[j] != "\n":
                    if s[j] == "\\":
                        j += 2
                        continue
                    if s[j] == "[":
                        cls = True
                    elif s[j] == "]":
                        cls = False
                    elif s[j] == "/" and not cls:
                        ok = True
                        break
                    j += 1
                if ok:
                    out.append(" " * (j - i))
                    i = j
                    prev = "/"
                    continue
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            if not c.isspace():
                prev = c
            out.append(c)
            i += 1
        return "".join(out), i

    return blank(0, False, False)[0]


def decl_names(s):
    """Имена из левой части let/const/var: «a = 1, b = 2» даёт и a, и b.

    Список объявлений режется по запятым на глубине 0, и из каждой части берётся первое
    имя: деструктуризация ([b, c], {d: e}) наружу имени не объявляет, поэтому она пропущена.
    """
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    out = []
    for p in parts:
        p = re.sub(r"^(let|const|var)\s+", "", p.strip())
        if not p or p[0] in "[{":
            continue
        m = re.match(r"([A-Za-z_$][\w$]*)", p)
        if m:
            out.append(m.group(1))
    return out


def exports_of(text):
    """Имена, которые модуль отдаёт наружу (текстовый разбор - страховка, не доказательство)."""
    text = strip_code(text, True)
    n = set()
    for m in RE_EXPORT_NAME.finditer(text):
        n.add(m.group(1))
    for m in RE_EXPORT_LET.finditer(text):
        n.update(decl_names(m.group(1)))
    for m in RE_EXPORT_LIST.finditer(text):
        for part in m.group(1).split(","):
            part = part.strip()
            if part:
                n.add(part.split(" as ")[-1].strip())
    if re.search(r"^\s*export\s+default\b", text, re.M):
        n.add("default")
    return n


def import_clauses(text):
    """[(путь, [имена])] по всем import модуля (имена как они видны в импортирующем файле)."""
    out = []
    for m in RE_IMPORT.finditer(strip_code(text, True)):
        path, clause = m.group("path"), m.group("clause") or ""
        names = []
        if "{" in clause:
            inner = clause[clause.index("{") + 1:clause.rindex("}")]
            for part in inner.split(","):
                part = part.strip()
                if part:
                    names.append(part.split(" as ")[-1].strip())
        mstar = re.search(r"\*\s+as\s+([A-Za-z_$][\w$]*)", clause)
        if mstar:
            names.append("*")
        mdef = re.match(r"\s*([A-Za-z_$][\w$]*)\s*(?:,|$)", clause)
        if mdef and "{" not in clause and not mstar:
            names.append("default")
            names.append(mdef.group(1))
        out.append((path, names))
    return out


def resolve(src_file, rel):
    """Куда ведёт относительный импорт (браузер требует расширение, но .js на конце простим)."""
    t = (src_file.parent / rel).resolve()
    if not t.is_file() and t.with_suffix(".js").is_file():
        t = t.with_suffix(".js")
    return t


def top_level_code(code):
    """Код, из которого вырезаны ТЕЛА функций: что исполняется сразу при загрузке модуля.

    Глубина в скобках тут не мерило: `const f = () => LIB.filter(...)` читается только
    когда f позвали, а `const TABS = [{ n: MODE_NAME.video }]` читается неминуемо. Поэтому
    вырезаются именно тела: function (...) {...}, метод класса, класс целиком и тело
    стрелки (до `,` `;` или закрывающей скобки того же уровня). Литералы объектов и
    массивов, вызовы, условия и циклы остаются: они и есть чтение на старте.
    """
    CONTROL = {"if", "for", "while", "switch", "catch", "with", "do"}
    ident = re.compile(r"([A-Za-z_$][\w$]*)\s*$")
    out = []
    depth = 0
    arrows = []                     # глубины, на которых открыто тело стрелки без {}
    paren_ctl = []                  # была ли каждая открытая ( у условия или цикла
    last_ctl = False                # последняя закрытая ( принадлежала if/for/while/...
    i, n = 0, len(code)

    def block_end(start):
        """Позиция } парной к { на позиции start."""
        j, d = start, depth
        while j < n:
            if code[j] == "{":
                d += 1
            elif code[j] == "}":
                d -= 1
                if d == depth:
                    break
            j += 1
        return j

    def bracket(c):
        """Скобки считаем всегда, даже внутри вырезанного тела: иначе уровень съедет."""
        nonlocal depth, last_ctl
        if c in "([{":
            if c == "(":
                m = ident.search(code[:i])
                paren_ctl.append(bool(m) and m.group(1) in CONTROL)
            depth += 1
        elif c in ")]}":
            depth -= 1
            if c == ")":
                last_ctl = paren_ctl.pop() if paren_ctl else False

    while i < n:
        c = code[i]
        if arrows and depth == arrows[-1] and c in ",;)]}":
            arrows.pop()                       # тело стрелки кончилось; сама скобка внешняя
            bracket(c)
            out.append(" ")
            i += 1
            continue
        if arrows and depth >= arrows[-1]:
            bracket(c)                         # внутри тела стрелки: знаков не оставляем
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if code.startswith("=>", i):
            j = i + 2
            while j < n and code[j] in " \n\t":
                j += 1
            out.append(" " * (j - i))
            if j < n and code[j] == "{":
                e = block_end(j)
                out.append(" " * (e - j + 1))
                i = e + 1
            else:
                arrows.append(depth)
                i = j
            continue
        if c in " \n\t":
            out.append(c)
            i += 1
            continue
        if c == "{":
            before = code[:i].rstrip()
            class_body = bool(re.search(r"\bclass\s+[A-Za-z_$][\w$]*\s*$", before)) or before.endswith("class")
            if class_body or (before.endswith(")") and not last_ctl):
                e = block_end(i)               # тело функции или класс: читается не на старте
                out.append(" " * (e - i + 1))
                i = e + 1
                last_ctl = False
                continue
            last_ctl = False                   # блок if/for/else или литерал: читаем содержимое
        bracket(c)
        out.append(c)
        i += 1
        if c not in ")]}":
            last_ctl = False
    return "".join(out)


def start_reads(text, names):
    """Какие из имён модуль правда читает, пока его тело исполняется (вне тел функций)."""
    if not names:
        return set()
    code = top_level_code(strip_code(text))
    # строка import - это связывание, а не чтение: её убираем совсем
    code = re.sub(r"(?m)^\s*import\b[^\n]*", lambda m: " " * len(m.group(0)), code)
    word = re.compile(r"[A-Za-z_$][\w$]*")
    found, i, n = set(), 0, len(code)
    while i < n:
        c = code[i]
        if c.isalpha() or c in "_$":
            m = word.match(code, i)
            if m:
                if m.group(0) in names and code[i - 1:i] != "." \
                        and not re.match(r"\s*:", code[i + len(m.group(0)):i + len(m.group(0)) + 2]):
                    found.add(m.group(0))
                i += len(m.group(0))
                continue
        i += 1
    return found


def depth0_names(text, names):
    """Устаревшее имя: чтения на уровне верхнего уровня (см. start_reads)."""
    return start_reads(text, names)


def local_names(text):
    """Приблизительный список имён, которые модуль объявил сам (в т.ч. параметры и поля).

    Список намеренно широкий: лишнее имя здесь только промолчит о проблеме, а вот
    недостающее имя заставило бы браузер ругаться на каждой загрузке страницы.
    """
    out = set()
    for m in re.finditer(r"\b(?:function\*?|class)\s+([A-Za-z_$][\w$]*)", text):
        out.add(m.group(1))
    for m in re.finditer(r"\b(?:let|const|var)\s([^;\n]+)", text):
        out.update(decl_names(m.group(1)))
    # разбор по шаблону: const { a, b = 1 } = ... и const [x, y] = ... - имена внутри скобок
    for m in re.finditer(r"\b(?:let|const|var)\s*[{[]([^}\]]*)[}\]]", text):
        for part in m.group(1).split(","):
            mm = re.search(r"([A-Za-z_$][\w$]*)\s*(?::|$|\s*=?[^=])", part.strip())
            if mm:
                out.add(mm.group(1))
    for m in re.finditer(r"\(([^()]*)\)\s*(?:=>|\{)", text):
        # скобки if (x) { и while (x) { - не параметры: иначе имя из условия
        # записывалось бы в объявления и проверка молчала бы о настоящем обрыве
        before = text[max(0, m.start() - 12):m.start()]
        if re.search(r"\b(if|while|for|switch|catch|do)\s*$", before):
            continue
        for p in m.group(1).split(","):
            mm = re.match(r"\s*(?:\{|\[)?\s*([A-Za-z_$][\w$]*)", p)
            if mm:
                out.add(mm.group(1))
    for m in re.finditer(r"[,(\s]([A-Za-z_$][\w$]*)\s*=>", text):
        out.add(m.group(1))
    for m in re.finditer(r"\bcatch\s*\(\s*([A-Za-z_$][\w$]*)", text):
        out.add(m.group(1))
    for m in re.finditer(r"\b([A-Za-z_$][\w$]*)\s*=", text):
        out.add(m.group(1))
    for m in re.finditer(r"^\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{", text, re.M):
        out.add(m.group(1))     # метод класса или объекта, а не вызов с новой строки
    return out


def unimported_usage(graph):
    """Модуль читает имя, которое другой модуль экспортирует, но сам его не импортировал.

    Так выглядит недорезанный одностраничник: `$` была глобальной, а в модуле она обязана
    прийти импортом, иначе браузер возьмёт её из window и упадёт с «$ is not defined».
    Проверяются только имена, которые хоть один модуль отдаёт: против глобальных
    window/document/Math скрипт молчит, поэтому и не ругается на браузерное.
    """
    exported = {}
    for name, g in graph.items():
        for nm in g["exp"]:
            exported.setdefault(nm, set()).add(name)
    word = re.compile(r"[A-Za-z_$][\w$]*")
    out = []
    for name, g in sorted(graph.items()):
        code = re.sub(r"(?m)^\s*import\b[^\n]*", lambda m: " " * len(m.group(0)), strip_code(g["text"]))
        imports = set()
        for path, names in import_clauses(g["text"]):
            imports.update(x for x in names if x not in ("default", "*"))
        local = local_names(code) | g["exp"]
        i, n = 0, len(code)
        while i < n:
            c = code[i]
            if c.isalpha() or c in "_$":
                m = word.match(code, i)
                if not m:
                    i += 1
                    continue
                nm = m.group(0)
                after = code[i + len(nm):i + len(nm) + 2]
                if (nm in exported and nm not in imports and nm not in local
                        and code[i - 1:i] != "." and not re.match(r"\s*:", after)):
                    out.append((name, nm, code[:i].count("\n") + 1, sorted(exported[nm])[:2]))
                    i += len(nm)
                    continue
                i += len(nm)
                continue
            i += 1
    # одно и то же имя в одном файле упоминается много раз: оставляем первую строку
    uniq = {}
    for name, nm, ln, where in out:
        uniq.setdefault((name, nm), (ln, where))
    return [(name, nm, ln, where) for (name, nm), (ln, where) in sorted(uniq.items())]


def line_of(text, name):
    """Первая строка, где имя встречается (подсказка в отчёте)."""
    for k, ln in enumerate(text.splitlines(), 1):
        if re.search(r"\b%s\b" % re.escape(name), ln):
            return k
    return 0


# --- граф --------------------------------------------------------------------

def build(repo):
    """{имя: {'text', 'exp', 'to': {имя: [имена]}}} по всем app/ui/js/**."""
    jsdir = (repo / "app" / "ui" / "js").resolve()
    graph = {}
    for f in sorted(jsdir.rglob("*.js")):
        text = f.read_text(encoding="utf-8", errors="replace")
        to = {}
        for path, names in import_clauses(text):
            if not path.startswith("."):
                continue
            tgt = resolve(f, path)
            key = tgt.relative_to(jsdir).as_posix() if tgt.is_file() else "!/" + path
            to.setdefault(key, [])
            to[key] += names
        name = f.relative_to(jsdir).as_posix()
        graph[name] = {"abs": f, "jsdir": jsdir, "text": text, "exp": exports_of(text), "to": to}
    return graph


def adj(graph):
    return {n: sorted({t for t in graph[n]["to"] if t in graph}) for n in graph}


def reach(adjm):
    """Транзитивное замыкание: кого откуда видно."""
    out = {n: set() for n in adjm}
    for n in adjm:
        seen, stack = set(), list(adjm[n])
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            stack.extend(adjm[x])
        out[n] = seen
    return out


def sccs(adjm):
    """Компоненты сильной связности (итеративный Тарьян)."""
    index, stack, on, link, val = {}, [], set(), {}, [0]
    out = []

    def strong(start):
        work = [(start, 0)]
        while work:
            v, pi = work[-1]
            if pi == 0:
                index[v] = val[0]
                link[v] = val[0]
                val[0] += 1
                stack.append(v)
                on.add(v)
            advanced = False
            for w in adjm[v][pi:]:
                if w not in index:
                    work[-1] = (v, pi + 1)
                    work.append((w, 0))
                    advanced = True
                    break
                if w in on:
                    link[v] = min(link[v], index[w])
            if advanced:
                continue
            work.pop()
            if work:
                p = work[-1][0]
                link[p] = min(link[p], link[v])
            if link[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(sorted(comp))
    for n in sorted(adjm):
        if n not in index:
            strong(n)
    return out


def all_cycles(adjm):
    """Все простые циклы (контуров) графа: обход, где старт - минимальный узел цикла."""
    cycles = []
    for start in sorted(adjm):
        stack, on = [start], {start}

        def dfs(v):
            for nxt in adjm[v]:
                if nxt == start:
                    if len(stack) > 1:
                        cycles.append(list(stack))
                    continue
                if nxt in on or nxt < start:
                    continue
                on.add(nxt)
                stack.append(nxt)
                dfs(nxt)
                stack.pop()
                on.discard(nxt)
        dfs(start)
    return cycles


def basis_cycles(graph):
    """Базис циклов: рёбра, которые замыкают цикл (минимальное число правок до ацикличности)."""
    a = adj(graph)
    seen, out = set(), []
    order = sorted(a)
    # обход в ширину от каждого невозвращённого узла: обратные рёбра и есть базис
    colour = {}

    def dfs(v, path):
        colour[v] = 1
        for w in a[v]:
            if colour.get(w, 0) == 1:
                i = path.index(w)
                key = tuple(sorted(path[i:]))
                if key not in seen:
                    seen.add(key)
                    out.append(path[i:])
            elif colour.get(w, 0) == 0:
                dfs(w, path + [w])
        colour[v] = 2
    sys.setrecursionlimit(10000)
    for v in order:
        if colour.get(v, 0) == 0:
            dfs(v, [v])
    return out


def binding_kinds(text):
    """Вид каждой отдаваемой привязки: function (всплывает) или значение (let/const/class).

    Для ответа на вопрос «можно ли читать это на уровне верхнего уровня, пока модуль
    ещё не доинициализирован», важна именно всплываемость: объявление функции браузер
    создаёт до тела модуля, а let/const/class живут в мёртвой зоне до своей строки.
    """
    code = strip_code(text, True)
    kinds = {}
    for m in re.finditer(r"^export\s+(async\s+)?function\*?\s+([A-Za-z_$][\w$]*)", code, re.M):
        kinds[m.group(2)] = "function"
    for m in re.finditer(r"^export\s+class\s+([A-Za-z_$][\w$]*)", code, re.M):
        kinds[m.group(1)] = "class"
    for m in RE_EXPORT_LET.finditer(code):
        kw = re.match(r"\s*export\s+(let|const|var)\b", m.group(0))
        for x in decl_names(m.group(1)):
            kinds[x] = kw.group(1) if kw else "значение"
    for m in RE_EXPORT_LIST.finditer(code):
        for part in m.group(1).split(","):
            part = part.strip()
            if not part:
                continue
            src = part.split(" as ")[0].strip()
            dst = part.split(" as ")[-1].strip()
            if re.search(r"(?:^|\s)(?:async\s+)?function\s+%s\s*\(" % re.escape(src), code):
                kinds[dst] = "function"
            elif dst not in kinds:
                kinds[dst] = kinds.get(src, "ссылка")
    return kinds


def esm_order(graph, entry="app.js"):
    """Порядок исполнения тел ESM от входа и чтения до инициализации.

    Обход - ровно тот, что делает браузер: сначала (в порядке строк import) исполняются
    зависимости, затем тело модуля. Если тело M читает привязку модуля D, который ещё
    только в стеке (его тело не исполнено), let/const/class дадут «Cannot access before
    initialization»: это и есть цикл, идущий через читаемое на старте значение.
    """
    a = adj(graph)
    order, stack, done = [], [], set()
    early = []

    def walk(name):
        if name in done or name not in graph:
            return
        done.add(name)
        stack.append(name)
        for path, names in import_clauses(graph[name]["text"]):
            if not path.startswith("."):
                continue
            tgt = resolve(graph[name]["abs"], path)
            if not tgt.is_file():
                continue
            dep = tgt.relative_to(graph[name]["jsdir"]).as_posix()
            walk(dep)
            if dep in stack:                            # dep ещё в стеке: его тело не исполнено
                read = depth0_names(graph[name]["text"], set(names))
                kinds = binding_kinds(graph[dep]["text"])
                for nm in sorted(read):
                    kind = kinds.get(nm, "ссылка")
                    if kind != "function":
                        early.append((name, dep, nm, kind, [x for x in stack]))
        order.append(name)
        stack.pop()

    if entry in graph:
        walk(entry)
    for n in sorted(graph):                             # то, до чего от входа не дойти, тоже исполняется
        walk(n)
    return order, early


def edges_of(graph, cycle):
    """Рёбра цикла по порядку: (откуда, куда, [имена])."""
    n = len(cycle)
    return [(cycle[i], cycle[(i + 1) % n], graph[cycle[i]]["to"].get(cycle[(i + 1) % n], []))
            for i in range(n)]


SELFTEST = [
    # (код, имя, правда ли оно читается, пока тело модуля исполняется)
    ("const f = () => LIB.x;", "LIB", False),
    ("const T = [{ n: MODE_NAME.video }];", "MODE_NAME", True),
    ("$$('.x').forEach(x => { y(MODE_NAME); });", "MODE_NAME", False),
    ("if (NEED.length) { go(PEAKS); }", "NEED", True),
    ("if (NEED.length) { go(PEAKS); }", "PEAKS", True),
    ("export const vPrev = previewPanel($('#p'), V, { extra: () => V.first });", "previewPanel", True),
    ("class K { m() { return LIB; } }", "LIB", False),
    ("const o = { g: function () { return LIB; } };", "LIB", False),
    ("btn.onclick = () => { setUpJob(1); };", "setUpJob", False),
    ("setUpJob(null);", "setUpJob", True),
    ("export const cwMine = () => LIB.filter(x => x.mode === 'custom');", "LIB", False),
    ("list.map(x => y * 2).filter(z => z); render(TABS);", "TABS", True),
    ("for (const m of MODES) { use(m); }", "MODES", True),
    ("export let a = 1, b = 2;", "b", True),
    ("export const P = { 'libFilter': 1 };", "P", True),
    ("const q = 'LIB is a string';", "LIB", False),
]


def selftest():
    """Разбор сам по себе обязан не врать: тела функций не чтения, литералы - чтения."""
    bad = 0
    for src, name, want in SELFTEST:
        got = name in start_reads(src, {name})
        if got != want:
            bad += 1
            print("   РАСХОЖДЕНИЕ: %r · имя %s · получилось %s, ждали %s" % (src, name, got, want))
    for src, want in (("export let UP_FILE = null, UP_JOB = null;", ["UP_FILE", "UP_JOB"]),
                      ("export const promptHandlers = new Map(), earlyEvents = new Map();",
                       ["promptHandlers", "earlyEvents"]),
                      ("export let libFilter = 'all', selecting = false, selected = new Set(), openId = null;",
                       ["libFilter", "selecting", "selected", "openId"])):
        got = sorted(set(decl_names(re.sub(r"^export\s+(let|const|var)\s+", "", src))))
        if got != sorted(want):
            bad += 1
            print("   РАСХОЖДЕНИЕ: %r -> %s, ждали %s" % (src, got, want))
    print("самопроверка разбора: %d случаев, расхождений: %d" % (len(SELFTEST) + 3, bad))
    return 1 if bad else 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    repo = env.repo(argv, "uigraph.py")
    graph = build(repo)
    a = adj(graph)
    reachm = reach(a)
    comps = [c for c in sccs(a) if len(c) > 1]
    cycles = all_cycles(a) if comps else []
    nedges = sum(len(x) for x in a.values())
    mutual = sorted({(x, y) for x in a for y in a[x] if x in a.get(y, ()) and x < y})

    if "--json" in argv:
        print(json.dumps({"nodes": len(graph), "edges": nedges, "scc": comps,
                          "cycles": [" -> ".join(c) for c in cycles],
                          "mutual": [list(m) for m in mutual]}, ensure_ascii=False, indent=1))
        return 0

    print("граф импортов интерфейса: %s" % (repo / "app" / "ui" / "js"))
    print("узлов: %d · рёбер: %d" % (len(graph), nedges))
    print("компонент взаимной досягаемости (цикличных): %d · узлов в них: %d"
          % (len(comps), sum(len(c) for c in comps)))
    for c in comps:
        print("   узлы: " + ", ".join(c))
    print("простых циклов (контуров): %d" % len(cycles))
    print("пар встречных импортов (A -> B -> A): %d" % len(mutual))
    for x, y in mutual:
        print("   %s <-> %s" % (x, y))
    bas = basis_cycles(graph)
    print("базисных циклов (обратных рёбер): %d - столько связей надо разорвать" % len(bas))
    for c in sorted(bas, key=lambda x: (len(x), x)):
        print("   " + " -> ".join(c) + " -> " + c[0])
    print()

    bad_path = ["%s -> %s" % (n, t[2:]) for n, g in sorted(graph.items()) for t in g["to"] if t.startswith("!/")]
    if bad_path:
        print("битые пути импортов: %d" % len(bad_path))
        for x in bad_path:
            print("   " + x)
        print()

    missing = []
    for name, g in sorted(graph.items()):
        for path, names in import_clauses(g["text"]):
            if not path.startswith("."):
                continue
            tgt = resolve(g["abs"], path)
            if not tgt.is_file():
                continue
            tname = tgt.relative_to(g["jsdir"]).as_posix()
            exp = graph.get(tname, {}).get("exp") or exports_of(tgt.read_text(encoding="utf-8", errors="replace"))
            for nm in names:
                if nm not in exp and nm not in ("default", "*"):
                    missing.append((name, nm, tname))
    print("импортируемых имён без экспорта: %d" % len(missing))
    for m in sorted(missing):
        print("   %-20s %-14s <- %-20s (строка %d)"
              % (m[0], m[1], m[2], line_of(graph[m[0]]["text"], m[1])))
    print()

    stray = unimported_usage(graph)
    print("имён, которые модуль читает, не импортируя (наследие одностраничника): %d" % len(stray))
    for name, nm, ln, where in stray:
        print("   %-20s %-14s строка %d · экспорт есть в %s" % (name, nm, ln, ", ".join(where)))
    print()

    vv = [c for c in cycles if all(x.startswith("views/") for x in c)]
    print("циклов только внутри views/: %d" % len(vv))
    for c in sorted(vv, key=lambda x: (len(x), x))[: (10 ** 9 if "--all" in argv else PRINT_CAP)]:
        print("   " + " -> ".join(c) + " -> " + c[0])
    if len(vv) > (10 ** 9 if "--all" in argv else PRINT_CAP):
        print("   ... всего %d, показаны первые %d (--all печатает все)" % (len(vv), PRINT_CAP))
    print()

    hot = []
    for src in sorted(a):
        for dst in a[src]:
            if src not in reachm[dst]:
                continue                      # этот путь назад не ведёт: цикла через него нет
            names = set(graph[src]["to"].get(dst, [])) - {"default", "*"}
            for nm in sorted(depth0_names(graph[src]["text"], names)):
                hot.append((src, dst, nm))
    print("рёбра циклов, где имя читается на уровне верхнего уровня: %d" % len(hot))
    for src, dst, nm in hot:
        print("   %s читает %s из %s" % (src, nm, dst))
    print()

    order, early = esm_order(graph)
    print("порядок исполнения тел ESM от %s: %s" % ("app.js", " -> ".join(order)))
    print("чтений до инициализации (цикл через читаемое на старте значение): %d" % len(early))
    for name, dep, nm, kind, path in early:
        print("   %s читает %s (%s) из %s, а то ещё не доинициализировано: %s"
              % (name, nm, kind, dep, " -> ".join(path)))
    print()

    print("все циклы (%d):" % len(cycles))
    shown = sorted(cycles, key=lambda x: (len(x), x))
    for c in (shown if "--all" in argv else shown[:PRINT_CAP]):
        print("   [%d] %s" % (len(c), " -> ".join(c)))
    if len(shown) > PRINT_CAP and "--all" not in argv:
        print("   ... показаны первые %d из %d (--all печатает все)" % (PRINT_CAP, len(shown)))
    print()
    print("ИТОГ: узлов: %d · рёбер: %d · циклов: %d · циклов views<->views: %d · "
          "циклов с чтением на старте: %d · чтений до инициализации: %d · имён без экспорта: %d · "
          "имён без импорта: %d"
          % (len(graph), nedges, len(cycles), len(vv), len(hot), len(early), len(missing), len(stray)))
    return 1 if (missing or bad_path or vv or early or stray) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
