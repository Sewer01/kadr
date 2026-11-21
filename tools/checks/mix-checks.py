"""Проверка звука в ролике: свой трек играет фоном тише, звук модели остаётся, прижатие - только с галочкой.

Здесь только ПОСТОЯННЫЕ инварианты собранного графа: они верны и на дереве, где правка уже
сделана и закоммичена. С git ничего не сверяется и размер диффа не считается: прежнее
утверждение «против прежнего кода переставлены только входы AudioMerge» брало «прежний код»
из `git show HEAD:app/workflows.py`, падало от ЛЮБОЙ правки, не связанной со звуком, и
стало бессмысленным, когда перестановка входов уехала в историю.

Что прогоняем:
1. пять графов (long_graph, long_part_graph k=0 и k=1, action_part_graph k=0 и k=1) на
   подставных данных, каждый в трёх случаях: без общего файла; с файлом без галочки «только
   голос»; с файлом и с галочкой - и то же самое с включённым повтором трека (loop);
2. ПРОИСХОЖДЕНИЕ входов AudioMerge обходом рёбер графа от ноды к предкам, а не номерами нод:
   audio1 обязан восходить к VAEDecodeAudio, который декодит латент семплера (звук модели),
   а audio2 - к AudioAdjustVolume с уровнем фона, который восходит к LoadAudio фона или к его
   зацикливанию (AudioConcat);
3. если общий файл не загружен, AudioMerge в графе не должно быть вовсе;
4. уровень музыки с ползунка (bed_db) и отдельный файл фона (bed_file): volume у приглушения
   равен переданному числу, а не всегда MUSIC_BG_DB; вторая нода LoadAudio появляется ровно
   одна; фон режется из ровной копии; то, что слушает модель (отделение голоса и прижатие
   звукового латента), к ровной копии не восходит; без общего файла ползунок и копия не
   меняют граф до байта;
5. запрещённые значки: постоянным инвариантом по app/workflows.py; по добавленным строкам
   незакоммиченной правки - только в режиме правки (KADR_DIFF=1), иначе печать ПРОПУСК.

Побайтовую неизменность самих графов доказывает golden.py, а не эта проверка: для каждого
случая без общего файла здесь назван эталон, который его покрывает, иmix-checks требует
только, чтобы этот эталон был на месте.

Запуск из корня репы:  python -X utf8 tools/checks/mix-checks.py [путь до репы]

Внешние инструменты (python, git, папка эталонов) берутся из tools/checks/env.py.
"""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True        # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

repo = env.repo(sys.argv[1:], "mix-checks.py").resolve()
sys.path.insert(0, str(repo / "app"))
import workflows as wf  # noqa: E402

fails = []


def verdict(name, ok, note=""):
    print(("   OK   " if ok else "   ПАДЕНИЕ  ") + name + ((" · " + note) if note else ""))
    if not ok:
        fails.append(name)


# ключи, которые графы правда читают из m (проверено поиском m[" по workflows.py)
MODEL = {k: k + ".file" for k in (
    "action_unet", "action_upscaler", "audio_vae", "lipsync_unet", "pika_lora",
    "ref2v_turbo_lora", "text_encoder", "upscaler", "video_vae")}
SC = [("бег", 5), ("прыжок", 5), ("приземление", 6)]
IMG = ["h.png"]
AUD = "song.mp3"          # общий звук, который человек положил в слот
VOC = "melband_roformer.onnx"   # модель отделения голоса (галочка «модель слушает только голос»)
DUR = 4.0                 # длительность трека, секунд: заведомо короче ролика, есть что зацикливать
START = 3.8               # с какой секунды трека начинается ролик: чтобы повтор точно сработал
DB = -22                  # уровень музыки с ползунка: заведомо не MUSIC_BG_DB, видно, что граф его взял
BEDF = "h3studio/aud0n.wav"   # ровная по громкости копия трека: имя, которым её видит ядро

