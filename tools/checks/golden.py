"""Эталоны графов: собираем ВСЕ графы из app/workflows.py на фиксированных входах и храним как JSON.

Зачем. Приложение разбивается на модули, и главное требование - «правка в одном месте не ломает
другое». Эта проверка и отвечает на вопрос «поведение не изменилось»: если после переноса кода
все эталоны совпали побайтово, графы, которые уходят в ComfyUI, остались ровно теми же.

Запуск из корня репы:
  python tools/checks/golden.py --write             # создать или обновить эталоны
  python tools/checks/golden.py                     # сверка с эталонами
  python tools/checks/golden.py C:\\путь\\до\\репы    # явный путь до репы
  python tools/checks/golden.py --golden C:\\tmp\\копия   # сверка с эталонами в другом месте

Что сравнивается: собранный граф (ноды, классы, все поля входов) и карта `stages` - этапы
прогресса, которые граф возвращает вместе с собой. Отличия печатаются по номерам нод и полям.

Внешних инструментов проверка не требует: только python из репы. Ничего не считается на видеокарте,
в очередь ComfyUI ничего не ставится.
"""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True      # .pyc не должны появляться внутри app/
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import env  # noqa: E402

# --- фикстура: что графы правда читают --------------------------------------

# роли -> имена файлов так, как их показывает ComfyUI ( rol'ы взяты из app/catalog.py,
# имена - снимок типового набора; фикстура сознательно НЕ зависит от catalog.py, чтобы
# правка справочника моделей не переписывала эталоны молча)
M = {
    "fast_unet": "MinimaxH3\\fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors",
    "lipsync_unet": "MinimaxH3\\Minimax-h3_Singularity_ref2va_v1.3_int8.safetensors",
    "action_unet": "MinimaxH3\\minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors",
    "text_encoder": "MinimaxH3\\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "video_vae": "MinimaxH3\\minimax_h3_video_vae_int8_convrot.safetensors",
    "audio_vae": "MinimaxH3\\minimax_h3_audio_vae_fp32.safetensors",
    "ref2v_turbo_lora": "MinimaxH3\\minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "sla_lora": "MinimaxH3\\minimax_h3_fl2v_turbo_4step_v0.1_768p_sla_comfyui_bf16.safetensors",
    "upscaler": "minimax_h3_latent_upscaler_2d_conv_v1_fp16.safetensors",
    "action_upscaler": "h3_upscaler_lms_v0.1.safetensors",
    "preview": "taeh3.safetensors",
    "vocal_model": "MinimaxH3\\MelBandRoformer_fp16.safetensors",
    "speed_slider_lora": "MinimaxH3\\H3_speed_slider_1.1.safetensors",
    "dmad_lora": "MinimaxH3\\minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors",
    "realism_lora": "MinimaxH3\\h3-realism-people-t2v-i2v-r2v.safetensors",
    "motion_repair_lora": "MinimaxH3\\Motion_Repair_V2.safetensors",
    "swap_lora": "MinimaxH3\\h3_character_swap_v1.5.safetensors",
    "pika_lora": "MinimaxH3\\pika_h3_flex_turbo_8step_hd_ref2va.safetensors",
    "seedvr_unet": "Images\\seedvr2_3b_int8_convrot.safetensors",
    "seedvr_vae": "Images\\seedvr2_ema_vae_fp16.safetensors",
    "relayvsr_unet": "Images\\relayvsr_x2_lightx2v_int8_convrot.safetensors",
    "relayvsr_vae": "Images\\relayvsr_flash_vae_x2_fp32.safetensors",
    "krea_unet": "Images\\krea2_turbo_int8_convrot.safetensors",
    "krea_clip": "Images\\qwen3vl_4b_fp8_scaled.safetensors",
    "krea_vae": "Images\\qwen_image_vae.safetensors",
    "kreareal_unet": "Images\\redcraftKREA2RedMix_krea2Edition.safetensors",
    "kreareal_lora": "Images\\realism_engine_krea2_v2.safetensors",
    "qwen_unet": "Images\\qwen_image_2.1_int8_convrot.safetensors",
    "qwen_clip": "Images\\qwen3vl_8b_int8_convrot.safetensors",
    "qwen_vae": "Images\\qwen_image_2.1_vae_bf16.safetensors",
    "h3img_unet": "MinimaxH3\\minimax_h3_image_pruned_w4a8.safetensors",
    "h3img_vae": "MinimaxH3\\minimax_h3_image_vae_fp16.safetensors",
    "flux_unet": "Images\\flux-2-klein-4b-fp8.safetensors",
    "flux_clip": "Images\\qwen_3_4b.safetensors",
    "flux_vae": "Images\\flux2-vae.safetensors",
    # вне справочника ролей: сервер подставляет её отдельно, когда установлен FLUX.3
    "flux_clip3": "qwen3vl_4b_flux3_int8_convrot.safetensors",
}

