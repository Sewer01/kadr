"""Проверки двух новых вещей: метки режима на миниатюре и перевода субтитров.

Всё это постоянные инварианты ТЕКУЩЕГО файла: утверждения звучат как «в файле есть» и
«функция вызывается», ни одно не зависит от того, что когда-то лежало в git. Прежнее
«новых строк достаточно много (правка дошла)» считало строки диффа против HEAD и падало от
ЛЮБОЙ другой правки интерфейса (убрали четыре осиротевших имени селекторов - и проверка
метки падала, хотя метка была цела).

1. каждый блок <script> страницы отдельно через node --check;
2. разметка метки: функция libTag есть, вызывается при разметке карточки Библиотеки и её
   стиль описан на странице; сама функция прогоняется на подставных записях;
3. перевод субтитров: у меню есть выбор «оставить как сказано / перевести», поле translate
   уходит в запросе '/api/subtitles', обработчик сервера это поле читает и отвечает
   translated - всё прямым разбором app/ui/index.html и app/server.py;
4. разбор SRT в тройки (начало, конец, текст) и сборка файла обратно;
5. перевод моделью на подставном ответе: точное число строк, лишние строки, пустой ответ,
   отказ при генерации видео и при отсутствии модели;
6. запрещённые значки: постоянным инвариантом по коду метки, меню субтитров и обработчику
   перевода; по добавленным строкам незакоммиченной правки - только в режиме правки
   (KADR_DIFF=1), иначе печать ПРОПУСК.

Запуск из корня репы:  python -X utf8 tools/checks/sub-checks.py [путь до репы]

node берётся из tools/checks/env.py; нет node - проверка синтаксиса печатает ПРОПУСК.
"""
import asyncio
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True        # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

repo = env.repo(sys.argv[1:], "sub-checks.py")
app = repo / "app"
NODE = env.node()
PY = str(env.python())
fails = []


def verdict(name, ok, note=""):
    print(("   OK   " if ok else "   ПАДЕНИЕ  ") + name + ((" · " + note) if note else ""))
    if not ok:
        fails.append(name)


def node_run(text):
    """Только синтаксис: node --check файл не исполняет."""
    return node_do(text, ["--check"])


def node_exec(text):
    """Прогон функции на подставных данных: node исполняет файл целиком."""
    return node_do(text, [])


def node_do(text, pre):
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "t.js"
        f.write_text(text, encoding="utf-8")
        return subprocess.run([str(NODE)] + pre + [str(f)], capture_output=True, text=True,
                              encoding="utf-8", errors="replace")


def js_body(name, where):
    """Тело функции страницы: от её объявления до строки, где она закрывается на нулевом отступе.

    Нужно, чтобы искать «этот код вызывает вот это» внутри конкретной функции, а не по всему
    файлу: так проверка не проходит враньём, когда имя всплыло в другом месте.
    """
    m = re.search(r"(?m)(?:async )?function %s\s*\([^)]*\)\s*\{[\s\S]*?\n\}" % re.escape(name), where)
    return m.group(0) if m else ""


def js_arrow(head, where):
    """Тело стрелочного обработчика: от начала строки вида $('#x').onclick = до её закрытия."""
    m = re.search(re.escape(head) + r"[\s\S]*?\n\};", where)
    return m.group(0) if m else ""


def py_body(name, where):
    """Тело метода сервера: от объявления до следующего метода того же уровня (отступ 4)."""
    m = re.search(r"(?m)^    (?:async )?def %s\(" % re.escape(name), where)
    if not m:
        return ""
    nxt = re.search(r"(?m)^    (?:async )?def \w+\(|^class \w+", where[m.end():])
    return where[m.start():m.end() + (nxt.start() if nxt else len(where) - m.end())]


print("=== 1. каждый блок <script> отдельно: node --check ===")
html = (app / "ui" / "index.html").read_text(encoding="utf-8")
srv = (app / "server.py").read_text(encoding="utf-8")
# таблица маршрутов осталась в фасаде, а тела обработчиков живут по областям (app/areas/*.py)
state_src = env.state_text(repo)
blocks = re.findall(r"<script(?![^>]*src=)[^>]*>([\s\S]*?)</script>", html)
if not NODE:
    env.missing("разбор блоков <script> и разметки метки", "KADR_NODE", "(node --check)")
    verdict("найдено %d блоков <script>" % len(blocks), bool(blocks),
            "синтаксис блоков не проверялся - см. ПРОПУСК выше")