# случай «без общего файла» этого графа покрывает этот эталон golden.py (побайтовая
# неизменность - его работа; здесь проверяем только, что покрытие не потерялось)
GOLDEN_FOR = {("long", None): "long_plain",
              ("long_part", 0): "long_part_k0",
              ("long_part", 1): "long_part_k1",
              ("action_part", 0): "action_part_k0",
              ("action_part", 1): "action_part_k1"}


def build(kind, audio, loop=False, k=1, vocals=None, audio_cont=None, bed_db=None, bed_file=None):
    """Сборка графа на фикстуре: `audio=None` - без общего файла."""
    voc = VOC if (audio and vocals) else None
    kw = {}
    if bed_db is not None:
        kw["bed_db"] = bed_db
    if bed_file:
        kw["bed_file"] = bed_file
    if kind == "long":
        kw.update({} if audio_cont is None else {"audio_cont": bool(audio_cont)})
        return wf.long_graph(MODEL, SC, 1024, 576, 7, IMG, audio=audio, start=0.0, vocals=voc,
                             loop=bool(audio and loop), audio_dur=DUR, **kw)
    if kind == "long_part":
        return wf.long_part_graph(MODEL, SC, k, 1024, 576, 7, IMG, audio=audio, start=START,
                                  vocals=voc, state="st.latent", loop=bool(audio and loop),
                                  audio_dur=DUR, **kw)
    return wf.action_part_graph(MODEL, SC, k, 1024, 576, 7, IMG, [], state="st.latent",
                                audio=audio, audio_at=5.2 if k else 0.0, vocals=voc,
                                audio_dur=(DUR if audio else 0.0), loop=bool(audio and loop), **kw)


# случаи: каждый граф и каждая сцена, каждый в трёх случаях с файлом и без,
# каждый ещё и с повтором трека и без него
CASES = []
for _title, _kind, _scenes in (("long_graph · Видеостудия, весь ролик", "long", (None,)),
                               ("long_part_graph · Видеостудия", "long_part", (0, 1)),
                               ("action_part_graph · Экшн-студия", "action_part", (0, 1))):
    for _k in _scenes:
        for mode in ("none", "file", "vocals"):
            for loop in (False, True):
                CASES.append(("%s · сцена %d (k=%d)" % (_title, _k + 1, _k) if _k is not None else _title,
                              _kind, mode, loop, _k))


def find(g, klass):
    return [nid for nid, n in g.items() if n.get("class_type") == klass]


def one(g, klass):
    ids = find(g, klass)
    return ids[0] if len(ids) == 1 else (ids or [None])[0]


def nid_of(ref):
    """Номер ноды, на которую указывает ссылка [номер, выход] (или None)."""
    return str(ref[0]) if isinstance(ref, (list, tuple)) and ref else None


AUDIO_KEYS = ("audio", "audio1", "audio2")          # входы, по которым идёт звук
LATENT_KEYS = ("samples", "samples1", "samples2")   # входы, по которым идёт латент


def walk(g, ref, keys, stop=()):
    """Обход рёбер графа от ноды К ПРЕДКАМ по входам из keys.

    Только связями: ноды ищутся по тем ссылкам, что в них стоят, а не по номерам, поэтому
    правка нумерации или перенос сборки сцены проверку не ломают. Возвращает [(номер, класс)]
    в порядке обхода; `stop` - классы, из которых дальше не идём (листы цепочки).
    """
    out, queue, seen = [], [nid_of(ref)], set()
    while queue:
        nid = queue.pop(0)
        if not nid or nid in seen or nid not in g:
            continue
        seen.add(nid)
        node = g[nid]
        out.append((nid, node.get("class_type")))
        if node.get("class_type") in stop:
            continue
        for key, val in node.get("inputs", {}).items():
            if key in keys and isinstance(val, (list, tuple)) and val:
                queue.append(str(val[0]))
    return out


