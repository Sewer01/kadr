"""Разбор полей формы: размер с округлением под шаг модели, сила LoRA, уровень
музыки с ползунка, имя видеокарты из строки ComfyUI, годность идентификатора чата."""

import workflows as wf


def round_size(form, step=32, low=256, high=2048, max_px=2200000):
    """The user's own width/height from the form, rounded to the model's step (None when not given)."""
    w, h = str(form.get("width", "")), str(form.get("height", ""))
    if not (w.isdigit() and h.isdigit()):
        return None
    w, h = int(w), int(h)
    if min(w, h) < 64:
        return None
    k = (max_px / (w * h)) ** 0.5 if w * h > max_px else 1.0
    r = lambda v: min(high, max(low, round(v * k / step) * step))
    return r(w), r(h)


def lora_strength(form, key, default):
    """Strength sent by the UI: a number when the LoRA is on, "off" when off, nothing -> the default (None = off)."""
    v = form.get(f"lora_{key}")
    if v in (None, ""):
        return default
    if v == "off":
        return None
    try:
        return float(v)
    except ValueError:
        return default


def bed_level(form):
    """Уровень музыки из формы: целые децибелы с ползунка, в его границах. Пустое или чужое значение -
    прежний захардкоженный -10, чтобы старая страница и чужой запрос считали как считали."""
    try:
        v = int(str(form.get("bed_db", "")).strip())
    except (TypeError, ValueError):
        return wf.MUSIC_BG_DB
    return max(wf.BED_DB_MIN, min(wf.BED_DB_MAX, v))


def re_chat_id(cid):
    return cid.isalnum() and 4 <= len(cid) <= 40


def gpu_name(raw):
    # "cuda:0 NVIDIA GeForce RTX 4060 Ti : cudaMallocAsync" -> "NVIDIA GeForce RTX 4060 Ti"
    name = raw.split(" : ")[0]
    return name.split(" ", 1)[1] if name.startswith("cuda:") and " " in name else name
