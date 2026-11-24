/* Голосовой ввод: запись с микрофона и распознавание речи.

   Модуль один на весь интерфейс: кнопка в чате сценариста и кнопки под полями «Сценарий» в
   режимах пользуются им, а не копируют друг друга. Запись всегда идёт одна - вторая кнопка не
   начинает второй поток, а кончает первую. Про то, скачана ли модель, модуль не догадывается:
   об этом спрашивает вызывающий через guard: про модель знает раздел, а не здесь. */
import { sharedAudioCtx, toast } from '../core/util.js';
import { wavSlice } from './audio.js';

let live = null;   // { mr, btn, stop } - одна живая запись

/* Слова из куска звука: тот же путь и для чата, и для режимов.
   Распознавание читает WAV; mp3 или m4a, отданные как есть, оно слышит обрывками -
   человек получал «начальное слово» вместо всей песни. Поэтому не-WAV сначала
   раскладывается браузером в WAV, а уж потом едет на распознавание. */
export async function transcribeWav(blob, lang = 'auto') {
  let b = blob;
  if (b && b.type !== 'audio/wav') {
    try {
      const buf = await sharedAudioCtx().decodeAudioData(await b.arrayBuffer());
      b = wavSlice(buf, 0, buf.duration);
    } catch (e) { /* что браузер не декодирует - уходит как есть: пусть распознавание пробует */ }
  }
  const fd = new FormData(); fd.append('file', b, 'a.wav'); fd.append('lang', lang);
  const r = await fetch('/api/speech/transcribe', { method: 'POST', body: fd });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Не удалось распознать');
  return j;
}

function stopLive() {
  if (!live) return;
  const rec = live; live = null;
  clearInterval(rec.timer);
  rec.btn.classList.remove('rec');
  rec.btn.title = rec.hint;
  rec.mr.stop();
}

/* Кнопка: нажал - говорит, нажал ещё раз - конец и распознавание.
   cfg: guard() - правда, если нельзя начать (модель не скачана);
        onText(text) - куда вставить распознанное; busy(text) - что писать в поле, пока думаем;
        hint - обычная подпись кнопки. */
export async function micToggle(btn, cfg) {
  if (live && live.btn === btn) { stopLive(); return; }
  if (live) { stopLive(); toast('Запись кончена: слушаем, что вы сказали'); return; }
  const hint = cfg.hint || 'Голосовой ввод: нажмите, говорите, нажмите ещё раз';
  /* Про скачанную модель спрашиваем и ЖДЁМ ответа: статус страницы мог ещё не прийти, и
     прежний отказ на пустом статусе заставлял человека нажимать кнопку дважды впустую. */
  if (cfg.guard && await cfg.guard()) return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    const chunks = [], t0 = Date.now(), mr = new MediaRecorder(stream);
    const rec = { mr, btn, hint, timer: null, stop: () => mr.stop() };
    live = rec; btn.classList.add('rec');
    const tick = () => { btn.title = `Идёт запись ${Math.round((Date.now() - t0) / 1000)} с — нажмите, чтобы закончить`; };
    tick(); rec.timer = setInterval(tick, 500);
    mr.ondataavailable = e => chunks.push(e.data);
    mr.onstop = async () => {
      clearInterval(rec.timer);
      stream.getTracks().forEach(t => t.stop());
      if (live === rec) live = null;
      btn.classList.remove('rec'); btn.title = hint;
      const undo = cfg.busy ? cfg.busy('Распознаём речь…') : null;
      try {
        const buf = await sharedAudioCtx().decodeAudioData(await new Blob(chunks).arrayBuffer());
        if (buf.duration < 0.4) throw new Error('Запись слишком короткая');
        const j = await transcribeWav(wavSlice(buf, 0, buf.duration));
        if (!j.text) toast('Речь не распознана — скажите ещё раз');
        else cfg.onText(j.text);
      } catch (e) { toast(e.message); }
      if (undo) undo();
    };
    mr.start();
  }).catch(() => toast('Нет доступа к микрофону. Разрешите его в окне Windows или подключите микрофон.'));
}