def audio_up(g, ref):
    """Аудио-предки ноды: обход по audio, audio1, audio2 до LoadAudio."""
    return walk(g, ref, AUDIO_KEYS, stop=("LoadAudio",))


def brief(g, ref, limit=7):
    """Цепочка коротко: в пояснении к падению длинный хвост только мешает читать."""
    seq = [str(c) for _, c in audio_up(g, ref)]
    return " -> ".join(seq[:limit]) + ("" if len(seq) <= limit else " (ещё %d нод)" % (len(seq) - limit))


def hits(up, *classes):
    return [(nid, c) for nid, c in up if c in classes]


def heard_files(g, ref):
    """Имена файлов, к которым восходит аудиопоток (LoadAudio - лист аудиоцепочки)."""
    return sorted({str(g[nid]["inputs"].get("audio")) for nid, c in audio_up(g, ref)
                   if c == "LoadAudio"})


def say(g, ref, label="вход", pad=0):
    """Печатает, на какую ноду указывает ссылка [номер, выход], фактическими значениями входов."""
    nid = nid_of(ref)
    if nid is None:
        print(" " * pad + "%s = %r" % (label, ref))
        return None
    n = g.get(nid, {})
    ins = n.get("inputs", {})
    scalars = ", ".join("%s=%r" % (k, v) for k, v in ins.items() if not isinstance(v, list))
    print(" " * pad + "%s -> %s %s%s" % (label, nid, n.get("class_type", "?"), ("   " + scalars) if scalars else ""))
    return nid


def pressed(g):
    """Прижатие звукового латента: SetLatentNoiseMask, который держит VAEEncodeAudio нулевой маской."""
    out = []
    for nid in find(g, "SetLatentNoiseMask"):
        ins = g[nid]["inputs"]
        src = g.get(str(ins["samples"][0]), {}) if isinstance(ins.get("samples"), list) else {}
        msk = g.get(str(ins["mask"][0]), {}) if isinstance(ins.get("mask"), list) else {}
        if src.get("class_type") == "VAEEncodeAudio" and msk.get("class_type") == "SolidMask" and msk.get("inputs", {}).get("value") == 0.0:
            out.append(nid)
    return out


def merge_of(g, vid):
    """Номер AudioMerge перед CreateVideo (если между ними стоит приглушение смеси)."""
    nid = str(g[vid]["inputs"]["audio"][0])
    while nid in g and g[nid]["class_type"] != "AudioMerge":
        ins = g[nid]["inputs"]
        nxt = ins.get("audio") or ins.get("audio1")
        if not isinstance(nxt, list):
            return None
        nid = str(nxt[0])
    return nid if nid in g and g[nid]["class_type"] == "AudioMerge" else None


def merge_parts(g, mix_id):
    """Два входа смеси фактическими ссылками: (звук модели, приглушённый фон)."""
    ins = g[mix_id]["inputs"]
    return ins.get("audio1"), ins.get("audio2")


def loaders(g, name):
    """Номера нод LoadAudio, грузящих этот файл."""
    return [nid for nid, n in g.items()
            if n.get("class_type") == "LoadAudio" and n.get("inputs", {}).get("audio") == name]


def file_listeners(g):
    """Ноды, которые слушают файл (отделение голоса и прижатие звукового латента), и файлы,
    к которым они восходят по аудио-рёбрам. Ровная копия фона здесь быть не должна: модель
    обязана слышать подлинный файл."""
    out = {}
    for nid, n in g.items():
        if n.get("class_type") in ("MelBandRoFormerSampler", "VAEEncodeAudio"):
            out["%s %s" % (nid, n["class_type"])] = heard_files(g, [nid, 0])
    return out