# FLUX.3: другая ветка в flux_* (is_flux3), поэтому отдельная фикстура модели
M_FLUX3 = dict(M, flux_unet="Images\\flux-3-klein-9b-fp8.safetensors")
# латентный увелличитель 3D: у него другой узел и другой набор полей (upscaler_node)
M_UP3D = dict(M, upscaler="minimax_h3_latent_upscaler_3d_v1_fp16.safetensors")

SEED = 20261121
W, H = 1152, 640                      # 16:9, качество 0.7 (wf.resolution даёт те же числа)
W2, H2 = 768, 1376                    # 9:16: размер сцены в другой ориентации
LORAS = [(M["dmad_lora"], 0.8), (M["speed_slider_lora"], 4.0)]   # экшн-пара, как в сервере
EXTRA = [(M["realism_lora"], 0.5)]    # своя картинная/видео LoRA пользователя

# картинки-референсы: ВТОРАЯ позиция пустая - так проверяется правило «пустое место
# не сдвигает другие номера»
IMAGES = ["h3studio/char-a.png", "", "h3studio/char-c.png", "h3studio/place.png"]
VIDEOS = ["h3studio/motion-ref.mp4"]
REF_AUDIOS = ["h3studio/voice-ref.wav"]
FIRST = "h3studio/first.png"
LAST = "h3studio/last.png"
SRC_FRAME = "h3studio/src-frame.png"       # последний кадр видео, которое продолжают

# сцена со СВОИМИ картинками и звуком: своя медиа нумеруется десятком сцены - у второй сцены
# это <Picture 20..28> и <Audio 20..22>; место 21 оставлено пустым, чтобы эталон показал,
# что пустое место сохраняет свой номер и не сдвигает соседние
SCENES = [
    ("бег по крыше, <Picture 1> в кадре", 5.0),
    ("прыжок: своя картинка <Picture 20>, пустое место <Picture 21>, <Picture 22> и свой звук <Audio 20>",
     5.0, ["h3studio/own-a.png", "", "h3studio/own-c.png"]),
    ("приземление, <Picture 3> крупно", 6.0),
]
# то же, но фильм продолжает готовый видео: метка <Frame> становится первым кадром
SCENES_FRAME = [(SCENES[0][0] + ", <Frame> в начале", 5.0), SCENES[1], SCENES[2]]
SCENE_AUDIOS = [(), ("h3studio/scene2-audio.wav",), ()]
FRESH = (False, False, True)          # третья сцена - новый план, не продолжение предыдущей

AUDIO = "h3studio/song.mp3"           # общий звук фильма, который положил человек
AUDIO_DUR = 12.0                      # заведомо короче фильма: есть что зацикливать
START = 3.8                           # с какой секунды трека начинается фильм
BED_DB = -22                          # уровень музыки с ползунка: не MUSIC_BG_DB, видно, что граф его взял
BED_FILE = "h3studio/song-loud.wav"   # ровная по громкости копия: фон берётся из неё
VOCALS = M["vocal_model"]             # отделение голоса («модель слушает только голос»)
STATE = "h3studio/h3s_long_run_0.latent"   # сохранённый хвост латента предыдущей сцены
SRC = ("h3studio/src-clip.mp4", 120)  # продолжение уже готового видео: (файл, кадров)
PREVIEW = {"tiny_vae": M["preview"]}  # живые кадры предпросмотра (KJNodes), когда узел установлен

SHOTS = [
    {"s": 0.0, "e": 4.0, "pic": 0, "who": "the man in the grey coat"},
    {"s": 4.0, "e": 8.5, "pic": -1, "who": ""},                 # этот план остаётся как есть
    {"s": 8.5, "e": 14.0, "pic": 2, "who": "the woman with the red scarf", "a_end": 12.5},
]


