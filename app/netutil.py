"""Адрес ComfyUI и его ответы: какой адрес вообще допустим, свой ли это компьютер,
ssl-контекст и человекочитаемый текст отказа."""

import ipaddress
import urllib.parse


def _ssl_context():
    # Windows store + the bundled certifi list: helps PCs with an outdated root-certificate store
    import ssl
    ctx = ssl.create_default_context()
    try:
        import certifi
        ctx.load_verify_locations(cafile=certifi.where())
    except Exception:
        pass
    return ctx


def clean_comfy_url(raw):
    """The address of the user's own ComfyUI as a plain http(s) URL, or (None, why it is not one).

    Whatever is set here receives the prompts, the pictures and the audio of the user and tells the
    program what to do, so "it starts with http" is not enough: logins in the address, other schemes and
    the address a cloud machine answers its metadata on are refused here.
    """
    u = str(raw or "").strip() or "http://127.0.0.1:8188"
    if "://" not in u:
        u = "http://" + u
    try:
        part = urllib.parse.urlsplit(u)
        port = part.port                       # ValueError for "host:abc" or a port out of range
    except ValueError:
        return None, "Адрес не разобрать: нужен вид http://127.0.0.1:8188"
    if part.scheme not in ("http", "https"):
        return None, "Подходит только адрес http или https"
    host = (part.hostname or "").lower()
    if not host:
        return None, "В адресе нет имени компьютера"
    if part.username or part.password:
        return None, "Адрес не должен содержать логин и пароль"
    if host.startswith("169.254.") or host in ("metadata", "metadata.google.internal"):
        return None, "Этот адрес служба облачного компьютера, ComfyUI там быть не может"
    if port is not None and not 0 < port < 65536:
        return None, "Порт в адресе вне диапазона"
    return part.geturl().rstrip("/"), ""


def comfy_is_local(url):
    """Does this address point at this computer or at the local network of the user?"""
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False              # another machine by its name: the user confirms it
    return ip.is_loopback or ip.is_private


def comfy_error_text(res):
    if not isinstance(res, dict):
        return "ComfyUI отклонил задание"
    err = res.get("error") or {}
    parts = [err.get("message", "") + (": " + err.get("details", "") if err.get("details") else "")]
    for node_id, ne in (res.get("node_errors") or {}).items():
        for e in ne.get("errors", []):
            parts.append(f'{ne.get("class_type", node_id)}: {e.get("message")} {e.get("details", "")}'.strip())
    return "\n".join(p for p in parts if p) or "ComfyUI отклонил задание"