def heard_sub(g, bed=None):
    """Узлы того, что слушает модель: они не имели права сдвинуться. `bed` - имя ровной копии,
    которую грузит ВТОРАЯ нода LoadAudio: её здесь нет намеренно, модель слушает подлинный файл."""
    keep = ("LoadAudio", "MelBandRoFormerModelLoader", "MelBandRoFormerSampler")
    out = {}
    for nid, n in g.items():
        if n.get("class_type") not in keep:
            continue
        if bed and n.get("class_type") == "LoadAudio" and n.get("inputs", {}).get("audio") == bed:
            continue
        out[nid] = n
    return blob(out)


def model_audio_origin(g, ref):
    """Восходит ли audio1 к декоду ЗВУКА МОДЕЛИ: VAEDecodeAudio, чей латент идёт от семплера.

    Это постоянный инвариант вместо сравнения с прежним кодом: длину смеси задаёт первый
    вход AudioMerge (comfy_extras/nodes_audio.py), поэтому первым обязан лежать звук ролика,
    а не трек человека. Проверяем обходом рёбер, а не номерами нод.
    """
    up = audio_up(g, ref)
    chain = brief(g, ref)
    decs = [nid for nid, c in up if c == "VAEDecodeAudio"]
    if not decs:
        return False, "в audio1 нет декода звука модели (VAEDecodeAudio); цепочка: %s" % chain
    for nid in decs:
        lat = walk(g, g[nid]["inputs"].get("samples"), LATENT_KEYS, stop=("SamplerCustomAdvanced",))
        if any(c == "SamplerCustomAdvanced" for _, c in lat):
            return True, "нода %s декодит латент %s" % (nid, " -> ".join(str(c) for _, c in lat))
    return False, ("VAEDecodeAudio %s в цепочке есть, но её латент идёт не от SamplerCustomAdvanced"
                   " (значит это не звук модели): %s" % (decs, chain))


def bed_origin(g, ref, db, bed_name):
    """Восходит ли audio2 к ПРИГЛУШЕННОЙ КОПИИ ФОНА: AudioAdjustVolume с уровнем db, а за ним
    LoadAudio фона (или его зацикливание). Уровень берётся из bed_db, то есть с ползунка."""
    nid = nid_of(ref)
    node = g.get(nid, {}) if nid else {}
    if node.get("class_type") != "AudioAdjustVolume":
        return False, ("audio2 идёт не из приглушения фона (AudioAdjustVolume), а из %s: %s"
                       % (node.get("class_type"), brief(g, ref)))
    got = node.get("inputs", {}).get("volume")
    if got != db:
        return False, "уровень приглушения фона %r вместо переданного %r" % (got, db)
    up = audio_up(g, ref)
    loads = heard_files(g, ref)
    if not loads:
        return False, "в audio2 нет LoadAudio фона; цепочка: %s" % brief(g, ref)
    if loads != [bed_name]:
        return False, "фон грузится из %s, а должен из %r" % (loads, bed_name)
    if hits(up, "VAEDecodeAudio"):
        return False, "в audio2 попал звук модели (VAEDecodeAudio): %s" % brief(g, ref)
    if hits(up, "MelBandRoFormerSampler"):
        return False, "фон взят из отделённого голоса (MelBandRoFormerSampler): %s" % brief(g, ref)
    return True, "нода %s глушит %r до %r дБ; %d аудио-предков" % (nid, bed_name, got, len(up))


def blob(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True)


