"""Студия референсов: листы референсов персонажа, предмета или места из одного короткого ролика.

Ролик считается тем же графом, что и режим «Видео по референсам» (/api/generate/refs): текст
листа говорит модели, где в кадре держат героя и что делает камера. Кадры из готового ролика
вырезает окно - там видно настоящий кадр, а не его расчётное место. Здесь то, что обязан знать
сервер: готовые наборы ракурсов, сборка текста листа, наборы ракурсов, которые человек собрал
сам, и история работ Студии (кадры и лист лежат в data/reflab/runs/<id>/).

В режимы ничего своего не добавляется: кадры-ракурсы и лист уходят обычными картинками - в
карточку раздела «Карточки» и в Библиотеку, а дальше их берут все режимы как обычные референсы.

Таблица наборов ракурсов ниже выписана исполнением модуля автора, а не переписана глазами: у
каждого ракурса там есть и русская строка, которую окно показывает под английским текстом
(в areas/refsheet.py лежит тот же набор без русской строки: тому разделу она не показывается).
"""

from aiohttp import web
from datetime import datetime
import agent as ag
import aiohttp
import json
import re
import uuid


TYPES = {"character": "Персонаж", "object": "Объект", "location": "Локация"}
MAX_UPLOAD = 30 * 1024 * 1024     # один файл работы: лист в 4K весит заметно
MAX_BEATS = 12                    # кадров-ракурсов на лист: длиннее список модель уже не держит
SECONDS = 8.0                     # длительность ролика по умолчанию
WHO_LEN = 300
FEATURES_LEN = 1200

