"""Что читал расчёт: картинки, видео и звук берутся из самого графа по нодам-
загрузчикам - так покрытие полное, и свои workflow человека тоже считаются."""


REF_LOADERS = (("image", ("LoadImage", "LoadImageMask", "LoadImage3D"), "image"),
               ("video", ("VHS_LoadVideo", "LoadVideo", "LoadVideoPath"), "video"),
               ("audio", ("LoadAudio", "VHS_AudioToSIPE", "LoadAudioPath"), "audio"))


def _graph_refs(graph):
    """What this calculation read: its pictures, the video it works on and audio, in the order of the
    places. Taken from the graph itself, so every section is covered at once - the ordinary ones, the
    studio and the user's own workflows: every file enters the calculation through a loader node.
    A name comes as ComfyUI keeps it, often "h3studio/h3s_ab12cd34.png": the folder belongs to it."""
    if not isinstance(graph, dict):
        return []

    def key(kv):
        n = kv[0]
        return (0, int(n)) if str(n).isdigit() else (1, str(n))

    out, seen = [], set()
    for _nid, node in sorted(graph.items(), key=key):
        if not isinstance(node, dict):
            continue
        for kind, classes, field in REF_LOADERS:
            if node.get("class_type") not in classes:
                continue
            val = (node.get("inputs") or {}).get(field)
            if isinstance(val, str) and val and val not in seen:
                seen.add(val)
                out.append({"kind": kind, "name": val})
    return out[:14]
