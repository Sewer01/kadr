"""Ответы на два вопроса: «сколько ждать» и «не начать бы это впустую».

Придуманных констант здесь нет. Программа копит только собственные замеры: сколько шло
каждое задание в каждом режиме и при скольких свободных гигабайтах оно падало на нехватке
памяти. Прогноз - медиана похожих прогонов на этой машине, а не обещание из инструкции.
Отказ тоже строится на опыте: если этот режим уже падал, когда свободно было столько же
или больше, начинать его при нынешнем месте незачем - работа встанет на том же месте.

Файл живёт в папке данных программы и остаётся между запусками. Его можно удалить:
программа просто снова начнёт учиться с нуля.
"""

import json
import statistics
from pathlib import Path

KEEP = 400          # сколько последних замеров хранить: больше уже не уточняет, а тормозит
MARGIN = 0.4        # ГБ запаса, который просим сверх того, на чём уже падали


def _load(path):
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"runs": [], "fails": []}
    if not isinstance(d, dict):
        return {"runs": [], "fails": []}
    d.setdefault("runs", [])
    d.setdefault("fails", [])
    return d


def _save(path, data):
    path = Path(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass       # замеры не стоят того, чтобы из-за них ронять генерацию


def record(path, mode, secs, *, quality="", sec=0, res="", ok=True, free=None, reason=""):
    """Запомнить прогон: сколько он шёл, или при каком свободном месте он упал.

    secs - секунды работы, а не ожидания в очереди: очередь зависит от того, сколько
    заданий поставили перед этим, и прогнозу она только мешает.
    """
    mode = str(mode or "")
    if not mode:
        return
    data = _load(path)
    if ok:
        if not secs or secs <= 0 or secs > 24 * 3600:
            return
        data["runs"].append({"mode": mode, "secs": round(float(secs), 1), "quality": str(quality or ""),
                             "sec": float(sec or 0), "res": str(res or "")})
        data["runs"] = data["runs"][-KEEP:]
    else:
        if free is None:
            return
        data["fails"].append({"mode": mode, "free": round(float(free), 2), "quality": str(quality or ""),
                              "sec": float(sec or 0), "reason": str(reason or "")[:160]})
        data["fails"] = data["fails"][-80:]
    _save(path, data)


def _alike(runs, mode, quality, res):
    """Похожие прогоны: тот же режим; если известно качество или размер - и они."""
    exact = [r for r in runs if r.get("mode") == mode
             and (not quality or not r.get("quality") or r.get("quality") == quality)
             and (not res or not r.get("res") or r.get("res") == res)]
    if len(exact) >= 3:
        return exact
    return [r for r in runs if r.get("mode") == mode]


def estimate(path, mode, *, quality="", sec=0, res=""):
    """Сколько секунд это обычно занимает здесь же. None - когда сказать нечего.

    Длительность ролика входит множителем: снятые пятисекундные прогоны дают и прогноз для
    десятисекундного, иначе программа молчала бы до третьего одинакового запуска.
    """
    runs = _load(path).get("runs") or []
    same = _alike(runs, mode, quality, res)
    if len(same) < 2:
        return None
    base = [r for r in same if (r.get("sec") or 0) > 0 and (r.get("secs") or 0) > 0]
    if sec and len(base) >= 2:
        per = statistics.median([r["secs"] / r["sec"] for r in base])
        secs = round(per * float(sec))
    else:
        secs = round(statistics.median([r["secs"] for r in same]))
    if secs <= 0:
        return None
    return {"secs": secs, "samples": len(same), "spread": _spread(same, sec)}


def _spread(same, sec):
    """Насколько разные прогоны одного и того же получались по времени: честный разброс."""
    vals = [r["secs"] / r["sec"] * sec if (sec and (r.get("sec") or 0) > 0) else r.get("secs", 0) for r in same]
    vals = [v for v in vals if v > 0]
    if len(vals) < 3:
        return 0
    lo, hi = min(vals), max(vals)
    med = statistics.median(vals) or 1
    return round(max(hi - med, med - lo) / med * 100)


def gate(path, mode, free, *, quality="", sec=0):
    """Стоит ли начинать: None - можно, иначе почему не стоит.

    Основание одно: этот же режим уже падал на нехватке памяти, и свободного места сейчас
    не больше, чем было в тот раз. Выдумывать, сколько «должно» хватить, мы не будем.
    """
    if free is None:
        return None
    fails = [f for f in (_load(path).get("fails") or []) if f.get("mode") == mode]
    if not fails:
        return None
    need = max(f.get("free") or 0 for f in fails)
    if float(free) + MARGIN < need:
        return {"have": round(float(free), 1), "need": round(need, 1),
                "reason": next((f.get("reason") for f in fails if (f.get("free") or 0) == need), "")}
    return None


def human(secs):
    """Время человеческими словами: 40 с, 3 мин 20 с, 1 ч 5 мин."""
    s = int(round(secs or 0))
    if s < 60:
        return f"{s} с"
    m, r = divmod(s, 60)
    if m < 60:
        return f"{m} мин" + (f" {r} с" if r and r < 50 else "")
    h, m = divmod(m, 60)
    return f"{h} ч" + (f" {m} мин" if m else "")