def check_case(title, kind, mode, loop, k):
    audio = None if mode == "none" else AUD
    vocals = mode == "vocals"
    tag = "%s · %s%s" % (title, {"none": "без файла", "file": "файл, галочки нет", "vocals": "файл + галочка"}[mode],
                         " · повтор трека" if loop else "")
    kk = k if k is not None else 1
    g, st = build(kind, audio, loop=loop, k=kk, vocals=vocals)
    vid = one(g, "CreateVideo")
    decs = find(g, "VAEDecodeAudio")
    pins = pressed(g)
    mix_id = merge_of(g, vid)
    print("\n" + tag)
    say(g, g[vid]["inputs"]["audio"], "CreateVideo.audio")
    print("   цепочка до источника: %s" % brief(g, g[vid]["inputs"]["audio"]))
    print("   нод VAEDecodeAudio: %d · прижатие звукового латента: %s"
          % (len(decs), "нет" if not pins else "ЕСТЬ " + str(pins)))
    if audio is None:
        verdict(tag + ": без файла ноды AudioMerge в графе нет", not find(g, "AudioMerge"))
        verdict(tag + ": без файла прижатия звукового латента нет", not pins)
        name = GOLDEN_FOR.get((kind, None if kind == "long" else kk))
        golden = env.GOLDEN_DIR / (name + ".json")
        verdict(tag + ": неизменность этого графа без файла доказывает эталон golden %s.json" % name,
                bool(name) and golden.is_file(), "файл эталона: %s (сверку ведёт golden.py)" % golden.name)
        return
    # случай с файлом: в фильме играет и звук модели, и трек человека фоном тише
    verdict(tag + ": звук модели декодируется (VAEDecodeAudio не ноль)", bool(decs), "%d нод" % len(decs))
    verdict(tag + ": в CreateVideo смесь AudioAdjustVolume(-3) -> AudioMerge(add)",
            g[str(g[vid]["inputs"]["audio"][0])]["class_type"] == "AudioAdjustVolume"
            and g[vid]["inputs"]["audio"] and mix_id is not None
            and g[mix_id]["inputs"]["merge_method"] == "add"
            and g[str(g[vid]["inputs"]["audio"][0])]["inputs"].get("volume") == -3)
    verdict(tag + ": нод AudioMerge ровно одна", len(find(g, "AudioMerge")) == 1,
            str(find(g, "AudioMerge")))
    m_ref, b_ref = merge_parts(g, mix_id)
    say(g, m_ref, "audio1 (звук модели: он задаёт длину смеси)", pad=4)
    say(g, b_ref, "audio2 (трек человека фоном)", pad=4)
    print("   цепочка модели: %s" % brief(g, m_ref))
    print("   цепочка трека: %s" % brief(g, b_ref))
    ok, why = model_audio_origin(g, m_ref)
    verdict(tag + ": audio1 восходит к декоду звука модели (VAEDecodeAudio по латенту семплера)", ok, why)
    verdict(tag + ": audio1 не берётся из аудиофайла (в его предках нет LoadAudio)",
            not heard_files(g, m_ref), "файлы: %s" % heard_files(g, m_ref))
    ok, why = bed_origin(g, b_ref, wf.MUSIC_BG_DB, AUD)
    verdict(tag + ": audio2 - приглушение фоновой копии с уровнем %r, восходящее к LoadAudio %r"
            % (wf.MUSIC_BG_DB, AUD), ok, why)
    if loop:
        verdict(tag + ": при повторе трек в смеси берётся из зацикленной дорожки (AudioConcat)",
                bool(hits(audio_up(g, b_ref), "AudioConcat")), brief(g, b_ref))
    if mode == "file":
        verdict(tag + ": прижатия звукового латента нет (модель сочиняет сама)", not pins)
        verdict(tag + ": без галочки VAEEncodeAudio в графе не осталось (прижатие снято)",
                not find(g, "VAEEncodeAudio"), "VAEEncodeAudio: %s" % find(g, "VAEEncodeAudio"))
    else:  # с галочкой: прижатие осталось, и смесь появилась
        verdict(tag + ": прижатие звукового латента сохранилось", bool(pins), str(pins))
        verdict(tag + ": прижатых сцен столько же, сколько в графе VAEEncodeAudio",
                len(pins) == len(find(g, "VAEEncodeAudio")), str(find(g, "VAEEncodeAudio")))
        verdict(tag + ": фон идёт из файла, а не из отделённого голоса (в фоне есть музыка)",
                not hits(audio_up(g, b_ref), "MelBandRoFormerSampler"), brief(g, b_ref))
    # три ноды смеси (приглушение смеси, merge, приглушение фона) обязаны числиться в этапах
    adj = nid_of(b_ref)
    new_audio = [str(g[vid]["inputs"]["audio"][0]), mix_id, adj]
    un = sorted(n for n in new_audio if n not in st)
    verdict(tag + ": ноды смеси помечены в stages как звуковые", not un,
            "этапы: %s · без этапа: %s" % (sorted({st[n] for n in new_audio if n in st}), un))


