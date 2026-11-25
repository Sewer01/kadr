"""Сценарист: локальная модель, навыки, чаты, правописание и
    распознавание речи. Методы перенесены из app/server.py без правок."""

from aiohttp import web
from datetime import datetime
from formutil import re_chat_id
from pathlib import Path
from paths import DATA_DIR, ROOT
import agent as ag
import aiohttp
import asyncio
import re
import engine
import json
import speech


class AgentMixin:
    """Методы области «agent»."""

    # ---------- agent ----------

    def skill_public(self, s):
        return {k: s[k] for k in ("id", "name", "description", "builtin", "mode", "keywords")} | \
               {"refs": [r.name for r in s["refs"]]}

    async def h_agent_status(self, _req):
        variant = await self.llm_variant()
        v = ag.LLM_VARIANTS[variant]
        custom = self.config.get("llm_custom")
        vram = (self.hw or {}).get("vram_gb") or 0
        candidates = []
        if custom and custom.get("dir") and Path(custom["dir"]).is_dir():
            _, _, found = await asyncio.to_thread(ag.find_gguf, custom["dir"])
            candidates = [{"path": str(p), "name": p.name, "gb": round(p.stat().st_size / 1e9, 1),
                           "fits": ag.fits(p, vram), "current": str(p) == custom["model"]} for p in found]
        options = []
        for k, ov in ag.LLM_VARIANTS.items():
            mp, pp = ag.variant_files(self.llm.root, ov)
            options.append({"key": k, "title": ov["title"], "uncensored": bool(ov.get("uncensored")),
                            "size": ov["model_size"] + ov["mmproj_size"], "have": mp.exists() and pp.exists(),
                            "current": k == variant and not custom, "fits": vram >= ov.get("min_vram", 0),
                            "min_vram": ov.get("min_vram", 0)})
        return web.json_response({
            "variants": options,
            "my_model": ({"title": Path((custom or self.config.get("llm_custom_saved") or {}).get("model", "")).stem,
                          "current": bool(custom)} if (custom or (self.config.get("llm_custom_saved") or {}).get("model")) else None),
            "variant": variant, "title": Path(custom["model"]).stem if custom else v["title"],
            "size": 37e6 if custom else v["model_size"] + v["mmproj_size"], "candidates": candidates, "vram": vram,
            "custom": custom, "vision": self.llm.vision(variant), "has_model": self.llm.has_model(variant),
            "speech_ready": self.speech_status()["ready"], "speech_size": speech.MODEL_SIZE + speech.WHISPER_ZIP_SIZE,
            "speech": self.speech_status(),
            "ctx": self.agent_ctx() or v.get("ctx"), "ctx_default": v.get("ctx"), "ctx_custom": bool(self.agent_ctx()),
            "installed": self.llm.installed(variant), "running": self.llm.alive(),
            "installing": bool(self.agent_installer), "dir": str(self.llm.root), "managed": self.config.get("engine") == "managed",
            "dir_chosen": bool(self.config.get("llm_dir")) or self.config.get("engine") == "managed",
            "skills": [self.skill_public(s) for s in self.skills.list()],
        })

    async def h_agent_install(self, req):
        if self.agent_installer:
            return web.json_response({"error": "Уже скачивается"}, status=409)
        variant = await self.llm_variant()
        try:
            wanted = ((await req.json()).get("dir") or "").strip()
        except ValueError:
            wanted = ""
        if self.config.get("engine") != "managed" and not self.llm.installed(variant):
            # with the user's own ComfyUI nothing goes anywhere the user did not name
            if not wanted and not self.config.get("llm_dir"):
                return web.json_response({"error": "Сначала укажите папку, куда скачать помощника"}, status=400)
            if wanted:
                target = Path(wanted) if Path(wanted).name == "MinimaxH3_assistant" else Path(wanted) / "MinimaxH3_assistant"
                try:
                    target.mkdir(parents=True, exist_ok=True)
                except OSError:
                    return web.json_response({"error": "Не получается создать папку. Проверьте путь и диск"}, status=400)
                self.config.update(llm_dir=str(target))
                await self.llm_variant()

        async def emit(ev):
            await self.broadcast(dict(ev, type="agent_setup"))

        self.agent_installer = engine.Installer(ROOT, self.session, emit)

        async def run():
            try:
                await ag.install(self.agent_installer, self.llm.root, variant,
                                 runtime_only=bool(self.config.get("llm_custom")),
                                 whisper_dir=self.config.get("whisper_dir"))
                await emit({"step": "agent", "state": "done", "label": "Модель сценариста установлена"})
            except engine.Cancelled:
                await emit({"step": "agent", "state": "cancelled", "label": "Скачивание остановлено"})
            except Exception as e:
                await emit({"step": "agent", "state": "error", "label": str(e)})
            finally:
                self.agent_installer = None

        asyncio.create_task(run())
        return web.json_response({"ok": True})

    def speech_status(self):
        s = speech.locate(self.llm.root, self.config.get("whisper_dir"))
        return {"ready": s["ready"], "missing": s["missing"], "custom": s["custom"],
                "exe": str(s["exe"]) if s["exe"] else None, "model": s["model"].name if s["model"] else None,
                "model_size": s["model"].stat().st_size if s["model"] else 0,
                "better": speech.better_state(self.llm.root, self.config.get("whisper_dir"))}

    async def h_speech_model(self, req):
        """Fetch the accurate whisper model. `small` mangles lyrics, and the app starts using the
        better file the moment it lies in the models folder - nothing else has to be switched."""
        if self.agent_installer:
            return web.json_response({"error": "Уже скачивается"}, status=409)
        st = speech.better_state(self.llm.root, self.config.get("whisper_dir"))
        if st.get("custom"):
            return web.json_response({"error": "Вы указали свою папку whisper: файл нужен в неё. "
                                               "Скачайте ggml-large-v3-turbo-q5_0.bin и положите рядом со своей моделью"}, status=400)

        async def emit(ev):
            await self.broadcast(dict(ev, type="agent_setup"))

        self.agent_installer = engine.Installer(ROOT, self.session, emit)

        async def run():
            try:
                await speech.install_better(self.agent_installer, self.llm.root)
                await emit({"step": "agent", "state": "done", "label": "Модель распознавания речи: точная версия на месте"})
            except engine.Cancelled:
                await emit({"step": "agent", "state": "cancelled", "label": "Скачивание остановлено"})
            except Exception as e:
                await emit({"step": "agent", "state": "error", "label": str(e)})
            finally:
                self.agent_installer = None

        asyncio.create_task(run())
        return web.json_response({"ok": True, "name": st["name"], "size": st["size"]})

    async def h_agent_ctx(self, req):
        """How much text the agent holds at once. More fits a long dialogue and many scenes, and it
        costs memory: the model is unloaded here, so the next request pays the loading time once."""
        body = await req.json()
        try:
            v = int(body.get("ctx") or 0)
        except (TypeError, ValueError):
            v = 0
        if v and not 8192 <= v <= 262144:
            return web.json_response({"error": "Размер контекста должен быть от 8192 до 262144 токенов"}, status=400)
        self.config.update(llm_ctx=v or None)
        variant = await self.llm_variant()
        await self.stop_llm()
        default = ag.LLM_VARIANTS.get(variant, {}).get("ctx")
        return web.json_response({"ok": True, "ctx": v or default, "custom": bool(v), "default": default,
                                  "note": "Модель выгружена: следующий запрос поднимет её с новым размером"})

    async def h_agent_spell(self, req):
        """Spelling help for the right mouse button in a prompt field: variants of one word, or a
        clean copy of the whole text. The local model does it, so nothing leaves the computer."""
        body = await req.json()
        word = (body.get("word") or "").strip()[:64]
        text = (body.get("text") or "").strip()[:4000]
        if not word and not text:
            return web.json_response({"error": "Пустое слово и пустой текст"}, status=400)
        if self.jobs:
            return web.json_response({"error": "Сейчас идёт генерация видео - поправите после"}, status=409)
        variant = await self.llm_variant()
        if not self.llm.installed(variant):
            return web.json_response({"error": "Модель сценариста ещё не скачана."}, status=400)
        try:
            if not self.llm.alive():
                self.llm.start(variant, ctx=self.agent_ctx())
                await ag.wait_ready(self.session, self.llm)
            if word:
                system = ("Ты проверяешь написание слов. Ответь не больше трёх правильных написаний "
                          "запрошенного слова, каждое с новой строки, без кавычек, без пояснений, без нумерации. "
                          "Если слово написано правильно, ответь ровно одной строкой: ОК.")
                user = "Слово: " + word + " | Его окружение в тексте: " + text + " | Ответ:"
            else:
                system = ("Поправь орфографию и пунктуацию. Смысл, порядок слов и язык не меняй; "
                          "теги <Picture N>, <Video N>, <Audio N>, реплики <d>[Язык] ...</d>, строки SCENE N | секунды "
                          "и названия полей промпта оставь дословно. Ответь только исправленным текстом.")
                user = "Исправь написания в тексте между чертами. Текст: <<< " + text + " >>>"
            payload = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                       "stream": False, "temperature": 0.1, "max_tokens": 900 if word else 3000,
                       "chat_template_kwargs": {"enable_thinking": False}, "thinking_budget_tokens": 0}
            async with self.session.post(self.llm.url + "/v1/chat/completions", json=payload,
                                         timeout=aiohttp.ClientTimeout(total=240)) as r:
                if r.status != 200:
                    return web.json_response({"error": f"Модель ответила ошибкой {r.status}"}, status=502)
                data = await r.json()
            out = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
            if not word:
                # the model often hands back the frame it was given: the field must get plain text
                while out[:3] in ("<<<", "```"):
                    out = out[3:].lstrip()
                while out[-3:] in (">>>", "```"):
                    out = out[:-3].rstrip()
                return web.json_response({"text": out})
            if out.upper().startswith("ОК") or out.upper().startswith("OK"):
                return web.json_response({"variants": [], "clean": True})
            seen, vars_ = set(), []
            for line in out.splitlines():
                cand = line.strip().strip("'\u0022`\u00ab\u00bb.,:;-— ").split(" ")[0][:40]
                if cand and cand.lower() != word.lower() and cand.lower() not in seen:
                    seen.add(cand.lower())
                    vars_.append(cand)
            return web.json_response({"variants": vars_[:3]})
        except Exception as e:
            return web.json_response({"error": str(e) or "Не удалось проверить написание"}, status=500)

    async def h_speech_folder(self, req):
        """Use whisper files the user already has (or go back to the app's own copy)."""
        body = await req.json()
        await self.llm_variant()
        if body.get("reset"):
            self.config.update(whisper_dir=None)
        else:
            folder = (body.get("dir") or "").strip().strip('"')
            if not Path(folder).is_dir():
                return web.json_response({"error": f"Папка не найдена: {folder}"}, status=400)
            found = await asyncio.to_thread(speech.locate, self.llm.root, folder)
            if not (speech._find_exe(folder) or speech._find_model(folder)):
                return web.json_response({"error": "В папке нет ни whisper-cli.exe, ни модели ggml-*.bin "
                                                   "(нужна многоязычная модель, не «.en»)."}, status=400)
            self.config.update(whisper_dir=folder)
        return await self.h_agent_status(req)

    async def h_transcribe(self, req):
        """Words from an audio clip (WAV from the browser) - lyrics for lipsync prompts and voice input."""
        await self.llm_variant()  # keeps llm.root in sync with the install folder
        if not self.speech_status()["ready"]:
            return web.json_response({"error": "Распознавание речи ещё не скачано (карточка «Модель» в разделе «Сценарист»)."},
                                     status=400)
        wav, lang = None, "auto"
        async for field in await req.multipart():
            if field.name == "file":
                wav = await field.read()
            elif field.name == "lang":
                lang = (await field.text()).strip() or "auto"
        if not wav:
            return web.json_response({"error": "Нет аудио"}, status=400)
        try:
            text, code, name = await speech.transcribe(self.llm.root, wav, lang, self.config.get("whisper_dir"))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        return web.json_response({"text": text, "lang": code, "lang_name": name})

    async def h_agent_variant(self, req):
        """Choose which of the app's own models the agent uses (Gemma / Qwen, with or without refusals)."""
        key = (await req.json()).get("variant")
        if key not in ag.LLM_VARIANTS:
            return web.json_response({"error": "Неизвестная модель"}, status=400)
        cur = self.config.get("llm_custom")
        # the user's own model is not lost: it stays as «Моя модель» and can be switched back on
        self.config.update(llm_variant=key, llm_custom=None, **({"llm_custom_saved": cur} if cur else {}))
        await self.stop_llm()
        return await self.h_agent_status(req)

    async def h_agent_variant_delete(self, req):
        """Сбросить скачанные файлы одной из моделей приложения: человек скачал
        лишнее и хочет вернуть место на диске. Выбранную модель не даём:
        сценарист должен остаться рабочим."""
        key = (await req.json()).get("variant")
        v = ag.LLM_VARIANTS.get(key)
        if not v:
            return web.json_response({"error": "Неизвестная модель"}, status=400)
        if self.agent_installer:
            return web.json_response({"error": "Скачивание идёт: дождитесь его или отмените."}, status=409)
        if key == await self.llm_variant() and not self.config.get("llm_custom"):
            return web.json_response({"error": "Нельзя удалять выбранную модель: сначала выберите другую."}, status=409)
        await self.stop_llm()   # файлы могут лежать в памяти запущенной модели
        m, p = ag.variant_files(self.llm.root, v)
        gone = 0
        for f in (m, p):
            try:
                if f and f.exists():
                    f.unlink()
                    gone += 1
            except OSError as e:
                return web.json_response({"error": f"Не вышло удалить файл: {e}"}, status=500)
        if not gone:
            return web.json_response({"error": "Файлов этой модели на диске нет."}, status=404)
        return await self.h_agent_status(req)

    async def h_agent_model(self, req):
        """Use a GGUF model the user already has (or go back to the app's own Gemma)."""
        body = await req.json()
        if body.get("reset"):
            cur = self.config.get("llm_custom")
            self.config.update(llm_custom=None, **({"llm_custom_saved": cur} if cur else {}))
        elif body.get("restore"):
            saved = self.config.get("llm_custom_saved")
            if not saved or not Path(saved.get("model", "")).exists():
                return web.json_response({"error": "Файл вашей модели не найден"}, status=400)
            self.config.update(llm_custom=saved)
        else:
            folder = (body.get("dir") or "").strip().strip('"')
            if not Path(folder).is_dir():
                return web.json_response({"error": f"Папка не найдена: {folder}"}, status=400)
            if self.hw is None:
                self.hw = await asyncio.to_thread(engine.detect_hardware)
            model, proj, models = await asyncio.to_thread(ag.find_gguf, folder, body.get("model"), self.hw.get("vram_gb"))
            if not model:
                return web.json_response({"error": "В папке нет моделей .gguf. Нужна обычная Gemma в формате GGUF "
                                                   "(версия для LTX в text_encoders не подойдёт)."}, status=400)
            self.config.update(llm_custom={"model": str(model), "mmproj": str(proj) if proj else None, "dir": folder})
        await self.stop_llm()
        return await self.h_agent_status(req)

    async def h_agent_install_cancel(self, _req):
        if self.agent_installer:
            self.agent_installer.cancelled = True
        return web.json_response({"ok": True})

    async def _compress(self, messages):
        """Короткий пересказ прежнего разговора, когда он перестал влезать в контекст.

        Старые реплики модель пересказывает сама в несколько абзацев, последние
        реплики остаются дословно. Касается только запроса к модели: чат человека
        не переписывается - там по-прежнему полный разговор."""
        keep = 4   # последние реплики всегда при себе, пересказ - только про прежнее
        if len(messages) <= keep + 2:
            return None
        head, tail = messages[:-keep], messages[-keep:]

        def flat(ms):
            out = []
            for m in ms:
                c = m.get("content")
                if isinstance(c, list):
                    c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
                txt = (c or "").strip()
                if txt:
                    out.append(("Человек: " if m.get("role") == "user" else "Сценарист: ") + txt)
            return "\n\n".join(out)

        text = flat(head)
        if not text:
            return None
        if len(text) > 26000:   # пересказываемое тоже должно влезть в один запрос
            text = text[:9000] + "\n…\n" + text[-17000:]
        payload = {"messages": [
            {"role": "system", "content":
                "Сделай короткий пересказ этого разговора человека с сценаристом видеоролика: до 1200 знаков, по-русски. "
                "Обязательно сохрани: о чём ролик, согласованные решения и тексты (кратко), имена героев и теги файлов, "
                "что осталось сделать. Это будет вся память о разговоре - не выдумывай ничего, чего в разговоре не было. "
                "Ответ - только пересказ."},
            {"role": "user", "content": text}],
            "stream": False, "temperature": 0.2, "chat_template_kwargs": {"enable_thinking": False},
            "thinking_budget_tokens": 0}
        try:
            async with self.session.post(self.llm.url + "/v1/chat/completions", json=payload,
                                         timeout=aiohttp.ClientTimeout(total=300)) as r:
                if r.status != 200:
                    return None
                j = await r.json()
                summ = ((j.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
        except Exception:
            return None
        if not summ:
            return None
        return [{"role": "user", "content":
                 "[Краткий пересказ прежнего разговора - целиком он не влез в контекст]\n" + summ}] + tail

    async def h_agent_chat(self, req):
        body = await req.json()
        messages = body.get("messages") or []
        target = body.get("target") if body.get("target") in ag.AGENT_TARGETS else "video"
        ctx = body.get("ctx") or {}
        # a fix talks about the pictures of this very message; a continuation of the story keeps the whole chat
        editing = bool(body.get("editing", True))
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
        await resp.prepare(req)

        async def send(obj):
            await resp.write(f"data: {ag.dumps(obj)}\n\n".encode())

        try:
            if self.jobs:   # the agent's model would compete with the video for video memory: wait for
                            # the end of the generation and then start by itself - the old words promised
                            # exactly this, while the answer was a refusal
                waited = 0
                while self.jobs:
                    if req.transport is None or req.transport.is_closing():   # the person pressed «Стоп» or left
                        return resp
                    await send({"type": "status", "text": f"Идёт генерация видео — сценарист запустится сам, когда она закончится… (ждём {waited // 60}:{waited % 60:02d})"})
                    await asyncio.sleep(3)
                    waited += 3
            variant = await self.llm_variant()
            if not self.llm.installed(variant):
                raise RuntimeError("Модель сценариста ещё не скачана.")
            if not self.llm.alive():
                await send({"type": "status", "text": "Освобождаем видеопамять…"})
                try:
                    await self.comfy_json("POST", "/free", json={"unload_models": True, "free_memory": True})
                except Exception:
                    pass
                await send({"type": "status", "text": f'Загружаем {ag.LLM_VARIANTS[variant]["title"]}… (до минуты)'})
                self.llm.start(variant, ctx=self.agent_ctx())
                await ag.wait_ready(self.session, self.llm)

            if not self.llm.vision(variant) and any(m.get("images") for m in messages):
                # without a vision projector the model cannot take pictures
                messages = [dict(m, images=None) for m in messages]
                await send({"type": "status", "text": "У этой модели нет файла «зрения» (mmproj) — изображения она не увидит"})
            # frames cut out of a video are the last pictures of a message and are not hero pictures (Picture N)
            users = [m for m in messages if m.get("role") == "user"]
            # a fix is about the pictures of this very message, so Picture N is counted there and not over the chat
            counted = users[-1:] if editing and users else users
            ctx["images"] = sum(max(0, len(m.get("images") or []) - int(m.get("frames") or 0)) for m in counted)
            active = self.skills.active(ag.chat_text(messages), target)
            if ctx.get("cont") and not any(s["id"] == "prodolzhenie-video" for s in active):
                # continuing a finished video has its own craft rules, whatever the words happened to match
                active += [s for s in self.skills.list() if s["id"] == "prodolzhenie-video" and s["mode"] != "off"]
            if target == "actor" and not any(s["id"] == "akterskaya-igra" for s in active):
                # this mode is acting-first: its skill is always on here
                active += [s for s in self.skills.list() if s["id"] == "akterskaya-igra" and s["mode"] != "off"]
            if target in ("long", "action", "actionsc", "clipsc") and not any(s["id"] == "sceny-studii" for s in active):
                # these studios work scene by scene: whatever the person wrote, the answer
                # has to come back as a scene sheet, or the studio cannot build the scenes
                active += [s for s in self.skills.list() if s["id"] == "sceny-studii" and s["mode"] != "off"]
            await send({"type": "skills", "names": [s["name"] for s in active]})
            system = ag.system_prompt("\n\n".join(self.skills.text(s) for s in active), target, ctx, editing=editing)
            await send({"type": "status", "text": "Читаю скиллы и думаю…"})

            thinking = False
            # локальная Qwen иногда срывается в иероглифы; один раз появившись, китайский
            # оседает в истории чата и копируется дальше. поэтому: ответ собираем, иероглифы
            # ловим, один раз молча перезапрашиваем, а плохой текст в чат не отдаём
            cjk = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
            for attempt in (0, 1, 2):   # 0: всё как есть; 1: без кадров; 2: прежний разговор ложится коротким пересказом
                if attempt == 2:
                    await send({"type": "status", "text": "Места в контексте не хватило: пересказываю прежний разговор коротко…"})
                    cm = await self._compress(messages)
                    if cm is None:
                        raise RuntimeError("Разговор не влезает в контекст даже коротким пересказом. "
                                           "Начните новый чат - он освободит место")
                    messages = cm
                    await send({"type": "status", "text": "Прежний разговор встал коротким пересказом (ваш чат не тронут), продолжаю"})
                    thinking = False
                conv, notes = ag.to_openai(messages, max_frames=(10 if attempt == 0 else 0))
                if attempt == 1:
                    await send({"type": "status", "text": "В контексте не уместилось: убираю все кадры и пробую ещё раз"})
                elif notes and not attempt:
                    await send({"type": "status", "text": "Места в контексте мало: " + ", ".join(notes)})
                payload = {"messages": [{"role": "system", "content": system}] + conv,
                           "stream": True, "temperature": 0.35, "cache_prompt": True}
                if body.get("think") != "deep":
                    # "fast" (default): no hidden reasoning before the answer. On the user's machine a light request took 17 s with it
                    # (about 2000 characters of thoughts) and 1.5 s without; the long-video rules took minutes with it
                    payload["chat_template_kwargs"] = {"enable_thinking": False}
                    payload["thinking_budget_tokens"] = 0
                async with self.session.post(self.llm.url + "/v1/chat/completions", json=payload,
                                             timeout=aiohttp.ClientTimeout(total=None, sock_read=600)) as r:
                    if r.status != 200:
                        why = (await r.text())[:300]
                        if "exceed_context" in why and attempt < 2:
                            continue   # lighter payload on the next pass
                        if "exceed_context" in why:
                            why += (". Увеличьте длину контекста ползунком «Контекст» в разделе «Сценарист» "
                                    "или начните новый чат - старый диалог занимает место")
                        raise RuntimeError(f"Модель ответила ошибкой {r.status}: {why}")
                    got = []                     # ответ собираем целиком: по нему решаем, отдавать ли его в чат
                    async for raw in r.content:
                        line = raw.decode("utf-8", errors="replace").strip()
                        if not line.startswith("data:") or line == "data: [DONE]":
                            continue
                        delta = (json.loads(line[5:]).get("choices") or [{}])[0].get("delta", {})
                        if delta.get("content"):
                            got.append(delta["content"])
                        elif delta.get("reasoning_content") and not thinking:
                            thinking = True
                            await send({"type": "status", "text": "Думаю над сценой…"})
                    text = "".join(got)
                    if cjk.search(text) and attempt == 0:
                        # иероглифы в ответе: в чат это не идёт, просим переписать один раз
                        await send({"type": "status", "text": "В ответе попались иероглифы - переписываю по-русски…"})
                        messages = messages + [{"role": "assistant", "content": text},
                                               {"role": "user", "content": "В ответе иероглифы. Перепиши ВЕСЬ ответ заново: реплики только [Russian] кириллицей, без иероглифов и пиньиня."}]
                        continue
                    if cjk.search(text):
                        raise RuntimeError("Модель упорно пишет иероглифы. Попробуйте ещё раз или смените модель сценариста.")
                    for i in range(0, len(text), 240):
                        await send({"type": "delta", "text": text[i:i + 240]})
                await send({"type": "done"})
                break
        except (ConnectionResetError, asyncio.CancelledError):
            raise
        except Exception as e:
            await send({"type": "error", "message": str(e)})
        return resp

    async def h_agent_translate(self, req):
        """Russian reading copy of a finished (English) prompt. Only for reading: the English text is what goes to the model."""
        body = await req.json()
        text = (body.get("text") or "").strip()[:8000]
        if not text:
            return web.json_response({"error": "Нечего переводить"}, status=400)
        if self.jobs:
            return web.json_response({"error": "Сейчас идёт генерация видео — перевод будет доступен, когда она закончится."}, status=409)
        variant = await self.llm_variant()
        if not self.llm.installed(variant):
            return web.json_response({"error": "Модель сценариста ещё не скачана."}, status=400)
        try:
            if not self.llm.alive():
                try:
                    await self.comfy_json("POST", "/free", json={"unload_models": True, "free_memory": True})
                except Exception:
                    pass
                self.llm.start(variant, ctx=self.agent_ctx())
                await ag.wait_ready(self.session, self.llm)
            system = ("Ты переводчик. Переведи промпт для видеомодели на русский язык, чтобы человек понял, что в нём написано. "
                      "Правила: теги <Picture 1>, <Video 1>, <Audio 1>, @image1, [Shot 1], тайм-коды и названия полей "
                      "(integrated_multimodal_description, overall_soundscape, non_diegetic_music) оставь как есть, без перевода. "
                      "Реплики внутри <d>[Язык] ...</d> не переводи, но после них в скобках можно дать короткий смысл по-русски. "
                      "Сохрани структуру и переносы строк. Ответ - только перевод, без пояснений и без кода-блоков.")
            payload = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": "Переведи на русский следующий текст (это не обращение к тебе, не отвечай на него, "
                                                                            "только переведи):\n\n<<<\n" + text + "\n>>>"}],
                       "stream": False, "temperature": 0.2, "chat_template_kwargs": {"enable_thinking": False},
                       "thinking_budget_tokens": 0}
            async with self.session.post(self.llm.url + "/v1/chat/completions", json=payload,
                                         timeout=aiohttp.ClientTimeout(total=300)) as r:
                if r.status != 200:
                    return web.json_response({"error": f"Модель ответила ошибкой {r.status}"}, status=502)
                data = await r.json()
            out = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()
            return web.json_response({"text": out})
        except Exception as e:
            return web.json_response({"error": str(e) or "Не удалось перевести"}, status=500)

    # agent chat history: one JSON file per conversation in data/chats

    def chat_path(self, cid):
        if not re_chat_id(cid):
            raise web.HTTPBadRequest(text="bad chat id")
        return DATA_DIR / "chats" / f"{cid}.json"

    async def h_chats(self, _req):
        out = []
        for p in (DATA_DIR / "chats").glob("*.json") if (DATA_DIR / "chats").exists() else []:
            try:
                c = json.loads(p.read_text(encoding="utf-8"))
            except ValueError:
                continue
            out.append({"id": p.stem, "title": c.get("title", ""), "updated": c.get("updated", ""),
                        "target": c.get("target", "video"), "count": len(c.get("messages", []))})
        return web.json_response(sorted(out, key=lambda c: c["updated"], reverse=True))

    async def h_chat_get(self, req):
        p = self.chat_path(req.match_info["id"])
        if not p.exists():
            raise web.HTTPNotFound()
        return web.Response(text=p.read_text(encoding="utf-8"), content_type="application/json")

    async def h_chat_put(self, req):
        p = self.chat_path(req.match_info["id"])
        body = await req.json()
        keep = ("role", "content", "images", "skills", "error", "nframes")
        msgs = []
        for m in body.get("messages") or []:
            if m.get("role") not in ("user", "assistant"):
                continue
            one = {k: m.get(k) for k in keep if m.get(k)}
            if "edit" in m:
                one["edit"] = bool(m["edit"])  # правка это была или продолжение: иначе ответ возвращается слепым
            msgs.append(one)
        first = next((m.get("content", "") for m in msgs if m["role"] == "user"), "") or "Без названия"
        data = {"title": (body.get("title") or first).strip().replace("\n", " ")[:80], "target": body.get("target", "video"),
                "updated": datetime.now().isoformat(timespec="seconds"), "messages": msgs}
        # лоток вложений и песни сцен: без них чат возвращается текстом без файлов,
        # и перенести фото сцены в раздел после этого уже невозможно
        att = body.get("att") or []
        auds = body.get("auds") or []
        if len(att) + len(auds) < 400:
            data["att"] = att
            data["auds"] = auds
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return web.json_response({"ok": True, "title": data["title"]})

    async def h_chat_delete(self, req):
        self.chat_path(req.match_info["id"]).unlink(missing_ok=True)
        return web.json_response({"ok": True})

    async def h_chats_clear(self, _req):
        for p in (DATA_DIR / "chats").glob("*.json") if (DATA_DIR / "chats").exists() else []:
            p.unlink(missing_ok=True)
        return web.json_response({"ok": True})

    async def h_skill_upload(self, req):
        files = []
        async for field in await req.multipart():
            if field.filename:
                files.append((field.filename.replace("\\", "/"), await field.read()))
        try:
            sid = await asyncio.to_thread(self.skills.save_upload, files)
        except ValueError as e:
            return web.json_response({"error": str(e)}, status=400)
        return web.json_response({"ok": True, "id": sid})

    async def h_skill_patch(self, req):
        body = await req.json()
        try:
            self.skills.save_settings(req.match_info["id"], body.get("mode"), body.get("keywords"))
        except ValueError as e:
            raise web.HTTPBadRequest(text=str(e))
        return web.json_response({"ok": True})

    async def h_skill_delete(self, req):
        try:
            self.skills.delete(req.match_info["id"])   # the name comes from the address and ends in a folder removal
        except ValueError as e:
            raise web.HTTPBadRequest(text=str(e))
        return web.json_response({"ok": True})