# --- сборка одного эталона --------------------------------------------------

USED = set()      # какие `*_graph` из app/workflows.py правда были вызваны


def two(fn, *a, **kw):
    """Граф, который возвращает (граф, этапы). Возвращает отложенный вызов: пусть один
    неудачный случай не роняет всю проверку, а падает отдельной строкой."""
    def build():
        USED.add(fn.__name__)
        g, st = fn(*a, **kw)
        return {"graph": g, "stages": st}
    return build


def three_prompt(fn, *a, **kw):
    """Граф листа персонажа: третьим идёт сам текст запроса."""
    def build():
        USED.add(fn.__name__)
        g, st, prompt = fn(*a, **kw)
        return {"graph": g, "stages": st, "prompt": prompt}
    return build


def three_titles(fn, *a, **kw):
    """Раскадровка по кадрам: третьим идёт подпись каждой ноды сохранения."""
    def build():
        USED.add(fn.__name__)
        g, st, titles = fn(*a, **kw)
        return {"graph": g, "stages": st, "titles": titles}
    return build


def cases(wf):
    """Все случаи: покрывают каждый `def *_graph` из app/workflows.py и нужные ветки."""
    C = []                                   # (имя эталона, данные)
    add = lambda name, data: C.append((name, data))   # noqa: E731

    # Видеостудия: текст, первый кадр, первый и последний кадр, черновик со своими LoRA
    add("video_i2v_plain", two(wf.video_graph, M, "лиса в снегу", W, H, 5, SEED))
    add("video_first_last", two(wf.video_graph, M, "лиса в снегу", W, H, 5, SEED,
                                first=FIRST, last=LAST))
    add("video_draft_loras", two(wf.video_graph, M, "лиса в снегу", W2, H2, 8, SEED,
                                 first=FIRST, extra_loras=EXTRA, fast=M["sla_lora"]))

    # Референсы: картинки с дыркой в нумерации, референсные видео и аудио, кадры начала и конца
    add("refs_plain", two(wf.ref_graph, M, "разговор на кухне", W, H, 6, SEED, IMAGES, VIDEOS, REF_AUDIOS))
    add("refs_pika_guides", two(wf.ref_graph, M, "разговор на кухне", W, H, 6, SEED, IMAGES, VIDEOS, REF_AUDIOS,
                                steps=8, ref_size="match", extra_loras=EXTRA, pika=M["pika_lora"],
                                first=FIRST, last=LAST))

    # Актёрская игра: первый кадр + образец голоса, LoRA реалистичности
    add("actor_plain", two(wf.actor_graph, M, "<d>привет, как дела</d>", W, H, 8, SEED, IMAGES, REF_AUDIOS))
    add("actor_realism", two(wf.actor_graph, M, "<d>привет, как дела</d>", W, H, 8, SEED, IMAGES, REF_AUDIOS,
                             realism=(M["realism_lora"], 0.6), extra_loras=EXTRA))

    # Замена персонажа: свой звук, звук с губами, звук от модели, Pika
    add("swap_sound_original", two(wf.swap_graph, M, wf.swap_prompt("the man in the grey coat"),
                                   W, H, 6, SEED, IMAGES, "h3studio/in.mp4"))
    add("swap_sound_lock_small", two(wf.swap_graph, M, wf.swap_prompt("the man in the grey coat"),
                                     W, H, 6, SEED, IMAGES, "h3studio/in.mp4",
                                     EXTRA, None, "lock", True))
    add("swap_sound_model_pika", two(wf.swap_graph, M, wf.swap_prompt(["первый", "второй"], "крупный план"),
                                     W, H, 6, SEED, IMAGES, "h3studio/in.mp4",
                                     EXTRA, M["pika_lora"], "model", False))
    # несколько планов одного видео: каждый меняется отдельно, потом склейка
    add("swap_shots_plain", two(wf.swap_shots_graph, M, SHOTS, W, H, SEED, IMAGES, "h3studio/in.mp4", "без музыки"))
    add("swap_shots_lock_cut", two(wf.swap_shots_graph, M, SHOTS, W, H, SEED, IMAGES, "h3studio/in.mp4",
                                   "", None, EXTRA, "lock", True))

    # Зерно и монтаж
    add("grain_soft", two(wf.grain_graph, "h3studio/clip.mp4", 0.35, SEED))
    add("montage_plain", two(wf.montage_graph, ["h3studio/a.mp4", "h3studio/b.mp4"],
                             [(W, H), (W2, H2)]))
    add("montage_cut_sound", two(wf.montage_graph, ["h3studio/a.mp4", "h3studio/b.mp4", "h3studio/c.mp4"],
                                 [(W, H), (W2, H2), (W, H)],
                                 cuts=[3.5, 0.0, 2.0],
                                 timing=[(4.0, 4.0), (2.0, None), (3.0, 2.4)],
                                 starts=[1.0, 0.0, 0.0]))

    # Видеостудия по-сценно: весь фильм одним заданием
    add("long_plain", two(wf.long_graph, M, SCENES, W, H, SEED, IMAGES, None, 0.0, M["pika_lora"]))
    add("long_audio_bed", two(wf.long_graph, M, SCENES, W, H, SEED, IMAGES, AUDIO, 0.0, M["pika_lora"],
                              scene_audios=SCENE_AUDIOS, audio_dur=AUDIO_DUR,
                              bed_db=BED_DB, bed_file=BED_FILE))
    add("long_audio_vocals_loop", two(wf.long_graph, M, SCENES, W, H, SEED, IMAGES, AUDIO, START, M["pika_lora"],
                                      vocals=VOCALS, loop=True, audio_dur=AUDIO_DUR, scene_audios=SCENE_AUDIOS))
    add("long_draft_preview", two(wf.long_graph, M, SCENES, W, H, SEED, IMAGES, None, 0.0, M["dmad_lora"],
                                  (), "max", None, PREVIEW, (), False, True))
    add("long_audiocont_newshot_frame", two(wf.long_graph, M, SCENES_FRAME, W, H, SEED, IMAGES, None, 0.0, M["pika_lora"],
                                            (), "match", None, None, FRESH, True, False, frame=SRC_FRAME))

    # Видеостудия: сцена по частям (k=0 начинает, k=1 продолжает сохранённый латент)
    add("long_part_k0", two(wf.long_part_graph, M, SCENES, 0, W, H, SEED, IMAGES))
    add("long_part_k1", two(wf.long_part_graph, M, SCENES, 1, W, H, SEED, IMAGES, None, 0.0, M["pika_lora"],
                            (), "match", None, STATE))
    add("long_part_k1_audio_vocals_loop", two(
        wf.long_part_graph, M, SCENES, 1, W, H, SEED, IMAGES, AUDIO, START, M["pika_lora"], (), "match",
        VOCALS, STATE, None, None, False, FRESH, False, True, AUDIO_DUR, SCENE_AUDIOS, BED_DB, BED_FILE))
    add("long_part_k0_src_cont", two(wf.long_part_graph, M, SCENES, 0, W, H, SEED, IMAGES, None, 0.0,
                                     M["pika_lora"], (), "match", None, None, None, SRC, True))
    add("long_part_draft", two(wf.long_part_graph, M, SCENES, 0, W, H, SEED, IMAGES, None, 0.0,
                               M["dmad_lora"], (), "max", None, None, PREVIEW))

    # Экшн-видео: обычная схема и точная схема оригинала
    add("action_simple", two(wf.action_graph, M, "драка под дождём", W, H, 8, SEED, IMAGES, REF_AUDIOS,
                             False, LORAS))
    add("action_faithful", two(wf.action_graph, M, "драка под дождём", W, H, 8, SEED, IMAGES, REF_AUDIOS,
                               True, LORAS, 4))

    # Экшн-студия по-сценно
    add("action_part_k0", two(wf.action_part_graph, M, SCENES, 0, W, H, SEED, IMAGES, LORAS))
    add("action_part_k1", two(wf.action_part_graph, M, SCENES, 1, W, H, SEED, IMAGES, LORAS,
                              None, STATE, FRESH))
    add("action_part_k1_faithful", two(wf.action_part_graph, M, SCENES, 1, W, H, SEED, IMAGES, LORAS,
                                       PREVIEW, STATE, (), True, False, None, False, False, 12, 4))
    add("action_part_k1_upscaler3d", two(wf.action_part_graph, M_UP3D, SCENES, 1, W, H, SEED, IMAGES, LORAS,
                                         None, STATE, (), False, True, None, False, False, 12, 6))
    add("action_part_k0_single", two(wf.action_part_graph, M, SCENES, 0, W, H, SEED, IMAGES, LORAS,
                                     PREVIEW, None, (), False, True, None, True))
    add("action_part_k1_audio_vocals_loop", two(
        wf.action_part_graph, M, SCENES, 1, W, H, SEED, IMAGES, LORAS, None, STATE, FRESH, False, True,
        None, False, False, 12, 2, AUDIO, 5.2, AUDIO_DUR, True, VOCALS, SCENE_AUDIOS, BED_DB, BED_FILE))

    # Губная синхронизация
    add("lipsync_plain", two(wf.lipsync_graph, M, wf.lipsync_prompt("привет, как дела", 2),
                             W, H, 5, SEED, "h3studio/voice.wav", IMAGES[:2], wf.lipsync_scale("720p")))
    add("lipsync_loras_match", two(wf.lipsync_graph, M, wf.lipsync_prompt("привет", 3, 1),
                                   W, H, 5, SEED, "h3studio/voice.wav", IMAGES[:3], 2.0, "match", EXTRA))

    # Картинки: Krea 2
    add("krea_t2i", two(wf.krea_graph, M, "портрет, 50mm", W, H, SEED))
    add("krea_real_2k", two(wf.krea_real_graph, M, "портрет, 50mm", W, H, SEED, wf.KREA_REAL_SCALES["2k"]))

    # Картинки: MiniMax H3 Image
    add("h3img_t2i", two(wf.h3img_t2i_graph, M, "лиса в снегу", 2048, 1152, SEED))
    add("h3img_edit_refs", two(wf.h3img_edit_graph, M, "та же лиса зимой", IMAGES[:3], 8.0, SEED, None, 2.0))
    add("h3img_edit_size", two(wf.h3img_edit_graph, M, "та же лиса зимой", IMAGES[:2], 8.0, SEED,
                               (1536, 864)))
    add("h3img_sheet_panels6", three_prompt(wf.h3img_sheet_graph, M, "h3studio/char-a.png", SEED,
                                            True, "white", "веснушки", 6, 8.0))
    add("h3img_story", two(wf.h3img_story_graph, M, IMAGES[:3], "<Picture 1> и <Picture 2> в деле", SEED))
    add("h3img_frames", three_titles(wf.h3img_frames_graph, M, IMAGES[:2],
                                     ["кадр первый", "кадр второй", "кадр третий"], SEED,
                                     wf.H3IMG_FRAME_SIZE, "black"))

    # Картинки: FLUX (обычный и FLUX.3 - другая ветка is_flux3)
    add("flux_t2i", two(wf.flux_t2i_graph, M, "лиса в снегу", W, H, SEED))
    add("flux3_t2i", two(wf.flux_t2i_graph, M_FLUX3, "лиса в снегу", W, H, SEED))
    add("flux_edit", two(wf.flux_edit_graph, M, "тот же персонаж в студии", "h3studio/char-a.png", 1.0, SEED))
    add("flux_edit_size_extras", two(wf.flux_edit_graph, M, "тот же персонаж в студии", "h3studio/char-a.png",
                                     2.0, SEED, IMAGES[:2], (1184, 896)))
    add("flux_story", two(wf.flux_story_graph, M, IMAGES[:3], "сцена у окна", SEED))
    add("flux_frames", three_titles(wf.flux_frames_graph, M, IMAGES[:3],
                                    ["кадр первый", "кадр второй", "кадр третий", "кадр четвёртый"], SEED))
    add("flux3_frames", three_titles(wf.flux_frames_graph, M_FLUX3, IMAGES[:2],
                                     ["кадр первый", "кадр второй"], SEED))

    # Картинки: Qwen Image 2.1
    add("qwen_t2i_plain", two(wf.qwen_t2i_graph, M, "лиса в снегу", "", W, H, SEED))
    add("qwen_t2i_negative", two(wf.qwen_t2i_graph, M, "лиса в снегу", "размытие", W, H, SEED))
    add("qwen_edit_size_extras", two(wf.qwen_edit_graph, M, "тот же персонаж в студии", "h3studio/char-a.png",
                                     1.0, SEED, wf.qwen_edit_size("16:9", 2.0), IMAGES[:2]))
    add("qwen_story", two(wf.qwen_story_graph, M, IMAGES[:3], "сцена у окна", SEED))
    add("qwen_sheet", three_prompt(wf.qwen_sheet_graph, M, "h3studio/char-a.png", SEED, False, "black",
                                   "веснушки", 6))
    add("qwen_frames", three_titles(wf.qwen_frames_graph, M, IMAGES[:2],
                                    ["кадр первый", "кадр второй", "кадр третий"], SEED))

    # Улучшение готового: SeedVR2, RelayVSR, картинка
    add("upscale_video", two(wf.upscale_graph, M, "h3studio/clip.mp4", 1.5, SEED))
    add("upscale_video_soften", two(wf.upscale_graph, M, "h3studio/clip.mp4", 2.0, SEED, 0.35))
    add("upscale_image", two(wf.upscale_image_graph, M, "h3studio/frame.png", 2.0, SEED))
    add("upscale_image_soften", two(wf.upscale_image_graph, M, "h3studio/frame.png", 1.5, SEED, 0.5))
    add("relay_video", two(wf.relay_graph, M, "h3studio/clip.mp4", SEED))
    add("relay_video_detail", two(wf.relay_graph, M, "h3studio/clip.mp4", SEED, 0.7))
    return C


