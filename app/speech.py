"""Speech to text for the agent: lyrics from a lipsync audio and voice input from the microphone.

Uses whisper.cpp (CPU build, ~10 MB) with the multilingual "small" model (~190 MB). Both files are
downloaded by the app next to the agent's model; nothing is installed system-wide.
"""

import asyncio
import re
import subprocess
import tempfile
from pathlib import Path

import engine

WHISPER_BUILD = "b5454"
WHISPER_URL = f"https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_BUILD}/whisper-bin-x64.zip"
WHISPER_ZIP_SIZE = 9e6
MODEL_FILE = "ggml-small-q5_1.bin"
MODEL_URL = f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{MODEL_FILE}"
MODEL_SIZE = 190e6

LANG_NAMES = {"ru": "Russian", "en": "English", "uk": "Ukrainian", "de": "German", "fr": "French", "es": "Spanish",
              "it": "Italian", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese", "ko": "Korean",
              "tr": "Turkish", "pl": "Polish", "ar": "Arabic", "hi": "Hindi"}
NOISE = re.compile(r"[\[\(][^\]\)]{0,40}[\]\)]")  # [BLANK_AUDIO], (music), [Music] ...


# multilingual models only (".en" ones cannot do Russian), best first
MODEL_PREFERENCE = ["large-v3-turbo", "large-v3", "large-v2", "large", "medium", "small", "base", "tiny"]


# `small` mangles singing - it is exactly where a little model gives up. This file hears lyrics far
# better, runs on the same CPU build, and the app starts using it by itself: the finder below always
# takes the best ggml file it can see.
BETTER_MODEL = "ggml-large-v3-turbo-q5_0.bin"
BETTER_URL = f"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{BETTER_MODEL}"
BETTER_SIZE = 574e6


def better_state(root, custom_dir=None):
    """Is the accurate model here, and where would it have to go."""
    dst = Path(root) / "whisper" / "models" / BETTER_MODEL
    if dst.exists():
        return {"present": True, "name": BETTER_MODEL, "size": dst.stat().st_size, "path": str(dst),
                "custom": bool(custom_dir)}
    return {"present": False, "name": BETTER_MODEL, "size": int(BETTER_SIZE), "custom": bool(custom_dir)}


async def install_better(installer, root):
    dst = Path(root) / "whisper" / "models" / BETTER_MODEL
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return {"ok": True, "name": dst.name, "already": True}
    await installer.download(BETTER_URL, dst, "agent", f"распознавание речи: {BETTER_MODEL}", BETTER_SIZE)
    return {"ok": True, "name": dst.name}


def _find_exe(folder):
    folder = Path(folder)
    if not folder.is_dir():
        return None
    hits = [p for p in folder.rglob("whisper-cli.exe") if len(p.relative_to(folder).parts) <= 5]
    return hits[0] if hits else None


def _model_list(folder):
    """Все пригодные модельные файлы, лучшие первым (те же правила, что у _find_model)."""
    folder = Path(folder)
    if not folder.is_dir():
        return []
    files = [p for p in folder.rglob("ggml-*.bin") if len(p.relative_to(folder).parts) <= 4
             and ".en" not in p.name and "silero" not in p.name.lower() and "vad" not in p.name.lower()
             and not p.name.endswith(("-encoder.bin",))]

    def rank(p):
        n = p.name.lower()
        return next((i for i, k in enumerate(MODEL_PREFERENCE) if k in n), len(MODEL_PREFERENCE)), p.stat().st_size
    return sorted(files, key=rank)


def _find_model(folder):
    files = _model_list(folder)
    return files[0] if files else None


def locate(root, custom_dir=None):
    """Where whisper is: the user's own folder first, then the app's own one. Returns a status dict."""
    own = Path(root) / "whisper"
    exe = (custom_dir and _find_exe(custom_dir)) or _find_exe(own / "bin")
    model = (custom_dir and _find_model(custom_dir)) or _find_model(own / "models")
    missing = ([] if exe else ["whisper-cli.exe"]) + ([] if model else ["модель ggml-*.bin"])
    return {"ready": not missing, "exe": exe, "model": model, "missing": missing, "custom": custom_dir or None}


