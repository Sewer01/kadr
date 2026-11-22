"""Лист референсов: короткий ролик нарезается на кадры по пресету движения камеры.

Пресет описывает короткий ролик: у него есть доли длительности, в которые должен попасть кадр, и
у каждого кадра своя фраза про камеру. Кадры попадают в библиотеку обычными кадрами-памятками:
их уже видят все режимы, а фраза кадра кладётся в поле памятки - оттуда её ставят в текст
«Сценария». Ничего своего в режимы не добавляется: лист только производит те же предметы, что
человек мог бы сохранить руками с верстака.

Таблица пресетов вынесена из разбора репы автора (см. docs/upstream-port.md): словарь был
исполнен и выписан, а не переписан глазами.
"""

from aiohttp import web
from datetime import datetime
from pathlib import Path
from paths import DATA_DIR
import asyncio
import re
import shutil
import subprocess
import uuid

KINDS = {"character": "Персонаж", "object": "Объект", "location": "Локация"}
MAX_VIDEO = 300 * 1024 * 1024
MIN_SECONDS = 1.0
MAX_SECONDS = 120.0
VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts", ".ts", ".wmv", ".flv",
             ".mpg", ".mpeg", ".3gp")
NO_WINDOW = 0x08000000 if hasattr(subprocess, "CREATE_NO_WINDOW") else 0

