"""Хранилища, которые переживают закрытие программы: очередь заданий на диске,
список Библиотеки и голоса раздела Voice Lab."""

import json
import uuid
from datetime import datetime
from pathlib import Path


class JobStore(dict):
    """prompt_id -> job; every change is written to disk so a closed program or a power cut does not lose the queue."""

    def __init__(self, on_change):
        super().__init__()
        self.on_change = on_change

    def __setitem__(self, k, v):
        super().__setitem__(k, v)
        self.on_change()

    def pop(self, k, *a):
        r = super().pop(k, *a)
        self.on_change()
        return r


class Library:
    def __init__(self, path):
        self.path = path
        self.items = []
        if path.exists():
            self.items = json.loads(path.read_text(encoding="utf-8"))

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def get(self, item_id):
        return next((x for x in self.items if x["id"] == item_id), None)

    def add(self, item):
        self.items.insert(0, item)
        self.save()

    def remove(self, item_id):
        self.items = [x for x in self.items if x["id"] != item_id]
        self.save()


KEEP_TAKES = 60   # сколько свежих немеченых вариантов держать на диске


class VoiceStore:
    """Голоса раздела Voice Lab.

    Два списка в одной папке: сохранённые голоса (короткий образец с названием - это «память голосов»,
    из неё берут голос, чтобы озвучить любой текст) и последние варианты озвучки (у каждого можно
    спросить, какими настройками он сделан, чтобы повторить). Файлы живут рядом с индексами:
    voices/ - образцы, out/ - готовые звуки.
    """

    def __init__(self, root):
        self.root = Path(root)
        self.vdir, self.odir = self.root / "voices", self.root / "out"
        self.index = self.root / "voices.json"
        self.takes_file = self.root / "takes.json"
        try:
            self.items = json.loads(self.index.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.items = []
        if not isinstance(self.items, list):
            self.items = []
        self.takes = self._load_takes()

    def ready(self):
        """Папки появляются, когда в них правда что-то кладут, а не при каждом запуске программы."""
        for d in (self.vdir, self.odir):
            d.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _dump(path, data):
        """Запись списка через временный файл: обрыв посередине не оставляет полсписка."""
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)

    def save(self):
        self._dump(self.index, self.items)

    def get(self, vid):
        return next((x for x in self.items if x["id"] == vid), None)

    def path(self, vid):
        """Файл сохранённого голоса, если он ещё на месте."""
        it = self.get(vid)
        f = self.vdir / it["file"] if it else None
        return f if f and f.is_file() else None

    def out_path(self, oid):
        """Файл варианта озвучки. Имя берём из адреса, поэтому путь наружу отсюда не уходит."""
        f = self.odir / Path(str(oid)).name
        return f if f.is_file() else None

    def public(self, it):
        return {**it, "url": f"/api/voice/saved/{it['id']}/file"}

    # ---------- варианты озвучки ----------

    def _load_takes(self):
        try:
            d = json.loads(self.takes_file.read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {"next": 1, "items": []}
        except (OSError, ValueError):
            return {"next": 1, "items": []}

    def save_takes(self):
        self._dump(self.takes_file, self.takes)

    def take_public(self, it):
        return {**it, "url": f"/api/voice/out/{it['id']}"}

    def take(self, oid):
        return next((x for x in self.takes["items"] if x["id"] == oid), None)

    def live_takes(self):
        """Варианты, у которых файл ещё цел (папку с результатами могли почистить и без нас)."""
        return [self.take_public(x) for x in reversed(self.takes["items"]) if (self.odir / x["id"]).is_file()]

    def add_take(self, data, ext, meta):
        """Сложить звук в out/ и записать его в список: имя «Голос N», текст и настройки, чтобы повторить."""
        self.ready()
        oid = uuid.uuid4().hex[:10] + (ext if str(ext).startswith(".") else "." + str(ext or "mp3"))
        (self.odir / oid).write_bytes(data)
        n = int(self.takes.get("next", 1))
        self.takes["next"] = n + 1
        take = {"id": oid, "num": n, "name": f"Голос {n}", "star": False,
                "date": datetime.now().isoformat(timespec="seconds"), **meta}
        self.takes["items"].append(take)
        keep, drop = [], []
        for it in reversed(self.takes["items"]):
            (keep if it.get("star") or sum(1 for k in keep if not k.get("star")) < KEEP_TAKES else drop).append(it)
        for it in drop:
            (self.odir / it["id"]).unlink(missing_ok=True)
        self.takes["items"] = list(reversed(keep))
        self.save_takes()
        return self.take_public(take)
