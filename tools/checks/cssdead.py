#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Стили не должны прятать живой интерфейс и переживать своих элементов.

Урок 2.2.54: в css ассистента осталось правило .tokens.sc-src{display:none},
поставленное, когда ряд тегов «переехал в окно Сценариста». Окна с тех пор
вернули теги на место, а гасилка осталась - и плашки пропали из ВСЕХ режимов
сразу. Признак «скрыт/не скрыт» в DOM при этом был честный: проверяющий,
который смотрит на атрибуты, ничего не замечает. Правила здесь два:

1) ни одно правило не может глобально (без области видимости) прятать
   структурные ряды окна - .tokens, .ta-foot, .field-btns и их виды;
   прятать можно только внутри конкретной карточки или вьюхи (.ag-comp .X,
   #view-x .Y) - тогда ответственный за это участок видит это в том же файле;
2) правило, чьи классы не встречаются больше ни в разметке, ни в JS, мертво:
   его надо удалить, иначе через полгода его никто не решится тронуть.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402  - находит репу так же, как остальные проверки

ROOT = None
fails = []


def ok(msg):
    print("OK   %s" % msg)


def bad(msg):
    fails.append(msg)
    print("ПАДЕНИЕ: %s" % msg)


SEL = re.compile(r"(?m)^([^@{};/]+?)\{")
TOKEN = re.compile(r"\.([A-Za-z][\w-]*)|#([A-Za-z][\w-]*)")
GENERIC = {"active", "hidden", "disabled", "collapsed", "on", "off", "open", "min", "pri", "mini", "hint", "bad", "n"}
# ряды, которые окно строит само; прятать их можно только вместе с окружением
ROWS = ("tokens", "ta-foot", "field-btns", "sc-tokens", "rm-tokens", "sr-tokens", "v-tokens")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    repo = env.repo([a for a in argv if not a.startswith("-")], "cssdead.py")
    root = repo / "app" / "ui"
    text = (root / "index.html").read_text(encoding="utf-8")
    for p in (root / "js").rglob("*.js"):
        text += p.read_text(encoding="utf-8")
    dead, naked, checked = [], [], 0
    for f in sorted((root / "css").glob("*.css")):
        src = f.read_text(encoding="utf-8")
        for m in SEL.finditer(src):
            sel = m.group(1).strip()
            if not sel or ":is(" in sel or ":has(" in sel or ":not(" in sel:
                continue
            line = src[: m.start()].count("\n") + 1
            body = src[m.end(): src.find("}", m.end())]
            toks = [a or b for a, b in TOKEN.findall(sel)]
            if not toks:
                continue
            checked += 1
            alive = [t for t in toks if re.search(r"(?<![\w-])" + re.escape(t) + r"(?![\w-])", text)]
            if not alive:
                dead.append("%s:%d %s" % (f.name, line, sel[:90]))
            first = re.split(r"[ >+~]", sel)[0]
            if "display:none" in body.replace(" ", ""):
                for cls in ROWS:
                    if re.match(r"^\." + re.escape(cls) + r"(:|\[|$)", first):
                        naked.append("%s:%d %s" % (f.name, line, sel[:90]))
    if dead:
        bad("мёртвые правила CSS (%d): их классов нет ни в разметке, ни в JS - "
            "удалите или верните разметку: %s" % (len(dead), dead[:6]))
    else:
        ok("в css нет правил, которые не к чему применить (проверено %d правил с классами)" % checked)
    if naked:
        bad("глобальные display:none для рядов окна: %s - так теги исчезли из всех режимов "
            "сразу (урок 2.2.54); прячьте внутри карточки или вьюхи" % naked[:4])
    else:
        ok("ни один структурный ряд окна не прячется глобальным правилом")
    print()
    if fails:
        print("ИТОГ: падений: %d -> %s" % (len(fails), [f[:60] for f in fails]))
        return 1
    print("ИТОГ: всё чисто")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