# Наборы ракурсов: title, hint, seconds, beats (name, text, at, ru). Выписаны исполнением модуля автора.
PRESETS = {'location': {'coverage': {'title': 'Со всех сторон',
                           'hint': 'общий · с обратной стороны · слева · справа · деталь',
                           'seconds': 8,
                           'beats': [{'name': 'общий',
                                      'text': 'wide establishing shot of the whole place, eye level, the camera is '
                                              'still',
                                      'at': 0.0,
                                      'ru': 'Общий план всего места, камера стоит'},
                                     {'name': 'обратно',
                                      'text': 'the camera has turned around and now looks at the place from the '
                                              'opposite side, reverse shot',
                                      'at': 0.3,
                                      'ru': 'Камера развернулась и смотрит на место с противоположной стороны'},
                                     {'name': 'слева',
                                      'text': 'the camera is moving along the left side of the place, left side view',
                                      'at': 0.55,
                                      'ru': 'Камера идёт вдоль левой стороны'},
                                     {'name': 'справа',
                                      'text': 'the camera is moving along the right side of the place, right side '
                                              'view',
                                      'at': 0.8,
                                      'ru': 'Камера идёт вдоль правой стороны'},
                                     {'name': 'деталь',
                                      'text': 'slow push in to a close-up of one characteristic detail of the place',
                                      'at': 0.97,
                                      'ru': 'Камера медленно приближается к одной характерной детали'}]},
              'pan360': {'title': 'Осмотр на месте 360°',
                         'hint': 'камера стоит и поворачивается вокруг',
                         'seconds': 8,
                         'beats': [{'name': '0°',
                                    'text': 'the camera stands still and looks straight ahead',
                                    'at': 0.0,
                                    'ru': 'Камера стоит и смотрит прямо'},
                                   {'name': '90°',
                                    'text': 'the camera has turned in place a quarter of a full turn to the right',
                                    'at': 0.25,
                                    'ru': 'Повернулась на месте на четверть оборота вправо'},
                                   {'name': '180°',
                                    'text': 'the camera has turned half a turn and looks at the opposite side',
                                    'at': 0.5,
                                    'ru': 'Повернулась на пол-оборота, смотрит в обратную сторону'},
                                   {'name': '270°',
                                    'text': 'the camera has turned three quarters of a full turn',
                                    'at': 0.75,
                                    'ru': 'Повернулась на три четверти оборота'},
                                   {'name': '360°',
                                    'text': 'the camera has finished the full turn and looks straight ahead again',
                                    'at': 0.97,
                                    'ru': 'Сделала полный оборот и снова смотрит прямо'}]},
              'walk': {'title': 'Пройтись по месту',
                       'hint': 'камера идёт вперёд по месту',
                       'seconds': 8,
                       'beats': [{'name': 'вход',
                                  'text': 'wide shot at the entrance of the place, the camera starts to walk forward',
                                  'at': 0.0,
                                  'ru': 'Общий план у входа, камера начинает идти вперёд'},
                                 {'name': 'вперёд',
                                  'text': 'the camera keeps walking forward at walking speed, the place opens up '
                                          'around',
                                  'at': 0.35,
                                  'ru': 'Камера идёт вперёд обычным шагом, место раскрывается'},
                                 {'name': 'середина',
                                  'text': 'the camera is in the middle of the place and slowly looks around',
                                  'at': 0.7,
                                  'ru': 'Камера в середине места, медленно оглядывается'},
                                 {'name': 'вглубь',
                                  'text': 'the camera has reached the far side of the place and looks back',
                                  'at': 0.97,
                                  'ru': 'Камера дошла до дальней стороны и смотрит назад'}]},
              'time': {'title': 'Время суток',
                       'hint': 'то же место утром, днём, вечером, ночью',
                       'seconds': 8,
                       'beats': [{'name': 'рассвет',
                                  'text': 'the same view at dawn, soft pink light, long shadows',
                                  'at': 0.0,
                                  'ru': 'Тот же вид на рассвете, мягкий розовый свет'},
                                 {'name': 'день',
                                  'text': 'the same view at noon, bright sun, short shadows',
                                  'at': 0.3,
                                  'ru': 'Тот же вид в полдень, яркое солнце'},
                                 {'name': 'закат',
                                  'text': 'the same view at golden hour, warm low light',
                                  'at': 0.6,
                                  'ru': 'Тот же вид на закате, тёплый низкий свет'},
                                 {'name': 'ночь',
                                  'text': 'the same view at night, artificial lights and moonlight',
                                  'at': 0.97,
                                  'ru': 'Тот же вид ночью, огни и лунный свет'}]},
              'empty': {'title': 'Пустая сцена',
                        'hint': 'место без людей, спокойный облёт',
                        'seconds': 6,
                        'beats': [{'name': 'начало',
                                   'text': 'empty place without any people, the camera is still',
                                   'at': 0.0,
                                   'ru': 'Пустое место без людей, камера стоит'},
                                  {'name': 'сдвиг',
                                   'text': 'the camera drifts slowly to the right, still no people',
                                   'at': 0.5,
                                   'ru': 'Камера плавно сдвигается вправо, людей по-прежнему нет'},
                                  {'name': 'конец',
                                   'text': 'the camera ends on the opposite corner of the empty place',
                                   'at': 0.97,
                                   'ru': 'Камера оказалась в противоположном углу пустого места'}]},
              'single': {'title': 'Один дубль',
                         'hint': 'один кадр места',
                         'seconds': 5,
                         'beats': [{'name': 'кадр',
                                    'text': 'one steady wide shot of the place',
                                    'at': 0.5,
                                    'ru': 'Один спокойный общий кадр места'}]},
              'custom': {'title': 'Свой',
                         'hint': 'свои ракурсы',
                         'seconds': 8,
                         'beats': [{'name': 'ракурс 1',
                                    'text': 'wide shot of the place',
                                    'at': 0.0,
                                    'ru': 'Общий план места'}]}},
 'character': {'face': {'title': 'Поворот лица',
                        'hint': 'левый профиль · анфас · правый профиль',
                        'seconds': 6,
                        'beats': [{'name': 'слева',
                                   'text': 'head and shoulders close-up, the face turned fully to the left in '
                                           'profile',
                                   'at': 0.0,
                                   'ru': 'Крупный план головы, лицо повёрнуто влево, профиль'},
                                  {'name': 'анфас',
                                   'text': 'the head slowly turns to look straight into the camera, front view',
                                   'at': 0.5,
                                   'ru': 'Голова плавно поворачивается и смотрит прямо в камеру'},
                                  {'name': 'справа',
                                   'text': 'the head keeps turning and ends fully to the right in profile',
                                   'at': 0.97,
                                   'ru': 'Голова продолжает поворот и оказывается в профиль вправо'}]},
               'orbit360': {'title': 'Поворот 360°',
                            'hint': 'камера облетает героя в полный рост · 5 кадров: спереди, 3/4, бок, сзади, '
                                    'другой бок',
                            'seconds': 12,
                            'beats': [{'name': 'спереди',
                                       'text': 'full body front view, the person stands completely still in a '
                                               'relaxed neutral pose, the camera starts one slow smooth orbit around '
                                               'them',
                                       'at': 0.0,
                                       'ru': 'Спереди в полный рост, герой стоит спокойно, камера начинает плавный '
                                             'облёт'},
                                      {'name': '3/4',
                                       'text': 'the camera has orbited 45 degrees around the standing person, '
                                               'three-quarter view, full body from head to feet in the frame',
                                       'at': 0.125,
                                       'ru': 'Камера обошла героя на 45°: вид в три четверти, он виден целиком, с '
                                             'головы до ног'},
                                      {'name': 'бок',
                                       'text': 'the camera has orbited 90 degrees around the standing person, side '
                                               'profile view, full body from head to feet in the frame',
                                       'at': 0.25,
                                       'ru': 'Камера обошла героя на 90°: вид сбоку, он виден целиком, с головы до '
                                             'ног'},
                                      {'name': 'сзади',
                                       'text': 'the camera has orbited 180 degrees around the standing person, back '
                                               'view, full body from head to feet in the frame',
                                       'at': 0.5,
                                       'ru': 'Камера обошла героя на 180°: вид сзади, он виден целиком, с головы до '
                                             'ног'},
                                      {'name': 'другой бок',
                                       'text': 'the camera has orbited 270 degrees around the standing person, side '
                                               'profile view from the other side, full body from head to feet in the '
                                               'frame',
                                       'at': 0.75,
                                       'ru': 'Камера обошла героя на 270°: вид с другого бока, он виден целиком, с '
                                             'головы до ног'}]},
               'single': {'title': 'Один дубль',
                          'hint': 'один кадр героя',
                          'seconds': 5,
                          'beats': [{'name': 'кадр',
                                     'text': 'one steady full body shot of the person facing the camera',
                                     'at': 0.5,
                                     'ru': 'Один спокойный кадр героя в полный рост'}]},
               'custom': {'title': 'Свой',
                          'hint': 'свои ракурсы',
                          'seconds': 8,
                          'beats': [{'name': 'ракурс 1',
                                     'text': 'full body front view',
                                     'at': 0.0,
                                     'ru': 'В полный рост спереди'}]}},
 'object': {'table': {'title': 'Поворот на столе',
                      'hint': 'предмет медленно крутится на месте',
                      'seconds': 8,
                      'beats': [{'name': 'спереди',
                                 'text': 'the object stands on a plain surface seen from the front',
                                 'at': 0.0,
                                 'ru': 'Предмет стоит на ровной поверхности, вид спереди'},
                                {'name': 'бок',
                                 'text': 'the object has turned a quarter turn, side view',
                                 'at': 0.25,
                                 'ru': 'Повернулся на четверть оборота, вид сбоку'},
                                {'name': 'сзади',
                                 'text': 'the object has turned half a turn, seen from behind',
                                 'at': 0.5,
                                 'ru': 'Повернулся на пол-оборота, вид сзади'},
                                {'name': 'другой бок',
                                 'text': 'the object has turned three quarters, the other side view',
                                 'at': 0.75,
                                 'ru': 'Повернулся на три четверти, вид с другого бока'},
                                {'name': 'сверху',
                                 'text': 'the camera rises and looks at the object from above',
                                 'at': 0.97,
                                 'ru': 'Камера поднимается и смотрит на предмет сверху'}]},
            'detail': {'title': 'Детали',
                       'hint': 'общий вид и крупные планы',
                       'seconds': 8,
                       'beats': [{'name': 'общий',
                                  'text': 'the whole object in the frame, still camera',
                                  'at': 0.0,
                                  'ru': 'Весь предмет в кадре, камера стоит'},
                                 {'name': 'деталь 1',
                                  'text': 'slow push in to a close-up of the most characteristic detail of the '
                                          'object',
                                  'at': 0.4,
                                  'ru': 'Камера медленно приближается к самой характерной детали'},
                                 {'name': 'деталь 2',
                                  'text': 'the camera moves along the object to another detail, close-up',
                                  'at': 0.75,
                                  'ru': 'Камера идёт вдоль предмета к другой детали, крупный план'},
                                 {'name': 'фактура',
                                  'text': 'extreme close-up of the surface and the material of the object',
                                  'at': 0.97,
                                  'ru': 'Самый крупный план: поверхность и материал'}]},
            'single': {'title': 'Один дубль',
                       'hint': 'один кадр предмета',
                       'seconds': 5,
                       'beats': [{'name': 'кадр',
                                  'text': 'one steady shot of the object',
                                  'at': 0.5,
                                  'ru': 'Один спокойный кадр предмета'}]},
            'custom': {'title': 'Свой',
                       'hint': 'свои ракурсы',
                       'seconds': 8,
                       'beats': [{'name': 'ракурс 1',
                                  'text': 'the whole object seen from the front',
                                  'at': 0.0,
                                  'ru': 'Весь предмет спереди'}]}}}