else:
    bad = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, b in enumerate(blocks, 1):
            f = Path(tmp) / f"block{i}.js"
            f.write_text(b, encoding="utf-8")
            r = subprocess.run([str(NODE), "--check", str(f)], capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
            if r.returncode:
                bad.append("блок %d: %s" % (i, (r.stderr or "").strip().replace("\n", " | ")[:160]))
    verdict("блоки %s разбираются" % len(blocks), not bad, "; ".join(bad)[:300])

print()
print("=== 2. разметка метки режима (libTag) ===")
m = re.search(r"function libTag\(it\) \{[\s\S]*?\n\}", html)
verdict("в файле есть функция метки libTag", bool(m))
card = js_body("renderLib", html)
verdict("метку ставит разметка карточки Библиотеки: renderLib вызывает libTag",
        bool(card) and "libTag(" in card,
        "тело renderLib: %d знаков" % len(card) if card else "функция renderLib не найдена")
verdict("стиль метки описан на странице (класс li-tag)",
        re.search(r"\.li-tag[\s,:{]", html) is not None,
        "" if re.search(r"\.li-tag[\s,:{]", html) else "правила для .li-tag нет")
if m and not NODE:
    print("   ПРОПУСК: node нет - прогон libTag на подставных записях не выполнен")
elif m:
    harness = m.group(0) + """
const cases = [
  ['обычная запись', {}],
  ['избранное без режимов', {fav: true}],
  ['субтитры', {subtitled: {place: 'bottom', lang: 'ru', translated: false}}],
  ['плавность 60', {smoothed: {fps: 60, how: 'повтором кадров'}}],
  ['плавность 48', {smoothed: {fps: 48}}],
  ['субтитры и плавность', {subtitled: {place: 'big', lang: 'en', translated: true}, smoothed: {fps: 60}}],
  ['сломанные поля', {subtitled: null, smoothed: 'нет'}],
];
for (const [name, it] of cases) console.log(name + ' >>> [' + libTag(it) + ']');
"""
    rr = node_exec(harness)
    print(rr.stdout.strip() or rr.stderr.strip()[:300])
    out = rr.stdout
    verdict("у обычной записи знака нет", rr.returncode == 0 and "обычная запись >>> []" in out)
    verdict("субтитры дают С, плавность - 48 или 60",
            ">С<" in out and ">48<" in out and ">60<" in out)
    verdict("оба поля дают «С 60»", ">С 60<" in out)
    verdict("подсказки по-русски", "Субтитры и плавность 60 кадров в секунду" in out
            and "Плавность 48 кадров в секунду" in out and 'title="Субтитры"' in out)

print()
print("=== 2б. выбор языка субтитров и поле translate: текущие файлы, без git ===")
sub_btn = js_arrow("$('#vwSub').onclick =", html)
verdict("кнопка субтитров открывает меню и зовёт выбор языка (subAskLang)",
        bool(sub_btn) and "subAskLang(" in sub_btn,
        "обработчик: %d знаков" % len(sub_btn) if sub_btn else "обработчик #vwSub не найден")
ask = js_body("subAskLang", html)
verdict("в меню есть оба выбора: оставить как сказано и перевести на русский",
        bool(ask) and "subMake(it, place, false)" in ask and "subMake(it, place, true)" in ask
        and "Перевести на русский" in ask, str([ln.strip()[:60] for ln in ask.splitlines() if "subMake(" in ln])[:200])
menu = js_body("subMenu", html)
verdict("само меню собирается функцией subMenu и вешается на страницу",
        bool(menu) and "document.body.append(menu)" in menu)
make = js_body("subMake", html)
verdict("запрос на субтитры идёт на '/api/subtitles' и содержит поле translate",
        bool(make) and "/api/subtitles" in make and re.search(r"translate:\s*!!translate", make) is not None,
        str([ln.strip()[:100] for ln in make.splitlines() if "api/subtitles" in ln or "translate:" in ln])[:260])
verdict("страница читает ответ translated (переведён текст или оставлен)", "j.translated" in make)
handler = py_body("h_subtitles", state_src)
verdict("обработчик сервера читает поле translate из запроса",
        bool(handler) and 'body.get("translate")' in handler,
        "обработчик: %d знаков" % len(handler) if handler else "h_subtitles не найден в модулях состояния")
verdict("обработчик зовёт перевод и кладёт translated в ответ",
        bool(handler) and "_subtitles_translate(" in handler and '"translated": translated' in handler)
verdict("маршрут '/api/subtitles' зарегистрирован на этот обработчик",
        re.search(r'web\.post\("/api/subtitles",\s*state\.h_subtitles\)', srv) is not None)
verdict("функция перевода на модели существует", "async def _subtitles_translate(" in state_src)

print()
print("=== 3. разбор SRT в тройки и сборка файла обратно ===")
sys.path.insert(0, str(app))
import server  # noqa: E402
import srt      # noqa: E402 - разбор и сборка SRT живут в app/srt.py

RAW = """1
00:00:01,200 --> 00:00:03,400
Hello there, how are you today?

2
00:00:03,400 --> 00:00:05,000
[BLANK_AUDIO]

3
00:00:05,120 --> 00:00:07,980
Fine, thanks.
(music) And yourself?

4
00:00:08,500 --> 00:00:10,250
Goodbye
"""
cues = srt.srt_parse(RAW)
for c in cues:
    print("   тройка:", c)
verdict("пустые реплики ([BLANK_AUDIO], (music)) выкинуты", len(cues) == 3, "реплик: %d" % len(cues))
verdict("номера реплик в тройки не попали", all("-->" not in c[0] for c in cues))
verdict("шум внутри реплики убран, текст остался",
        cues[1][2] == "Fine, thanks. And yourself?", cues[1][2])
TIMES = [[c[0], c[1]] for c in cues]
verdict("метки времени сохранены",
        TIMES == [["00:00:01,200", "00:00:03,400"], ["00:00:05,120", "00:00:07,980"],
                  ["00:00:08,500", "00:00:10,250"]], str(TIMES))

RU = ["Привет, как дела?", "Хорошо, а у тебя?", "Прощай"]
translated = [[a, b, t] for (a, b, _), t in zip(cues, RU)]
built = srt.srt_build(translated)
print("--- итоговый SRT после перевода ---")
print(built, end="")
print("--- конец файла ---")
back = srt.srt_parse(built)
verdict("пересобранный файл читается тем же разбором", [c[:2] for c in back] == TIMES)
verdict("время не съехало после подмены текстов", [c[:2] for c in back] == [c[:2] for c in cues])
verdict("номера в файле идут 1, 2, 3",
        re.findall(r"(?m)^\d+$", built) == ["1", "2", "3"], str(re.findall(r"(?m)^\d+$", built)))

print()
print("=== 4. перевод моделью на подставном ответе ===")


class Resp:
    def __init__(self, status, content):
        self.status, self.content = status, content

    async def json(self):
        return {"choices": [{"message": {"content": self.content}}]}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class Session:
    def __init__(self, content, status=200):
        self.content, self.status, self.payload, self.timeout = content, status, None, None

    def post(self, url, json=None, timeout=None):
        self.payload, self.timeout = json, timeout
        return Resp(self.status, self.content)


class Llm:
    def __init__(self, installed=True):
        self.url, self.installed_flag = "http://127.0.0.1:9999", installed

    def installed(self, v):
        return self.installed_flag

    def alive(self):
        return True


class State(server.App):
    """Настоящий App, но без очереди, ComfyUI и модели: ответ подставлен."""

    def __init__(self, content, installed=True, jobs=None):
        self.jobs = jobs or {}
        self.llm = Llm(installed)
        self.session = Session(content)

    async def llm_variant(self):
        return "test"

    def agent_ctx(self):
        return 8192


async def tr(state):
    return await state._subtitles_translate([list(c) for c in cues])


ok_state = State("\n".join(RU))
st = asyncio.run(tr(ok_state))
print("   перевод вышел:", st[1], "| пояснение:", repr(st[2]))
verdict("при точном числе строк перевод принят", st[1] is True and [c[2] for c in st[0]] == RU)
verdict("перевод не тронул время", [c[:2] for c in st[0]] == TIMES)
body = ok_state.session.payload
print("   одним запросом ушло реплик:", len(body["messages"][-1]["content"].splitlines()),
      "| таймаут:", body and ok_state.session.timeout.total)
verdict("все реплики ушли одним запросом, по строке на реплику",
        body["messages"][-1]["content"] == "\n".join(c[2] for c in cues))
verdict("модели запрещено думать (как в исправлении написаний)",
        body["chat_template_kwargs"] == {"enable_thinking": False} and
        body["thinking_budget_tokens"] == 0 and body["temperature"] == 0.1 and body["stream"] is False)
verdict("таймаут перевода не меньше 300 секунд", ok_state.session.timeout.total >= 300,
        str(ok_state.session.timeout.total))
print("   системный текст:", body["messages"][0]["content"][:120])

more = asyncio.run(tr(State("\n".join(RU) + "\nЛишняя строка")))
print("   перевод не вышел:", more[1], "| пояснение:", repr(more[2]))
verdict("лишняя строка - остаётся оригинал",
        more[1] is False and [c[2] for c in more[0]] == [c[2] for c in cues])

fewer = asyncio.run(tr(State("Привет, как дела?")))
verdict("строк меньше - остаётся оригинал",
        fewer[1] is False and [c[2] for c in fewer[0]] == [c[2] for c in cues])

empty = asyncio.run(tr(State("   \n  ")))
verdict("пустой ответ - остаётся оригинал",
        empty[1] is False and [c[2] for c in empty[0]] == [c[2] for c in cues])

numbered = asyncio.run(tr(State("1. Привет\n2. Хорошо\n3. Прощай")))
verdict("нумерация у модели снимается, перевод принят",
        numbered[1] is True and [c[2] for c in numbered[0]] == ["Привет", "Хорошо", "Прощай"],
        str([c[2] for c in numbered[0]]))

busy = asyncio.run(State("x", jobs={"1": {}})._subtitles_translate([list(c) for c in cues]))
print("   при генерации:", busy[1], "|", repr(busy[2]))
verdict("идёт генерация видео - внятный отказ по-русски",
        busy[1] is False and "генерация видео" in busy[2])

nolog = asyncio.run(State("x", installed=False)._subtitles_translate([list(c) for c in cues]))
print("   без модели:", nolog[1], "|", repr(nolog[2]))
verdict("модель Агента не скачана - внятный отказ по-русски",
        nolog[1] is False and "не скачана" in nolog[2])

bad502 = State("\n".join(RU))
bad502.session.status = 502
gone = asyncio.run(bad502._subtitles_translate([list(c) for c in cues]))
verdict("ошибка модели - оригинал и пояснение",
        gone[1] is False and [c[2] for c in gone[0]] == [c[2] for c in cues] and gone[2])

print()
print("=== 4б. понимание, что речь и так по-русски ===")
ru_text = "Ну что смотрим, как это всё работает вместе и что из этого выйдет"
en_text = "Hello there, how are you today and what are we going to do next"
mix_text = "Hello there, my friend, how are you"
print("   по-русски:", srt.srt_russian(ru_text), "| по-английски:", srt.srt_russian(en_text),
      "| только латиница:", srt.srt_russian(mix_text))
verdict("русский текст не просит перевода", srt.srt_russian(ru_text) is True)
verdict("английский текст просит перевода", srt.srt_russian(en_text) is False)
verdict("короткая латиница просит перевода", srt.srt_russian(mix_text) is False)

print()
print("=== 5. запрещённые значки: постоянно по новому коду, дифф - только в режиме правки ===")
segs = (("код метки libTag", js_body("libTag", html)),
        ("выбор языка субтитров subAskLang", js_body("subAskLang", html)),
        ("меню субтитров subMenu", js_body("subMenu", html)),
        ("запрос субтитров subMake", js_body("subMake", html)),
        ("обработчик перевода _subtitles_translate", py_body("_subtitles_translate", state_src)),
        ("обработчик субтитров h_subtitles", py_body("h_subtitles", state_src)))
for label, text in segs:
    marks = env.bad_glyphs(text)
    verdict("постоянно: в коде «%s» нет значков U+2600-27BF, U+2190-21FF, U+3040-30FF, U+4E00-9FFF" % label,
            bool(text) and not marks,
            ("знаки: %s" % marks[:6]) if marks else ("%d знаков" % len(text) if text else "сегмент не найден"))
added, why = env.added_lines(repo, ("app",))
if added is None:
    env.skip("поиск значков в добавленных строках незакоммиченной правки", why)
else:
    hits = sorted({("%s U+%04X" % (c, ord(c))) for ln in added for c in ln if env.BAD_GLYPHS.match(c)})
    verdict("в %d новых строках app/ (фасад, области, помощники, страница) запрещённых значков нет"
            % len(added), not hits, str(hits)[:200])

print()
print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
sys.exit(1 if fails else 0)
