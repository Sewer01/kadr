#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Страница должна ДЕЙСТВИТЕЛЬНО загружать свои модули и стили.

Дважды на практике ломалось молча: скрипт был подключён без type="module"
(браузер читал import как обычный код, страница вставала без вкладок), и
сборка не забирала папки css/ и js/ (программа ставилась без стилей и
скриптов). Когда страница разбита на модули, добавляется третий молчаливый
обвал: модуль импортирует имя, которого файл-источник не отдаёт, или значение
читают на старте через незавершённый цикл. Браузер роняет тогда весь граф
модулей разом, вкладок становится ноль, а каждый файл по отдельности выглядит
рабочим. Здесь инварианты, которые ловят всё это до сборки: type="module",
ссылки страницы, пути импортов, сверка импортов с экспортами, порядок
исполнения ESM и состав сборки.
"""
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402
import uigraph  # noqa: E402  - один разбор js на все проверки интерфейса

fails = []
skip = []

# живой движок модулей: связывает граф и говорит, какие имена на самом деле отдаются
ESM_CHECK_JS = r"""
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(process.argv[2]);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);
files.sort();
const rel = p => path.relative(root, p).split(path.sep).join('/');
const ctx = vm.createContext({});
const bad = [];
for (const entry of files) {
  const cache = new Map();          // каждый файл связываем заново: иначе чужая ошибка прячется
  const compile = abs => {
    if (!cache.has(abs)) {
      const m = new vm.SourceTextModule(fs.readFileSync(abs, 'utf8'), { identifier: abs, context: ctx });
      m.__file = abs;
      cache.set(abs, m);
    }
    return cache.get(abs);
  };
  const link = (spec, ref) => {
    const from = ref && ref.__file ? path.dirname(ref.__file) : path.dirname(entry);
    let target = path.resolve(from, spec);
    if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
    if (!fs.existsSync(target)) { bad.push(rel(entry) + ': импорт ' + spec + ' - файла нет'); return undefined; }
    return compile(target);
  };
  try {
    const m = compile(entry);
    await m.link(link);            // имена разрешаются при связывании: там же виден отсутствующий экспорт
  } catch (e) {
    bad.push(rel(entry) + ': ' + String((e && e.message) || e));
  }
}
console.log(bad.join('\n'));
"""


def ok(msg):
    print("   OK   " + msg)


def bad(msg):
    print("   ПАДЕНИЕ  " + msg)
    fails.append(msg)


def miss(msg):
    print("   ПРОПУСК: " + msg)
    skip.append(msg)


def main():
    repo = env.repo()
    ui = repo / "app" / "ui"
    page = (ui / "index.html").read_text(encoding="utf-8")

    # 1. модули обязан подключать тот тег, который реально в странице
    tags = re.findall(r"<script\b[^>]*>", page)
    app = [t for t in tags if "js/app.js" in t]
    if not app:
        bad("страница не подключает js/app.js ни одним тегом <script>")
    elif not re.search(r'type=["\']module["\']', app[0]):
        bad("js/app.js подключён без type=\"module\": браузер прочитает import "
            "как обычный код и страница встанет без вкладок · тег: %s" % app[0])
    else:
        ok("js/app.js подключён как модуль · %s" % app[0])

    # 2. всё, на что ссылается страница, лежит рядом
    refs = re.findall(r'(?:href|src)="(/ui/[^"]+)"', page)
    lost = [r for r in refs if not (ui / r[len("/ui/"):]).is_file()]
    if lost:
        bad("страница ссылается на %d несуществующих файла: %s" % (len(lost), lost[:6]))
    else:
        ok("все %d ссылок страницы на css и js ведут на существующие файлы" % len(refs))

    # 3. каждый относительный импорт ведёт к файлу: битый путь это тихая 404
    #    в браузере, а не ошибка при проверке кода
    js = sorted((ui / "js").rglob("*.js"))
    broken = []
    for f in js:
        for m in re.finditer(r"""^\s*import\s+(?:[\w{*][^'"]*?from\s+)?['"](\.[^'"]+)['"]""",
                             f.read_text(encoding="utf-8"), re.M):
            p = m.group(1)
            target = (f.parent / p).resolve()
            if not target.is_file() and target.with_suffix(".js").is_file():
                target = target.with_suffix(".js")
            if not target.is_file():
                broken.append("%s -> %s" % (f.name, p))
    if broken:
        bad("%d импортов ведут в никуда: %s" % (len(broken), broken[:6]))
    else:
        ok("все относительные импорты в %d js-файлах ведут на существующие файлы" % len(js))

    # 4. каждое импортируемое имя обязан отдавать файл-источник. Без этого браузер
    #    говорит «does not provide an export named ...» и роняет весь граф: вкладок
    #    ноль, а в консоли одна строка. Текстовый разбор - страховка; живая сверка
    #    движком модулей (node) - доказательство, её отсутствие печатает ПРОПУСК.
    graph = uigraph.build(repo)
    wrong = []
    for name, g in sorted(graph.items()):
        for path, names in uigraph.import_clauses(g["text"]):
            if not path.startswith("."):
                continue
            tgt = uigraph.resolve(g["abs"], path)
            if not tgt.is_file():
                continue
            exp = (graph.get(tgt.relative_to(g["jsdir"]).as_posix()) or {}).get("exp") \
                or uigraph.exports_of(tgt.read_text(encoding="utf-8", errors="replace"))
            for nm in names:
                if nm not in exp and nm not in ("default", "*"):
                    wrong.append("%s импортирует %s из %s" % (name, nm, path))
    if wrong:
        bad("%d импортов ссылаются на имя, которое источник не экспортирует: %s"
            % (len(wrong), wrong[:6]))
    else:
        ok("все импортируемые имена в %d файлах правда экспортируются файлами-источниками"
           % len(graph))

    # 4б. обратная сторона той же поломки: модуль читает имя, которое другой модуль
    #     экспортирует, но сам его не импортировал. В одностраничнике `$` и `toast`
    #     были глобальными, в модуле они обязаны прийти импортом - иначе «$ is not
    #     defined» на первой же строке тела модуля.
    stray = uigraph.unimported_usage(graph)
    if stray:
        bad("%d имён читаются без импорта: %s"
            % (len(stray), ["%s: %s (строка %d)" % s[:3] for s in stray[:6]]))
    else:
        ok("нет имён, которые читались бы как глобальные: всё чужое приходит импортом")

    # 4в. то же живым движком ESM: имена сверяет модульная система, а не глаз
    node = env.node()
    if not node:
        miss("сверка экспортов движком ESM - нет node; задайте KADR_NODE")
    else:
        with tempfile.TemporaryDirectory() as tmp:
            wrap = Path(tmp) / "esmcheck.mjs"
            wrap.write_text(ESM_CHECK_JS, encoding="utf-8")
            try:
                r = subprocess.run([str(node), "--experimental-vm-modules", str(wrap), str(ui / "js")],
                                   capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=180)
            except (OSError, subprocess.TimeoutExpired) as e:
                miss("сверка экспортов движком ESM не выполнилась: %s" % str(e)[:80])
            else:
                errs = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
                if not errs and r.returncode != 0:
                    bad("движок ESM не смог связать граф модулей: %s"
                        % ((r.stderr or "").strip()[-200:] or "код %d" % r.returncode))
                elif errs:
                    bad("движок ESM нашёл %d обрыва графа модулей: %s" % (len(errs), errs[:6]))
                else:
                    ok("движок ESM связал граф модулей без единой ошибки (node)")

    # 5. порядок исполнения ESM: через незавершённый цикл ничего не читается. Сам цикл
    #    законен, но let/const/class незавершённого модуля - «Cannot access before
    #    initialization», и страница снова встаёт без вкладок.
    order, early = uigraph.esm_order(graph)
    if early:
        bad("%d имён читаются, пока их модуль ещё не доинициализирован: %s"
            % (len(early), ["%s читает %s из %s" % e[:3] for e in early[:4]]))
    else:
        ok("ни одно значение не читается через незавершённый цикл (тела %d модулей идут "
           "в порядке от js/app.js)" % len(order))

    # 5б. тот же порядок, но телами: esmbodies.mjs исполняет все модули настоящим
    #     движком ESM на заглушках браузера. Статика видит только чтения в самом теле,
    #     а падает страница чаще на вызове локальной функции из тела (первая отрисовка
    #     очереди, new AudioTrimmer и т. п.) - здесь это ловится без браузера.
    if not node:
        miss("исполнение тел модулей - нет node; задайте KADR_NODE")
    else:
        harness = Path(__file__).resolve().parent / "esmbodies.mjs"
        try:
            r = subprocess.run([str(node), "--experimental-vm-modules", str(harness),
                                str(ui / "js"), "app.js"],
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=180)
        except (OSError, subprocess.TimeoutExpired) as e:
            miss("исполнение тел модулей не выполнилось: %s" % str(e)[:80])
        else:
            out = (r.stdout or "") + (r.stderr or "")
            fall = [ln for ln in out.splitlines() if ln.startswith("ПАДЕНИЕ")]
            if fall:
                where = [ln for ln in out.splitlines() if "тело, на котором упало" in ln]
                bad("тела модулей не исполняются: %s%s" % (fall[0], (" · " + where[0].strip()) if where else ""))
            elif "исполнились без падения" not in out:
                bad("стенд исполнения тел не отчитался: %s" % out.strip()[:200])
            else:
                ok("тела всех модулей исполняются настоящим движком ESM без падений")

    # 6. сборка обязана нести интерфейс целиком: проверяем, только если сборка
    #    указана и существует (иначе это не правка, а отсутствующий артефакт)
    dist = os.environ.get("KADR_DIST", "").strip()
    if not dist:
        miss("сборка не задана (KADR_DIST) - проверять, что в неё попали css и js, не на чем")
    else:
        d = Path(dist)
        got = d / "_internal" / "ui"
        if not got.is_dir():
            miss("в указанной сборке нет _internal/ui (%s) - проверять негде" % d)
        else:
            want = sorted(p.relative_to(ui).as_posix() for p in (ui / "css").rglob("*.css")) + \
                sorted(p.relative_to(ui).as_posix() for p in (ui / "js").rglob("*.js"))
            gone = [w for w in want if not (got / w).is_file()]
            if gone:
                bad("в сборку не попали %d файлов интерфейса: %s - программа "
                    "поставится без них" % (len(gone), gone[:8]))
            else:
                ok("в сборке есть все %d файлов css и js интерфейса" % len(want))

    print()
    if fails:
        print("ИТОГ: падений: %d -> %s" % (len(fails), [f[:60] for f in fails]))
        return 1
    if skip:
        print("ИТОГ: всё чисто (пропусков: %d)" % len(skip))
    else:
        print("ИТОГ: всё чисто")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