# Таблица пресетов движения камеры: выписана разбором репы автора,
# там словарь исполнен, а не переписан глазами (docs/upstream-port.md).
PRESETS = {
    'location': {
        'coverage': {
            'title': 'Со всех сторон',
            'hint': 'общий · с обратной стороны · слева · справа · деталь',
            'seconds': 8,
            'beats': [
                {
                    'name': 'общий',
                    'text': 'wide establishing shot of the whole place, eye level, the camera is still',
                    'at': 0.0,
                },
                {
                    'name': 'обратно',
                    'text': 'the camera has turned around and now looks at the place from the opposite side, reverse shot',
                    'at': 0.3,
                },
                {
                    'name': 'слева',
                    'text': 'the camera is moving along the left side of the place, left side view',
                    'at': 0.55,
                },
                {
                    'name': 'справа',
                    'text': 'the camera is moving along the right side of the place, right side view',
                    'at': 0.8,
                },
                {
                    'name': 'деталь',
                    'text': 'slow push in to a close-up of one characteristic detail of the place',
                    'at': 1.0,
                },
            ],
        },
        'pan360': {
            'title': 'Осмотр на месте 360°',
            'hint': 'камера стоит и поворачивается вокруг',
            'seconds': 8,
            'beats': [
                {
                    'name': '0°',
                    'text': 'the camera stands still and looks straight ahead',
                    'at': 0.0,
                },
                {
                    'name': '90°',
                    'text': 'the camera has turned in place a quarter of a full turn to the right',
                    'at': 0.25,
                },
                {
                    'name': '180°',
                    'text': 'the camera has turned half a turn and looks at the opposite side',
                    'at': 0.5,
                },
                {
                    'name': '270°',
                    'text': 'the camera has turned three quarters of a full turn',
                    'at': 0.75,
                },
                {
                    'name': '360°',
                    'text': 'the camera has finished the full turn and looks straight ahead again',
                    'at': 1.0,
                },
            ],
        },
        'walk': {
            'title': 'Пройтись по месту',
            'hint': 'камера идёт вперёд по месту',
            'seconds': 8,
            'beats': [
                {
                    'name': 'вход',
                    'text': 'wide shot at the entrance of the place, the camera starts to walk forward',
                    'at': 0.0,
                },
                {
                    'name': 'вперёд',
                    'text': 'the camera keeps walking forward at walking speed, the place opens up around',
                    'at': 0.35,
                },
                {
                    'name': 'середина',
                    'text': 'the camera is in the middle of the place and slowly looks around',
                    'at': 0.7,
                },
                {
                    'name': 'вглубь',
                    'text': 'the camera has reached the far side of the place and looks back',
                    'at': 1.0,
                },
            ],
        },
        'time': {
            'title': 'Время суток',
            'hint': 'то же место утром, днём, вечером, ночью',
            'seconds': 8,
            'beats': [
                {
                    'name': 'рассвет',
                    'text': 'the same view at dawn, soft pink light, long shadows',
                    'at': 0.0,
                },
                {
                    'name': 'день',
                    'text': 'the same view at noon, bright sun, short shadows',
                    'at': 0.3,
                },
                {
                    'name': 'закат',
                    'text': 'the same view at golden hour, warm low light',
                    'at': 0.6,
                },
                {
                    'name': 'ночь',
                    'text': 'the same view at night, artificial lights and moonlight',
                    'at': 1.0,
                },
            ],
        },
        'empty': {
            'title': 'Пустая сцена',
            'hint': 'место без людей, спокойный облёт',
            'seconds': 6,
            'beats': [
                {
                    'name': 'начало',
                    'text': 'empty place without any people, the camera is still',
                    'at': 0.0,
                },
                {
                    'name': 'сдвиг',
                    'text': 'the camera drifts slowly to the right, still no people',
                    'at': 0.5,
                },
                {
                    'name': 'конец',
                    'text': 'the camera ends on the opposite corner of the empty place',
                    'at': 1.0,
                },
            ],
        },
        'single': {
            'title': 'Один дубль',
            'hint': 'один кадр места',
            'seconds': 5,
            'beats': [
                {
                    'name': 'кадр',
                    'text': 'one steady wide shot of the place',
                    'at': 0.5,
                },
            ],
        },
        'custom': {
            'title': 'Свой',
            'hint': 'свои ракурсы',
            'seconds': 8,
            'beats': [
                {
                    'name': 'ракурс 1',
                    'text': 'wide shot of the place',
                    'at': 0.0,
                },
            ],
        },
    },
    'character': {
        'face': {
            'title': 'Поворот лица',
            'hint': 'левый профиль · анфас · правый профиль',
            'seconds': 6,
            'beats': [
                {
                    'name': 'слева',
                    'text': 'head and shoulders close-up, the face turned fully to the left in profile',
                    'at': 0.0,
                },
                {
                    'name': 'анфас',
                    'text': 'the head slowly turns to look straight into the camera, front view',
                    'at': 0.5,
                },
                {
                    'name': 'справа',
                    'text': 'the head keeps turning and ends fully to the right in profile',
                    'at': 1.0,
                },
            ],
        },
        'orbit360': {
            'title': 'Поворот 360°',
            'hint': 'камера облетает героя в полный рост · 5 кадров: спереди, 3/4, бок, сзади, другой бок',
            'seconds': 12,
            'beats': [
                {
                    'name': 'спереди',
                    'text': 'full body front view, the person stands completely still in a relaxed neutral pose, the camera starts one slow smooth orbit around them',
                    'at': 0.0,
                },
                {
                    'name': '3/4',
                    'text': 'the camera has orbited 45 degrees around the standing person, three-quarter view, full body from head to feet in the frame',
                    'at': 0.125,
                },
                {
                    'name': 'бок',
                    'text': 'the camera has orbited 90 degrees around the standing person, side profile view, full body from head to feet in the frame',
                    'at': 0.25,
                },
                {
                    'name': 'сзади',
                    'text': 'the camera has orbited 180 degrees around the standing person, back view, full body from head to feet in the frame',
                    'at': 0.5,
                },
                {
                    'name': 'другой бок',
                    'text': 'the camera has orbited 270 degrees around the standing person, side profile view from the other side, full body from head to feet in the frame',
                    'at': 0.75,
                },
            ],
        },
        'single': {
            'title': 'Один дубль',
            'hint': 'один кадр героя',
            'seconds': 5,
            'beats': [
                {
                    'name': 'кадр',
                    'text': 'one steady full body shot of the person facing the camera',
                    'at': 0.5,
                },
            ],
        },
        'custom': {
            'title': 'Свой',
            'hint': 'свои ракурсы',
            'seconds': 8,
            'beats': [
                {
                    'name': 'ракурс 1',
                    'text': 'full body front view',
                    'at': 0.0,
                },
            ],
        },
    },
    'object': {
        'table': {
            'title': 'Поворот на столе',
            'hint': 'предмет медленно крутится на месте',
            'seconds': 8,
            'beats': [
                {
                    'name': 'спереди',
                    'text': 'the object stands on a plain surface seen from the front',
                    'at': 0.0,
                },
                {
                    'name': 'бок',
                    'text': 'the object has turned a quarter turn, side view',
                    'at': 0.25,
                },
                {
                    'name': 'сзади',
                    'text': 'the object has turned half a turn, seen from behind',
                    'at': 0.5,
                },
                {
                    'name': 'другой бок',
                    'text': 'the object has turned three quarters, the other side view',
                    'at': 0.75,
                },
                {
                    'name': 'сверху',
                    'text': 'the camera rises and looks at the object from above',
                    'at': 1.0,
                },
            ],
        },
        'detail': {
            'title': 'Детали',
            'hint': 'общий вид и крупные планы',
            'seconds': 8,
            'beats': [
                {
                    'name': 'общий',
                    'text': 'the whole object in the frame, still camera',
                    'at': 0.0,
                },
                {
                    'name': 'деталь 1',
                    'text': 'slow push in to a close-up of the most characteristic detail of the object',
                    'at': 0.4,
                },
                {
                    'name': 'деталь 2',
                    'text': 'the camera moves along the object to another detail, close-up',
                    'at': 0.75,
                },
                {
                    'name': 'фактура',
                    'text': 'extreme close-up of the surface and the material of the object',
                    'at': 1.0,
                },
            ],
        },
        'single': {
            'title': 'Один дубль',
            'hint': 'один кадр предмета',
            'seconds': 5,
            'beats': [
                {
                    'name': 'кадр',
                    'text': 'one steady shot of the object',
                    'at': 0.5,
                },
            ],
        },
        'custom': {
            'title': 'Свой',
            'hint': 'свои ракурсы',
            'seconds': 8,
            'beats': [
                {
                    'name': 'ракурс 1',
                    'text': 'the whole object seen from the front',
                    'at': 0.0,
                },
            ],
        },
    },
};