def _err(text, status=400):
    return web.json_response({"error": text}, status=status)


def _num(value, lo, hi, default):
    """Число из формы, приведённое к разрешённым границам."""
    try:
        return min(hi, max(lo, float(value)))
    except (TypeError, ValueError):
        return default


def clean(value, limit):
    """Одна строка заданной длины: переводы строк тексту листа не нужны."""
    return " ".join(str(value or "").split())[:limit]


def _beats(raw):
    """Ракурсы сохранённого набора: только те, у которых есть текст про камеру.

    Русская строка едет рядом: окно показывает её под английским текстом, чтобы человек
    понимал ракурс, не переводя промпт.
    """
    out = []
    for b in (raw or [])[:MAX_BEATS]:
        item = b if isinstance(b, dict) else {}
        text = clean(item.get("text"), 300)
        if not text:
            continue
        out.append({"name": clean(item.get("name"), 30) or ("ракурс " + str(len(out) + 1)),
                    "text": text, "at": round(_num(item.get("at"), 0, 1, 0.0), 2),
                    "ru": clean(item.get("ru"), 300)})
    return out


def build_prompt(p):
    """Английский текст для H3: один непрерывный дубль, камера проходит ракурсы по времени.

    Героя называют в начале и повторяют, что он не меняется: ролик длинный, и к середине модель
    иначе начинает переодевать и перекрашивать SUBJECT. Для персонажа и предмета фон просят
    плоским серым - без пола, линии горизонта и теней, чтобы фигура держалась в кадре целиком и
    на кадрах листа не было разных фонов.
    """
    typ = p.get("type") if p.get("type") in TYPES else "character"
    seconds = _num(p.get("seconds"), 3, 15, SECONDS)
    who = clean(p.get("who"), WHO_LEN) or {"character": "the person", "object": "the object",
                                           "location": "the place"}[typ]
    beats = _beats(p.get("beats")) or PRESETS[typ]["single"]["beats"]
    head = {"character": "A character reference clip of " + who + ". The person stays calm and does not talk, "
                          "the face and outfit stay exactly the same.",
            "object": "A product reference clip of " + who + ". The object does not change its shape or colours.",
            "location": "A location reference clip of " + who + ". No people are in the frame, nothing important "
                                                                "moves in the place."}[typ]
    parts = [head]
    if clean(p.get("features"), FEATURES_LEN):
        parts.append("Keep: " + clean(p.get("features"), FEATURES_LEN).rstrip(".") + ".")
    if clean(p.get("style"), 200):
        parts.append("Look: " + clean(p.get("style"), 200).rstrip(".") + ".")
    if clean(p.get("setdress"), 300):
        parts.append("Setting: " + clean(p.get("setdress"), 300).rstrip(".") + ".")
    if clean(p.get("focus"), 200):
        parts.append("Every view is centred on " + clean(p.get("focus"), 200).rstrip(".") + ".")
    if any("orbit" in b["text"] for b in beats):   # лист поворотом: герой стоит, камера обходит его вокруг
        parts.append("The person does not move at all and the camera makes one smooth full 360-degree orbit "
                     "around them at a constant distance; the whole body from head to feet stays in the frame.")
    if typ != "location":   # плоский одноцветный фон: без пола, горизонта и теней, чтобы фигура держалась в кадре
        parts.append("The background is one flat seamless light grey colour everywhere, like a cut-out on a plain "
                     "sheet: no floor, no floor line, no horizon, no gradient, no vignette, no backdrop edges, "
                     "no cast shadows, no ground shadow, no reflections, no props. The subject is lit evenly from "
                     "the front and fills most of the frame height, with only a small margin above and below.")
    parts.append("One continuous take, no cuts, steady and clean camera, " +
                 ("" if typ == "location" else "flat even light, ") + "no text, no music, no dialogue.")
    moves = ["At %.1f seconds: %s." % (b["at"] * seconds, b["text"].rstrip(".")) for b in beats]
    parts.append("Camera, in time order. " + " ".join(moves))
    return " ".join(parts), seconds


