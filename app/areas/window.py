"""Окно программы: страница с ключом сеанса, буфер
    обмена и просьба второй копии показать своё окно. Методы перенесены из app/server.py без
    правок."""

from aiohttp import web
from paths import UI_DIR
import asyncio
import clipboard


class WindowMixin:
    """Методы области «window»."""

    async def h_clipboard(self, _req):
        """Text from the Windows clipboard (the web view may refuse to let the page read it)."""
        text = ""
        try:
            import ctypes
            u, k = ctypes.windll.user32, ctypes.windll.kernel32
            u.GetClipboardData.restype = ctypes.c_void_p
            k.GlobalLock.restype = ctypes.c_void_p
            k.GlobalLock.argtypes = [ctypes.c_void_p]
            k.GlobalUnlock.argtypes = [ctypes.c_void_p]
            if u.OpenClipboard(0):
                try:
                    h = u.GetClipboardData(13)  # CF_UNICODETEXT
                    if h:
                        p = k.GlobalLock(h)
                        if p:
                            text = ctypes.wstring_at(p)
                            k.GlobalUnlock(h)
                finally:
                    u.CloseClipboard()
        except Exception:
            pass
        return web.json_response({"text": text})

    @staticmethod
    def focus_own_window():
        """Bring this program's window forward - a second copy of the program asks us to do it."""
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        me = ctypes.windll.kernel32.GetCurrentProcessId()
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def pick(hwnd, _lparam):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value != me or not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n < 1:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            found.append((hwnd, buf.value))
            return True

        user32.EnumWindows(pick, 0)
        if not found:
            return False
        hwnd = next((h for h, title in found if "Minimax" in title or "H3" in title), found[0][0])
        user32.ShowWindow(hwnd, 9)              # SW_RESTORE: it may sit minimized
        user32.BringWindowToTop(hwnd)
        if user32.SetForegroundWindow(hwnd):
            return True

        class Flash(ctypes.Structure):          # Windows does not always hand the focus to a background process
            _fields_ = [("cbSize", wintypes.UINT), ("hWnd", wintypes.HWND), ("dwFlags", wintypes.UINT),
                        ("uTimeout", wintypes.UINT), ("dwReserved", ctypes.c_size_t)]

        user32.FlashWindowEx(ctypes.byref(Flash(ctypes.sizeof(Flash), hwnd, 3, 0, 0)))
        return True

    async def h_clipboard_has_image(self, _req):
        """Whether there is a picture to paste: asks Windows about the formats, cheap and without helpers."""
        return web.json_response({"have": await asyncio.to_thread(clipboard.has_picture)})

    async def h_clipboard_image(self, req):
        """GET: the clipboard picture (404 when there is none). POST: put this PNG on the clipboard."""
        if req.method == "POST":
            data = await req.read()
            if not data.startswith(clipboard.PNG_SIGNATURE) or len(data) > 40_000_000:
                return web.json_response({"error": "Нужна картинка в формате PNG"}, status=400)
            if await asyncio.to_thread(clipboard.set_picture, data):
                return web.json_response({"ok": True})
            return web.json_response({"error": "Не удалось положить картинку в буфер обмена"}, status=500)
        picture = await asyncio.to_thread(clipboard.picture)
        if not picture:
            return web.json_response({"error": "В буфере обмена нет картинки"}, status=404)
        data, mime = picture
        return web.Response(body=data, content_type=mime, headers={"Cache-Control": "no-store"})

    async def h_focus(self, _req):
        """A second copy knocked: show the window the user is really working in."""
        return web.json_response({"ok": await asyncio.to_thread(self.focus_own_window)})

    async def h_index(self, _req):
        """The interface, with the key of this session inside it.

        The page is kept in memory only as long as the file on disk does not change: while the
        person's window stays open, a fixed interface arrives on the next reload, not after a
        restart. A page that cannot be read (mid-copy, locked) leaves the good one in place."""
        f = UI_DIR / "index.html"
        try:
            stamp = f.stat().st_mtime
        except OSError:
            stamp = 0.0
        if self._index is None or stamp != self._index_at:
            try:
                html = f.read_text(encoding="utf-8")
            except OSError:
                html = ""
            if html:
                self._index = html.replace("</head>", f'<script>window.__H3_TOKEN="{self.token}";</script></head>', 1)
                self._index_at = stamp
        return web.Response(text=self._index, content_type="text/html",
                            headers={"Cache-Control": "no-store",
                                     "Set-Cookie": f"h3token={self.token}; Path=/; SameSite=Lax"})