# --- запись и сверка ---------------------------------------------------------

def canonical(payload):
    """Канонический текст эталона: ключи отсортированы, переносы строк всегда \\n."""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n"


def fmt(v, limit=160):
    s = json.dumps(v, ensure_ascii=False, sort_keys=True)
    return s if len(s) <= limit else s[:limit] + "..."


def order(node_id):
    """Номера нод в человеческом порядке: 9 раньше 10, буквы (V0, C1) - после чисел."""
    s = str(node_id)
    return (0, int(s)) if s.isdigit() else (1, s)


def is_node(v):
    """Похож ли словарь на ноду графа (класс + входы)."""
    return isinstance(v, dict) and "class_type" in v and "inputs" in v


def diff_graph(exp, got):
    """Отличия графа: списком понятных строк по номерам нод и полям входов."""
    out = []
    for nid in sorted(set(exp) | set(got), key=order):
        if nid not in got:
            out.append("нода %s: в новом графе её НЕТ (было: %s)" % (nid, fmt(exp[nid])))
        elif nid not in exp:
            out.append("нода %s: ПОЯВИЛАСЬ новая, эталон её не знает: %s" % (nid, fmt(got[nid])))
        elif exp[nid] != got[nid]:
            a, b = exp[nid], got[nid]
            if is_node(a) and is_node(b):
                if a.get("class_type") != b.get("class_type"):
                    out.append("нода %s: класс %s вместо %s" % (nid, b.get("class_type"), a.get("class_type")))
                ia, ib = a.get("inputs", {}), b.get("inputs", {})
                for field in sorted(set(ia) | set(ib), key=str):
                    if ia.get(field) != ib.get(field):
                        out.append("нода %s (%s): поле %s = %s вместо %s"
                                   % (nid, b.get("class_type"), field, fmt(ib.get(field)), fmt(ia.get(field))))
            else:
                out.append("нода %s: %s вместо %s" % (nid, fmt(b), fmt(a)))
    return out


