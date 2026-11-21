"""Живая проверка выравнивания громкости фона: loudnorm_bed из сервера на настоящем файле.

Приложение не запускается, видеокарта не трогается и в очередь ComfyUI ничего не ставится:
серверный модуль только импортируется (проверяем, что импорт возможен без запуска), а ffmpeg
берётся из переносимого ComfyUI и работает только со звуком.

Что печатаем:
1. что `import server` проходит, а `main()` не вызывается;
2. измеренную громкость входа, путь к созданному wav и отдельным промером громкость результата
   (ждём около -16 LUFS) - плюс длительность до и после: выравнивание не должно резать трек;
3. честный отказ на битом файле, собранный из пары килобайт мусора.

Временное (wav, битый файл) удаляется в конце, скрипт остаётся.

Запуск из корня репы:  python -X utf8 tools/checks/bed-check.py [путь до репы] [аудиофайл]

ffmpeg ищет tools/checks/env.py (KADR_FFMPEG), файл для пробы - KADR_SAMPLE_AUDIO.
Нет декодера или нет файла - проверка печатает ПРОПУСК и выходит с нулём: живая проверка
не должна валить общий прогон из-за чужой машины.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True        # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

rest = [a for a in sys.argv[1:]]
repo = env.repo(rest, "bed-check.py").resolve()
extra = [a for a in rest if Path(a).is_file()]
src_file = Path(extra[0]) if extra else env.sample_audio()
COMFY = env.comfy_root()
fails = []


def verdict(name, ok, note=""):
    print(("   OK   " if ok else "   ПАДЕНИЕ  ") + name + ((" · " + note) if note else ""))
    if not ok:
        fails.append(name)


print("=== 1. импорт сервера без запуска приложения ===")
sys.path.insert(0, str(repo / "app"))
try:
    import server                       # main() живёт под `if __name__ == "__main__"`, сервер не стартует
    import ffrun                        # выравнивание громкости переехало из сервера в app/ffrun.py
    import engine                       # CREATE_NO_WINDOW: та же константа, чем пользуется приложение
    verdict("app/server.py импортируется, приложение не запускается", hasattr(ffrun, "loudnorm_bed"),
            "loudnorm_bed найдена в app/ffrun.py" if hasattr(ffrun, "loudnorm_bed")
            else "loudnorm_bed нет в app/ffrun.py")
except Exception as e:
    verdict("app/server.py импортируется", False, "%s: %s" % (type(e).__name__, str(e)[:160]))
    print("\nИТОГ: падений: %d -> %s" % (len(fails), fails))
    sys.exit(1)

if not hasattr(ffrun, "loudnorm_bed"):
    print("\nИТОГ: всё чисто")     # живой части без loudnorm_bed проверять нечего
    sys.exit(0)
loudnorm_bed = ffrun.loudnorm_bed

ff = env.ffmpeg()                       # тот же порядок поиска, что у приложения
print("декодер: %s" % (ff or "не найден"))
if not ff:
    env.missing("выравнивание громкости на настоящем файле", "KADR_FFMPEG")
    print("\nИТОГ: всё чисто")
    sys.exit(0)
if not src_file or not src_file.is_file():
    env.skip("выравнивание громкости на настоящем файле",
             "нет пробного аудиофайла; задайте KADR_SAMPLE_AUDIO")
    print("\nИТОГ: всё чисто")
    sys.exit(0)


def probe(path):
    """Отдельный измерительный проход loudnorm: громкость (LUFS) и длительность файла."""
    r = subprocess.run([str(ff), "-hide_banner", "-nostats", "-i", str(path), "-af",
                        "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                       creationflags=getattr(engine, "CREATE_NO_WINDOW", 0))
    txt = (r.stderr or "") + (r.stdout or "")
    i = re.search(r'"input_i"\s*:\s*"?(-?[0-9.]+)"?', txt)
    d = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", txt)
    dur = int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3)) if d else None
    return (float(i.group(1)) if i else None), dur


work = Path(tempfile.mkdtemp(prefix="h3bedcheck-", dir=str(Path(os.environ.get("TEMP") or "."))))
print("временная папка: %s" % work)
try:
    print()
    print("=== 2. выравнивание настоящего файла ===")
    before_i, before_dur = probe(src_file)
    print("промер до: вход %s LUFS · длительность %s с · файл %s (%d байт)"
          % (before_i, before_dur, src_file.name, src_file.stat().st_size))
    dst = work / "aud0n.wav"
    ok, lufs, why = loudnorm_bed(ff, src_file, dst)
    print("loudnorm_bed вернула: удалось=%r · громкость входа=%r LUFS · отказ=%r" % (ok, lufs, why))
    print("созданный wav: %s (%d байт)" % (dst, dst.stat().st_size if dst.is_file() else 0))
    verdict("выравнивание удалось и wav создан", ok and dst.is_file() and dst.stat().st_size > 1024)
    verdict("измеренная громкость входа совпала с отдельным промером",
            before_i is not None and lufs is not None and abs(before_i - lufs) < 0.6,
            "%r против %r" % (lufs, before_i))
    if dst.is_file():
        after_i, after_dur = probe(dst)
        print("промер результата: %s LUFS (ждём около -16) · длительность %s с" % (after_i, after_dur))
        verdict("результат около -16 LUFS", after_i is not None and -17.5 <= after_i <= -14.5, "%s LUFS" % after_i)
        verdict("длительность не поехала", before_dur and after_dur and abs(before_dur - after_dur) < 0.5,
                "%s с против %s с" % (after_dur, before_dur))

    print()
    print("=== 3. битый файл: честный отказ, а не падение ===")
    bad = work / "broken.mp3"
    bad.write_bytes(b"ID3\x03\x00\x00\x00\x00" + bytes(range(256)) * 8)   # пара килобайт мусора под видом mp3
    print("битый файл: %s (%d байт)" % (bad, bad.stat().st_size))
    bad_dst = work / "broken.wav"
    ok2, lufs2, why2 = loudnorm_bed(ff, bad, bad_dst)
    print("loudnorm_bed вернула: удалось=%r · громкость входа=%r LUFS · отказ=%r" % (ok2, lufs2, why2))
    verdict("на битом файле возвращён отказ", not ok2)
    verdict("текст отказа по-русски и не пустой", bool(why2) and re.search(r"[а-яё]", why2) is not None, repr(why2))
    verdict("битый файл не измерился", lufs2 is None, repr(lufs2))
    verdict("кривого wav на выходе не осталось", not bad_dst.exists())
finally:
    shutil.rmtree(work, ignore_errors=True)
    print()
    print("временное удалено: %s%s" % (work, "" if not work.exists() else " (осталось!)"))

print()
print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
sys.exit(1 if fails else 0)