def beat_times(beats, seconds):
    """Секунды, в которые попадает каждый ракурс.

    Кадры окно берёт из ролика по тем же числам: момент в тексте и момент в видео обязаны
    совпадать, иначе подпись кадра врёт.
    """
    return [round(_num(b.get("at") if isinstance(b, dict) else b, 0, 1, 0.0) * seconds, 2)
            for b in _beats(beats)]


class ReflabMixin:
    """Область «reflab»: наборы ракурсов, текст листа и история работ Студии референсов."""

    # ---------- наборы ракурсов ----------

    async def h_reflab_presets(self, _req):
        """Что предлагать в окне: готовые наборы своего типа и наборы самого человека."""
        return web.json_response({"types": TYPES, "presets": PRESETS, "mine": self.reflab.presets})

    async def h_reflab_prompt(self, req):
        """Готовый текст листа и моменты ракурсов: окно показывает их до отправки в ComfyUI."""
        try:
            form = await req.json()
        except ValueError:
            return _err("Не удалось прочитать данные")
        if not _beats((form or {}).get("beats")):
            return _err("Добавьте хотя бы один ракурс с описанием камеры")
        try:
            prompt, seconds = build_prompt(form)
        except (TypeError, ValueError):
            return _err("Не удалось собрать описание")
        return web.json_response({"prompt": prompt, "seconds": seconds,
                                  "times": beat_times(form["beats"], seconds)})

    async def h_reflab_preset_save(self, req):
        """Свой набор ракурсов человека: тот же вид, что готовый, только живёт он в его папке."""
        try:
            body = await req.json()
        except ValueError:
            return _err("Не удалось прочитать данные")
        name = clean((body or {}).get("name"), 40)
        beats = _beats((body or {}).get("beats"))
        if not name:
            return _err("Напишите название набора")
        if not beats:
            return _err("В наборе не осталось ни одного ракурса")
        preset = {"id": uuid.uuid4().hex[:8], "name": name,
                  "type": (body or {}).get("type") if (body or {}).get("type") in TYPES else "character",
                  "seconds": _num((body or {}).get("seconds"), 3, 15, SECONDS), "beats": beats}
        self.reflab.presets.append(preset)
        self.reflab.save_presets()
        return web.json_response(preset)

    async def h_reflab_preset_delete(self, req):
        pid = req.match_info["id"]
        rest = [p for p in self.reflab.presets if p.get("id") != pid]
        if len(rest) == len(self.reflab.presets):
            return _err("Такого набора нет", 404)
        self.reflab.presets = rest
        self.reflab.save_presets()
        return web.json_response({"ok": True})

    # ---------- работы ----------

    async def h_reflab_list(self, _req):
        """Список работ: свежие первыми, у кадров и листа уже есть адреса."""
        return web.json_response([self.reflab.public(r) for r in self.reflab.runs])

    async def h_reflab_save(self, req):
        """Положить работу в историю: поля приходят строками, картинки - файлами той же формы.

        Кадр, которого в форме нет, остаётся на диске: окно дописывает кадры по одному, и
        потерянный при этом старый ракурс человек увидел бы как пустое место на листе.
        """
        meta, files = {}, {}
        try:
            async for part in await req.multipart():
                if part.name == "meta":
                    meta = json.loads((await part.read()).decode("utf-8"))
                elif part.name and part.filename:
                    raw = bytes(await part.read())
                    if len(raw) > MAX_UPLOAD:
                        return _err("Файл слишком большой (до 30 МБ)")
                    if raw[:8] != b"\x89PNG\r\n\x1a\n":
                        return _err("Кадры и лист приходят картинками PNG")
                    files[part.name] = raw
        except (ValueError, UnicodeDecodeError):
            return _err("Не удалось прочитать данные")
        if not isinstance(meta, dict):
            return _err("Не удалось прочитать данные")
        old = self.reflab.get(meta.get("id")) if meta.get("id") else None
        rid = old["id"] if old else re.sub(r"[^a-z0-9]", "", str(meta.get("id") or ""))[:40] or uuid.uuid4().hex[:12]
        folder = self.reflab.folder(rid)
        folder.mkdir(parents=True, exist_ok=True)
        beats = []
        for i, b in enumerate((meta.get("beats") or [])[:MAX_BEATS]):
            item = b if isinstance(b, dict) else {}
            name, raw = "%d.png" % i, files.get("f_%d" % i)
            if raw:
                (folder / name).write_bytes(raw)
            elif not ((folder / name).is_file() and item.get("file")):
                name = ""
            beats.append({"name": clean(item.get("name"), 30) or ("ракурс " + str(i + 1)),
                          "text": clean(item.get("text"), 400),
                          "ru": clean(item.get("ru"), 300),
                          "t": round(_num(item.get("t"), 0, 60, 0.0), 2),
                          "on": bool(item.get("on", True)), "file": name})
        sheet = ""
        if files.get("sheet"):
            (folder / "sheet.png").write_bytes(files["sheet"])
            sheet = "sheet.png"
        elif old and old.get("sheet") and (folder / str(old["sheet"])).is_file():
            sheet = str(old["sheet"])
        now = datetime.now().isoformat(timespec="seconds")
        run = {"id": rid, "date": (old or {}).get("date") or now, "updated": now,
               "name": clean(meta.get("name"), 60) or "Без названия",
               "type": meta.get("type") if meta.get("type") in TYPES else "location",
               "preset": clean(meta.get("preset"), 40),
               "status": "finished" if meta.get("status") == "finished" else "draft",
               "star": bool((old or {}).get("star")),
               "rating": int(_num((old or {}).get("rating"), -1, 1, 0)),
               "res": clean(meta.get("res"), 20), "seed": clean(meta.get("seed"), 20),
               "video": clean(meta.get("video"), 40),
               "seconds": _num(meta.get("seconds"), 3, 15, SECONDS),
               "layout": meta.get("layout") if isinstance(meta.get("layout"), dict) else {},
               "form": meta.get("form") if isinstance(meta.get("form"), dict) else {},
               "beats": beats, "sheet": sheet}
        self.reflab.add(run)
        return web.json_response(self.reflab.public(run))

    async def h_reflab_file(self, req):
        """Один файл работы: кадр-ракурс или лист."""
        r = self.reflab.get(req.match_info["id"])
        if not r:
            return _err("Работа не найдена", 404)
        f = self.reflab.file(r, req.match_info["name"])
        if not f:
            return _err("Файл не найден", 404)
        return web.FileResponse(f)

    async def h_reflab_rate(self, req):
        """Звезда и оценка работы: по ним человек видит, какой набор ракурсов ему подошёл."""
        r = self.reflab.get(req.match_info["id"])
        if not r:
            return _err("Работа не найдена", 404)
        body = await req.json()
        if "star" in body:
            r["star"] = bool(body["star"])
        if "rating" in body:
            r["rating"] = int(_num(body["rating"], -1, 1, 0))
        self.reflab.save()
        return web.json_response({"star": r["star"], "rating": r["rating"]})

    async def h_reflab_delete(self, req):
        r = self.reflab.get(req.match_info["id"])
        if not r:
            return _err("Работа уже удалена", 404)
        self.reflab.remove(r)
        return web.json_response({"ok": True})

    async def h_reflab_clear(self, _req):
        """Убрать немеченые работы: помеченные звездой человек оставил себе."""
        return web.json_response({"removed": self.reflab.clear_unstarred()})

    # ---------- «Описать по картинке» ----------

    async def h_reflab_describe(self, req):
        """Модель сценариста смотрит картинки и пишет короткий «кто» и что в нём сохранять.

        Работает только на своей модели сценариста с файлом «зрения»: без неё честный отказ с
        подсказкой, где это берётся, а не пустое поле в форме.
        """
        try:
            body = await req.json()
        except ValueError:
            return _err("Не удалось прочитать данные")
        imgs = [u for u in ((body or {}).get("images") or [])[:4]
                if isinstance(u, str) and u.startswith("data:image")]
        typ = (body or {}).get("type") if (body or {}).get("type") in TYPES else "character"
        if not imgs:
            return _err("Сначала добавьте картинку: по ней программа составит описание")
        if self.jobs:
            return _err("Идёт генерация: описание можно будет сделать, когда она закончится.")
        variant = await self.llm_variant()
        if not self.llm.installed(variant):
            return _err("Модель сценариста ещё не скачана: скачать её можно в разделе «Сценарист». "
                        "Пока впишите описание вручную.")
        if not self.llm.vision(variant):
            return _err("У выбранной модели сценариста нет файла «зрения» (mmproj): она не видит картинки. "
                        "Впишите описание вручную.")
        try:
            if not self.llm.alive():
                try:
                    await self.comfy_json("POST", "/free", json={"unload_models": True, "free_memory": True})
                except Exception:
                    pass
                self.llm.start(variant, ctx=self.agent_ctx())
                await ag.wait_ready(self.session, self.llm)
            what = {"character": "the person or creature", "object": "the object", "location": "the place"}[typ]
            ask = ("Look at the picture(s): " + what + " is shown. Reply with ONLY a JSON object with two "
                   'string fields. "who": one short English noun phrase starting with "the" (like "the man '
                   'in a dark denim jacket"). "features": one English sentence listing what must stay the '
                   "same in every view (colours, materials, clothes, marks, shapes, style). No other text.")
            payload = {"messages": [{"role": "user", "content": [{"type": "text", "text": ask}] +
                                     [{"type": "image_url", "image_url": {"url": u}} for u in imgs]}],
                       "stream": False, "temperature": 0.3,
                       "chat_template_kwargs": {"enable_thinking": False}, "thinking_budget_tokens": 0}
            async with self.session.post(self.llm.url + "/v1/chat/completions", json=payload,
                                         timeout=aiohttp.ClientTimeout(total=240)) as r:
                if r.status != 200:
                    return _err("Модель ответила ошибкой " + str(r.status) + ". Впишите описание вручную.", 502)
                text = (await r.json())["choices"][0]["message"].get("content") or ""
        except Exception as e:
            return _err("Не удалось описать картинку (" + str(e)[:160] + "). Впишите описание вручную.", 502)
        m = re.search(r"\{.*\}", text, re.S)
        try:
            found = json.loads(m.group(0)) if m else {}
        except ValueError:
            found = {}
        who, feats = clean(found.get("who"), WHO_LEN), clean(found.get("features"), FEATURES_LEN)
        if not who and not feats:
            who = clean(text, WHO_LEN)
        return web.json_response({"who": who, "features": feats})
