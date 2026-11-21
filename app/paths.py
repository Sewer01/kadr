"""Пути, файлы и адреса приложения: откуда берутся папки данных, файл библиотеки,
очередь, сохранённые сцены и ключ сеанса. Значения задаются один раз здесь, а не в обработчиках:
установленное приложение держит код в сборке, а данные - рядом со своим exe."""

from pathlib import Path
import os
import sys
import uuid


# Immers.Cloud: the author's referral link goes here (a discount for the new user, a bonus for the author). Empty: the plain site is opened.
RENT_REFERRAL = ""   # our build opens the plain site: no one else's referral code inside a program we hand out


RENT_SITE = "https://immers.cloud/"


# frozen builds keep code inside the bundle but user data next to the exe
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


HOME = Path(sys.executable).parent if getattr(sys, "frozen", False) else ROOT


UI_DIR = ROOT / "ui"


DATA_DIR = Path(os.environ.get("H3STUDIO_DATA", HOME / "data"))


LONG_DIR = DATA_DIR / "long"   # saved scene states of the long video made scene by scene


REF_DIR = DATA_DIR / "refs"    # copies of the pictures a result was made of, one folder per calculation


LIBRARY_FILE = DATA_DIR / "library.json"


TIMINGS = DATA_DIR / "timings.json"   # чем программа платит на вопрос «сколько ждать» и «не упадёт ли»


QUEUE_FILE = DATA_DIR / "queue.json"


WORKFLOWS_DIR = DATA_DIR / "workflows"


CLIENT_ID = "h3studio-" + uuid.uuid4().hex[:8]