def diff_stages(exp, got):
    """Отличия карты этапов: та же логика, но словами про этапы прогресса."""
    out = []
    for nid in sorted(set(exp) | set(got), key=order):
        if nid not in got:
            out.append("этап ноды %s пропал (было: %s)" % (nid, fmt(exp[nid])))
        elif nid not in exp:
            out.append("узел %s получил этап %s, в эталоне его нет" % (nid, fmt(got[nid])))
        elif exp[nid] != got[nid]:
            out.append("этап ноды %s: %s вместо %s" % (nid, fmt(got[nid]), fmt(exp[nid])))
    return out


def compare_one(name, got, golden_dir):
    """Сверка одного эталона: пустой список если всё совпало, иначе строки отличий."""
    path = golden_dir / (name + ".json")
    if not path.is_file():
        return ["нет файла эталона %s - создайте его: python tools/checks/golden.py --write" % path]
    text = path.read_text(encoding="utf-8")
    if text == canonical(got):                       # побайтовое совпадение - лучший случай
        return []
    exp = json.loads(text)
    lines = []
    for key in sorted(set(exp) | set(got)):
        if key not in got:
            lines.append("в новом ответе нет раздела %s" % key)
        elif key not in exp:
            lines.append("в эталоне нет раздела %s (новый ответ добавляет его)" % key)
        elif key == "graph":
            lines += diff_graph(exp[key], got[key])
        elif key == "stages":                        # карта этапов сверяется отдельно
            lines += diff_stages(exp[key], got[key])
        elif exp[key] != got[key]:
            lines.append("сверка %s: %s вместо %s" % (key, fmt(got[key]), fmt(exp[key])))
    return lines


