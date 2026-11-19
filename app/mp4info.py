"""Lengths of the video and sound tracks of an MP4 file, read from its header (no ffmpeg, nothing is decoded)."""
import re
import struct


def _boxes(b, s, e):
    while s + 8 <= e:
        size, kind = struct.unpack(">I4s", b[s:s + 8])
        head = 8
        if size == 1:
            size = struct.unpack(">Q", b[s + 8:s + 16])[0]
            head = 16
        elif size == 0:
            size = e - s
        if size < head:
            return
        yield kind.decode("latin1"), s + head, min(s + size, e)
        s += size


def track_seconds(data):
    """{'vide': seconds, 'soun': seconds} of the tracks of an MP4/MOV file given as bytes; {} when it cannot be read."""
    out = {}
    try:
        for kind, s, e in _boxes(data, 0, len(data)):
            if kind != "moov":
                continue
            for k2, s2, e2 in _boxes(data, s, e):
                if k2 != "trak":
                    continue
                scale = dur = handler = None
                for k3, s3, e3 in _boxes(data, s2, e2):
                    if k3 != "mdia":
                        continue
                    for k4, s4, e4 in _boxes(data, s3, e3):
                        if k4 == "mdhd":
                            if data[s4] == 0:
                                scale, dur = struct.unpack(">II", data[s4 + 12:s4 + 20])
                            else:
                                scale, dur = struct.unpack(">IQ", data[s4 + 20:s4 + 32])
                        elif k4 == "hdlr":
                            handler = data[s4 + 8:s4 + 12].decode("latin1")
                if handler and scale and dur:
                    out.setdefault(handler, round(dur / scale, 4))
    except (struct.error, IndexError):
        return {}
    return out


# имена, которыми описание лежит в файле: яблочный стиль (©cmt) и ключи ComfyUI (mdta)
_KEYS = {"\xa9cmt": "comment", "desc": "comment", "\xa9nam": "title", "\xa9day": "date", "\xa9aut": "author",
         "\xa9too": "encoder", "\xa9lyr": "prompt"}


def _spans(b, needle, s, e):
    """Где внутри куска лежит коробка с таким именем: ищем по байтам, потому что описание
    прячут то в moov, то в moov/udta, то в moov/udta/meta, и обходить всё дерево надёжнее,
    чем угадывать глубину."""
    out, i = [], b.find(needle, s, e)
    while i >= 4:
        st = i - 4
        try:
            size = struct.unpack(">I", b[st:st + 4])[0]
        except struct.error:
            break
        if 8 <= size <= e - st:
            out.append((st + 8, st + size))
        i = b.find(needle, i + 4, e)
    return out


def _key_names(b, s, e):
    """Имена ключей в списке keys: ComfyUI и QuickTime помечают значения номерами, а имена
    держат отдельно. Порядок здесь тот же, что и номера в ilst."""
    out = []
    for m in re.finditer(rb"(?:mdta|usr )([ -~]{2,40})", b[s:e]):
        name = m.group(1).decode("latin1").strip("\x00 ").strip()
        if name:
            out.append(name)
    return out


def _ilst(b, s, e, names):
    """Строки описания из ilst: каждое значение лежит в атоме со своим именем, текст - в потомке data."""
    out = {}
    for kind, s2, e2 in _boxes(b, s, e):
        name = _KEYS.get(kind)
        if name is None and names:
            if kind.startswith("key#"):
                tail = kind[4:]
            elif len(kind) == 4 and not kind.isprintable():
                # QuickTime и ComfyUI пишут имя свойства не буквами, а номером ключа четырьмя байтами
                tail = str(int.from_bytes(kind.encode("latin1"), "big"))
            else:
                tail = ""
            if tail.isdigit() and 1 <= int(tail) <= len(names):
                name = names[int(tail) - 1]
        if not name:
            continue
        for k3, s3, e3 in _boxes(b, s2, e2):
            if k3 == "data" and e3 - s3 >= 8:
                # заголовок data: версия с флагами и четыре зарезервированных байта, дальше текст
                text = b[s3 + 8:e3].decode("utf-8", "replace").strip("\x00 ")
                if text:
                    out.setdefault(name, text)
    return out


def tag(data):
    """Что записано в файле: {'comment': ..., 'prompt': ...}; {} когда описания нет."""
    out = {}
    try:
        spans = [(s, e) for kind, s, e in _boxes(data, 0, len(data)) if kind == "moov"] + _moovs(data)
        for s, e in spans:
            names = []
            for ks, ke in _spans(data, b"keys", s, e):
                names.extend(_key_names(data, ks, ke))
            for iss, ise in _spans(data, b"ilst", s, e):
                out.update(_ilst(data, iss, ise, names))
    except (struct.error, IndexError):
        return out
    return out


def _moovs(b):
    """Места, где в произвольном куске файла стоит коробка описания треков.

    Разные сборщики кладут её то в начало, то в конец, поэтому хвост файла приходится
    уметь читать с любого байта, а не только с начала коробки."""
    out, i = [], b.find(b"moov")
    while i >= 4:
        s = i - 4
        try:
            size = struct.unpack(">I", b[s:s + 4])[0]
        except struct.error:
            break
        if 8 <= size <= len(b) - s:
            out.append((s + 8, s + size))
        i = b.find(b"moov", i + 4)
    return out


def tag_of(path, edge=1 << 20):
    """Теги файла по имени. Описание треков стоит то в начале файла, то в конце, поэтому
    читаем оба края: одного не хватает ровно тогда, когда файл записал другой сборщик."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            out = tag(f.read(edge))
            if not out and size > edge:
                f.seek(max(0, size - edge))
                out = tag(f.read())
        return out
    except OSError:
        return {}