def ready(root, custom_dir=None):
    return locate(root, custom_dir)["ready"]


async def install(installer, root, custom_dir=None):
    """Download whatever of whisper.cpp / its model is missing (the user's own files are never touched)."""
    import zipfile
    root = Path(root)
    found = locate(root, custom_dir)
    if not found["exe"]:
        zpath = root / "downloads" / f"whisper-{WHISPER_BUILD}.zip"
        await installer.download(WHISPER_URL, zpath, "agent", "распознавание речи (программа)", WHISPER_ZIP_SIZE)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(root / "whisper" / "bin")
        zpath.unlink(missing_ok=True)
    if not found["model"]:
        await installer.download(MODEL_URL, root / "whisper" / "models" / MODEL_FILE, "agent",
                                 f"распознавание речи: {MODEL_FILE}", MODEL_SIZE)


def _run(root, wav_bytes, lang, custom_dir=None, model=None):
    found = locate(root, custom_dir)
    exe = found["exe"]
    model = Path(model) if model else found["model"]
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "in.wav"
        wav.write_bytes(wav_bytes)
        args = [str(exe), "-m", str(model), "-f", str(wav), "-l", lang or "auto", "-nt", "-t", "6"]
        r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=300, creationflags=engine.CREATE_NO_WINDOW)
    if r.returncode != 0:
        raise RuntimeError("Не удалось распознать речь: " + (r.stderr.strip().splitlines() or ["ошибка"])[-1])
    m = re.search(r"auto-detected language:\s*([a-z]{2,3})", r.stderr)
    code = m.group(1) if m else (lang if lang and lang != "auto" else "")
    text = " ".join(line.strip() for line in r.stdout.splitlines() if line.strip())
    text = re.sub(r"\s+", " ", NOISE.sub("", text)).strip()
    return text, code


def _seconds(wav_bytes):
    """Длительность присланного WAV из заголовка: нужна, чтобы понять, сколько слов
    человек имел право услышать на этом звуке."""
    try:
        import struct
        if wav_bytes[:4] != b"RIFF" or wav_bytes[8:12] != b"WAVE":
            return 0.0
        i, sr, bits, ch, data = 12, 0, 0, 0, 0
        while i + 8 <= len(wav_bytes):
            cid = wav_bytes[i:i + 4]
            sz = struct.unpack("<I", wav_bytes[i + 4:i + 8])[0]
            if cid == b"fmt " and sz >= 16:
                ch = struct.unpack("<H", wav_bytes[i + 10:i + 12])[0]
                sr = struct.unpack("<I", wav_bytes[i + 12:i + 16])[0]
                bits = struct.unpack("<H", wav_bytes[i + 22:i + 24])[0]
            elif cid == b"data":
                data = sz
                break
            i += 8 + sz + (sz & 1)
        if not sr or not ch or not bits:
            return 0.0
        return data / float(sr * ch * (bits // 8))
    except Exception:
        return 0.0


async def transcribe(root, wav_bytes, lang="auto", custom_dir=None):
    """Returns (text, language_code, language_name_for_prompt)."""
    text, code = await asyncio.to_thread(_run, root, wav_bytes, lang, custom_dir)
    secs = _seconds(wav_bytes)
    # Длинный звук и пара слов - это не «там петь нечего», а модель, которая на пении
    # сдалась: на одной и той же песне большая модель выдавала «я бы», а маленькая
    # слышала весь припев. Молча оставить человека с двумя словами нельзя, поэтому
    # слушаем этим же звуком второй моделью, которая есть на диске, и берём ответ
    # длиннее. Ничего не выдумываем: берём то, что одна из моделей правда услышала.
    if secs >= 4 and len(text.split()) <= 3:
        try:
            found = locate(root, custom_dir)
            best = Path(found["model"]) if found.get("model") else None
            alt = next((p for p in _model_list(best.parent) if p != best), None) if best else None
            if alt is not None:
                t2, c2 = await asyncio.to_thread(_run, root, wav_bytes, lang, custom_dir, alt)
                if len(t2.split()) > len(text.split()):
                    text, code = t2, c2 or code
        except Exception:
            pass
    return text, code, LANG_NAMES.get(code, code.upper() if code else "")
