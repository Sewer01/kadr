"""Текст субтитров: разбор файла SRT в реплики, сборка файла обратно, раскадровка на
кадры и понимание, что речь и так по-русски. Чистые функции: ни сервера, ни ComfyUI."""

import re
import speech


def split_frames(text):
    """One frame per line / numbered item: "1: ...", "Frame 2. ...", "Кадр 3 - ..."."""
    parts = re.split(r"(?m)^\s*(?:frame|кадр)?\s*\d+\s*[:.)\-–]\s*", text.strip(), flags=re.I)
    frames = [p.strip().replace("\n", " ") for p in parts if p.strip()]
    if len(frames) < 2:
        frames = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return frames


def srt_parse(raw):
    """Файл SRT -> список реплик: [строка начала, строка конца, текст]. Номера реплик не
    сохраняются: при сборке файла они считаются заново по порядку. Реплика, от которой после
    очистки шума (speech.NOISE) ничего не осталось, в список не попадает, поэтому и в готовый
    файл такой пустой реплики не будет."""
    cues = []
    for block in raw.replace("\r", "").split("\n\n"):
        rows = [x.strip() for x in block.splitlines() if x.strip()]
        at = next((i for i, x in enumerate(rows) if "-->" in x), None)
        if at is None:
            continue   # блок без строки времени: это не реплика
        start, _, end = rows[at].partition("-->")
        body = re.sub(r"\s+", " ", speech.NOISE.sub("", " ".join(rows[at + 1:]))).strip()
        if body:
            cues.append([start.strip(), end.strip(), body])
    return cues


def srt_build(cues):
    """Список реплик -> текст SRT: те же метки времени, номера по порядку, новый текст внутри."""
    return "\n\n".join("%d\n%s --> %s\n%s" % (i, a, b, t)
                       for i, (a, b, t) in enumerate(cues, 1)) + "\n"


def srt_russian(text):
    """Похоже ли, что речь и так по-русски: кириллицы много, латиницы почти нет. Нужно, чтобы
    не дёргать моделью перевод там, где переводить нечего."""
    cyr = len(re.findall(r"[а-яёА-ЯЁ]", text))
    lat = len(re.findall(r"[A-Za-z]", text))
    return cyr >= 20 and lat <= max(3, cyr // 10)
