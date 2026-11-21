# PyInstaller spec: python -m PyInstaller app/build/h3studio.spec --distpath app/build/dist --workpath app/build/work
from pathlib import Path

APP = Path(SPECPATH).parent

a = Analysis(
    [str(APP / "main.py")],
    pathex=[str(APP)],
    # папки интерфейса едут целиком: страница разбита на css/ и js/, а PyInstaller по
    # одному файлу их бы не забрал и программа поставилась бы без стилей и скриптов
    datas=[(str(APP / "ui" / "index.html"), "ui"), (str(APP / "ui" / "css"), "ui/css"), (str(APP / "ui" / "js"), "ui/js"),
           (str(APP / "ui" / "previews"), "ui/previews"), (str(APP / "skills"), "skills"), (str(APP / "bin"), "bin")],
    hiddenimports=["webview.platforms.edgechromium", "webview.platforms.winforms", "clr", "certifi"],
    # the builder and its friends must not ride along: the program imports none of them,
    # and a fresh PyInstaller otherwise drags setuptools and pydantic into the download
    excludes=["tkinter", "matplotlib", "numpy", "PIL", "pandas", "scipy", "IPython",
              "setuptools", "pkg_resources", "pydantic", "pydantic_core", "PyInstaller", "pip"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Kadr",
    icon=str(APP / "build" / "icon.ico"),
    console=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Kadr")
