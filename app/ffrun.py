"""Запуск внешних программ без окна и выравнивание громкости фоновой музыки двумя
проходами ffmpeg. Возвращает пояснение по-русски, а не исключение: тихий отказ лучше упавшего
расчёта."""

from pathlib import Path
import engine
import os
import re
import subprocess
import tempfile


def _sub_run(cmd, secs, cwd):
    """Запуск программы без окна: тот же порядок, что у распознавания речи в speech._run."""
    return subprocess.run([str(x) for x in cmd], cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=secs,
                          creationflags=engine.CREATE_NO_WINDOW)


# Цель выравнивания фона: одна заданная громкость, чтобы ползунок «Уровень музыки» значил одно и то
# же в тихом файле и в громком. -16 LUFS - обычный уровень фонового звучания, TP и LRA как в ffmpeg.
LOUDNORM_I, LOUDNORM_TP, LOUDNORM_LRA = -16.0, -1.5, 11


def loudnorm_bed(ff, src, dst):
    """Ровная по громкости копия фоновой музыки: два прохода ffmpeg loudnorm. Первый измеряет файл,
    второй применяет ровно измеренные значения, поэтому трек приходит к одной заданной громкости
    независимо от того, громким был исходный файл или тихим. Так положение ползунка значит
    «насколько фон тише речи», а не «насколько повезло с файлом». На выходе wav 44100 стерео.
    Возвращает (удалось ли, измеренная громкость входа в LUFS, текст отказа по-русски): отказ -
    повод взять подлинный файл, а не ронять задание. Временное - в tempfile рядом с папкой цели."""
    src, dst, work = str(src), str(dst), Path(dst).parent
    meas = "loudnorm=I=%g:TP=%g:LRA=%d:print_format=json" % (LOUDNORM_I, LOUDNORM_TP, LOUDNORM_LRA)
    try:   # первый проход: только измеряет, ничего не пишет
        first = _sub_run([ff, "-hide_banner", "-nostats", "-i", src, "-af", meas, "-f", "null", "-"], 600, work)
    except Exception as e:   # декодер не запустился или не успел
        return False, None, "декодер не смог открыть этот файл (%s): музыка играет как есть" % type(e).__name__
    txt = (first.stderr or "") + (first.stdout or "")

    def num(name):
        """Одно число из отчёта loudnorm: вместо числа там может быть inf или nan."""
        m = re.search(r'"%s"\s*:\s*"?(-?[0-9.]+|-?inf|nan)"?' % name, txt)
        if not m or m.group(1).lower() in ("inf", "-inf", "nan", "+inf"):
            return None
        try:
            return float(m.group(1))
        except ValueError:
            return None

    in_i = num("input_i")
    if first.returncode or in_i is None:   # файл битый или без звука: чисел нет - выравнивать нечего
        return False, None, "декодер не смог измерить громкость этого файла: музыка играет как есть"
    filt = ["loudnorm=I=%g:TP=%g:LRA=%d:linear=true" % (LOUDNORM_I, LOUDNORM_TP, LOUDNORM_LRA)]
    for key, val in (("measured_I", in_i), ("measured_TP", num("input_tp")), ("measured_LRA", num("input_lra")),
                     ("measured_thresh", num("input_thresh")), ("offset", num("target_offset"))):
        if val is not None:
            filt.append("%s=%.2f" % (key, val))
    filt.append("print_format=summary")
    tmp = None
    try:   # пишу в tempfile: неудачный проход не должен оставить хвост в папке цели
        fd, tmp_name = tempfile.mkstemp(suffix=".wav", dir=str(work))
        os.close(fd)
        tmp = Path(tmp_name)
        second = _sub_run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-af", ":".join(filt),
                           "-ar", "44100", "-ac", "2", str(tmp)], 900, work)
        if second.returncode or not tmp.is_file() or tmp.stat().st_size < 1024:
            return False, in_i, "декодер не смог переписать файл ровно: музыка играет как есть"
        os.replace(tmp, dst)
        return True, in_i, ""
    except Exception as e:
        return False, in_i, "выравнивание не вышло (%s): музыка играет как есть" % type(e).__name__
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
