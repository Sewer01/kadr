"""Карточки актёров: персонаж, предмет, транспорт или локация, которые повторяются из ролика в ролик.

Карточка хранит до девяти фото (каждое можно включить или выключить), необязательный образец
голоса и короткий текст - что это и что в нём сохранять. Список живёт в DATA_DIR/actors.json,
файлы карточек в DATA_DIR/actors/<id>/. Режимы берут включённые фото отмеченных карточек и
меняют @имя в тексте на тег картинки с одной строкой определения; меняет текст интерфейс, а
здесь только хранение.
"""

from aiohttp import web
from datetime import datetime
from pathlib import Path
from paths import DATA_DIR
import json
import re
import shutil
import uuid

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
AUD_EXT = {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".opus"}
TYPES = {"character": "Персонаж", "vehicle": "Транспорт", "object": "Предмет", "location": "Локация"}
MAX_IMAGES = 9
MAX_UPLOAD = 60 * 1024 * 1024
NAME_LEN = 60
TEXT_LEN = 600


def _err(text, status=400):
    return web.json_response({"error": text}, status=status)


def _clean(value, limit):
    return " ".join(str(value or "").split())[:limit]


def _token(name):
    """Имя карточки в тексте: то, что человек печатает после значка @."""
    return re.sub(r"\s+", "_", str(name or "").strip())


def actors_dir():
    """Папка файлов карточек."""
    return DATA_DIR / "actors"


def actors_index():
    """Список карточек."""
    return DATA_DIR / "actors.json"


class ActorsMixin:
    """Область «actors»: карточки актёров, их фото и голоса."""

    def _actors_read(self):
        """Список карточек. Битый список не перезаписывается молча: копия остаётся рядом."""
        f = actors_index()
        if not f.exists():
            return []
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            try:
                shutil.copy2(f, f.with_name("actors.broken.json"))
            except OSError:
                pass
            return []
        return data if isinstance(data, list) else []

    def _actors_write(self, items):
        f = actors_index()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(f)

    def _actors_public(self, item):
        """Карточка для интерфейса: у фото и голоса появляется адрес, по которому их отдают."""
        out = dict(item)
        base = f"/api/actors/{item['id']}/file/"
        out["images"] = [{**i, "url": base + i["file"]} for i in item.get("images", [])]
        out["voice"] = ({**item["voice"], "url": base + item["voice"]["file"]} if item.get("voice") else None)
        out["token"] = _token(item.get("name"))
        return out

    async def h_actors_list(self, _req):
        return web.json_response([self._actors_public(x) for x in self._actors_read()])

    async def h_actors_file(self, req):
        """Один файл карточки: фото или образец голоса."""
        aid = re.sub(r"[^a-z0-9]", "", req.match_info["id"])[:40]
        name = Path(req.match_info["name"]).name
        base = (actors_dir() / aid).resolve()
        path = (base / name).resolve()
        if not str(path).startswith(str(base)) or not path.is_file():
            return _err("Файл карточки не найден", 404)
        kind = "audio" if path.suffix.lower() in AUD_EXT else "image"
        return web.FileResponse(path)

    async def h_actors_save(self, req):
        """Создание или правка карточки: поля приходят строками, файлы - рядом с ними."""
        form = await req.post()
        items = self._actors_read()
        aid = re.sub(r"[^a-z0-9]", "", str(form.get("id") or ""))[:40]
        # карточка берётся ИЗ ЭТОГО же списка, а не из нового чтения: правка копии
        # из другого списка в файл не попала бы - проба на это и поймала
        item = next((x for x in items if x.get("id") == aid), None) if aid else None
        if aid and not item:
            return _err("Карточка уже не найдена: обновите список", 404)
        name = _clean(form.get("name"), NAME_LEN)
        if not name:
            return _err("Назовите карточку: по имени вы будете звать её в тексте")
        kind = str(form.get("type") or "character")
        if kind not in TYPES:
            return _err("Не знаю такой вид карточки")
        same = [x for x in items if _token(x.get("name")) == _token(name) and x.get("id") != (item or {}).get("id")]
        if same:
            return _err("Карточка с таким именем уже есть: придумайте другое имя")

        if item is None:
            aid = uuid.uuid4().hex[:10]
            item = {"id": aid, "name": name, "type": kind, "text": "", "images": [], "voice": None,
                    "created": datetime.now().isoformat(timespec="seconds")}
            items.append(item)
        item["name"], item["type"] = name, kind
        item["text"] = _clean(form.get("text"), TEXT_LEN)

        folder = actors_dir() / aid
        got = [f for f in form.getall("images", []) if hasattr(f, "filename") and f.filename]
        if got:
            if len(got) > MAX_IMAGES:
                return _err(f"Больше {MAX_IMAGES} фото в одной карточке не нужно")
            bad = [f for f in got if Path(f.filename).suffix.lower() not in IMG_EXT]
            if bad:
                return _err("Карточка принимает картинки: " + ", ".join(Path(b.filename).name for b in bad))
            if item.get("images"):
                shutil.rmtree(folder, ignore_errors=True)
            folder.mkdir(parents=True, exist_ok=True)
            keep = []
            for n, up in enumerate(got, 1):
                data = up.file.read()
                if len(data) > MAX_UPLOAD:
                    return _err(f"Файл {Path(up.filename).name} слишком большой")
                fname = f"{n}{Path(up.filename).suffix.lower()}"
                (folder / fname).write_bytes(data)
                keep.append({"file": fname, "name": _clean(Path(up.filename).name, 60), "on": True})
            item["images"] = keep
        else:
            on = form.get("on")
            if on:
                try:
                    flags = json.loads(on)
                except ValueError:
                    return _err("Не смог прочитать, какие фото включены")
                for i, img in enumerate(item.get("images", [])):
                    if i < len(flags):
                        img["on"] = bool(flags[i])

        voice = form.get("voice")
        if hasattr(voice, "filename") and voice.filename:
            if Path(voice.filename).suffix.lower() not in AUD_EXT:
                return _err("Образец голоса - это аудиофайл")
            data = voice.file.read()
            if len(data) > MAX_UPLOAD:
                return _err("Образец голоса слишком большой")
            folder.mkdir(parents=True, exist_ok=True)
            fname = "voice" + Path(voice.filename).suffix.lower()
            (folder / fname).write_bytes(data)
            if item.get("voice") and item["voice"].get("file") not in (fname,):
                (folder / item["voice"]["file"]).unlink(missing_ok=True)
            item["voice"] = {"file": fname, "name": _clean(Path(voice.filename).name, 60)}
        elif str(form.get("drop_voice") or "") == "1" and item.get("voice"):
            (folder / item["voice"]["file"]).unlink(missing_ok=True)
            item["voice"] = None

        item["updated"] = datetime.now().isoformat(timespec="seconds")
        self._actors_write(items)
        return web.json_response(self._actors_public(item))

    async def h_actors_delete(self, req):
        aid = re.sub(r"[^a-z0-9]", "", req.match_info["id"])[:40]
        items = self._actors_read()
        rest = [x for x in items if x.get("id") != aid]
        if len(rest) == len(items):
            return _err("Карточка уже удалена", 404)
        shutil.rmtree(actors_dir() / aid, ignore_errors=True)
        self._actors_write(rest)
        return web.json_response({"ok": True})
