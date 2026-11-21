"""Одна строка в app.log: когда на экране только «не отвечает», по этому журналу и
видно, где встало."""

from paths import DATA_DIR
import time


def applog(msg):
    """One line in the data folder's app.log. When the screen can only say "it does not answer",
       this is what tells where it stuck. Kept small: the last few hundred lines."""
    try:
        p = DATA_DIR / "app.log"
        if p.exists() and p.stat().st_size > 400_000:
            p.write_text("\n".join(p.read_text(encoding="utf-8", errors="replace").splitlines()[-600:]), encoding="utf-8")
        with p.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%d.%m %H:%M:%S ") + msg + "\n")
    except OSError:
        pass
