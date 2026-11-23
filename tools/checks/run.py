"""Общий прогон сторожей: компиляция, эталоны графов, страница, перенесённые проверки.

Запуск из корня репы:
  python tools/checks/run.py                    # всё, по порядку
  python tools/checks/run.py C:\\путь\\до\\репы    # явный путь до репы
  python tools/checks/run.py --offline          # живые проверки (ComfyUI, ffmpeg) пропустить
  python tools/checks/run.py --edit             # режим правки: KADR_DIFF=1 (смотреть добавленные
                                                # строки незакоммиченного изменения)
  python tools/checks/run.py --list             # только список шагов

Каждый шаг печатает свой вывод целиком, в конце одна строка: «ИТОГ: всё чисто» или
список падений. Код возврата 0 только когда всё чисто - так прогон можно ставить
в сборку или в скрипт перед коммитом.

Проверки сверяют поведение с постоянными инвариантами (структура графа, обход его рёбер,
эталоны golden, содержимое файлов), а не с историей: на дереве, где правка уже сделана и
закоммичена, прогон обязан быть чистым. Что всё же смотрит в git (добавленные строки
правки) - включается только KADR_DIFF=1 (он же --edit) и иначе печатает ПРОПУСК.

Ничего не собирается, приложение не запускается, в очередь ComfyUI ничего не ставится,
видеокарта не трогается.
"""
import os
import py_compile
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True          # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

# порядок: сначала самое дешёвое и самое главное (эталоны), потом остальное
STEPS = [
    ("golden.py", "эталоны графов: все графы сверяются с эталонами"),
    ("routes.py", "таблица маршрутов: метод, путь и имя обработчика заморожены побайтово"),
    ("ui.py", "страница интерфейса без браузера"),
    ("uisnapshot.py", "снимок интерфейса: вкладки, контролы, динамические классы, вызовы API - заморожен побайтово"),
    ("uimount.py", "страница правда подключает свои модули, импорты ведут к файлам, сборка несёт интерфейс"),
    ("cssdead.py", "стили не прячут живые ряды окна глобально и не переживают своих элементов (урок 2.2.54)"),
    ("check-all.py", "сборка: компиляция, графы, разметка, маршруты, ноды ядра"),
    ("mix-checks.py", "звук в ролике: фон фоном, звук модели цел"),
    ("sub-checks.py", "метка режима на миниатюре и перевод субтитров"),
    ("bed-check.py", "выравнивание громкости фона на настоящем файле (ffmpeg)"),
]


def compile_app(repo):
    """py_compile всех модулей приложения: фасада, сборки графов, областей и помощников."""
    print("=== 0. python-модули компилируются ===")
    ok = True
    targets = [("app/" + p.name, p) for p in sorted((repo / "app").glob("*.py"))]
    targets += [("app/areas/" + p.name, p) for p in sorted((repo / "app" / "areas").glob("*.py"))]
    if not targets:
        targets = [("app/server.py", repo / "app" / "server.py")]
    for label, path in targets:
        try:
            with tempfile.TemporaryDirectory() as tmp:      # байт-код во временную папку, не в app/
                py_compile.compile(str(path), cfile=os.path.join(tmp, "x.pyc"), doraise=True)
            print("   OK   " + label)
        except Exception as e:                              # noqa: BLE001
            ok = False
            print("   ПАДЕНИЕ  %s · %s" % (label, str(e)[:160]))
    print()
    return ok


def whisper_probe(repo):
    """Видно ли приложение, где лежит whisper (только поиск файлов, считать ничего не будем)."""
    print("=== 0б. приложение видит whisper ===")
    if not env.live_allowed():
        env.skip("поиск whisper", "живые проверки выключены (KADR_LIVE=0)")
        print()
        return True
    folder = env.whisper_dir()
    if not folder:
        env.missing("поиск whisper", "KADR_WHISPER_DIR", "или KADR_LLM_DIR")
        print()
        return True
    sys.path.insert(0, str(repo / "app"))
    try:
        import speech                                   # noqa: E402 - только чтение путей
        found = speech.locate(env.llm_dir())
    except Exception as e:                              # noqa: BLE001
        env.skip("поиск whisper", "%s: %s" % (type(e).__name__, str(e)[:120]))
        print()
        return True
    if found["ready"]:
        print("   OK   whisper готов: программа %s · модель %s"
              % (Path(found["exe"]).name, Path(found["model"]).name))
    else:
        print("   (справка) whisper не готов: нет %s · папка %s"
              % (", ".join(found["missing"]), folder))
    print()
    return True


def run_step(script, title, repo, py, child_env):
    """Один шаг: подпроцесс, вывод наружу, вердикт по коду возврата."""
    print()
    print("################ %s · %s ################" % (script, title))
    r = subprocess.run([str(py), "-X", "utf8", str(HERE / script), str(repo)],
                       cwd=str(repo), env=child_env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (r.stdout or "") + (r.stderr or "")
    print(out.rstrip())
    return r.returncode, out


def main(argv):
    flags = [a for a in argv if a.startswith("--")]
    if "--list" in flags:
        for s, t in STEPS:
            print("%-16s %s" % (s, t))
        return 0
    if "--offline" in flags:
        os.environ["KADR_LIVE"] = "0"
    if "--edit" in flags:
        os.environ["KADR_DIFF"] = "1"          # режим правки: проверки смотрят добавленные строки
    repo = env.repo([a for a in argv if not a.startswith("--")], "run.py")
    py = env.python()

    print("проверки репы Kadr: %s" % repo)
    env.banner(repo / "app" / "ui" / "index.html")

    child_env = dict(os.environ, KADR_REPO=str(repo))
    fails = []

    if not compile_app(repo):
        fails.append("компиляция модулей приложения (app/ и app/areas/)")
    whisper_probe(repo)

    for script, title in STEPS:
        code, out = run_step(script, title, repo, py, child_env)
        if code != 0:
            fails.append("%s (%s)" % (script, title))
        if code == 0 and "ПРОПУСК" in out:
            print("   (шаг %s прошёл с пропусками - смотри строки ПРОПУСК выше)" % script)

    print()
    print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