def coverage(wf):
    """Список всех `def *_graph` в app/workflows.py и те, что ни одним эталоном не вызваны."""
    all_graphs = sorted(n for n in dir(wf) if n.endswith("_graph") and callable(getattr(wf, n)))
    return all_graphs, sorted(set(all_graphs) - USED)


def parse_args(argv):
    """Пути и режимы: --write, --golden <папка>, необязательный путь до репы."""
    write, golden_dir, repo_arg = False, None, None
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--write":
            write = True
        elif a == "--golden":
            if i + 1 >= len(argv):
                raise SystemExit("--golden требует путь до папки с эталонами")
            golden_dir = Path(argv[i + 1]).resolve()
            i += 1
        elif a in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        elif a.startswith("-"):
            raise SystemExit("незнакомый режим: %s (есть --write, --golden <папка>)" % a)
        else:
            repo_arg = a
        i += 1
    return write, golden_dir, repo_arg


def main(argv):
    write, golden_dir, repo_arg = parse_args(argv)
    repo = env.repo([repo_arg] if repo_arg else [], "golden.py")
    golden_dir = golden_dir or env.GOLDEN_DIR
    sys.path.insert(0, str(repo / "app"))
    import workflows as wf  # noqa: E402

    C = cases(wf)
    fails, built = [], []
    for name, build in C:
        try:
            built.append((name, build()))
        except Exception as e:                       # noqa: BLE001 - один случай не глушит остальные
            fails.append(name)
            print("   ПАДЕНИЕ  %s: %s: %s" % (name, type(e).__name__, str(e)[:200]))
    covered, uncovered = coverage(wf)
    print("репа: %s" % repo)
    print("эталоны: %s" % golden_dir)
    print("функций графа в app/workflows.py: %d, вызвано эталонами: %d" % (len(covered), len(USED)))
    if uncovered:
        print("ВНИМАНИЕ, ни один эталон не вызывает: %s" % ", ".join(uncovered))
    print()

    if write:
        golden_dir.mkdir(parents=True, exist_ok=True)
        for old in golden_dir.glob("*.json"):
            old.unlink()                             # ненужные эталоны не должны врать, что всё покрыто
        for name, data in built:
            (golden_dir / (name + ".json")).write_text(canonical(data), encoding="utf-8", newline="\n")
        print("создано эталонов: %d" % len(built))
        for name, _ in built:
            print("   %s.json" % name)
        print()
        print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
        return 1 if fails else 0

    missing_here = [n for n, _ in built if not (golden_dir / (n + ".json")).is_file()]
    for name, data in built:
        lines = compare_one(name, data, golden_dir)
        if lines:
            fails.append(name)
            print("   ПАДЕНИЕ  %s" % name)
            for line in lines[:12]:
                print("        " + line)
            if len(lines) > 12:
                print("        ... ещё %d отличий" % (len(lines) - 12))
        else:
            print("   OK   %-34s нод %d · этапов %d" % (name, len(data.get("graph", {})),
                                                        len(data.get("stages", {}))))
    if missing_here:
        print("   ПРОПУСК: %d эталонов ещё нет - создайте их: python tools/checks/golden.py --write"
              % len(missing_here))
    print()
    print("ИТОГ:", "всё чисто" if not fails else "падений: %d -> %s" % (len(fails), fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