def presets_public():
    """Пресеты для интерфейса: вид, ключ, название, подсказка и кадры."""
    out = []
    for kind, group in PRESETS.items():
        for key, p in group.items():
            out.append({"id": kind + "/" + key, "kind": kind, "kindName": KINDS.get(kind, kind),
                        "title": p["title"], "hint": p["hint"], "seconds": p["seconds"],
                        "beats": p["beats"]})
    out.sort(key=lambda x: (x["kindName"], x["title"]))
    return out


def preset_of(ident):
    """Пресет по адресу вида вид/ключ."""
    kind, _, key = str(ident or "").partition("/")
    group = PRESETS.get(kind, {})
    return dict(group[key], kind=kind, key=key) if key in group else None


def _err(text, status=400):
    return web.json_response({"error": text}, status=status)


def _duration(text):
    """Длительность из текста ffmpeg: там есть строка Duration: 00:00:08.03."""
    m = re.search(r"Duration:\s*(\d+):(\d\d):(\d\d(?:[.,]\d+)?)", text or "")
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3).replace(",", "."))


class RefsheetMixin:
    """Область «refsheet»: кадры движения камеры из короткого ролика."""

    async def h_refsheet_presets(self, _req):
        return web.json_response({"presets": presets_public()})

    def _grab(self, ff, src, at, out):
        """Один кадр на отметке at. Вторым значением возвращаем stderr: по нему видно, почему отказ."""
        cmd = [str(ff), "-hide_banner", "-loglevel", "error", "-y", "-ss", "%.3f" % at,
               "-i", str(src), "-frames:v", "1", "-update", "1", str(out)]
        r = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW)
        return r.returncode == 0 and out.is_file(), (r.stderr or b"").decode("utf-8", "replace")

    def _probe(self, ff, src):
        """Длительность ролика: ffmpeg сам печатает её, отдельный ffprobe не нужен."""
        flags = [str(ff), "-hide_banner", "-i", str(src), "-f", "null", "-"]
        r = subprocess.run(flags, capture_output=True, creationflags=NO_WINDOW)
        return _duration((r.stderr or b"").decode("utf-8", "replace"))

    async def h_refsheet_make(self, request):
        """POST байтами ролика; в адресе - пресет и имя файла."""
        ff = self._ffmpeg()
        if not ff:
            return _err("декодер не найден", 404)
        preset = preset_of(request.query.get("preset"))
        if not preset:
            return _err("Не знаю такой пресет движения камеры: обновите список")
        data = await request.read()
        if not data:
            return _err("пустой файл")
        if len(data) > MAX_VIDEO:
            return _err("файл больше %d МБ" % (MAX_VIDEO // 1024 // 1024), 413)
        name = request.query.get("name") or "ролик.mp4"
        suffix = Path(name).suffix.lower()
        if suffix not in VIDEO_EXT:
            suffix = ".mp4"
        work = DATA_DIR / ("tmp-refsheet-" + uuid.uuid4().hex)
        work.mkdir(parents=True, exist_ok=True)
        src = work / ("in" + suffix)
        created, skipped = [], []
        try:
            src.write_bytes(data)
            hours = await asyncio.to_thread(self._probe, ff, src)
            if hours is None:
                return _err("Не удалось прочитать длительность ролика: похоже, это не видео")
            if not MIN_SECONDS <= hours <= MAX_SECONDS:
                return _err("Для листа нужен ролик от %s до %s секунд, а тут %.1f с"
                            % (MIN_SECONDS, MAX_SECONDS, hours))
            clean = re.sub(r"[^\w\- ]+", "", Path(name).stem)[:40].strip() or "ролик"
            where = DATA_DIR / "keeps"
            where.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            # последнюю долю берём с запасом: кадр ровно в конце ролика декодер часто не даёт
            base = max(0.0, hours - 0.25)
            for num, beat in enumerate(preset["beats"], 1):
                at = min(max(0.0, beat["at"] * base), base)
                out = work / ("f%d.png" % num)
                got, _err_text = await asyncio.to_thread(self._grab, ff, src, at, out)
                if not got and at > 0.1:
                    # вторая попытка чуть раньше: на последнем кадре декодер иногда молчит
                    got, _err_text = await asyncio.to_thread(self._grab, ff, src, at - min(0.5, at * 0.1), out)
                    if got:
                        at = max(0.0, at - min(0.5, at * 0.1))
                if not got:
                    skipped.append(beat["name"])
                    continue
                safe = re.sub(r"\s+", "_", beat["name"]) or "кадр"
                target = where / ("%s-%s-лист-%s.png" % (stamp, uuid.uuid4().hex[:4], safe))
                target.write_bytes(out.read_bytes())
                item = {"id": uuid.uuid4().hex[:12], "prompt_id": "",
                        "date": datetime.now().isoformat(timespec="seconds"), "fav": False,
                        "file": {"type": "local", "path": str(target), "filename": target.name},
                        "ext": "png", "kind": "image", "mode": "frame", "label": "лист",
                        "title": "%s · %s" % (preset["title"], beat["name"]),
                        "prompt": beat["text"][:400], "source": clean[:120], "at": "%.1f с" % at}
                self.library.add(item)
                created.append({"id": item["id"], "name": beat["name"], "at": round(at, 2),
                                "text": beat["text"], "title": item["title"]})
            if not created:
                return _err("Ни одного кадра взять не удалось" +
                            (": " + ", ".join(skipped) if skipped else " - ролик пустой"))
            return web.json_response({"ok": True, "seconds": round(hours, 2), "preset": preset["title"],
                                      "frames": created, "skipped": skipped})
        finally:
            shutil.rmtree(work, ignore_errors=True)