print("=== 1-4. пять графов x три случая x повтор трека ===")
for title, kind, mode, loop, k in CASES:
    check_case(title, kind, mode, loop, k)

print()
print("=== 5. long_graph: продолжение звука на стыках и прижатие вместе ===")
for cont, mode in ((True, "file"), (True, "vocals")):
    g, _ = build("long", AUD, k=0, vocals=mode == "vocals", audio_cont=cont)
    pins = pressed(g)
    print("\nстыковое продолжение звука (audio_cont) · %s" % ("файл + галочка" if mode == "vocals" else "файл, галочки нет"))
    print("   нод LatentConcat: %d · прижатие: %s" % (len(find(g, "LatentConcat")), pins or "нет"))
    if mode == "vocals":
        verdict("audio_cont + галочка: прижатие не съедено продолжением", len(pins) == len(SC), str(pins))
    else:
        verdict("audio_cont без галочки: сочинённый звук продолжается на стыке (LatentConcat есть)",
                any(n["class_type"] == "LatentConcat" for n in g.values()))

print()
print("=== 6. уровень музыки с ползунка (bed_db) и отдельный файл фона (bed_file) ===")
MODE_NAME = {"none": "без файла", "file": "файл, галочки нет", "vocals": "файл + галочка"}
for title, kind, mode, loop, k in CASES:
    audio = None if mode == "none" else AUD
    vocals = mode == "vocals"
    kk = k if k is not None else 1
    tag = "%s · %s%s · музыка %d дБ · ровная копия" % (title, MODE_NAME[mode], " · повтор трека" if loop else "", DB)
    g, st = build(kind, audio, loop=loop, k=kk, vocals=vocals, bed_db=DB, bed_file=BEDF)
    print("\n" + tag)
    if audio is None:   # без общего файла ни ползунок, ни копия ничего не меняют: граф обязан быть прежним
        verdict(tag + ": без файла второй LoadAudio не появился", not loaders(g, BEDF))
        g0, st0 = build(kind, None, loop=loop, k=kk)
        verdict(tag + ": без файла ползунок и ровная копия не меняют граф и этапы до байта",
                blob(g) == blob(g0) and blob(st) == blob(st0), "узлов %d" % len(g))
        continue
    vid = one(g, "CreateVideo")
    mix_id = merge_of(g, vid)
    m_ref, b_ref = merge_parts(g, mix_id)
    adj = nid_of(b_ref)
    say(g, m_ref, "audio1 (звук модели)", pad=4)
    say(g, b_ref, "audio2 (фон)", pad=4)
    print("   цепочка фона: %s" % brief(g, b_ref))
    volume = g.get(adj, {}).get("inputs", {}).get("volume")
    print("   volume у приглушения фона: %r (просили %d; MUSIC_BG_DB = %r)" % (volume, DB, wf.MUSIC_BG_DB))
    verdict(tag + ": volume приглушения фона = переданный %d, а не всегда %r" % (DB, wf.MUSIC_BG_DB),
            volume == DB, "volume=%r" % volume)
    ok, why = model_audio_origin(g, m_ref)
    verdict(tag + ": audio1 остаётся звуком модели (не съеден копией фона)", ok, why)
    ok, why = bed_origin(g, b_ref, DB, BEDF)
    verdict(tag + ": audio2 - приглушение ровной копии %r с уровнем %d, восходящее к её LoadAudio" % (BEDF, DB), ok, why)
    got, keep = loaders(g, BEDF), loaders(g, AUD)
    print("   LoadAudio с именем копии %r: %s · LoadAudio подлинного файла %r: %s" % (BEDF, got, AUD, keep))
    verdict(tag + ": в графе появилась ВТОРАЯ нода LoadAudio с именем ровной копии", len(got) == 1, str(got))
    verdict(tag + ": нод LoadAudio стало ровно на один больше", len(find(g, "LoadAudio")) == len(keep) + 1,
            "всего %d" % len(find(g, "LoadAudio")))
    if loop:
        verdict(tag + ": при повторе фон зацикливается из ровной копии",
                bool(hits(audio_up(g, b_ref), "AudioConcat")), brief(g, b_ref))
    listeners = file_listeners(g)
    verdict(tag + ": ровная копия не попала туда, где слушают файл (отделение голоса, прижатие латента)",
            all(BEDF not in names for names in listeners.values()), str(listeners)[:200])
    if vocals:
        verdict(tag + ": с галочкой отделение голоса и прижатие восходят к подлинному файлу %r" % AUD,
                bool(listeners) and all(names == [AUD] for names in listeners.values()),
                str(listeners)[:200])
    else:
        verdict(tag + ": без галочки прижатия звукового латента в графе нет", not find(g, "VAEEncodeAudio"),
                str(find(g, "VAEEncodeAudio")))
    g0, _ = build(kind, audio, loop=loop, k=kk, vocals=vocals)   # тот же вызов без ровной копии
    verdict(tag + ": путь, который слушает модель, не изменился",
            heard_sub(g, bed=BEDF) == heard_sub(g0), "узлы %s" % heard_sub(g, bed=BEDF)[:120])

