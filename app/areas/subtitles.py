"""Субтитры готового клипа: распознать речь из
    его же звука, положить слова поверх видео, перевести на русский локальной моделью. Методы
    перенесены из app/server.py без правок."""

from aiohttp import web
from applog import applog
from datetime import datetime
from ffrun import _sub_run
from pathlib import Path
from srt import srt_build, srt_parse, srt_russian
import agent as ag
import aiohttp
import asyncio
import re
import speech
import subprocess
import tempfile
import time
import uuid


class SubtitlesMixin:
    """Методы области «subtitles»."""

    SUB_PLACES = ("bottom", "big", "center")   # куда ложатся слова: выбор человека в окне Библиотеки

    def _subtitles_read(self, ff, wh, src, lang):
        """Вынуть звук из клипа и распознать речь: возвращает реплики вместе с метками времени,
        весь текст и код языка, который whisper определил сам. Работает в рабочей нити; временные
        папка и файлы живут только пока идёт работа. wav называется in.wav и лежит в рабочей
        папке, поэтому в фильтре ffmpeg путь не надо ни экранировать, ни куда-то класть целиком."""
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            wav = work / "in.wav"
            r = _sub_run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                          "-vn", "-ac", "1", "-ar", "16000", wav.name], 600, work)
            if r.returncode != 0 or not wav.exists() or wav.stat().st_size < 1024:
                raise web.HTTPBadRequest(text="В этом клипе нет звуковой дорожки: распознавать нечего")
            # метки времени здесь нужны, поэтому не -nt, а -osrt: на выходе получится subs.srt
            r = _sub_run([wh["exe"], "-m", str(wh["model"]), "-f", wav.name, "-l", lang, "-osrt",
                          "-of", "subs", "-t", "6"], 1800, work)
            srt = work / "subs.srt"
            if r.returncode != 0 or not srt.exists():
                raise web.HTTPBadRequest(text="Речь не удалось распознать: " +
                                          ((r.stderr or "").strip().splitlines() or ["движок молчит"])[-1][:180])
            m = re.search(r"auto-detected language:\s*([a-z]{2,3})", r.stderr or "")
            cues = srt_parse(srt.read_text(encoding="utf-8", errors="replace"))
            text = " ".join(t for _, _, t in cues).strip()
            if not text:
                return {"error": "Речь в этом клипе не нашлась - субтитры не нужны"}
            return {"cues": cues, "text": text, "lines": len(cues),
                    "lang": m.group(1) if m else (lang if lang and lang != "auto" else "")}

    def _subtitles_burn(self, ff, src, place, cues):
        """Собрать subs.srt из реплик и положить слова поверх видео: ролик становится НОВЫМ
        файлом, исходник остаётся как был. Метки времени берутся прямо из реплик, поэтому
        перевод едет рядом со своими словами и время никуда не съезжает."""
        styles = {   # три варианта, о которых человек просит кнопкой
            "bottom": "FontName=Arial,FontSize=22,Bold=0,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=34",
            "big": "FontName=Arial,FontSize=34,Bold=1,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=48",
            "center": "FontName=Arial,FontSize=26,Bold=0,BorderStyle=1,Outline=2,Shadow=0,Alignment=5,MarginV=0",
        }
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            (work / "subs.srt").write_text(srt_build(cues), encoding="utf-8")
            out_dir = self.default_results_dir()
            out_dir.mkdir(parents=True, exist_ok=True)
            stem = re.sub(r'[\\/:*?"<>|]', "", src.stem)[:80] or "клип"
            out, n = out_dir / f"{stem}-субтитры.mp4", 1
            while out.exists():   # прежний ролик с субтитрами не затираем: ему добавляется -2, -3...
                n += 1
                out = out_dir / f"{stem}-субтитры-{n}.mp4"
            vf = "subtitles=subs.srt:force_style='%s'" % styles.get(place, styles["bottom"])
            cmd = [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", vf,
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart"]
            r = _sub_run(cmd + ["-c:a", "copy", out], 1800, work)
            if r.returncode != 0 or not out.exists() or out.stat().st_size < 2048:
                # звука может не быть вовсе (или он не переносится в mp4 без перекодирования):
                # пробуем ещё раз без него, чтобы слова не пропали из-за одной только дорожки
                out.unlink(missing_ok=True)
                r = _sub_run(cmd + ["-an", out], 1800, work)
            if r.returncode != 0 or not out.exists() or out.stat().st_size < 2048:
                out.unlink(missing_ok=True)
                raise web.HTTPBadRequest(text="Субтитры не леглись на видео: " +
                                          ((r.stderr or "").strip().splitlines() or ["ffmpeg отказал"])[-1][:180])
            return {"file": out, "text": " ".join(t for _, _, t in cues).strip(), "lines": len(cues)}

    async def _subtitles_llm(self):
        """Модель Агента, которой переводят субтитры: внятный отказ, если сейчас идёт генерация
        видео или самой модели ещё нет на диске. Возвращает (вариант модели, текст отказа)."""
        if self.jobs:
            return None, "Сейчас идёт генерация видео - поправите после"
        variant = await self.llm_variant()
        if not self.llm.installed(variant):
            return None, "Модель агента ещё не скачана: без неё переводить нечем"
        return variant, ""

    async def _subtitles_translate(self, cues):
        """Перевод реплик на русский локальной моделью Агента: все реплики уходят одним
        запросом, по одной строке на реплику; метки времени не трогаются. Если ответ пустой
        или строк пришло не столько, сколько было, остаются подлинные слова.
        Возвращает (реплики, перевод вышел, короткое пояснение по-русски)."""
        texts = [t for _, _, t in cues]
        variant, refuse = await self._subtitles_llm()
        if refuse:
            return cues, False, refuse
        try:
            if not self.llm.alive():
                # модель Агента встаёт в ту же память, где сейчас лежит видео: отдаём её,
                # иначе на карте в 16 ГБ перевод не запустится (тот же порядок, что у
                # перевода промпта в h_agent_translate)
                try:
                    await self.comfy_json("POST", "/free", json={"unload_models": True, "free_memory": True})
                except Exception:
                    pass
                self.llm.start(variant, ctx=self.agent_ctx())
                await ag.wait_ready(self.session, self.llm)
            system = ("Ты переводишь субтитры на русский язык. Переведи на русский каждую строку "
                      "отдельно. Строок в ответе должно быть ровно столько же, в том же порядке, "
                      "без номеров строк, без пустых строк, без пояснений и без чего-либо ещё, "
                      "кроме самого перевода. Если строка уже по-русски, верни её же, слово в слово.")
            payload = {"messages": [{"role": "system", "content": system},
                                    {"role": "user", "content": "\n".join(texts)}],
                       "stream": False, "temperature": 0.1, "max_tokens": min(8000, 60 * len(texts) + 200),
                       "chat_template_kwargs": {"enable_thinking": False}, "thinking_budget_tokens": 0}
            async with self.session.post(self.llm.url + "/v1/chat/completions", json=payload,
                                         timeout=aiohttp.ClientTimeout(total=600)) as r:
                if r.status != 200:
                    return cues, False, "модель ответила ошибкой %d - оставлено как сказано" % r.status
                data = await r.json()
            out = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
            # модель часто возвращает рамку, в которую её просили: переводу она не нужна
            while out[:3] in ("<<<", "```"):
                out = out[3:].lstrip()
            while out[-3:] in (">>>", "```"):
                out = out[:-3].rstrip()
            got = [re.sub(r"^\s*\d{1,3}\s*[.)]\s+", "", x).strip() for x in out.splitlines() if x.strip()]
            if not got or len(got) != len(texts):
                # реплик стало больше или меньше: лучше оставить подлинные слова, чем сдвинуть время
                return cues, False, "перевод не совпал по числу строк - оставлено как сказано"
            return [[a, b, tr] for (a, b, _), tr in zip(cues, got)], True, ""
        except Exception as e:
            return cues, False, "перевод не вышел: " + (str(e) or "модель молчит")[:120]

    async def h_subtitles(self, req):
        """Слова поверх готового клипа: речь из его звука распознаётся и ложится текстом в НОВЫЙ
        файл, который становится отдельной записью Библиотеки. Исходник не трогается. С полем
        translate распознанное переводится на русский локальной моделью Агента; время реплик
        остаётся тем же, а если перевод не вышел - остаются подлинные слова."""
        try:
            body = await req.json()
        except Exception:
            raise web.HTTPBadRequest(text="Не разобран запрос")
        item = self.library.get(str(body.get("id") or ""))
        if not item:
            raise web.HTTPBadRequest(text="Файл не найден")
        if item.get("kind") == "image":
            raise web.HTTPBadRequest(text="Субтитры кладутся на видео: в изображении речи нет")
        path = self.file_path(item)
        if not path or not path.exists():
            raise web.HTTPBadRequest(text="Файл клипа не найден: возможно, папка результатов очищена")
        ff = self._ffmpeg()
        if not ff:
            raise web.HTTPBadRequest(text="Не нашли ffmpeg: он идёт в комплекте с ComfyUI - проверьте, что ComfyUI на месте")
        wh = speech.locate(self.llm.root, self.config.get("whisper_dir"))
        if not (wh.get("exe") and wh.get("model")):
            raise web.HTTPBadRequest(text="Распознавание речи не установлено: скачайте его в разделе «Модели»")
        place = body.get("place") if body.get("place") in self.SUB_PLACES else "bottom"
        lang = body.get("lang") if body.get("lang") in ("auto", "ru", "en") else "auto"
        want = bool(body.get("translate"))   # просит ли человек перевести распознанное на русский
        if want:
            # про модель и очередь лучше сказать сразу: распознавание занимает минуты
            _, refuse = await self._subtitles_llm()
            if refuse:
                raise web.HTTPBadRequest(text=refuse)
        try:
            got = await asyncio.to_thread(self._subtitles_read, ff, wh, path, lang)
        except subprocess.TimeoutExpired:
            raise web.HTTPBadRequest(text="Клип слишком длинный: распознавание не успело закончиться. Возьмите кусок короче")
        if got.get("error"):
            return web.json_response({"ok": False, "error": got["error"]})
        cues, translated, why = got["cues"], False, ""
        if want:
            if srt_russian(got["text"]):
                why = "речь и так по-русски"   # переводить нечего, модель не дёргаем
            else:
                cues, translated, why = await self._subtitles_translate(got["cues"])
        try:
            burn = await asyncio.to_thread(self._subtitles_burn, ff, path, place, cues)
        except subprocess.TimeoutExpired:
            raise web.HTTPBadRequest(text="Клип слишком длинный: субтитры не успели лечь. Возьмите кусок короче")
        out = burn["file"]
        new = dict(item)   # запись строится по образцу исходной: те же поля просят список и просмотрщик
        new.update(id=uuid.uuid4().hex[:12], name=f"{path.stem} · субтитры",
                   file={"filename": out.name, "subfolder": "", "type": "local", "path": str(out)},
                   date=datetime.now().isoformat(timespec="seconds"), t=time.time(),
                   kind=item.get("kind") or "video", ext="mp4", fav=False,
                   sub="Субтитры" + {"bottom": " понизу", "big": " понизу, крупные", "center": " по центру"}[place],
                   subtitled={"place": place, "lang": got["lang"] or lang, "translated": translated})
        # адреса исходной записи новой не подходят: с ними новая запись указывала бы на прежний файл
        for k in ("local", "src", "src_file", "ref_group", "refs"):
            new.pop(k, None)
        if isinstance(new.get("size"), int):
            new["size"] = out.stat().st_size
        self.library.add(new)
        applog("субтитры: %s - реплик %d, вариант %s%s" % (out.name, burn["lines"], place,
                                                          ", перевод" if translated else ""))
        return web.json_response({"ok": True, "id": new["id"], "file": str(out),
                                  "text": burn["text"], "lines": burn["lines"],
                                  "translated": translated, "lang": got["lang"] or lang,
                                  **({"why": why} if why else {})})