print()
print("=== 6б. только ползунок, без ровной копии: копия не обязана грузиться ===")
for title, kind, mode, loop, k in CASES:
    if mode == "none":
        continue
    kk = k if k is not None else 1
    tag = "%s · %s · музыка %d дБ без выравнивания" % (title, MODE_NAME[mode], DB)
    g, _ = build(kind, AUD, loop=loop, k=kk, vocals=mode == "vocals", bed_db=DB)
    mix_id = merge_of(g, one(g, "CreateVideo"))
    m_ref, b_ref = merge_parts(g, mix_id)
    ok, why = bed_origin(g, b_ref, DB, AUD)     # фон берётся из подлинного файла: копии нет
    verdict(tag + ": volume = %d и вторая нода LoadAudio не появилась" % DB,
            ok and not loaders(g, BEDF) and len(find(g, "LoadAudio")) == 1,
            "LoadAudio=%s · %s" % ([g[n]["inputs"]["audio"] for n in find(g, "LoadAudio")], why))

print()
print("=== 7. запрещённые значки ===")
txt = (repo / "app" / "workflows.py").read_text(encoding="utf-8", errors="replace")
bad = env.bad_glyphs(txt)
verdict("постоянно: в app/workflows.py нет значков U+2600-27BF, U+2190-21FF, U+3040-30FF, U+4E00-9FFF",
        not bad, str(bad)[:200])
added, why = env.added_lines(repo, ("app/workflows.py",))
if added is None:
    env.skip("поиск значков в добавленных строках правки", why)
else:
    hits_bad = sorted({"%s U+%04X" % (c, ord(c)) for ln in added for c in ln if env.BAD_GLYPHS.match(c)})
    verdict("в %d новых строках app/workflows.py запрещённых значков нет" % len(added),
            not hits_bad, str(hits_bad)[:200])

print()
if fails:
    shown = fails[:6] + (["... ещё %d таких же" % (len(fails) - 6)] if len(fails) > 6 else [])
    print("ИТОГ: падений: %d -> %s" % (len(fails), shown))
else:
    print("ИТОГ: всё чисто")
sys.exit(1 if fails else 0)
