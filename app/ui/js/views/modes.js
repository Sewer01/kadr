import { API, postJSON } from '../core/net.js';
import { $, $$, GB, ICON_AUD, ICON_IMG, ICON_VID, confirmBox, copyText, foldSlots, isImage, normItem, noteMsg, paintRange, sceneReconcile, toast, watchSlots } from '../core/util.js';
import { REF_HINT } from '../core/modes.js';
import { LIB, MEM, QUEUE, abuf, audioName, byId, memFile, memSave, openId, openItem, registerViews, setClipAudio, setUpJob, views } from '../core/state.js';
import { goTo, onNav } from '../core/tabs.js';
import { AudioRow, AudioTrimmer, VideoTrimmer, actx, wavSlice, setActx } from '../ui/audio.js';
import { ASPECTS, QUALITY, QUALITY_ALL, loraForm, mountLoras, paramsCard, r32, resFor, seedForm, sizeForm, useSeed } from '../ui/params.js';
import { previewPanel } from '../ui/preview.js';
import { audioTokens, ownWords, scenarioResolvers, scenarioTagRow, scenarioWindow, sceneAudioPlan } from '../ui/scenario.js';
import { fitAspect, fitSlot, repeatRefs, resetSlot, wireDrop, wireSlotSwap } from '../ui/slots.js';
import { AG, agAttachFile, agCtx, agDraftOut, agGenerate, agGo, agMakeBtn, agPickTarget, agRefWarn, agScenesText, agStatus, agWords, agWordsFor, hGrip, hGripAfter, setChatAudio, showAudioBox, speechReady, wordsIntoPrompt } from './agent.js';
import { transcribeWav } from '../ui/mic.js';
import { addToLib, closeViewer, openUpscale, openViewer, renderLib, setFav } from './library.js';
import { mdStart } from './models.js';
import { PR, presetsHave, presetsPaint } from './presets.js';
import { errSay, jobView } from './queue.js';
import { libToFile } from './workflows.js';

/* ---------- VIDEO view ---------- */
export const V = { aspect: '16:9', q: '720p', dur: 5, first: false, last: false, len: () => V.dur };
export const vPrev = previewPanel($('#vPreview'), V, {
  extraLabel: 'Режим',
  extra: () => V.first && V.last ? 'Кадр -> кадр' : V.first ? 'Изображение -> видео' : 'Текст -> видео',
  validate: () => !$('#vPrompt').value.trim() ? 'Напишите промпт' : '',
  passes: () => [V.accel === 'sla' ? 4 : 8],
  target: () => $('#dFirst img'),
  real: {
    url: '/api/generate/video',
    form: () => {
      const fd = new FormData();
      fd.append('prompt', $('#vPrompt').value.trim());
      fd.append('note', ownWords($('#vPrompt')));      // our own words from the scenario field
      sizeForm(V, fd); fd.append('aspect', V.aspect); fd.append('quality', V.q); fd.append('duration', V.dur);
      seedForm(V, fd);
      if ($('#dFirst')._file) fd.append('first', $('#dFirst')._file);
      fd.append('accel', V.accel === 'sla' ? 'sla' : '');
      const loop = $('#vLoop').checked && $('#dFirst')._file;
      if (loop) fd.append('loop', '1');
      else if ($('#dFirst')._file && $('#dLast')._file) fd.append('last', $('#dLast')._file);
      return fd;
    },
  },
  meta: () => ({ mode: 'video', prompt: $('#vPrompt').value.trim(), sub: $('#vLoop').checked && V.first ? 'Зацикленное видео' : V.first && V.last ? 'Кадр -> кадр' : V.first ? 'Изображение -> видео' : 'Текст -> видео' }),
  onDone: item => addToLib(item),
});
$('#vLoop').onchange = () => { $('#dLast').style.opacity = $('#vLoop').checked ? .4 : ''; vPrev(); };
export const vUpd = paramsCard($('#vParams'), V, { n: 3, duration: true, onChange: () => { vPrev(); vMode(); try { agCtx(); } catch (e) {} },
  extraRow: `<div class="row"><div class="row-l">Ускорение <span class="hint">для слабых видеокарт</span></div>
    <div class="seg v-accel" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button type="button" data-ac="normal">Обычное<small>как раньше</small></button><button type="button" data-ac="sla">Быстрый черновик<small>в 1,3 раза быстрее, качество ниже</small></button></div>
    <div class="hint v-achint" hidden></div><div class="hint" style="margin-top:6px">«Быстрый черновик» нужен для проб: это скорость, а не увеличение размера. Для готового ролика выбирайте «Обычное».</div></div>` });
export function vAccUpd() { $$('.v-accel button').forEach(b => b.classList.toggle('on', (b.dataset.ac === 'sla') === (V.accel === 'sla'))); }
export async function vAccCheck() {
  const hint = $('.v-achint'); hint.hidden = true; hint.innerHTML = '';
  if (V.accel !== 'sla') return;
  try {
    const st = await (await fetch('/api/status')).json();
    const m = (st.models || []).find(x => x.role === 'sla_lora');
    if (m && !m.have) {
      hint.hidden = false;
      hint.innerHTML = `Для быстрого режима нужен файл ускорения (${GB(m.size)}). <button class="btn mini pri" type="button" id="vAccDl">Скачать</button> <span class="hint" id="vAccProg"></span>`;
      $('#vAccDl').onclick = () => { mdStart(['sla_lora']); };
    }
  } catch {}
}
$('#vParams').addEventListener('click', e => {
  const b = e.target.closest('.v-accel button'); if (!b) return;
  V.accel = b.dataset.ac; vAccUpd(); vAccCheck(); vPrev();
});
vAccUpd(); vAccCheck();
export function vMode() {
  $('#vMode').textContent = 'Режим: ' + (V.first && V.last ? 'видео между двумя кадрами' : V.first ? 'изображение -> видео' : 'видео по тексту');
  $('#dLast').classList.toggle('disabled', !V.first);
  $('#lastHint').textContent = V.first ? 'необязательно' : 'сначала загрузите первый';
}
export const lastDrop = wireDrop($('#dLast'), on => { V.last = on; vUpd(); });
// the first frame decides the composition, so the format always follows it
wireDrop($('#dFirst'), (on, img) => { V.first = on; if (!on) lastDrop.clear(); vUpd(); if (on) fitAspect(V, img, vUpd, true); });
$('#vPrompt').oninput = e => $('#vCount').textContent = e.target.value.length + ' символов';
// one click instead of picking the page apart by hand
$('#vClear').onclick = () => {
  const pics = ['#dFirst', '#dLast'].filter(s => $(s).classList.contains('filled')), txt = $('#vPrompt').value.trim();
  if (!pics.length && !txt) { toast('Здесь и так пусто'); return; }
  confirmBox('Очистить «Видео»?',
    `Уберём${pics.length ? ' картинки (' + pics.length + ' шт.) и' : ''} промпт. Готовые видео в Библиотеке останутся.`, 'Очистить', () => {
      pics.forEach(s => $(s + ' .x').click());
      $('#vPrompt').value = ''; $('#vPrompt').oninput({ target: $('#vPrompt') });
      const prev = $('#vPreview'); if (prev && prev._reset) prev._reset();   // and the preview panel with the result
      toast('Раздел очищен');
    });
};
vUpd();

/* ---------- LIPSYNC view ---------- */
export const L = { aspect: '9:16', q: '1080p', refSize: 'max', start: 0, end: 0, dur0: 0, refs: 0, len: () => Math.max(0, L.end - L.start) };
export const MAX_LEN = 15, REC_LEN = 12;
export const lPrev = previewPanel($('#lPreview'), L, {
  extraLabel: 'Проходы',
  extra: () => {
    const [w, h] = resFor(L.aspect, L.q), s = QUALITY_ALL.find(x => x.id === L.q).px >= 1824 * 1024 ? 2 : 1.5;
    return `${r32(w / s)}×${r32(h / s)} -> ×${s}`;
  },
  passes: () => [8, 4],
  twoPass: true,
  real: {
    url: '/api/generate/lipsync',
    form: () => {
      const fd = new FormData();
      fd.append('prompt', wordsIntoPrompt($('#lPrompt').value.trim(), [], CL_HEARD.text ? [{ words: CL_HEARD.text, lang: CL_HEARD.lang }] : []));
      fd.append('note', ownWords($('#lPrompt')));      // our own words from the scenario field
      sizeForm(L, fd); fd.append('aspect', L.aspect); fd.append('quality', L.q); fd.append('ref_size', L.refSize);
      loraForm(L, fd); seedForm(L, fd);
      fd.append('audio', new File([wavSlice(abuf, L.start, L.end)], 'clip.wav', { type: 'audio/wav' }));
      fd.append('audio_len', L.len().toFixed(3));
      $$('.ref', refsEl).filter(r => r._file).forEach((r, i) => fd.append('ref' + i, r._file));
      return fd;
    },
  },
  target: () => $('#refs .ref img'),
  meta: () => ({ mode: 'lipsync', prompt: $('#lPrompt').value.trim(), sub: `${L.refs} реф. · аудио ${L.len().toFixed(1)} с` }),
  onDone: item => addToLib(item),
  validate: () => !L.dur0 ? 'Загрузите аудио' : !L.refs ? 'Добавьте хотя бы один референс — лицо персонажа' : L.len() > MAX_LEN ? `Фрагмент длиннее ${MAX_LEN} с — укоротите` : !$('#lPrompt').value.trim() ? 'Напишите промпт' : '',
});
export const lUpd = paramsCard($('#lParams'), L, {
  n: 4, duration: false, onChange: () => {
    lPrev();
    $('#refHint').textContent = REF_HINT[L.refSize];
  },
  extraRow: `
    <div class="row">
      <div class="row-l">Точность переноса с изображений</div>
      <div class="seg" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <button data-r="match">Быстро<small>изображения уменьшаются</small></button>
        <button data-r="max">Максимум<small>лучшее сходство</small></button>
      </div>
      <div class="hint" id="refHint"></div>
    </div>
    <div id="lLoras"></div>`,
});
lUpd();
mountLoras($('#lLoras'), L, ['realism']);

// refs
export const MAX_REFS = 9;
export const refsEl = $('#refs');
watchSlots(refsEl);   // here too: one free plate, not a wall of them
for (let i = 1; i <= MAX_REFS; i++) {
  const r = document.createElement('label');
  r.className = 'ref';
  r.innerHTML = `<input type="file" accept="image/*"><div class="plus"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>${i === 1 ? 'Персонаж' : 'Референс'}</div><i class="cnt">${i}/${MAX_REFS}</i>
    <span class="tag" hidden>Picture ${i}</span><button class="x" type="button">✕</button>`;
  refsEl.append(r);
  const input = $('input', r);
  const set = f => {
    if (!isImage(f)) return;
    $('img', r)?.remove(); $('select', r)?.remove();
    r._file = f;
    const img = document.createElement('img'); img.src = URL.createObjectURL(f); r.prepend(img);
    fitSlot(r, img);
    if (!$$('.ref.filled', refsEl).length) fitAspect(L, img, lUpd);
    const sel = document.createElement('select');
    sel.innerHTML = ['Персонаж', 'Локация', 'Одежда', 'Предмет', 'Стиль'].map(o => `<option>${o}</option>`).join('');
    if (i > 1) sel.selectedIndex = 1;
    sel.onclick = e => e.preventDefault();
    sel.onmousedown = e => e.stopPropagation();
    r.append(sel);
    r.classList.add('filled'); $('.plus', r).hidden = true; $('.tag', r).hidden = false;
    refsChanged();
  };
  input.onchange = () => set(input.files[0]);
  r.addEventListener('dragover', e => e.preventDefault());
  r.addEventListener('drop', e => { e.preventDefault(); set(e.dataTransfer.files[0]); });
  $('.x', r).onclick = e => {
    e.preventDefault(); e.stopPropagation();
    $('img', r)?.remove(); $('select', r)?.remove(); input.value = ''; r._file = null; resetSlot(r);
    r.classList.remove('filled'); $('.plus', r).hidden = false; $('.tag', r).hidden = true; refsChanged();
  };
}
// ряд референсов «Клипа» тоже можно растянуть, как кадры в «Видео»
hGripAfter(refsEl, 'h3.refh.lipsync', { h: '--tk', base: 148, min: 110, max: 420, host: $('#view-lipsync') });
/* The song in «Клип» is the driving sound, not a numbered reference: a tag for it would promise
   something the mode does not do. What a person needs here is the lyric, so the song is listened to
   as soon as it lands, and the heard line becomes a chip that puts it into the text. */
export let CL_HEARD = { name: '', text: '', lang: '', busy: false };
export const clEsc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export async function clipHeard(tr) {
  const nm = (tr && tr.name) || '';
  if (!nm || !tr.dur0 || !tr.buf || CL_HEARD.busy) return;
  if (CL_HEARD.name === nm && (CL_HEARD.text || !CL_HEARD.busy)) return;
  CL_HEARD = { name: nm, text: '', lang: '', busy: true };
  refsChanged();
  try {
    const known = (typeof AG !== 'undefined' && ((AG.audios || []).find(a => a.name === nm && (a.text || '').trim()))) || null;
    if (known) { CL_HEARD = { name: nm, text: known.text.trim(), lang: known.langName || known.lang || '', busy: false }; refsChanged(); return; }
    if (!AG.status || !AG.status.speech_ready) await agStatus();
    if (!AG.status || !AG.status.speech_ready) { CL_HEARD = { name: nm, text: '', lang: '', busy: false }; refsChanged(); return; }
    const j = await transcribeWav(wavSlice(tr.buf, 0, tr.dur0), 'auto');
    CL_HEARD = { name: nm, text: String(j.text || '').trim(), lang: j.lang_name || j.lang || '', busy: false };
  } catch (e) { CL_HEARD = { name: nm, text: '', lang: '', busy: false }; }
  refsChanged();
}

export function refsChanged() {
  // H3 numbers references without gaps, so tags follow the order of filled slots
  const slots = $$('.ref.filled', refsEl);
  slots.forEach((r, i) => $('.tag', r).textContent = `Picture ${i + 1}`);
  const filled = slots.map((_, i) => i + 1);
  L.refs = filled.length;
  $('#rCount').textContent = `${L.refs} / ${MAX_REFS}`;
  const words = CL_HEARD.busy
    ? '<button class="token" type="button" disabled>слушаю песню…</button>'
    : CL_HEARD.text
      ? '<button class="token" type="button" data-ins="' + clEsc('<d>[' + (CL_HEARD.lang || 'язык аудио') + '] ' + CL_HEARD.text + '</d>') + '" title="' + clEsc(CL_HEARD.text) + '">вставить слова песни</button>'
      : '';
  const song = L.dur0 ? '<span class="hint" style="font-size:11.5px;flex:1 1 160px">песня в этом режиме - движущий звук: её не называют тегом' + (CL_HEARD.text ? ', а слова вставляются кнопкой' : CL_HEARD.busy ? ', слова слушаю' : ', слов не слышно - проверьте распознавание речи в разделе «Сценарист»') + '</span>' : '';
  $('#tokens').innerHTML = filled.map(n => `<button class="token" type="button">&lt;Picture ${n}&gt;</button>`).join('') + words + song
    || '<span class="hint">добавьте референсы — появятся метки</span>';
}
$('#tokens').onclick = e => {
  const t = e.target.closest('.token'); if (!t) return;
  const ta = $('#lPrompt'), s = ta.selectionStart, txt = (t.dataset.ins || t.textContent) + ' ';   // the words chip carries a whole line
  ta.value = ta.value.slice(0, s) + txt + ta.value.slice(ta.selectionEnd);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + txt.length;
};
refsChanged();

// abuf, peaks и audioName (звук «Клипа») лежат в core/state.js: их читают ещё «Сценарист» и «Workflow»
export const aFile = $('#aFile');
// one click: audio, pictures and the prompt of this section
$('#lClear').onclick = () => {
  const pics = $$('.ref.filled .x', refsEl), hasAudio = !!audioName, txt = $('#lPrompt').value.trim();
  if (!pics.length && !hasAudio && !txt) { toast('Здесь и так пусто'); return; }
  confirmBox('Очистить «Клип»?',
    `Уберём${hasAudio ? ' аудио,' : ''}${pics.length ? ' картинки (' + pics.length + ' шт.) и' : ''} промпт. Готовые клипы в Библиотеке останутся.`,
    'Очистить', () => {
      if (hasAudio) removeClipAudio();   // one function, whatever the button is called today
      pics.forEach(x => x.click());
      $('#lPrompt').value = ''; $('#lPrompt').dispatchEvent(new Event('input', { bubbles: true }));
      const prev = $('#lPreview'); if (prev && prev._reset) prev._reset();
      toast('Раздел очищен');
    });
};
aFile.onchange = () => loadAudio(aFile.files[0]);
export const aDrop = $('#aDrop');
aDrop.addEventListener('dragover', e => { e.preventDefault(); aDrop.classList.add('over'); });
aDrop.addEventListener('dragleave', () => aDrop.classList.remove('over'));
aDrop.addEventListener('drop', e => { e.preventDefault(); aDrop.classList.remove('over'); loadAudio(e.dataTransfer.files[0]); });

/* Аудио-вид. Один объект = одна карточка с полноценной работой со звуком: проигрывание, волна с
   рамкой выделения, приближение, два режима (что оставить в клипе / что вырезать), «убрать паузы»,
   «отделить голос», «отменить», поля «Начало/Конец» с длиной и предупреждением про лимит.
   Никакого состояния режима он не знает: ему дают куда встроиться, лимит в секундах и функцию,
   которой вернуть готовый файл. Сама обработка звука - общие функции keepRanges, findPauses,
   shiftAfter, wavSlice, так что логика срезов живёт в одном месте. */
/* The film bench for reference video: a strip of frames, a marker you drag, and scissors on both sides of
   it. Cutting is done by the program itself (a real decoder), because a browser cannot cut what it did not
   encode, and a cut on keyframes alone would leave a frozen start exactly where the clip should begin. */
// a piece of sound, taken out of a clip, goes to the library the same way a frame does
export async function soundOut(blob, name, from, at, notice) {
  try {
    const r = await fetch('/api/library/add?kind=audio&name=' + encodeURIComponent(name) +
      '&from=' + encodeURIComponent(from || '') + '&at=' + encodeURIComponent(at || ''),
      { method: 'POST', body: blob });
    if (!r.ok) { notice('Звук не принят в библиотеку (ответ ' + r.status + ') - нужна версия 1.5.3 или новее'); return null; }
    try { await window.h3ReloadLibrary?.(); } catch (e) { }
    try { window.trayFill?.(); } catch (e) { }
    notice('Звук сохранён в библиотеку: ' + name);
    return await r.json();
  } catch (e) {
    notice('Звук не ушёл в библиотеку: нужна более новая версия программы');
    return null;
  }
}

// the same for every video bench: the frame becomes a picture of this place, and a copy goes to the
// library, because a project can be cleared while the frame was made to be kept and reused elsewhere
export async function frameOut(f, rootEl, notice) {
  const free = rootEl ? $$('.rm-imgs .ref:not(.filled) input', rootEl)[0] : null;
  let where;
  if (!rootEl) where = '';
  else if (free) {
    const dt = new DataTransfer(); dt.items.add(f);
    free.files = dt.files; free.dispatchEvent(new Event('change'));
    where = 'в картинки';
  } else where = 'места под картинку нет';
  let lib;
  try {
    const r = await fetch('/api/library/add?name=' + encodeURIComponent(f.name) +
      '&from=' + encodeURIComponent(f.__from || '') + '&at=' + encodeURIComponent(f.__at || ''),
      { method: 'POST', body: f });
    lib = r.ok ? ' + копия в библиотеке' : ' · в библиотеку не принял ответ ' + r.status + ' (нужна версия 1.5.3 или новее)';
    if (r.ok) { try { await window.h3ReloadLibrary?.(); } catch (e) { } try { window.trayFill?.(); } catch (e) { } }
  } catch (e) { lib = ' · в библиотеку не ушёл: нужна более новая версия программы'; }
  notice('Кадр ' + (where ? where + ' ' : '') + lib.trim() + ': ' + f.name);
}

export let vocalsOk = null;
export const lTrim = new AudioTrimmer({
  mount: $('#lTrim'), limit: MAX_LEN, preselect: REC_LEN, warnOver: REC_LEN,
  lenLabel: 'Длина видео', agentTarget: 'lipsync',
  whereLabel: () => 'аудио из «Клипа», тег <Audio 1>',
  // the voice model may be missing in this installation: the server knows, and says why
  canVocals: async () => {
    if (!API) return 'ComfyUI не запущен: отделить голос нельзя.';
    try { vocalsOk = await (await fetch('/api/audio/info')).json(); }
    catch { vocalsOk = { available: false, reason: 'ComfyUI не ответил.' }; }
    return vocalsOk.available ? '' : 'Отделить голос нельзя: ' + (vocalsOk.reason || 'модель не установлена');
  },
  // the editor knows the selection; the Clip reads it from L, so the two stay in step
  onState: tr => {
    setClipAudio(tr.buf, tr.peaks, tr.name || '');
    clipHeard(tr);   // as soon as the song is in the bench, its words are worth knowing
    L.dur0 = tr.dur0; L.start = tr.start; L.end = tr.end;
    const nt = $('#aNote');
    if (nt) {
      const len = tr.len();
      const txt = len > MAX_LEN ? 'Максимум ' + MAX_LEN + ' секунд — укоротите фрагмент.'
        : len > REC_LEN ? 'Лучше держать фрагмент до ' + REC_LEN + ' секунд — так синхронизация губ точнее. Длиннее можно, но надёжнее короче.'
        : 'Оставьте небольшую паузу до и после слов — так губы начинают и заканчивают движение естественно.';
      nt.className = 'note' + (len > REC_LEN ? ' warn' : '');
      nt.querySelector('span').textContent = txt;
    }
    try { lUpd(); lPrev(); } catch (e) { }
  },
});
// the Clip's own two buttons stand in the editor's line: one editor, no second set of controls
(() => {
  const top = lTrim.el.querySelector('.at-top');
  const mk = (cls, txt, title, fn, id) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = txt; b.title = title; b.id = id;
    b.onclick = fn; top.append(b); return b;
  };
  mk('a-change', 'Заменить', 'Выбрать другой файл; то, что уже поправили, останется', () => aFile.click());
  mk('a-change a-del', 'Удалить', 'Убрать аудио из этого раздела', () => { removeClipAudio(); toast('Аудио удалено'); });
})();
export function removeClipAudio() {
  lTrim.clear();
  setClipAudio(null, [], '');
  L.dur0 = 0; L.start = 0; L.end = 0; MEM.audio = null; aFile.value = '';
  $('#aEd').classList.remove('on'); aDrop.style.display = '';
  lUpd(); memSave();
}
export async function loadAudio(f) {
  if (!f) return;
  MEM.audio = f;
  await lTrim.setFile(f);
  if (!lTrim.dur0) return;                 // a file the browser cannot decode: the zone stays
  aDrop.style.display = 'none'; $('#aEd').classList.add('on');
}
// names the rest of the page still uses: they point at the shared editor now
export function syncSel() {
  if (lTrim.dur0 && (Math.abs(lTrim.start - L.start) > .01 || Math.abs(lTrim.end - L.end) > .01)) {
    lTrim.start = L.start; lTrim.end = L.end;                 // a saved selection comes back
    lTrim._loaded = { start: L.start, end: L.end };
  }
  lTrim._sync();
}
export function syncCut() { lTrim._sync(); }
export function stop() { lTrim.stop(); }

/* Sound editing, shared by every editor in the program: the studio slots, the film bench and the Clip
   all go through AudioTrimmer, and these four functions are the arithmetic behind it. They sit next to
   wavSlice so that cutting, fading and quiet-passing live in exactly one place. */
export let MP4_LINE = null;
document.addEventListener('change', async e => {
  const inp = e.target;
  if (!inp || inp.type !== 'file') return;
  const f = inp.files && inp.files[0];
  if (!f || !/\.(mp4|m4v|mov)$/i.test(f.name) || f.size > 120 * 1048576) return;
  let j = null;
  try { j = await (await fetch('/api/mp4tag', { method: 'POST', body: f })).json(); } catch (err) { return; }
  const t = j && j.tag;
  if (!t) return;
  if (MP4_LINE) { MP4_LINE.remove(); MP4_LINE = null; }
  const line = document.createElement('div');
  line.className = 'note';
  line.style.cssText = 'margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const ours = j.made_by === 'kadr';
  const nm = (typeof MODE_NAME !== 'undefined' && MODE_NAME[t.mode]) || t.mode || '';
  const words = String(t.prompt || '').replace(/\s+/g, ' ').slice(0, 150);
  const span = document.createElement('span');
  span.innerHTML = (ours ? 'Этот клип делала программа: <b>' + esc(nm || 'не помнит режим') + '</b>'
    : 'В файле лежит промпт, которым его сделали')
    + (t.seed ? ', сид ' + esc(String(t.seed)) : '') + (t.res ? ', ' + esc(String(t.res)) : '')
    + (words ? ' · «' + esc(words) + (String(t.prompt || '').length > 150 ? '…' : '') + '»' : '');
  line.append(span);
  if (t.prompt) {
    const cp = document.createElement('button');
    cp.className = 'btn mini'; cp.type = 'button'; cp.textContent = 'Скопировать промпт';
    cp.onclick = () => { copyText(t.prompt, 'Промпт скопирован'); };
    line.append(cp);
  }
  const host = inp.closest('.lm-srcpick') || inp.closest('.row') || (inp.closest('label') || {}).parentElement;
  if (host) host.insertAdjacentElement('afterend', line);
  MP4_LINE = line;
}, true);

// Library: own copies of the results (settings)
export async function resLoad(s) {
  if (!API) return;
  try { s = s || await (await fetch('/api/results')).json(); } catch { return; }
  $('#resKeep').checked = s.keep; if (!$('#resDir').value || s.dir) $('#resDir').value = s.dir;
  $('#resBadge').textContent = s.lost ? `· файлов не найдено: ${s.lost}` : '';
  $('#resInfo').textContent = `Без копии: ${s.nocopy} · записей без файла: ${s.lost}`;
  $('#resBackfill').disabled = !s.nocopy; $('#resClean').disabled = !s.lost;
}
$('#resBox').addEventListener('toggle', () => { if ($('#resBox').open) resLoad(); });
$('#resKeep').onchange = async e => { try { resLoad(await postJSON('/api/results', { keep: e.target.checked })); toast(e.target.checked ? 'Копии включены' : 'Копии выключены'); } catch (err) { toast(err.message); } };
$('#resApply').onclick = async () => { try { resLoad(await postJSON('/api/results', { dir: $('#resDir').value })); toast('Папка копий сохранена: новые результаты пойдут туда'); } catch (err) { toast(err.message); } };
$('#resBackfill').onclick = async () => { $('#resBackfill').disabled = true; try { const r = await postJSON('/api/results/backfill'); resLoad(r); toast(`Скопировано файлов: ${r.copied}`); } catch (err) { toast(err.message); } };
$('#resClean').onclick = async () => { if (!confirm('Убрать из Библиотеки записи, у которых нет файла? Файлы на диске не затрагиваются.')) return; try { const r = await postJSON('/api/results/clean'); resLoad(r); toast(`Убрано записей: ${r.removed}`); const items = await (await fetch('/api/library')).json(); LIB.length = 0; items.forEach(it => LIB.push(normItem(it))); renderLib(); } catch (err) { toast(err.message); } };
if (API) resLoad();
// «Ретушь»: any file of the user, not only the ones made in the program
export let UP_FILE = null;   // UP_JOB и setUpJob (какое задание апскейла показывать) лежат в core/state.js
export function upProgress(j) {
  const line = document.querySelector('#upParams .up-run'); if (!line) return;
  const t = $('.up-run-t', line); if (!t) return;
  const v = jobView(j);
  t.textContent = (v.txt || v.label || 'работаем') + ' · ' + Math.round((v.p || 0) * 100) + '%';
}
export function upFinished(j) {
  const line = document.querySelector('#upParams .up-run'), box = document.getElementById('upParams');
  if (j.state === 'error') {
    if (line) line.innerHTML = '<b style="color:var(--pink)">Не получилось.</b> <span>' + esc(errSay(j.raw || j.msg)) + '</span>' +
      '<button class="btn mini" type="button" data-a="again">Убрать и попробовать иначе</button>';
    const ag = line && $('[data-a="again"]', line); if (ag) ag.onclick = upClear;
    if (box) {
      box.querySelectorAll('.up-s, input[type=range]').forEach(b => { b.disabled = false; });
      [...box.querySelectorAll('input[type=range]')].forEach(paintRange);
    }
    toast('Увеличение не получилось: ' + errSay(j.raw || j.msg));
  } else if (line) {
    line.innerHTML = '<b style="color:#3fd18b">Готово.</b> <span>Новый файл в Библиотеке, ваш исходный не тронут.</span>'
      + (j.itemId ? '<button class="btn mini" type="button" data-a="cmp">Показать до и после</button>' : '');
    const cb = line && $('[data-a="cmp"]', line);
    if (cb) cb.onclick = () => openViewer(j.itemId);
    if (j.itemId && $('#viewer').hidden) setTimeout(() => openViewer(j.itemId), 400);   // do not make him hunt for it
    toast('Готово: файл в Библиотеке');
  }
  setUpJob(null);
}
export function upClear() {
  UP_FILE = null; setUpJob(null);      // the page is cleared; the job itself keeps running in the queue
  $('#upInfo').hidden = true; $('#upInfo').innerHTML = '';
  $('#upParamsCard').hidden = true; $('#upParams').innerHTML = '';
  $('#upDrop').hidden = false;
}
export function upPick(f) {
  if (!f) return;
  const isVid = f.type.startsWith('video/'), isImg = f.type.startsWith('image/');
  if (!isVid && !isImg) { toast('Нужен файл видео или изображения'); return; }
  if (f.size > 300 * 1048576) { toast('Файл больше 300 МБ: уменьшите или обрежьте его'); return; }
  UP_FILE = f;
  const info = $('#upInfo'); info.hidden = false; info.innerHTML = `<span class="hint">Читаем файл «${esc(f.name)}»…</span>`;
  const url = URL.createObjectURL(f), el = document.createElement(isVid ? 'video' : 'img');
  const done = (w, h, len) => {
    const it = { kind: isVid ? 'video' : 'image', res: w ? `${w}×${h}` : '', len: len || 0, prompt: '' };
    // the file becomes a chip with a cross, and the settings appear under it - on the same page
    info.innerHTML = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:9px 11px;border:1px solid var(--line-2);border-radius:12px;background:var(--bg-2)">
      <b style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</b>
      <span class="hint">${it.res || 'размер не читается'}${it.len ? ' · ' + (Math.round(it.len * 10) / 10) + ' с' : ''} · ${Math.round(f.size / 1048576 * 10) / 10} МБ</span>
      <button class="btn mini" type="button" id="upClearBtn" title="Убрать файл и начать заново">✕ Убрать</button></div>`;
    $('#upClearBtn').onclick = upClear;
    $('#upDrop').hidden = true;
    $('#upKind').textContent = it.kind === 'image' ? 'настроки для изображения' : 'настроки для видео';
    const card = $('#upParamsCard'), box = $('#upParams');
    card.hidden = false; box.innerHTML = '<span class="hint">Смотрим, какие способы доступны на вашей видеокарте…</span>';
    openUpscale(it, f, box).catch(err => { box.innerHTML = '<span class="hint" style="color:var(--pink)">' + esc(err.message) + '</span>'; });
  };
  if (isVid) { el.muted = true; el.preload = 'metadata'; el.onloadedmetadata = () => { done(el.videoWidth, el.videoHeight, el.duration); URL.revokeObjectURL(url); }; el.onerror = () => { info.innerHTML = `<span style="color:var(--pink)">Не получилось открыть «${esc(f.name)}» (необычный формат или кодек). Сохраните как обычный MP4 (H.264) и загрузите снова.</span>`; }; }
  else { el.onload = () => { done(el.naturalWidth, el.naturalHeight, 0); URL.revokeObjectURL(url); }; el.onerror = () => { info.innerHTML = `<span style="color:var(--pink)">Не получилось открыть изображение «${esc(f.name)}».</span>`; }; }
  el.src = url;
}
$('#upFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; upPick(f); };
$('#upDrop').addEventListener('dragover', e => e.preventDefault());
$('#upDrop').addEventListener('drop', e => { e.preventDefault(); upPick(e.dataTransfer.files[0]); });
// «Показать по-русски» under any prompt field: the agent model translates it; the text is for reading only, the field is not changed
/* ── Prompt written in a mode, finished by the Agent, without leaving the mode.
   The person drafts the scene in the field where the tags live; this carries the draft and the mode's
   own files into the chat (the same buttons do that by hand), asks the Agent to turn the draft into a
   finished prompt, and puts the answer back into the very same field. The chat keeps both messages, so
   the history shows what was asked and what came out. */
export async function continueLong(it) {
  const L2 = (RM[it.mode] || RM.long).root;   // a clip made in the action studio continues there
  if (!(it.long && it.long.run) || (L2._run !== it.long.run && !(await L2._openRun(it.long.run)))) {
    // a video that was not made here (or whose project is gone): continue from its last frames as a new project
    L2._setSrc({ id: it.id, name: (it.prompt || it.sub || 'видео из Библиотеки').slice(0, 50) });
    goTo('long');
    toast((await L2._ensureFrame())
      ? 'Продолжаем это видео: оно стало основой, режим «продолжить своё видео» включён, его последний кадр стоит отдельной плиткой перед вашими фото. Добавьте референсы (персонаж, локацию…), опишите следующую сцену и нажмите «Сделать эту сцену».'
      : 'Продолжаем это видео: оно стало основой, но последний кадр прочитать не удалось - добавьте изображения героя и места сами.');
    return;
  }
  goTo('long');
  if (L2._mode === 'parts' && L2._ready() >= $$('.sc', L2).length && $$('.sc', L2).length < 12) L2._addScene('', 10);
  toast('Проект открыт: те же изображения и сцены. Опишите следующую сцену и нажмите «Сделать эту сцену».');
}
$('#vwContinue').onclick = () => { const it = (byId(openId) || openItem); if (!it) return; closeViewer(); continueLong(it); };
$('#vwSeed').onclick = () => {
  const it = (byId(openId) || openItem); if (!it || it.seed == null) return;
  const st = it.mode === 'video' ? V : it.mode === 'lipsync' ? L : RM[it.mode]?.S; if (!st) return;
  closeViewer(); useSeed(st, it.seed, it.mode);
};
$('#vwFav').onclick = () => { const it = (byId(openId) || openItem); setFav(it, !it.fav); $('#vwFav').textContent = it.fav ? ' В избранном' : 'В избранное'; renderLib(); };
$('#vwRepeat').onclick = async () => {
  const it = (byId(openId) || openItem); closeViewer();
  if (it.mode === 'custom') { toast('Для своих workflow настройки переносятся вручную: откройте раздел «Свои workflow»'); goTo('custom'); return; }
  // a video studio project keeps its pictures next to the program: repeat means the whole project,
  // scenes, settings AND the pictures - otherwise the texts would point at empty places
  if (it.mode === 'long' && it.long && it.long.run) {
    goTo('long');
    try {
      if (await (RM[it.mode] || RM.long).root._openRun(it.long.run)) { toast('Перенесли проект целиком: сцены, настройки и все картинки'); return; }
    } catch { }
    toast('Картинки проекта не нашлись - переносим настройки и тексты');
  }
  const own = it.note != null ? it.note : it.prompt;   // your words, not the sentence the program wrote for the model
  const panel = (views.IMG || {})[it.mode];   // окна картинок заявляют о себе в общем хабе
  if (panel) { panel.fill(it); goTo(it.mode); }
  else if (it.mode === 'video') { Object.assign(V, { aspect: it.aspect, q: it.q, dur: Math.round(it.len) }); $('#vPrompt').value = own; $('#vPrompt').oninput({ target: $('#vPrompt') }); vUpd(); goTo('video'); }
  else if (RM[it.mode]) {
    const r = RM[it.mode]; Object.assign(r.S, { aspect: it.aspect, q: it.q, dur: Math.round(it.len) }, it.steps ? { steps: it.steps } : {});
    const ta = r.prompt(); if (ta) ta.value = own; else toast('Нет поля для описания: откройте раздел и добавьте сцену вручную');
    if (it.mode === 'swap' && r.root) {   // the swap keeps its own fields: who to replace, and where the plans change
      (it.whos || []).forEach((w, k) => { const el = $(`.rm-who[data-i="${k}"]`, r.root); if (el && w) el.value = w; });
      const cu = $('.sw-cuts', r.root); if (cu && (it.cuts || []).length) cu.value = it.cuts.join('; ');
    }
    r.upd(); goTo(it.mode);
  }
  else { Object.assign(L, { aspect: it.aspect, q: it.q, refSize: it.ref_size || L.refSize }); $('#lPrompt').value = own; lUpd(); goTo('lipsync'); }
  const back = await repeatRefs(it);   // the pictures the result was made of come back too
  toast(back ? `Перенесли настройки и вернули картинок: ${back}` : 'Настройки перенесены — можно генерировать');
};

$('#lib').addEventListener('mouseover', e => e.target.closest('.li-th')?.querySelector('video')?.play().catch(() => {}));
$('#lib').addEventListener('mouseout', e => { const v = e.target.closest('.li-th')?.querySelector('video'); if (v && !e.target.closest('.li-th').contains(e.relatedTarget)) v.pause(); });

export function makeRefMode(cfg) {
  const root = $('#view-' + cfg.mode);
  const S = { aspect: '16:9', q: 'HD+', dur: cfg.dur, steps: 6, refSize: 'max', accel: 'old', len: () => S.dur };
  root.innerHTML = `
    <div class="head"><div><h1>${cfg.title}</h1><p>${cfg.sub}</p></div><div class="mode-pill"><i></i><span class="rm-pill">${cfg.pill}</span></div></div>
    <div class="grid"><div class="col">
      <div class="card">
        <div class="card-h"><h3><span class="n">1</span>Референсы</h3><span class="counter rm-count"></span>
          <button class="btn mini rm-clear" type="button" title="Убрать всё в этом разделе: картинки, видео, аудио и текст">Очистить всё</button></div>
        <div class="refs rm-imgs"></div>
        ${cfg.frames ? `<div class="sub-l"><span>Первый и последний кадр</span></div>
        <div class="refs rm-frames"></div>
        <small class="media-hint">необязательно: первый кадр - с чего ролик начнётся, последний - чем кончится</small>` : ''}
        <div class="rm-media">
          ${cfg.videos ? `<div><div class="sub-l"><span>Референс-видео</span></div><div class="slots rm-vids"></div><small class="media-hint">движение, камера, хореография · 2–15 с</small></div>` : ''}
          <div><div class="sub-l"><span>Референс-аудио</span></div><div class="slots rm-auds"></div><small class="media-hint">голос, ритм, атмосфера · до 15 с</small></div>
        </div>
        <div class="note" style="margin-top:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h0M11 12h1v5h1"/></svg>
          <span>${cfg.refHint}</span></div>
      </div>
      <div class="card" data-scenarobox="mode"></div>
      <div class="card rm-params"></div>
    </div><div class="preview rm-preview"></div></div>`;
  /* Окно «Сценарий» ставит общий модуль: поле, ряд кнопок тегов и подписи собираются одним
     кодом во всех разделах. В студиях сцен это место занимает карточка «Сцены» - поле
     живёт в карточке каждой сцены, а общий ряд картинок остаётся под списком сцен. */
  const scBox = $('[data-scenarobox="mode"]', root);
  let scWin = null;
  if (!cfg.scenes && !cfg.swap) {
    scWin = scenarioWindow(scBox, {
      kind: 'mode', num: 2, hint: 'можно написать в разделе «Сценарист»',
      placeholder: cfg.placeholder, cls: 'rm-prompt', chips: 'below', chipsCls: 'rm-tokens',
      generate: { mode: cfg.mode, text: () => ($('.rm-prompt', root) || {}).value },
    });
  }
  const imgsEl = $('.rm-imgs', root), vidsEl = $('.rm-vids', root), audsEl = $('.rm-auds', root), framesEl = $('.rm-frames', root);

  // one button instead of clicking every ✕ by hand: pictures, video, audio, text and scenes at once
  $('.rm-clear', root).onclick = () => {
    const ta = $('.rm-prompt', root) || root._ta;
    const files = $$('.ref.filled .x, .slot.filled .x, .drop.filled .x', root);
    const text = (ta ? ta.value : '').trim() || (root._hasText ? root._hasText() : '');
    if (!files.length && !text) { toast('Здесь и так пусто'); return; }
    confirmBox(`Очистить «${cfg.title}»?`,
      `Уберём загруженное (${files.length} шт.), текст${cfg.scenes ? ' и сцены' : ''}. Видео и картинки в Библиотеке останутся.`, 'Очистить', () => {
        files.forEach(x => x.click());
        // chips and thumbnails of the reference video and audio stand in cards of their own and are
        // redrawn only by their own painter: without this the files were gone but the chips stayed
        (root._mediaPaint || []).forEach(fn => { try { fn(); } catch (e) { } });
        if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
        if (root._clearScenes) root._clearScenes();
        if (root._setSrc) root._setSrc(null);   // the "we continue a finished video" plate goes away with the rest
        root._target = null; root._chainPart = 0;
        const prev = $('.rm-preview', root); if (prev && prev._reset) prev._reset();   // the mini preview goes empty too
        toast('Раздел очищен');
      });
  };

  // the numbers belong to the places: an empty place keeps its number, nothing shifts

  // picture slots (same behaviour as Lipsync)
  /* Кадры начала и конца ролика - те же плиты, что и референсы: тот же вид, тот же крест,
     то же перетаскивание файла. Отличаются надписью и тем, что уходят на сервер в поля
     first и last, как в режиме «Видео». Первый кадр - с чего ролик начнётся, последний -
     чем кончится; оба не обязательны. */
  const FRAME_PLACES = cfg.frames ? [['Первый кадр', 'первый', 'first'], ['Последний кадр', 'последний', 'last']] : [];
  const framePlates = [];
  for (let i = 0; i < cfg.maxImages + FRAME_PLACES.length; i++) {
    const r = document.createElement('label'); r.className = 'ref';
    r.innerHTML = `<input type="file" accept="image/*"><div class="plus">${ICON_IMG}${i === 0 ? 'Главный' : 'Референс'}</div><i class="cnt">${i + 1}/${cfg.maxImages}</i><span class="tag" hidden></span><button class="x" type="button">✕</button>`;
    const fr = i >= cfg.maxImages ? FRAME_PLACES[i - cfg.maxImages] : null;   // плита кадра стоит в своём ряду
    (fr ? framesEl : imgsEl).append(r);
    if (fr) {
      r.classList.add('frame'); r._frameKey = fr[2];
      $('.plus', r).lastChild.textContent = fr[0];
      $('.cnt', r).textContent = (i - cfg.maxImages + 1) + '/' + FRAME_PLACES.length;
      $('.tag', r).textContent = fr[1];   // подпись видна и когда плита уже занята
      framePlates.push(r);
    }
    const input = $('input', r);
    const set = f => {
      if (!isImage(f)) return;
      $('img', r)?.remove(); r._file = f;
      const img = document.createElement('img'); img.src = URL.createObjectURL(f); r.prepend(img);
      fitSlot(r, img);
      if (!$$('.ref.filled', imgsEl).length) fitAspect(S, img, () => upd());
      r.classList.add('filled'); $('.plus', r).hidden = true; $('.tag', r).hidden = false;
      changed();   // the number of this place does not depend on the others
    };
    input.onchange = () => set(input.files[0]);
    r.addEventListener('dragover', e => e.preventDefault());
    r.addEventListener('drop', e => { e.preventDefault(); set(e.dataTransfer.files[0]); });
    $('.x', r).onclick = e => {
      e.preventDefault(); e.stopPropagation();
      $('img', r)?.remove(); input.value = ''; r._file = null; resetSlot(r); r.classList.remove('filled'); $('.plus', r).hidden = false; $('.tag', r).hidden = true;
      changed();   // the place keeps its number; its chip only goes inactive
    };
  }
  wireSlotSwap($$('.ref', imgsEl), changed);
  hGripAfter(imgsEl, 'h3.refh.' + cfg.mode, { h: '--tk', base: 148, min: 110, max: 420, host: root });
  // a second button that threw away the whole row by one careless click is not needed: every plate
  // has its own cross, and the section has «Очистить всё»


  // video / audio slots
  const mkSlots = (el, n, accept, icon, label) => {
    for (let i = 0; i < n; i++) {
      const s = document.createElement('label'); s.className = 'slot';
      s.innerHTML = `<input type="file" accept="${accept}" hidden>${icon}<i class="cnt">${i + 1}/${n}</i><span>${label} ${i + 1}</span><small></small><button class="x" type="button">✕</button>`;
      el.append(s);
      const input = $('input', s);
        s.addEventListener('dragover', e => { e.preventDefault(); s.classList.add('over'); });
        s.addEventListener('dragleave', () => s.classList.remove('over'));
        s.addEventListener('drop', e => {
          e.preventDefault(); e.stopPropagation(); s.classList.remove('over');
          const f = e.dataTransfer.files[0]; if (!f) return;
          const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event('change'));
        });
      input.onchange = () => {
        const f = input.files[0]; if (!f) return;
        s._file = f; s.classList.add('filled'); $('span', s).textContent = accept.startsWith('video') ? '. Видео загружено' : f.name;
        const media = document.createElement(accept.startsWith('video') ? 'video' : 'audio');
        media.preload = 'auto'; media.muted = true; media.src = URL.createObjectURL(f);
        if (accept.startsWith('video')) {   // a frame of the video in the slot, like a picture: it is clear at a glance that the video is there
          s.classList.add('vthumb'); s.style.backgroundImage = '';
          media.addEventListener('loadeddata', () => { try { media.currentTime = Math.min(0.3, (media.duration || 1) / 2); } catch {} });
          media.addEventListener('seeked', () => {
            const c = document.createElement('canvas'), w = 240; c.width = w; c.height = Math.round(w * (media.videoHeight || 3) / (media.videoWidth || 4));
            try { c.getContext('2d').drawImage(media, 0, 0, c.width, c.height); s.style.backgroundImage = `linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.6)),url(${c.toDataURL('image/jpeg', 0.8)})`; } catch {}
          }, { once: true });
        }
        const isVid = accept.startsWith('video'), mh = (el._hint || el.parentElement.querySelector('.media-hint')), mh0 = mh && (mh._t0 = mh._t0 || mh.textContent);
        const say = (txt, bad) => { if (!mh) return; mh.textContent = txt; mh.style.color = bad ? 'var(--pink)' : 'var(--green, #4ade80)'; };
        if (mh) say(`Загружается: ${f.name}…`, false);
        media.onloadedmetadata = () => {
          s._dur = media.duration; s.classList.remove('bad'); $('small', s).textContent = media.duration.toFixed(1) + ' с';
          if (isVid && media.videoWidth) {   // like a picture slot: a vertical video gets a vertical slot, a horizontal one a wide slot
            const ratio = Math.min(16 / 9, Math.max(9 / 16, media.videoWidth / media.videoHeight));
            s.style.aspectRatio = ratio.toFixed(4); s.classList.toggle('wide', ratio > 1.2);
          }
          say(`. Загружено: ${f.name} · ${media.duration.toFixed(1)} с${isVid && media.videoWidth ? ` · ${media.videoWidth}×${media.videoHeight}` : ''} · ${(f.size / 1048576).toFixed(1)} МБ`, false); changed();
        };
        media.onerror = () => {
          s._dur = 0; s.classList.add('bad'); $('small', s).textContent = 'не открылось'; if (isVid) $('span', s).textContent = ' Видео не открылось';
          say(`Не получилось открыть «${f.name}» в программе (возможно, необычный формат или кодек). Попробуйте сохранить файл как обычный MP4 (H.264) и загрузить снова.`, true);
          toast('Файл не открылся: ' + f.name);
        };
        changed();
      };
      $('.x', s).onclick = e => { e.preventDefault(); e.stopPropagation(); const mh = (el._hint || el.parentElement.querySelector('.media-hint')); if (mh && mh._t0) { mh.textContent = mh._t0; mh.style.color = ''; } s.classList.remove('bad', 'vthumb', 'wide'); s.style.backgroundImage = ''; s.style.aspectRatio = ''; s._file = null; s._dur = 0; input.value = ''; s.classList.remove('filled'); $('span', s).textContent = `${label} ${i + 1}`; $('small', s).textContent = ''; changed(); };
    }
  };
  if (vidsEl) mkSlots(vidsEl, cfg.swap ? 1 : 3, 'video/*', ICON_VID, 'Видео');
  if (cfg.swap) audsEl.parentElement.hidden = true;
  async function detectCuts(file) {   // looks at the video 10 times a second and finds hard cuts (sudden change of the picture)
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
    await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; });
    const dur = v.duration || 0; if (!(dur > 2)) return [];
    const c = document.createElement('canvas'); c.width = 32; c.height = 24; const g = c.getContext('2d', { willReadFrequently: true });
    const diffs = []; let prev = null;
    for (let t = 0; t < Math.min(dur, 15); t += 0.1) {
      v.currentTime = t; await new Promise(r => { v.onseeked = r; setTimeout(r, 600); });
      g.drawImage(v, 0, 0, 32, 24); const d = g.getImageData(0, 0, 32, 24).data, cur = new Uint8Array(32 * 24);
      for (let i = 0; i < cur.length; i++) cur[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
      if (prev) { let sum = 0; for (let i = 0; i < cur.length; i++) sum += Math.abs(cur[i] - prev[i]); diffs.push([t, sum / cur.length]); }
      prev = cur;
    }
    URL.revokeObjectURL(v.src);
    const med = diffs.map(x => x[1]).sort((a, b) => a - b)[Math.floor(diffs.length / 2)] || 0;
    const cuts = [];
    diffs.forEach(([t, d]) => { if (d > Math.max(28, med * 5) && (!cuts.length || t - cuts[cuts.length - 1] > 1.5)) cuts.push(+t.toFixed(2)); });
    return cuts;
  }
  mkSlots(audsEl, cfg.scenes ? 1 : 3, 'audio/*', ICON_AUD, cfg.scenes ? 'Музыка' : 'Аудио');   // в студиях сцен этот ряд скрыт: звук там живёт в своей карточке
  // twelve empty plates are noise: only the filled ones and one free slot stay visible
  [imgsEl, vidsEl, audsEl].forEach(b => { watchSlots(b); foldSlots(b); });
  // Reference audio in Референсы, Актёр and Экшн-видео: the same window the studio uses, instead of a bare
  // tile. The tiles stay in the page - the run collects them by selector - they only stop showing, and
  // whatever the window does is written back into the tile, so the calculation cannot tell the difference.
  // Reference audio in Референсы, Актёр and Экшн-видео: its own numbered card, and the files are ADDED
  // one by one the way a scene adds them - three empty planks at once only made people load something
  // they did not need. The tiles stay in the page: the run collects them by selector, so the card writes
  // into them and the calculation cannot tell the difference.
  if (!cfg.scenes && !cfg.swap) refAudioCard();
  // the video card is put in SECOND: both ask to stand right after the first card, so the one that
  // comes later ends up nearer the top - and he wants «Референс-видео» to be the second card
  if (!cfg.scenes && !cfg.swap && vidsEl && $$('.slot', vidsEl).length) refVideoCard();
  if (cfg.swap) swapVideoBench();   // the same bench for the video a person is replacing a face in
  // The card for reference video: same way of growing as the audio card has - nothing stands empty, a
  // file appears when the person adds it - and its «Монтаж» window cuts the clip with a marker, scissors
  // on both sides of it and a zoom, because finding the right second in a 20-second film by numbers is
  // hopeless. The limit is what the model actually looks at.
  // The swap mode had a bare tile: a two-minute phone video went to the model whole, and the first
  // seconds of it decided everything. The bench under the tile is the same class the reference card
  // uses, so nothing new is learned twice.
  function swapVideoBench() {
    const esc = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    const slot = $('.rm-vids .slot', root);
    if (!slot || typeof VideoTrimmer !== 'function') return;
    const card = slot.closest('.card');
    if (!card) return;
    // a bench that appears out of nowhere is hard to find: the video gets the same chip as in the
    // reference card - its number, its name, its length, the scissors and the cross
    const chips = document.createElement('div');
    chips.className = 'ra-row sw-chips';
    const media = $('.rm-media', root);
    (media || card).after(chips);
    const box = document.createElement('div');
    box.className = 'sw-bench'; box.hidden = true;
    box.innerHTML = '<div class="hint" style="margin:10px 0 6px">Отрежьте лишнее: в расчёт пойдёт только выбранное время.' +
      ' Дальше <b>25 секунд</b> модель не смотрит. Двойной клик по ленте возвращает целый клип.</div>';
    card.append(box);
    const tr = root._vtrim = new VideoTrimmer({
      mount: box, limit: 25, agentTarget: 'swap',
      onFile: (f, q) => {
        const src = slot._src || slot._file;
        slot._src = slot._src || slot._file;
        slot._file = f;
        slot._vsel = { start: q.start, end: q.end, of: src ? src.name : f.name };
        slot._dur = q.len();
        $('span', slot).textContent = f.name;
        paint();
        try { changed(); } catch (e) {}
        if (root._save) root._save();
      },
      onWhole: () => {
        if (!slot._src) return;
        slot._file = slot._src; slot._vsel = null;
        slot._dur = 0;
        $('span', slot).textContent = slot._src.name;
        const m = document.createElement('video');
        m.preload = 'metadata'; m.src = URL.createObjectURL(slot._src);
        m.onloadedmetadata = () => { slot._dur = m.duration || 0; paint(); try { changed(); } catch (e) {} URL.revokeObjectURL(m.src); };
      },
      onRemove: () => { const x = $('.x', slot); if (x) x.click(); box.hidden = true; syncChip(); },
      // the same rule here: a frame is meant to be reused, so it goes to the pictures of this place
      // and to the library - a file nobody can find again is not a result
      onFrame: f => frameOut(f, root, toast)
    });
    const syncChip = () => {
      const f = slot._file;
      if (!f) { chips.innerHTML = ''; chips.hidden = true; return; }
      chips.hidden = false;
      const dur = slot._dur ? (Math.round(slot._dur * 10) / 10 + '').replace('.', ',') + ' с' : '...';
      chips.innerHTML = '<span class="token"><button class="tk" type="button" data-video="1" title="вставить метку в текст">&lt;Video 1&gt;</button>' +
        '<span class="tk-n">' + esc(f.name) + '</span><span class="tk-d">' + dur + '</span>' +
        '<button class="tk-e" data-a="montage" type="button" title="открыть верстак монтажа">&#9986; Монтаж</button></span>' +
        '<span class="ra-count">1 / 1</span>';
    };
    // the tile's own cross is the app's removal path and it does not know about the chip: listen there too
    // capture, because the cross stops the event from bubbling and the chip would stay behind
    slot.addEventListener('click', () => setTimeout(syncChip, 80), true);
    chips.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.video) {
        const ta = $('.rm-prompt', root);
        if (ta) {
          const p = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, p) + '<Video 1>' + ta.value.slice(p);
          ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus();
        }
        return;
      }
      if (b.dataset.a === 'montage') {
        if (!slot._file) return;
        box.hidden = !box.hidden;
        if (!box.hidden) { try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e2) {} }
      }
    });
    const paint = () => {
      syncChip();
      box.hidden = !slot._file;
      if (box.hidden) return;
      const src = slot._file;                          // the piece is what the run will take
      if (tr._loaded !== src) {
        tr._loaded = src;
        tr.origFile = slot._src || null;
        tr.isPiece = !!slot._src;
        tr.setFile(src, true);
        const sel = slot._vsel;
        if (sel && slot._src) setTimeout(() => {
          tr.start = sel.start; tr.end = sel.end; tr.cut = { s: sel.start, e: sel.end }; tr._sync();
        }, 600);
      }
    };
    $('input', slot).addEventListener('change', () => {
      slot._src = null; slot._vsel = null; slot._dur = 0;   // the new file has its own length
      tr._loaded = null; tr._srcFile = null; paint();
      const f = slot._file;
      if (f) {
        const m = document.createElement('video');
        m.preload = 'metadata'; m.src = URL.createObjectURL(f);
        m.onloadedmetadata = () => { if (slot._file === f) { slot._dur = m.duration || 0; paint(); try { changed(); } catch (e) {} } URL.revokeObjectURL(m.src); };
      }
    });
    const x = $('.x', slot);
    if (x) x.addEventListener('click', () => { slot._src = null; slot._vsel = null; tr._loaded = null; box.hidden = true; });
  }

  function refVideoCard() {
    const slots = [...$$('.slot', vidsEl)];
    if (!slots.length || typeof VideoTrimmer !== 'function') return;
    const refCard = vidsEl.closest('.card');
    if (!refCard) return;
    const newEl = cls => { const e = document.createElement('div'); if (cls) e.className = cls; return e; };
    const esc = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    const LIMIT = 25;                                  // seconds: the model does not look further
    vidsEl.parentElement.classList.add('ra-tiles');    // the old block: storage only
    const card = newEl('card');
    card.innerHTML = '<div class="card-h"><h3><span class="n">2</span>Референс-видео</h3></div>' +
      '<div class="vthumbs" hidden></div><div class="hresize" hidden title="Потяните вниз или вверх, чтобы рассмотреть эскизы. Двойной клик — вернуть как было"></div>' +
      '<div class="hint" style="margin-bottom:9px">Видео-пример для модели: она берёт из него движение и кадр.' +
      ' <b>Не длиннее ' + LIMIT + ' секунд</b> - дальше модель просто не смотрит, поэтому лишнее лучше отрезать.' +
      ' Кнопка «Монтаж» открывает верстак: лента кадров, маркер, ножницы с двух сторон от него и приближение.</div>' +
      '<div class="ra-row"></div>';
    refCard.after(card);
    const row = $('.ra-row', card), host = newEl('ra-host'); host.hidden = true;
    const thumbs = $('.vthumbs', card), tbar = $('.hresize', card);
    // the grip under the thumbnails rides the same scale as the one under the pictures; it has to be
    // wired here, where the card exists - earlier in this section there was nothing to find yet
    hGrip(tbar, thumbs, 'h3.refh.' + cfg.mode, { h: '--tk', base: 148, min: 110, max: 420, host: root });
    card.append(host);
    // the button stands on this card, not on the old caption row: the row is storage only and hidden
    {
      const vb = agMakeBtn($('.card-h', card), '🎞', 'видео-пример - Сценарист получит его кадрами');
      if (vb) {
        vb._agCount = () => slots.filter(s => s._src || s._file).length;
        vb.onclick = async () => {
          const list = slots.map(s => s._src || s._file).filter(Boolean);
          if (!list.length) { toast('Референс-видео нет - сначала добавьте его'); return; }
          let added = 0, again = 0;
          const moved = agPickTarget(cfg.mode);
          try {
            for (const f of list) {
              if (AG.att.some(a => a.frame && a.vname === f.name)) { again++; continue; }
              if (await agAttachFile(f)) added++; else again++;
            }
            agGo();
            toast(added ? ('В чат сценариста добавлено видео (кадрами): ' + added + (again ? ' · ' + again + ' уже лежало' : '') + moved)
                        : 'Это видео уже лежит в чате сценариста');
          } catch (err) { toast('Не удалось передать видео сценаристу: ' + (err && err.message ? err.message : '')); }
        };
      }
    }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'video/*,.mp4,.mov,.mkv,.webm,.m4v'; inp.hidden = true; card.append(inp);
    // a clip dragged from the library panel lands on this card and goes through the same input
    card.classList.add('h3vdrop'); card.__h3input = inp;
    card.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/h3lib')) { e.preventDefault(); card.style.outline = '2px dashed var(--accent)'; } });
    card.addEventListener('dragleave', () => { card.style.outline = ''; });
    card.addEventListener('drop', () => { card.style.outline = ''; });
    const MODE_NAME = { refs: 'Видеостудия', actor: 'Актёр', action: 'Экшн-видео', long: 'Киностудия', actionsc: 'Экшн-студия' }[cfg.mode] || cfg.mode;
    let turls = [];
    const paintThumbs = () => {
      turls.forEach(u2 => { try { URL.revokeObjectURL(u2); } catch (e) { } }); turls = [];
      const have = slots.filter(s => s._file);
      thumbs.hidden = tbar.hidden = !have.length;
      if (!have.length) { thumbs.innerHTML = ''; return; }
      thumbs.innerHTML = have.map(s => {
        const p = slots.indexOf(s);
        return `<div class="vt2" data-j="${p}" title="&lt;Video ${p + 1}&gt; · ${esc(s._file.name)}"><video muted playsinline preload="metadata"></video><b>&lt;Video ${p + 1}&gt;</b><small>${esc(s._file.name.slice(0, 20))}</small></div>`;
      }).join('');
      $$('.vt2', thumbs).forEach(el => {
        const s = slots[+el.dataset.j], v = el.querySelector('video');
        if (!s || !s._file || !v) return;
        const url = URL.createObjectURL(s._file); turls.push(url); v.src = url;
        // the first frame of a clip is usually black: step a little inside it
        v.addEventListener('loadeddata', () => { try { v.currentTime = Math.min(0.6, (v.duration || 1) * .06); } catch (e) { } }, { once: true });
      });
    };
    let tr = null, cur = -1, pick = -1;
    const fmt = x => (Math.round(x * 10) / 10 + '').replace('.', ',');
    const paint = () => {
      const full = slots.filter(s => s._file).length >= slots.length;
      row.innerHTML = '<button class="btn mini" type="button" data-a="add"' + (full ? ' disabled' : '') +
        ' title="Видео-пример: до ' + slots.length + ' файлов, каждый не длиннее ' + LIMIT + ' с">Добавить видео</button>' +
        '<span class="counter" title="Сколько референс-видео допускается">' + slots.filter(s => s._file).length + ' / ' + slots.length + '</span>' +
        slots.map((s, i) => s._file
          ? `<span class="token" data-j="${i}" title="Тег вставится в текст по нажатию">&lt;Video ${i + 1}&gt; ${esc(s._file.name.slice(0, 22))}` +
            (s._dur ? ' · <small style="opacity:.75">' + fmt(s._dur) + ' с' + (s._vsel ? ' · нарезано' : '') + '</small>' : '') +
            (s._dur > LIMIT + .1 ? ' <small style="color:var(--pink)">длиннее ' + LIMIT + ' с</small>' : '') +
            ` <button class="btn mini" type="button" data-a="edit" data-j="${i}" title="Лента кадров, маркер и ножницы">✂ Монтаж</button>` +
            `<button class="btn mini" type="button" data-a="del" data-j="${i}" title="Убрать этот файл">✕</button></span>`
          : '').join('') +
        (full ? '<span class="hint" style="font-size:12px">' + slots.length + ' видео - максимум</span>' : '');
      paintThumbs();
    };
    const closeWin = () => { host.hidden = true; cur = -1; };
    const onFile = (f, q) => {                         // the cut replaces the file in the tile; the original stays
      const i = q._slot, s = slots[i]; if (!s) return;
      s._src = s._src || s._file;
      s._file = f;
      s._vsel = { start: q.start, end: q.end, of: s._src.name };
      s._dur = q.len();
      $('span', s).textContent = f.name;
      $('small', s).textContent = Math.round(s._dur) + ' с';
      paint();
      try { changed(); } catch (e) {}
      if (root._save) root._save();
    };
    const openTrim = i => {
      const s = slots[i];
      if (!s._file) return;
      if (!host.hidden && cur === i) { closeWin(); return; }
      host.hidden = false;
      if (!tr) tr = root._vtrim = new VideoTrimmer({
        mount: host, limit: LIMIT, agentTarget: cfg.mode, onFile,
        whereLabel: q => 'раздел «' + MODE_NAME + '», референс-видео ' + (q._slot + 1) + ', тег <Video ' + (q._slot + 1) + '>',
        onRemove: q => {                       // the cross on the block does the same as ✕ in the chip
          const s = slots[q._slot]; if (!s) return;
          const x = $('.x', s); if (x) x.click();
          s._src = null; s._vsel = null;
          closeWin(); paint();
          if (root._save) root._save();
        },
        onWhole: q => { const s = slots[q._slot]; if (s) { s._vsel = null; paint(); } },
        // a frame of the reference video is a reference picture: it goes to the first free place, and the
        // person sees it right there - a file nobody sees is not a result
        onFrame: f => frameOut(f, root, toast)
      });
      const src = s._file;                            // what is stored now: the piece, if it was cut
      // the same place can hold ANOTHER video: then it has to be loaded again, however the marks stood -
      // otherwise the bench keeps showing the file that was there before, which is what it did
      if (tr._slot !== i || !tr.dur0 || tr._srcFile !== src) {
        tr._slot = i;
        tr._srcFile = src;
        tr.origFile = s._src || null;                  // «Вернуть целый» must know the original
        tr.isPiece = !!s._src;
        tr.setFile(src, true);
        const sel = s._vsel;
        if (sel && src === s._src && sel.end <= (tr.dur0 || sel.end) + .2) {
          const fix = () => { tr.start = sel.start; tr.end = sel.end; tr.cut = { s: sel.start, e: sel.end }; tr._sync(); };
          if (tr.dur0) fix(); else setTimeout(fix, 500);
        }
      }
      cur = i;
      host.scrollIntoView({ block: 'nearest' });
    };
    const put = (f, i) => {
      const free = slots.findIndex(x => !x._file);
      const s = slots[i < 0 ? free : i];
      if (!s) { toast('Больше ' + slots.length + ' референс-видео нельзя'); return; }
      const e2 = new DataTransfer(); e2.items.add(f);
      const input = $('input', s);
      input.files = e2.files; input.dispatchEvent(new Event('change'));
    };
    row.onclick = e => {
      const b = e.target.closest('button'), j = e.target.closest('.token');
      if (b && b.dataset.a === 'add') { pick = -1; inp.click(); return; }
      if (b && b.dataset.a === 'edit') { openTrim(+b.dataset.j); return; }
      if (b && b.dataset.a === 'del') {
        const s = slots[+b.dataset.j], x = $('.x', s);
        if (x) x.click();
        s._src = null; s._vsel = null;
        if (cur === +b.dataset.j) closeWin();
        paint();
        if (root._save) root._save();
        return;
      }
      if (j && !b) {
        const ta = $('textarea', root), tag = '<Video ' + (+j.dataset.j + 1) + '>';
        if (!ta) { toast('Тег ' + tag + ' - в этом режиме текста нет'); return; }
        const p = ta.selectionStart || 0;
        ta.value = ta.value.slice(0, p) + tag + ta.value.slice(p);
        ta.focus(); ta.selectionStart = ta.selectionEnd = p + tag.length;
        if (root._save) root._save();
      }
    };
    thumbs.onclick = e => { const cc = e.target.closest('.vt2'); if (cc) openTrim(+cc.dataset.j); };
    root._mediaPaint = (root._mediaPaint || []).concat(paint);   // the section's «Очистить всё» calls this too
    inp.onchange = () => {
      const f = inp.files && inp.files[0], i = pick; pick = -1;
      inp.value = '';
      if (f) put(f, i);
    };
    slots.forEach((s, i) => $('input', s).addEventListener('change', () => {
      s._src = null; s._vsel = null; s._dur = 0;    // the length of the previous file must not survive it
      if (cur === i) closeWin();
      paint();
      const f = s._file;
      if (f && !s._dur) {                 // the length arrives a moment later than the file itself
        const m = document.createElement('video');
        m.preload = 'metadata'; m.src = URL.createObjectURL(f);
        m.onloadedmetadata = () => {
          if (s._file === f) { s._dur = m.duration || 0; paint(); }
          URL.revokeObjectURL(m.src);
        };
      }
    }));
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('over'); });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('over');
      const f = e.dataTransfer.files[0]; if (f) put(f, -1);
    });
    paint();
  }

  function refAudioCard() {
    const slots = [...$$('.slot', audsEl)];
    if (!slots.length || typeof AudioTrimmer !== 'function') return;
    const refCard = audsEl.closest('.card');
    if (!refCard) return;
    const newEl = (cls) => { const e = document.createElement('div'); if (cls) e.className = cls; return e; };
    const esc = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    audsEl.parentElement.classList.add('ra-tiles');   // the old block with its caption: storage only
    const card = newEl('card');
    card.innerHTML = '<div class="card-h"><h3><span class="n">2</span>Аудио</h3></div>' +
      '<div class="hint" style="margin-bottom:9px">Модель получает ваши аудио как <b>ссылки</b> и берёт их там, где вы упомянули файл тегом в тексте. Не упомянули - звук она делает сама. До трёх файлов, каждый можно обрезать до 15 секунд.</div>' +
      '<div class="ra-row"></div>';
    refCard.after(card);
    const row = $('.ra-row', card), host = newEl('ra-host'); host.hidden = true;
    card.append(host);
    // same here: this card is what the person sees, the old row is hidden storage
    {
      const ab = agMakeBtn($('.card-h', card), '🎧', 'весь референс-аудио: Сценарист распознает слова и вставит их в промпт');
      if (ab) {
        ab._agCount = () => slots.filter(s => s._file).length;
        ab.onclick = async () => {
          const list = slots.map(s => s._file).filter(Boolean);
          if (!list.length) { toast('Референс-аудио нет - сначала добавьте его'); return; }
          if (await speechReady()) return;
          let added = 0, again = 0;
          for (let j = 0; j < list.length; j++) {
            const f = list[j];
            try {
              const ac = setActx();
              const buf = await ac.decodeAudioData(await f.arrayBuffer());
              const e = Math.min(buf.duration, 15);
              const where = 'референс-аудио ' + (j + 1) + ', тег <Audio ' + (j + 1) + '>'
                + (buf.duration > 15 ? ' (берём первые 15 с)' : '');
              if (await setChatAudio(wavSlice(buf, 0, e), f.name, e, where)) added++; else again++;
            } catch (err) { toast('Не удалось передать «' + f.name + '»: ' + (err && err.message ? err.message : '')); }
          }
          const moved = agPickTarget(cfg.mode);   // цель включается до перехода: тост должен о ней сказать
          agGo();
          toast(added ? ('В чат сценариста добавлено аудио: ' + added + (again ? ' · ' + again + ' уже лежало' : '') + moved)
                      : 'Всё это аудио уже лежит в чате сценариста' + moved);
        };
      }
    }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a'; inp.hidden = true; card.append(inp);
    let tr = null, cur = -1, pick = -1;               // pick: the chip whose button opened the dialog
    const paint = () => {
      const full = slots.filter(s => s._file).length >= slots.length;
      row.innerHTML = '<button class="btn mini" type="button" data-a="add"' + (full ? ' disabled' : '') +
        ' title="Голос, ритм, атмосфера: до ' + slots.length + ' файлов. Обрезать можно до 15 секунд.">Загрузить аудио</button>' +
        '<span class="counter" title="Сколько аудио допускается в этом режиме">' + slots.filter(s => s._file).length + ' / ' + slots.length + '</span>' +
        slots.map((s, i) => s._file
          ? `<span class="token" data-j="${i}" title="Тег вставится в текст по нажатию">&lt;Audio ${i + 1}&gt; ${esc(s._file.name.slice(0, 22))}` +
            (s._dur ? ' · <small style="opacity:.75">' + (Math.round(s._dur * 10) / 10 + '').replace('.', ',') + ' с' + (s._sel ? ' · вырезано' : '') + '</small>' : '') +
            ` <button class="btn mini" type="button" data-a="trim" data-j="${i}" title="Послушать и обрезать: окно под строкой">Обрезать</button>` +
            `<button class="btn mini" type="button" data-a="del" data-j="${i}" title="Убрать этот файл">✕</button></span>`
          : '').join('') +
        (full ? '<span class="hint" style="font-size:12px">' + slots.length + ' аудио - максимум</span>' : '') +
        (slots.some(s => s._file && s._dur > 15.2) ? '<span class="hint" style="font-size:12px;color:var(--pink)">есть длиннее 15 с - обрежьте, иначе модель возьмёт начало</span>' : '');
    };
    const closeWin = () => { host.hidden = true; cur = -1; };
    const onFile = f => {                             // the editor hands over the cut; the tile is what the run reads
      const i = tr._slot, s = slots[i]; if (!s) return;
      const src = s._src || s._file;
      s._src = src;                                   // the original stays, so a second cut is possible
      s._file = new File([f], src.name.replace(/\.[a-z0-9]+$/i, '') + '.wav', { type: 'audio/wav' });
      s._sel = { start: tr.start, end: tr.end, of: src.name };
      s._dur = tr.len();
      $('span', s).textContent = s._file.name;
      $('small', s).textContent = Math.round(s._dur) + ' с';
      paint();
      try { changed(); } catch (e) {}
      if (root._save) root._save();
    };
    const openTrim = i => {
      const s = slots[i];
      if (!s._file) return;
      if (!host.hidden && cur === i) {                // the same button closes it: what you highlighted is what you get
        const keep = s._sel || (tr && tr._loaded) || { start: 0, end: (tr && tr.dur0) || 0 };
        if (tr && tr.dur0 && (Math.abs(tr.start - keep.start) > .05 || Math.abs(tr.end - keep.end) > .05)) tr.out();
        closeWin();
        return;
      }
      host.hidden = false;
      const MODE_NAME = { refs: 'Видеостудия', actor: 'Актёр', action: 'Экшн-видео', long: 'Киностудия', actionsc: 'Экшн-студия' }[cfg.mode] || cfg.mode;
      if (!tr) tr = root._raTrim = new AudioTrimmer({ mount: host, limit: 15, agentTarget: cfg.mode, onFile,
        whereLabel: q => 'раздел «' + MODE_NAME + '», аудио ' + (q._slot + 1) + ', тег <Audio ' + (q._slot + 1) + '>, ' + slots.length + ' места в разделе' });
      const src = s._src || s._file;
      if (tr._slot !== i || !tr.dur0) {
        tr._slot = i;
        tr.setFile(src, true);                        // the ORIGINAL always opens
        const sel = s._sel;
        if (sel && src === s._src && sel.end <= tr.dur0 + .2) {
          tr.start = sel.start; tr.end = Math.min(sel.end, tr.dur0);
          tr._loaded = { start: sel.start, end: tr.end }; tr._sync();
        }
      }
      cur = i;
      host.scrollIntoView({ block: 'nearest' });
    };
    const put = (f, i) => {                           // the tile is filled through its own input: its handlers stay in charge
      const s = slots[i < 0 ? slots.findIndex(x => !x._file) : i];
      if (!s) { toast('Больше ' + slots.length + ' аудио нельзя'); return; }
      const e2 = new DataTransfer(); e2.items.add(f);
      const input = $('input', s);
      input.files = e2.files; input.dispatchEvent(new Event('change'));
    };
    row.onclick = e => {
      const b = e.target.closest('button');
      const j = e.target.closest('.token');
      if (b && b.dataset.a === 'add') { pick = -1; inp.click(); return; }
      if (b && b.dataset.a === 'trim') { openTrim(+b.dataset.j); return; }
      if (b && b.dataset.a === 'del') {
        const s = slots[+b.dataset.j], x = $('.x', s);
        if (x) x.click();
        s._src = null; s._sel = null;
        if (cur === +b.dataset.j) closeWin();
        paint();
        if (root._save) root._save();
        return;
      }
      if (j && !b) {                                  // a click on the chip itself puts the tag into the text
        const ta = $('textarea', root), tag = '<Audio ' + (+j.dataset.j + 1) + '>';
        if (!ta) { toast('Тег ' + tag + ' - в этом режиме текста нет'); return; }
        const p = ta.selectionStart || 0;
        ta.value = ta.value.slice(0, p) + tag + ta.value.slice(p);
        ta.focus(); ta.selectionStart = ta.selectionEnd = p + tag.length;
        if (root._save) root._save();
      }
    };
    inp.onchange = () => {
      const f = inp.files && inp.files[0], i = pick; pick = -1;
      inp.value = '';
      if (!f) return;
      put(f, i);
    };
    // a file may arrive without the button: dropped on the row, or put back from a saved project
    slots.forEach((s, i) => $('input', s).addEventListener('change', () => {
      s._src = null; s._sel = null;
      if (cur === i) closeWin();
      paint();
      const f = s._file;
      if (f && !s._dur) {                 // the tile learns the length from a media element a moment later;
        const m = new Audio(URL.createObjectURL(f));   // the chip waits for it, otherwise it shows no length
        m.preload = 'metadata';
        m.onloadedmetadata = () => { if (s._file === f) { s._dur = m.duration || 0; paint(); } URL.revokeObjectURL(m.src); };
      }
    }));
    row.addEventListener('dragover', e => { e.preventDefault(); row.classList.add('over'); });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('over');
      const f = e.dataTransfer.files[0]; if (f) put(f, -1);
    });
    root._mediaPaint = (root._mediaPaint || []).concat(paint);   // the section's «Очистить всё» calls this too
    // the cards after the new one used to be «2», «3» and so on: they all move one step. The whole
    // section is walked, not only this column - «Параметры» stands in another one and stayed a «3»
    // «Параметры» is built later than this point, so renumbering once here is not enough: the section
    // keeps the job as a function and calls it again when everything stands in place
    const renumber = () => {
      let num = 0;
      [...(root.closest('.view') || root).querySelectorAll('.card')].forEach(c2 => {
        const nn = c2.querySelector('.card-h .n'); if (!nn) return;   // a card without a number takes no place
        const want = String(++num);
        if (nn.textContent !== want) nn.textContent = want;           // touch it only when it really differs
      });
    };
    renumber();
    const viewEl = root.closest('.view') || root;
    viewEl._h3Renumber = renumber;
    setTimeout(renumber, 700);          // the settings card and any later card are numbered too
    setTimeout(renumber, 2500);
    paint();
  }
  if (cfg.swap) $('.rm-vids input', root).addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const box = $('.sw-cuts', root); box.value = '';
    try { const c = await detectCuts(f); box.value = c.join(', '); } catch { /* one piece then */ }
  });
  let onScenes = () => {};
  const promptEl = () => $('.rm-prompt', root) || (cfg.scenes ? ($$('.sc textarea', root).find(t => t.value.trim()) || $('.sc textarea', root)) : (root._ta || $('.sc textarea', root)));   // video studio: the first scene that has a text (the focused field may be a stale one)
  if (cfg.swap) {   // beginner form: who to replace instead of a prompt; the program writes the prompt itself
    scWin = scenarioWindow(scBox, {
      kind: 'swap', num: 2, hint: 'можно написать в разделе «Сценарист»',
      placeholder: 'Напишите обычным промптом, кого на кого заменить. Например: Replace the man in the white shirt in <Video 1> with the character from <Picture 1>. Keep the background, camera and movements of the video.',
      cls: 'rm-prompt', chips: 'below', chipsCls: 'rm-tokens',
      generate: { mode: cfg.mode, text: () => ($('.rm-prompt', root) || {}).value },
      tail: `<div class="hint" style="margin-top:6px">Изображения называются <b>Picture 1</b>, <b>Picture 2</b> (по порядку слотов), видео — <b>Video 1</b>. Если оставить пустым, программа сама заменит главного человека в видео на героя с первого изображения.</div>
      <div hidden>
        <input class="sw-cuts"><input class="rm-who" data-i="0"><input class="rm-who" data-i="1">
      </div>`,
    });
    /* Кнопка примера - не тег, а кнопка поля: она встаёт в ряд кнопок окна, перед очисткой. */
    if (scWin && scWin.buttons) {
      const ex = document.createElement('button');
      ex.type = 'button'; ex.className = 'btn sw-example';
      ex.style.cssText = 'padding:3px 10px;font-size:12px';
      ex.title = 'Если поле промпта пустое - впишет готовый текст замены: «замените человека в &lt;Video 1&gt; на героя из &lt;Picture 1&gt;…». Поле с вашим текстом не тронет - пример вставляется только в пустое поле. Текст можно править как обычно.';
      ex.textContent = 'Вставить пример';
      scWin.buttons.append(ex);
    }
    $('.sw-example', root).onclick = () => { const t = $('.rm-prompt', root); if (!t.value.trim()) { t.value = 'Replace the person in <Video 1> with the character from <Picture 1>. Retain the identity, attire and style of the character from <Picture 1>. Preserve the camera angle, background, lighting and the movements of the original video. Do not display the reference images or their backgrounds.'; t.dispatchEvent(new Event('input', { bubbles: true })); } };
    $('.rm-media .sub-l span', root).textContent = 'Видео, в котором меняем';
    $('.rm-media .media-hint', root).textContent = 'одно видео · брать можно до 25 секунд · лучше один непрерывный план · лишнее отрежьте: ✂ Монтаж под плитками';
    $$('.rm-imgs .plus', root).forEach((pl, i) => { pl.lastChild.textContent = i ? 'Персонаж 2' : 'Персонаж 1'; });
    // the video sits in the same row as the pictures (third slot); its status line goes under the row
    vidsEl._hint = $('.rm-media .media-hint', root); vidsEl.style.display = 'contents'; imgsEl.append(vidsEl);
    imgsEl.closest('.card').insertBefore(vidsEl._hint, $('.note', imgsEl.closest('.card'))); vidsEl._hint.style.margin = '8px 0 0';
    $('.rm-media', root).hidden = true;
    // «how it works» sits right after the references, before the prompt
    imgsEl.closest('.card').insertAdjacentHTML('beforeend', `<details class="agvar" style="margin:10px 0 0"><summary>Как работает и советы</summary>
      <div class="hint" style="font-size:12.5px;line-height:1.5">Берём ваше видео и заменяем в нём выбранного человека на героя с изображения: поза, движения, камера и фон остаются прежними. Лучше всего на коротком непрерывном плане; лицо и мелкие детали иногда «плывут», тогда нажмите «Другой вариант».</div>
      <div class="hint" style="font-size:12.5px;line-height:1.5;margin-top:6px"><b>Советы.</b> Изображение с одним героем и простым фоном. Качество задаёт размер результата, а не размер вашего видео. Для пробы выберите самый быстрый размер, понравилось — «В хорошем качестве» под результатом. Ориентир: около минуты расчёта на секунду видео на RTX 4060 Ti 16 ГБ при 864×480.</div>
      <div class="hint" style="font-size:11.5px;margin-top:6px">Основа: рабочий процесс Smart Bobo и LoRA akatz-ai.</div></details>`);
  }
  // which scenes start as a NEW SHOT: the ones marked by hand, and automatically every 4th continuation in a row
  // (a long chain of continuations wears the picture out; a new shot is built from the references again, so the quality stays the same)
  const MAX_CHAIN = 3;
  const freshAt = () => { let run = 0; return $$('.sc', root).map((c, i) => { if (!i) { run = 0; return false; } const hand = !!$('.sc-fresh', c)?.checked; if (hand || run >= MAX_CHAIN) { run = 0; return true; } run++; return false; }); };
  const sceneList = () => { const fr = freshAt(); return $$('.sc', root).map((c, i) => ({ prompt: $('textarea', c).value.trim(), sec: +$('input[type=range]', c).value, lng: !!c._longSec, fresh: fr[i] })); };
  if (cfg.scenes) {
    const card = scBox;                      // то же место в колонке, где у остальных режимов окно
    card.removeAttribute('data-scenarobox');
    card.innerHTML = `<div class="card-h"><h3><span class="n">4</span>Сцены</h3><span class="counter lm-total"></span></div>
      <div class="tl-player"><video class="tl-vid" controls playsinline loop hidden></video><div class="hint tl-empty">Здесь покажется готовая сцена. Выберите фрагмент на ленте ниже и нажмите «Сделать эту сцену».</div></div>
      <div style="display:flex;gap:8px;margin-bottom:6px;flex-wrap:wrap"><button class="btn pri tl-all" type="button" title="Готовые сцены подряд, как один ролик: первая, вторая, третья...">▶ Смотреть готовые сцены подряд</button><button class="btn pri tl-join" type="button" title="Все готовые сцены по порядку отправляются в «Монтаж»: там остаётся нажать «Склеить», и весь ролик одним файлом появится в Библиотеке, откуда его можно сохранить"> вниз Собрать весь ролик и сохранить</button><span class="hint tl-note" style="align-self:center"></span></div>
      <div class="tl" title="Фрагменты ролика по порядку. Тяните внутри фрагмента, чтобы задать его длину. Ручкой слева переставляйте сцены"></div>
      <div class="hint" style="margin:-6px 0 10px;font-size:12px">Нажмите на фрагмент, чтобы открыть его. Тяните внутри фрагмента - задаёте время сцены, за правый край - тоже, но с шагом. Ручка слева переставляет сцены местами, крестик убирает сцену целиком.</div>
      <div class="lm-scenes"></div>
      <div class="seg lm-q" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin:10px 0 6px"><button type="button" data-mq="draft">Черновик<small>4 шага, быстро: посмотреть, что получится</small></button><button type="button" data-mq="final">Хорошее качество<small>8 шагов: итоговые сцены</small></button></div>
      <div class="hint lm-q-hint" style="margin-bottom:10px"></div>
      <div class="seg lm-mode" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-bottom:6px"><button type="button" data-m="parts">По частям<small>сцена за сценой</small></button><button type="button" data-m="all">Весь ролик<small>одним файлом</small></button></div>
      <div class="hint lm-mode-hint" style="margin-bottom:10px"></div>
      <div class="seg lm-base" style="margin-bottom:6px"><button type="button" data-b="own" class="on" title="Новые сцены - считать всё с нуля по вашим описаниям">Новые сцены</button><button type="button" data-b="cont" title="Продолжить своё видео - берём конец вашего файла, и сцена идёт дальше от него">Продолжить видео</button></div>
      <div class="hint lm-base-hint" style="margin-bottom:10px"></div>
      <button class="btn pri lm-chain" type="button" style="margin-bottom:12px;width:100%;padding:12px" title="Сцены считаются одна за другой сами: следующая запускается, когда предыдущая готова. Можно оставить компьютер на ночь: каждая сцена сохраняется в Библиотеку отдельным клипом.">Сделать все сцены</button>
      <button class="btn pri lm-final" type="button" hidden style="margin-bottom:12px;width:100%;padding:12px" title="Все сцены считаются заново с теми же текстами и тем же seed, но на 8 шагах: детали станут лучше. Один в один они не будут."> Всё готово? Сделать всё в хорошем качестве</button>
      <div class="note lm-src" hidden style="margin-bottom:10px"><span><b>Продолжаем готовое видео:</b> <span class="lm-srcname"></span>. Первая сцена продолжит его конец, как будто это была прошлая сцена.</span> <button class="btn lm-srcx" type="button" style="padding:2px 9px;margin-left:8px">Убрать</button></div>
      <button class="btn" type="button" id="lmAdd" style="margin-top:10px">+ Добавить сцену</button>
      <div class="lm-srcpick" hidden>
        <div class="hint" style="margin:0 0 6px">Загрузи своё видео</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn" style="cursor:pointer" title="Видео с телефона, из монтажника, от другой модели: возьмём его последние кадры, и первая сцена продолжит их">С компьютера…<input type="file" accept="video/*" class="lm-srcfile" hidden></label>
          <button class="btn lm-srclib" type="button" title="Взять ролик, который вы уже делали здесь">Из Библиотеки…</button>
        </div>
      </div>
      <div data-tagrow></div>
      <div class="note" style="margin-top:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h0M11 12h1v5h1"/></svg><span>Изображения героя необязательны: без них ролик строится только по тексту (например, про Древний Рим). Сцены идут одна за другой, каждая продолжает прошлую: герой, место и звук переходят дальше. Но при каждом продолжении изображение немного портится, поэтому при смене плана или места ставьте у сцены галочку «Новый план»: она строится заново по вашим изображениям, и качество остаётся как в первой сцене. В каждой сцене опишите героя, что он делает и как движется камера. Длину сцены задаёт ползунок. Текст сцены можно составить в разделе «Сценарист».</span></div>`;
    /* Общий ряд картинок студий сцен даёт тот же модуль окна, что и поля: ряд собирается
       одним кодом, а ряды отдельных сцен помечены иначе, чтобы их не перепутать. */
    const sharedRow = scenarioTagRow('rm-tokens');
    sharedRow.row.dataset.tagrow = '1';
    $('[data-tagrow]', card).replaceWith(sharedRow.row);
    const c1 = $('.rm-imgs', root).closest('.card');
    $('h3', c1).innerHTML = '<span class="n">1</span>Референсы';
    $('.rm-count', root).hidden = true;
    $$('.rm-imgs .plus', root).forEach((pl, i) => { pl.lastChild.textContent = 'Референс'; });
    $('.rm-media .sub-l span', root).textContent = 'Песня или фрагмент';
    $('.rm-media .media-hint', root).textContent = 'любой длины: каждая сцена берёт свой кусок по порядку';
    const box = $('.lm-scenes', root);
    const snap = v => { v = Math.max(5, Math.round(v * 24)); return v + (5 - v % 17 + 17) % 17; };
    const accs = () => {  // frames of the finished video after each scene (same arithmetic as the server)
      const out = []; let acc = 0;
      const fr = freshAt(); $$('.sc input[type=range]', root).forEach((r, k) => { const seg = snap(+r.value); if (!k) acc = seg; else if (fr[k]) acc += seg; else { const t = snap((seg + snap(1)) / 24), ov = snap((t - seg) / 24); acc += t - ov; } out.push(acc); });
      return out;
    };
    const total = () => { const a = accs(); return a.length ? a[a.length - 1] / 24 : 0; };
    const mmss = t => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    const recount = () => {
      const all = $$('.sc', root), a = accs(), own = root._snd === 'own';
      all.forEach(x => x._counter?.());   // a tag inserted by a chip does not fire "input": count on every recount
      root._lockBase?.();   // a fresh scene must inherit what the continuation forbids
      const st = Math.max(0, parseFloat($('.lm-start', root)?.value) || 0);
      all.forEach((c, i) => {

      paintRange($('input[type=range]', c));   // the blue fill follows the handle, also on a freshly added scene
        const from = i ? a[i - 1] / 24 : 0, to = a[i] / 24;
        /* The number of the scene belongs on the card, not only on the ribbon: with twenty scenes
           the person must see at a glance which one they are looking at. The length of the clip
           stands right after the plus, the same in both studios - where the action studio used to
           print the piece of its own song. That time is not lost: it lives in the tooltip. */
        const no = $('.sc-no', c), se = $('.sc-sec', c);
        if (no) no.textContent = i + 1;
        const sec = +$('input[type=range]', c).value;
        if (se) {
          se.textContent = sec + ' с';
          // за 15 секунд качество держится хуже: пусть это будет видно без наведения
          se.style.color = sec > 15 ? 'var(--pink)' : '';
          se.title = `Длительность этой сцены: ${sec} с` + (sec > 15 ? ' · длинный режим: модель обучена до 15 с' : '') + (own ? ` · кусок аудио ${mmss(st + from)}–${mmss(st + to)}` : '');
        }
        $('.sc-win', c).textContent = '';
      });
      const t = total(); $('.lm-total', root).textContent = `≈ ${Math.round(t)} с в итоге`; S.dur = Math.round(t);
      const dur = root._adur;
      const w = $('.lm-warn', root); if (w) { w.hidden = !(own && dur && st + t > dur + 0.5); w.textContent = `Аудио короче, чем нужно: ролик на ${Math.round(t)} с, а от выбранного места в треке осталось ${Math.max(0, Math.round(dur - st))} с. Сократите сцены или начните трек раньше.`; }
      root._renderTL?.(); changed(); onScenes(); refreshStates(); if (root._save && !root._restoring) root._save();
    };
    root._recount = recount;
    root._mode = 'parts'; root._run = Math.random().toString(36).slice(2, 12);
    const sig = c => JSON.stringify([+$('input[type=range]', c).value]);
    const secOf = sg => { try { const a = JSON.parse(sg); return a.length === 1 ? a[0] : a[1]; } catch { return null; } };   // old saved projects had [text, seconds, file]
    const sigOk = c => !!c._done && String(secOf(c._done.sig)) === String(+$('input[type=range]', c).value);
    function readyUpTo() {   // how many scenes from the start are done and unchanged
      let n = 0; for (const c of $$('.sc', root)) { if (sigOk(c)) n++; else break; } return n;
    }
    function refreshStates() {
      const parts = root._mode === 'parts', ready = readyUpTo();
      $$('.sc', root).forEach((c, i) => {
        $('.sc-act', c).hidden = !parts;
        const done = sigOk(c);
        const stale = c._done && !done;
        $('.sc-state', c).textContent = done ? ', готова, клип в Библиотеке' + (c._done.text != null && c._done.text.trim() !== $('textarea', c).value.trim() ? ' · текст изменён после генерации, клип прежний' : '') : stale ? 'длина изменена: переделайте (следующие тоже)' : i > 0 && !root._canGo(i) ? `сцена ${i} ещё не готова: эта будет сделана как новый план` : '';
        $('.sc-state', c).style.color = done ? 'var(--ok, #7bd88f)' : stale ? 'var(--pink)' : '';
        const b = $('.sc-do', c); b.disabled = false; b.style.opacity = ''; $('.sc-undo', c).hidden = !(root._undo && root._undo.length); b.textContent = done ? 'Переделать' : 'Сделать эту сцену';
        const rg = $('.sc-redogo', c); if (rg) rg.hidden = !(done && parts && i < $$('.sc', root).length - 1);
      });
      const r = $('.lm-reset', root); if (r) r.hidden = !parts || !ready;
      const ch = $('.lm-chain', root); if (ch) { ch.hidden = !parts; ch.textContent = 'Сделать все сцены'; }
      root._memo?.();   // the quality and the counting mode are said once, above the run buttons
      $('.rm-preview', root)._syncLabel?.();   // and the button shows the scene you are on
      const lf = $('.lm-final', root); if (lf) lf.hidden = !(parts && root._q === 'draft' && ready >= $$('.sc', root).length);
      root._renderTL?.();
      onScenes();
      if (root._save && !root._restoring) root._save();
    }
    root._ready = readyUpTo; root._sig = sig;
    root._canGo = i => i === 0 || freshAt()[i] || sigOk($$('.sc', root)[i - 1]);   // a scene may start when it needs no previous one, or the previous one is ready
    S.onSizeChange = kind => {   // another size (or format): the ready scenes were made in the old one, they stay on the ribbon as an old version
      const modes = kind === 'aspect' ? ['draft', 'final'] : [root._q]; let any = false;
      $$('.sc', root).forEach(c => modes.forEach(m => { if (c._dn[m]) { c._old = { ...(c._old || {}), [m]: c._dn[m] }; c._dn[m] = null; any = true; } }));
      root._paintQ?.(); refreshStates(); root._renderTL?.();
      if (any) toast('Размер изменён. Готовые сцены остались на ленте как «старая версия»: сделайте их заново в новом размере.');
    };
    root._chainPart = null;   // scene number started by "make all scenes in a row": only its result starts the next one
    const chainNext = () => {
      const all = $$('.sc', root), k = readyUpTo();
      if (root._chainEnd != null && k > root._chainEnd) { root._chainPart = null; root._chainEnd = null; return; }
      if (k >= all.length) { root._chainPart = null; toast('Все сцены готовы. Клипы лежат в Библиотеке: склейте их в «Монтаже». Память всё ещё держит ComfyUI - «Освободить память» в карточке сцен.'); return; }
      if (!all[k].querySelector('textarea').value.trim()) { root._chainPart = null; toast(`Сцена ${k + 1} пустая: опишите её, и нажмите «Сделать все сцены подряд» снова.`); return; }
      root._chainPart = k; root._target = k; $('.go', $('.rm-preview', root)).click();
    };
    root._chainFail = msg => {   // стоп цепочки с внятной причиной вместо тишины
      if (root._chainPart == null) return;
      const num = root._chainPart + 1;
      root._chainPart = null; root._chainEnd = null;
      const txt = `Сцена ${num} из ${$$('.sc', root).length} не получилась: ${msg}`;
      toast(txt);
      try { noteMsg(txt + ' · цепочка остановлена: почините и нажмите «Сделать все сцены» - продолжится с этой сцены'); } catch (e) { }
    };
    root._chainNext = chainNext;
    $('.lm-chain', root).onclick = () => {
      if (root._mode !== 'parts') return;
      root._chainEnd = null;
      if (readyUpTo() >= $$('.sc', root).length) { toast('Все сцены уже сделаны. Чтобы переделать одну, нажмите «Переделать» в её карточке.'); return; }
      chainNext();
    };
    root._next = () => { const n = $$('.sc', root).length; return Math.min(n - 1, root._target != null ? root._target : readyUpTo()); };
    S.len = () => { if (root._mode !== 'parts') return total(); const r = $$('.sc input[type=range]', root)[root._next()]; return r ? +r.value : total(); };
    root._src = null;
    const lastFrameFile = async file => {   // the last picture of a video file from the computer
      // ask the program first: it has a real decoder, so HEVC and odd containers work there
      try {
        const r = await fetch('/api/video/lastframe?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
        if (r.ok) { const b = await r.blob(); if (b && b.size > 512) return new File([b], 'last_frame.png', { type: 'image/png' }); }
      } catch (e) { /* the window method below still has a chance */ }
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
      const fail = new Error(`Браузер не открыл это видео (${file.name}): обычно так ведут себя HEVC или редкий контейнер. Сохраните его как MP4 (H.264).`);
      const open = await new Promise(res => { v.onloadedmetadata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(v.readyState > 0), 15000); });
      if (!open) { URL.revokeObjectURL(v.src); throw fail; }
      // some files (webm especially) do not know their length until you ask for the end
      if (!isFinite(v.duration) || !v.duration) {
        v.currentTime = 1e6;
        await new Promise(res => { v.ondurationchange = () => res(); setTimeout(res, 4000); });
      }
      v.currentTime = Math.max(0, (v.duration || 1) - 0.12);
      await new Promise(res => { v.onseeked = res; setTimeout(res, 4000); });
      if (!v.videoWidth || !v.videoHeight) { URL.revokeObjectURL(v.src); throw fail; }
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/png')); URL.revokeObjectURL(v.src);
      if (!blob) throw fail;
      return new File([blob], 'last_frame.png', { type: 'image/png' });
    };
    // the last frame of a continued video is a picture of its own: it stands in front of your five,
    // is not one of them and cannot be called by a number - it just always goes to the model
    const frameTile = async file => {
      let tile = $('.srf', imgsEl);
      if (!tile) {
        tile = document.createElement('div'); tile.className = 'srf';
        tile.innerHTML = '<img alt=""><i class="srfl">кадр видео</i>';
        imgsEl.prepend(tile);
      }
      $('img', tile).src = URL.createObjectURL(file);
      root._srcFrame = tile; root._srcFrameFile = file;
      $$('.sc', root).forEach(x => x._counter?.());
      return tile;
    };
    root._ensureFrame = async () => {
      /* The last frame of the base video is what a continuation really starts from, so it must be
         visible - not only when you pick the video by hand, but after a project is reopened from the
         library and after the Agent hands a video over. One door for all of them. */
      const s = root._src; if (!s) return null;
      if (root._srcFrame && root._srcFrame.isConnected) return root._srcFrame;
      try {
        const f = s.file instanceof File ? s.file
          : s.id ? await libToFile((typeof LIB !== 'undefined' ? LIB : []).find(x => x.id === s.id)) : null;
        if (!(f instanceof File)) return null;
        return await frameTile(await lastFrameFile(f));
      } catch { return null; }
    };
    root._setSrc = (src, fresh = true) => {   // src: { id } of a library clip or { file } from the computer; null removes it
      root._src = src || null;
      $('.lm-src', root).hidden = !src; $('.lm-srcname', root).textContent = src ? src.name : '';
      $('.lm-srcx', root).hidden = !src;   // the button stands with the source buttons, so it hides itself
      if (!src && root._srcFrame) { root._srcFrame?.remove?.(); root._srcFrame = null; root._srcFrameFile = null; $$('.sc', root).forEach(x => x._counter?.()); }   // the frame tile leaves together with the video
      if (src && fresh) { root._run = Math.random().toString(36).slice(2, 12); $$('.sc', root).forEach(c => { c._dn = { draft: null, final: null }; }); }
      if (src) setMode('parts');
      $('.lm-mode [data-m="all"]', root).disabled = !!src;
      if (src && root._base !== 'cont') { root._base = 'cont'; setBase('cont'); }
      if (src) root._ensureFrame();   // the frame in front of the photos belongs to the base, whoever set it   // a saved project that continues a video shows that choice
      refreshStates();
    };
    // nine pictures in a scene, counted from the text; a chip for a picture the text does not call
    // has no right to add itself when all nine places are taken
      root._free = (k, sc) => {
      if (!sc || !sc._used) return true;
      const cap = sc._cap || 9;
      if (sc._used.size < cap || sc._used.has(k)) return true;
      toast(`В сцене занято все ${cap} мест${sc._frame ? ' (кадр вашего видео идёт отдельно)' : ''}. Уберите из текста другой тег - тогда это фото освободит себе место.`);
      return false;
    };
    root._takeVideo = async f => {
      /* The base video of a continuation, whole: the file, the mode that continues it, and the last
         frame standing in front of your photos. The Agent hands videos over the same door, so the
         frame appears there too - before, the transfer only remembered the file. */
      let frame = null, why = '';
      try { frame = await lastFrameFile(f); } catch (err) { why = err.message; }
      root._setSrc({ file: f, name: f.name });   // the video itself is usable even when its last frame cannot be read
      if (frame) await frameTile(frame);
      return { frame, why };
    };
    $('.lm-srcx', root).onclick = () => root._setSrc(null);
    // the same continuation can be taken from what you already made here
    const useLibVideo = async it => {
      root._setSrc({ id: it.id, name: (it.label || it.prompt || it.sub || 'видео из Библиотеки').slice(0, 50) });
      if (root._base !== 'cont') setBase('cont');
      if (await root._ensureFrame()) toast('Взяли видео из Библиотеки: его последний кадр встал отдельной плиткой перед вашими фото, ваших мест 8.');
      else toast('Видео принято. Последний кадр прочитать не удалось - добавьте изображения героя и места сами.');
    };
    $('.lm-srclib', root).onclick = () => {
      let m = $('#lmLibM'); if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'lmLibM'; document.body.append(m); }
      m.hidden = false;
      // a lot of older records carry no kind at all: anything that is not a picture continues a scene
      const vids = LIB.filter(it => !it.missing && it.url && it.kind !== 'image').sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 120);
      m.innerHTML = '<div class="box" style="padding:20px;max-height:80vh;overflow:auto"><div class="card-h"><h3>Продолжить видео из Библиотеки</h3><button class="btn" data-x type="button">Закрыть</button></div>'
        + (vids.length ? `<div class="cw-pickgrid">${vids.map(it => `<button class="cw-th" data-id="${it.id}" type="button" title="${esc((it.prompt || '').slice(0, 90))}" style="width:100%;aspect-ratio:auto;display:block;padding:0;overflow:hidden;text-align:left">
            <span style="display:block;height:96px;background:#0d0d10"><video src="${it.url}#t=0.5" preload="metadata" muted loop playsinline style="width:100%;height:100%;object-fit:cover;display:block"></video></span>
            <span style="display:block;padding:7px 9px"><b>${it.date ? new Date(it.date).toLocaleDateString('ru-RU') : 'без даты'}</b>${it.label || it.sub ? `<small class="hint" style="display:block">${esc((it.label || it.sub || '').slice(0, 34))}</small>` : ''}<small class="hint" style="display:block;font-size:11px">${esc((it.prompt || '').slice(0, 48))}</small></span></button>`).join('')}</div>`
          : '<div class="hint" style="padding:20px 4px">Видео в Библиотеке пока нет - загрузите с компьютера.</div>') + '</div>';
      m.onclick = ev => {
        if (ev.target === m || ev.target.closest('[data-x]')) { m.hidden = true; return; }
        const th = ev.target.closest('.cw-th'); if (!th) return;
        const it = LIB.find(x => x.id === th.dataset.id); if (!it) return;
        m.hidden = true; useLibVideo(it);
      };
    };
    $('.lm-srcfile', root).onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const { frame, why } = await root._takeVideo(f);
        if (frame) toast('Видео загружено. Его последний кадр встал отдельной плиткой перед вашими фото (помечен «кадр видео»), выбрать его номером нельзя - ваших мест 8.');
        else toast((why || 'Кадр взять не удалось') + ' Видео принято - сцена продолжит его, но кадр отдельной плиткой не встал: ваших мест тогда 9.');
      } catch (err) { toast(err.message); }
    };
    root._setScenes = list => {   // from the agent: replace all scenes
      if (!list.length) return 0;
      /* The usual round trip is the same scenes with better texts. Rebuilding the cards for it threw
         away what the person had put in them - a photo gone from a scene was the price of a cleaner
         sentence. When the number of scenes is the same, only the words change: the text and the
         length are written into the cards that already stand there, and shelves, songs, cuts, typed
         lyrics and the decade are not touched at all. */
      const same = $$('.sc', root);
      if (same.length === list.length && list.every(x => x && typeof x.prompt === 'string')) {
        const tags = s => new Set(((s || '').match(/<(?:Audio|Picture)\s*\d+>/g) || []));
        const back = [];
        same.forEach((c, i) => {
          const x = list[i], ta = $('textarea', c); if (!ta) return;
          const had = tags(ta.value), got = tags(x.prompt);
          const lost = Array.from(had).filter(t => !got.has(t));
          ta.value = (String(x.prompt).trim() + (lost.length ? ' ' + lost.join(' ') : '')).trim();
          if (Math.round(x.sec) > 15) window.sceneLongOn(c, true);
          const sec = Math.min(window.sceneCap(c), Math.max(3, Math.round(x.sec) || 0));
          if (sec) { const r = $('input[type=range]', c); if (r) { r.value = sec; } }
          if (x.fresh !== undefined) { const fb = $('.sc-fresh', c); if (fb) fb.checked = !!x.fresh; }
          if (lost.length) back.push('сцена ' + (i + 1) + ': ' + lost.join(', '));
          c._paint?.();
        });
        renumber(); sceneReconcile(root); recount(); refreshStates(); renderTL(); showClip(); if (root._save) root._save();
        if (back.length) toast('Возврат из чата дописал потерянные теги: ' + back.join(' · '));
        return same.length;
      }
      /* The person's own photos and songs hang on the scene cards. Rebuilding the list without
         saving them threw everything away: a draft sent to the Agent came back without a single
         picture, and the numbers in the text pointed at nothing. Cards are matched by their place,
         so the usual round trip - the same scenes with better texts - keeps every shelf filled. */
      const keep = $$('.sc', root).map(c => ({
        files: (c._files || []).slice(), auds: (c._auds || []).slice(), src: (c._audSrc || []).slice(),
        sel: (c._audSel || []).slice(), dur: (c._audDur || []).slice(), fresh: !!$('.sc-fresh', c)?.checked,
        base: c._baseFixed || 0, words: (c._audWords || []).slice(), prompt: ($('textarea', c) || {}).value || "",
      }));
      /* Файл сцены живёт под её номером места: у второй сцены десятки от 20. Когда ответов
       приходит больше или меньше, чем карточек, место съезжает и полка остаётся пустой, хотя
       человек ничего не выбрасывал. Поэтому файл ищем сначала по номеру, который новый текст
       сам называет, и только потом - по совпадению мест. */
      const wantBase = txt => {
        const n = [...String(txt || '').matchAll(/<(?:Picture|Audio)\s*(\d{2,})>/g)].map(m => Math.floor(+m[1] / 10) * 10);
        return n.length ? n.sort((x, y) => x - y)[0] : 0;
      };
      $$('.sc', root).forEach(c => c.remove());
      /* Номер места решается до того, как карточка появилась. Новый текст сам называет номер
         своих файлов: если его позвала сцена, этот номер за ней и закрепляется, а прежняя
         владелица получает свободный. Так подпись плитки и тег в тексте всегда одинаковы. */
      const fresh = list.slice(0, 20);
      const used0 = new Set();
      const baseFor = fresh.map(() => 0);
      // очереди: сначала те, кого текст назвал сам, потом прежний номер сцены, и лишь потом свободный
      fresh.forEach((x, i) => {
        const called = wantBase(x.prompt);
        if (called && !used0.has(called)) { used0.add(called); baseFor[i] = called; }
      });
      fresh.forEach((x, i) => {
        if (baseFor[i]) return;
        const mine = (keep[i] && keep[i].base) || 0;
        if (mine && !used0.has(mine)) { used0.add(mine); baseFor[i] = mine; }
      });
      let free0 = 10;
      const alloc = () => { while (used0.has(free0)) free0 += 10; const v = free0; free0 += 10; return v; };
      fresh.forEach((x, i) => { if (!baseFor[i]) baseFor[i] = alloc(); });
      fresh.forEach((x, i) => addScene(x.prompt, Math.min(25, Math.max(3, Math.round(x.sec) || 10)),
        x.fresh === undefined ? !!(keep[i] && keep[i].fresh) : !!x.fresh, baseFor[i]));
      let back = 0; const lostBack = [];
      /* Перенос в два прохода. Сначала каждая сцена забирает файлы того номера места, который
         назван в её новом тексте: так фото и песня едут вместе со своим тегом, даже если сцены
         в ответе встали в другом порядке. Только то, что никто не позвал, достаётся по месту.
         одним проходом те же файлы оказывались в двух сценах сразу. */
      const cards = $$('.sc', root);
      const called0 = new Array(keep.length).fill(false);
      const take = new Array(cards.length).fill(null);
      cards.forEach((c, i) => {
        const want = wantBase((list[i] && list[i].prompt) || '');
        if (!want) return;
        const j = keep.findIndex((k0, n) => !called0[n] && k0.base === want);
        if (j < 0) return;
        called0[j] = true; take[i] = keep[j];   // файлы едут к той сцене, которая их позвала
      });
      cards.forEach((c, i) => { if (!take[i] && keep[i] && !called0[i]) take[i] = keep[i]; });
      /* Сцен убрали больше, чем карточек осталось: снимок с файлами некому достался. Молча
         выбросить то, что человек принёс, - худший из исходов, поэтому бесхозные файлы
         уходят первой пустой сцене, а её текст пополняется их номерами. */
      keep.forEach((k0, j) => {
        if (called0[j] || !(k0.files.some(Boolean) || k0.auds.some(Boolean))) return;
        const empty = n => cards[n] && !(cards[n]._files || []).some(Boolean) && !(cards[n]._auds || []).some(Boolean)
          && !(take[n] && (take[n].files || []).some(Boolean) || take[n] && (take[n].auds || []).some(Boolean));
        const i = take.findIndex(empty);
        if (i < 0) return;
        called0[j] = true; take[i] = k0;   // снимок без файлов уступает место снимку с файлами
        if (k0.base && !cards[i]._baseFixed) { cards[i]._baseFixed = k0.base; cards[i]._base = k0.base; }
      });
      cards.forEach((c, i) => {
        const k = take[i];
        if (!k) return;
        /* The rewritten text often forgets the media tags of the scene it came from: the agent
           answers beautifully and the song or the object disappears with the tag. Tags the draft
           carried and the answer dropped are put back - the files are still on the shelves, so a
           text without their numbers would leave them unused. */
        const tags = s => new Set(((s || '').match(/<(?:Audio|Picture)\s*\d+>/g) || []));
        const had = tags(k.prompt), got = tags((list[i] && list[i].prompt) || '');
        const lost = Array.from(had).filter(x => !got.has(x));
        if (lost.length) {
          const ta = $('textarea', c);
          if (ta) { ta.value = (ta.value.trim() + ' ' + lost.join(' ')).trim(); lostBack.push('сцена ' + (i + 1) + ': ' + lost.join(', ')); c._paint?.(); }
        }
        if ((k.files || []).some(Boolean)) { c._files = k.files.slice(0, 9); c._paint?.(); back++; }
        if ((k.auds || []).some(Boolean)) {
          c._auds = k.auds.slice(); c._audSrc = (k.src || []).slice(); c._audSel = (k.sel || []).slice();
          if (c._audDur) c._audDur = (k.dur || []).slice();
          c._audWords = (k.words || []).slice();   // the line the person fixed must outlive the rewrite
          c._paintAuds?.(); back++;
        }
      });
      root._sel = 0;
      renumber(); sceneReconcile(root);   // номера мест не спорят друг с другом и согласуются с текстом
      root._run = Math.random().toString(36).slice(2, 12); recount(); refreshStates();
      if (lostBack.length) toast('Возврат из чата дописал потерянные теги: ' + lostBack.join(' · '));
      return back;
    };
    /* Клип мог вернуться уже после того, как страница пересобралась: номер прогона живой, а карточки
     новые. Раньше такой результат молча выбрасывался - человек видел ролик в предпросмотре, полоса
     сцен оставалась пустой, а в журнале не было ни слова. Теперь причина пишется, а клип находится
     в Библиотеке по номеру проекта (см. root._adopt). */
    root._adopt = () => {   // what the Library already holds for THIS project goes back into the tiles
      try {
        const all = (typeof LIB !== 'undefined' && LIB) || [];
        let took = 0;
        all.forEach(it => {
          const lg = it && it.long;
          if (!lg || lg.all || lg.test || lg.run !== root._run || it.missing) return;
          const c = $$('.sc', root)[lg.part]; if (!c) return;
          const mk = lg.draft ? 'draft' : 'final';
          if (c._dn && !c._dn[mk]) {
            c._dn[mk] = { sig: root._sig(c), url: it.url, id: it.id, sec: +it.len || 0, text: ($('textarea', c) || {}).value || '' };
            (root._doneIds = root._doneIds || new Set()).add(it.id);
            took++;
          }
        });
        if (took) { refreshStates(); noteMsg(`студия ${cfg.mode}: нашлось в Библиотеке готовых сцен: ${took}`); }
        return took;
      } catch (e) { return 0; }
    };
    /* Экшн-студия понимает только живое описание того, что происходит в кадре. Тексты, которые
     раньше писал помощник для другого раздела, тащат за собой поля вида overall_soundscape:,
     non_diegetic_music:, integrated_multimodal_description:, служебные фразы «For the target video,
     at 0.00 seconds ...» и метки [Shot 1]; модель читает их как содержимое кадра и начинает
     дорисовывать лишние фигуры. Кнопка «почистить» убирает служебное и оставляем описание. */
  const cleanScene = (txt, pics, c) => {
    let s = String(txt || '');
    // sound and music fields belong to another section: drop the field and its value to the line end
    /* A sound field belongs to another section, but its VALUE may be a tag the person put there by
       hand - <Audio 20> is the scene's own song. The field name goes, the tag stays: eating it used to
       leave the song on the shelf and the model singing its own music. */
    s = s.replace(/[ \t]*(?:overall_soundscape|non_diegetic_music|diegetic_sounds|background_music|sound_design)\s*:\s*([^\n]*)/gi,
      (whole, val) => { const tg = (val.match(/<\s*(?:Picture|Audio)\s*\d+\s*>/gi) || []); return tg.length ? ' ' + tg.join(' ') + ' ' : ' '; });
    // a heading label of its own: keep the description standing after it
    s = s.replace(/[ \t]*(?:integrated_multimodal_description|shot_description|subject_action|camera_movement)\s*:\s*/gi, ' ');
    // the legacy sentence «<Picture 3> (from [Shot 1]) is fully referenced.» - the model has no such pictures
    s = s.replace(/<\s*Picture\s*\d+\s*>\s*\(?\s*(?:from\s*)?\[\s*Shot\s*\d+\s*\]\s*\)?\s*is\s+fully\s+referenced\s*\.?/gi, ' ');
    s = s.replace(/For the target video\s*,?\s*(?:at\s+\d+(?:\.\d+)?\s+seconds\s+into\s+the\s+target\s+video\s*)?,?\s*/gi, ' ');
    s = s.replace(/at\s+\d+(?:\.\d+)?\s+seconds\s+into\s+the\s+target\s+video\s*,?\s*/gi, ' ');
    s = s.replace(/\(?\s*(?:from\s*)?\[\s*Shot\s*\d+\s*\]\s*\)?\s*(?:is\s+fully\s+referenced\s*)?\.?/gi, ' ');
    s = s.replace(/\(\s*\)/g, ' ').replace(/\bis\s+fully\s+referenced\s*\.?/gi, ' ');
    if (pics > 0) {
      /* The count of common references says nothing about the scene's OWN photos, which carry numbers
         of the scene's decade: <Picture 30> was deleted as "more pictures than we have", although the
         file was sitting on the scene's shelf and travelling to the model. A tag with a file behind it
         is never junk. */
      const own = (c && c._baseFixed) || 0, slots = (c && c._files) || [], auds = (c && c._auds) || [];
      s = s.replace(/<\s*(Picture|Audio)\s*(\d+)\s*>/gi, (m, kind, d) => {
        d = +d;
        if (kind.toLowerCase() === 'audio') return (own && d >= own && d < own + 3 && auds[d - own]) ? '<Audio ' + d + '>' : (d < 10 ? '<Audio ' + d + '>' : '');
        if (d <= pics) return '<Picture ' + d + '>';
        const j = own ? d - own : -1;
        return (j >= 0 && j < 9 && slots[j]) ? '<Picture ' + d + '>' : '';
      });
    }
    return s.replace(/[ \t]{2,}/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/^\s+|\s+$/g, '').replace(/\.\s*\./g, '.');
  };
  const sceneJunk = txt => {
    const s = String(txt || '');
    const bad = [];
    if (/(?:overall_soundscape|non_diegetic_music|integrated_multimodal_description|diegetic_sounds)\s*:/i.test(s)) bad.push('поля звука и описания из другого раздела');
    if (/\[[A-Za-z]+\s*\d+\]/.test(s)) bad.push('метки [Shot N]');
    if (/for the target video|fully referenced|seconds into the target video/i.test(s)) bad.push('служебные фразы про «целевой ролик»');
    return bad;
  };
  root._cleanScene = cleanScene;
  root._sceneJunk = sceneJunk;
  // плашка с предупреждением: ставим её под списком сцен и обновляем, когда тексты меняются
  const junkBar = document.createElement('div');
  junkBar.className = 'hint lm-junk';
  junkBar.style.cssText = 'margin:8px 0 0;line-height:1.5';
  junkBar.hidden = true;
  try { ($('.lm-scenes', root) || root).appendChild(junkBar); } catch (e) { }
  const junkPaint = () => {
    try {
      const pics = $$('.ref.filled', root).length;
      const who = $$('.sc', root).map((c, i) => ({ i, why: sceneJunk((c.querySelector('textarea') || {}).value) })).filter(x => x.why.length);
      if (!who.length) { junkBar.hidden = true; junkBar.innerHTML = ''; return; }
      junkBar.hidden = false;
      junkBar.innerHTML = '<b>В тексте ' + who.map(x => 'сцены ' + (x.i + 1)).join(', ') + ' есть лишнее для этого раздела</b> · ' +
        who.map(x => x.why.join(', ')).filter((v, k, arr) => arr.indexOf(v) === k).join(' · ') +
        ' — модель читает это как содержимое кадра и может дорисовать лишние фигуры.' +
        ' <button class="btn mini lm-junkgo" type="button">Почистить тексты</button>';
      const b = $('.lm-junkgo', junkBar);
      if (b) b.onclick = () => {
        $$('.sc', root).forEach(c => {
          const ta = c.querySelector('textarea'); if (!ta) return;
          const v = cleanScene(ta.value, pics, c);
          if (v !== ta.value) { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); }
        });
        toast('Тексты починены: осталось только то, что происходит в кадре');
        junkPaint();
        if (typeof changed === 'function') changed();
      };
    } catch (e) { }
  };
  root._junkPaint = junkPaint;
  setTimeout(junkPaint, 1200);
  root.addEventListener('input', e => { if (e.target && e.target.tagName === 'TEXTAREA') junkPaint(); });
  root._partDone = item => {
      let lg = item && item.long;
      if (!lg && item && item.id) {           // the same clip seen through another door: take the real one
        const real = (typeof LIB !== 'undefined' ? LIB : []).find(x => x.id === item.id);
        if (real && real.long) { lg = real.long; item = real; }
      }
      if (!lg || lg.run !== root._run) {
        if (cfg.scenes) noteMsg(lg
          ? `студия ${cfg.mode}: пришёл клип сцены ${lg.part + 1} из проекта ${lg.run}, а сейчас открыт проект ${root._run} - заберём из Библиотеки`
          : `студия ${cfg.mode}: пришло готовое задание без метки сцены (${item && item.id || 'без id'}) - лента не обновится`);
        return;
      }
      if (root._doneIds && root._doneIds.has(item.id)) return;   // the same result can arrive twice (panel and queue)
      (root._doneIds = root._doneIds || new Set()).add(item.id);
      if (lg.all) {   // the whole video at once: every scene is done, the last one can be continued
        $$('.sc', root).forEach(c => { c._dn.final = { sig: root._sig(c), url: item.url, id: item.id, sec: +item.len || 0, text: $('textarea', c).value }; });
        refreshStates(); toast('Ролик готов. Чтобы продлить его, добавьте сцену и нажмите «Сделать эту сцену» (режим «По частям»).'); return;
      }
      const c = $$('.sc', root)[lg.part]; if (!c) return;
      if (lg.test) { c._tests.push({ res: item.res, url: item.url, id: item.id }); c._paintTests(); toast(`Проба сцены ${lg.part + 1} в размере ${item.res} готова: кнопка под сценой`); return; }
      c._dn[lg.draft ? 'draft' : 'final'] = { sig: (root._sent && root._sent[lg.part]) || root._sig(c), url: item.url, id: item.id, sec: +item.len || 0, text: root._sentText && root._sentText[lg.part] != null ? root._sentText[lg.part] : $('textarea', c).value };
      { const fr = freshAt(), all = $$('.sc', root), mk = lg.draft ? 'draft' : 'final'; for (let j = lg.part + 1; j < all.length && !fr[j]; j++) { const x = all[j]; if (x._dn[mk]) x._old = { ...(x._old || {}), [mk]: x._dn[mk] }; x._dn[mk] = null; } c._old = { ...(c._old || {}), [mk]: null }; }   // the scenes that continued the old one, up to the next new shot
      refreshStates();
      // почему цепочка встала, видно только из этих чисел: что было запланировано, сколько готово, какой проект
      noteMsg(`студия ${cfg.mode}: сцена ${lg.part + 1} из ${lg.n} готова · цепочка=${root._chainPart} · готово до ${readyUpTo()} · проект ${root._run}` + (root._chainPart !== lg.part ? ' · цепочка не совпала: продолжения не будет' : ''));
      if (root._chainPart === lg.part) { toast(`Сцена ${lg.part + 1} готова. Запускаю следующую…`); setTimeout(root._chainNext, 800); return; }
      toast(`Сцена ${lg.part + 1} готова` + (lg.part + 1 < lg.n ? '. Можно делать следующую.' : '. Все сцены готовы: склейте клипы в «Монтаже».'));
    };
    const MODE_HINT = { parts: 'Каждая сцена считается отдельно и сохраняется в Библиотеку своим клипом. Можно посмотреть первую, потом сделать следующую, а неудачную переделать, не трогая остальные. Клипы встают встык без повторов: склейте их в любом видеоредакторе.', all: 'Все сцены считаются подряд и склеиваются в один файл. Удобно, когда уверены в тексте, но если что-то не получится, ждать придётся заново целиком.' };
    // what the work is built on: new scenes, or the continuation of a video from the computer. The
    // second choice decides the rest of the page for you, so nothing has to be remembered
    const baseSeg = $('.lm-base', root), baseHint = $('.lm-base-hint', root);
    const ownBox = $('.lm-srcpick', root);
    // what the continuation forbids, stays on the screen but inactive - so it is visible why it is off
    root._lockBase = () => {
      const cont = root._base === 'cont', seg = $('.lm-mode', root);
      if (seg) {
        seg.style.opacity = cont ? '.45' : ''; seg.style.pointerEvents = cont ? 'none' : '';
        $$('button', seg).forEach(b => { b.disabled = cont && b.dataset.m !== 'parts'; });
      }
      $$('.sc', root).forEach((x, i) => {
        const box = x.querySelector('.sc-fl'), cb = $('.sc-fresh', x); if (!box || !cb) return;
        if (!box.dataset.otitle) box.dataset.otitle = box.title;
        const lock = cont && i === 0;
        if (lock) cb.checked = false;
        cb.disabled = lock;
        box.style.opacity = lock ? '.45' : '';
        box.title = lock ? 'Первая сцена как раз продолжает ваше видео - смену плана здесь не ставят' : box.dataset.otitle;
      });
    };
    const setBase = b => {
      root._base = b;
      $$('button', baseSeg).forEach(x => x.classList.toggle('on', x.dataset.b === b));
      if (ownBox) ownBox.hidden = b !== 'cont';
      if (b === 'cont') setMode('parts');
      root._lockBase();
      baseHint.innerHTML = b === 'cont'
        ? '<b>«Продолжить своё видео»</b>: программа берёт последние кадры вашего файла, и первая сцена продолжает их, как будто это была прошлая сцена. Считается только по частям - режим «весь ролик» здесь не нужен и скрыт. Конец файла встаёт отдельной плиткой перед вашими изображениями (помечен «кадр видео»): он уходит в модель всегда, номером вызвать его нельзя, и потому ваших мест в сцене 8, а не 9. Нажмите «Загрузи своё видео» под выбором: «С компьютера…» или «Из Библиотеки…».'
        : '<b>«Новые сцены»</b>: ролик строится с нуля по описаниям сцен, доступны оба режима счёта - «по частям» и «весь ролик». Общая картинка сцены и её собственные фото делят 9 мест: сначала идут общие (<Picture 1>…), затем свои (<Picture 10>…).';
      if (b !== 'cont') root._setSrc(null);
      refreshStates();
    };
    baseSeg.onclick = e => { const b = e.target.closest('button'); if (b) setBase(b.dataset.b); };
    const setMode = v => { if (cfg.mode === 'actionsc') v = 'parts';   // this studio has one way to run: scene after scene
      root._mode = v; $$('.lm-mode button', root).forEach(b => b.classList.toggle('on', b.dataset.m === v)); $('.lm-mode-hint', root).textContent = MODE_HINT[v]; refreshStates(); };
    $('.lm-mode', root).onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); };
    queueMicrotask(() => setMode('parts'));
    queueMicrotask(() => setBase('own'));

    /* --- the project survives a restart: scenes, pictures of scenes, sound choice, which scenes are done --- */
    /* every studio keeps its own projects: the action one used to open the video studio's last
       scene list, which looked like a copy of the section (the old key stays for the video studio,
       so projects saved before this are not lost) */
    const PKEY = 'h3-long-projects' + (cfg.mode === 'long' ? '' : '-' + cfg.mode), LASTKEY = 'h3-long-last' + (cfg.mode === 'long' ? '' : '-' + cfg.mode), fsig = {};
    const loadAll = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch { return {}; } };
    const putFile = (key, f) => { const sg = f ? `${f.name}|${f.size}|${f.lastModified}` : ''; if (fsig[key] === sg) return; fsig[key] = sg; if (f) memFile('put', key, f); else memFile('delete', key); };
    let saveT = null;
    function saveNow() {
      try {
        const run = root._run, slotA = $('.rm-auds .slot', root);
        const proj = { run, t: Date.now(), sec: cfg.mode, mode: root._mode, qm: root._q, qBy: { ...(root._qBy || {}), [root._q]: S.q }, snd: root._snd, loop: root._loop !== false, start: $('.lm-start', root).value, vocals: $('.lm-vocals', root).checked,
          bed: $('.lm-beddb', root).value, bednorm: !!$('.lm-bednorm', root).checked,   // уровень музыки и выравнивание: их помним тоже
          aspect: S.aspect, q: S.q, cw: S.cw || 0, ch: S.ch || 0, src: root._src ? { id: root._src.id || '', name: root._src.name } : null,
          scenes: $$('.sc', root).map(c => ({ prompt: $('textarea', c).value, sec: +$('input[type=range]', c).value, lng: !!c._longSec, fresh: !!$('.sc-fresh', c)?.checked, nimg: 9, var: c._var || 0, words: (c._audWords || []).slice(), base: c._baseFixed || 0,
            done: c._dn.final ? { sig: c._dn.final.sig, url: c._dn.final.url, id: c._dn.final.id, text: c._dn.final.text } : null,
            draftDone: c._dn.draft ? { sig: c._dn.draft.sig, url: c._dn.draft.url, id: c._dn.draft.id, text: c._dn.draft.text } : null })) };
        const all = loadAll(); all[run] = proj;
        Object.keys(all).sort((a, b) => all[b].t - all[a].t).slice(8).forEach(k => delete all[k]);   // the 8 latest projects
        localStorage.setItem(PKEY, JSON.stringify(all)); localStorage.setItem(LASTKEY, run);
        fetch('/api/long/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run, project: proj }) }).catch(() => {});
        $$('.ref', imgsEl).forEach((r, i) => putFile(`long/${run}/img${i}`, r._file));
        putFile(`long/${run}/aud0`, slotA ? slotA._file : null);
        putFile(`long/${run}/src`, root._src && root._src.file ? root._src.file : null);
        $$('.sc', root).forEach((c, i) => { for (let j = 0; j < 9; j++) putFile(`long/${run}/simg${i}_${j}`, c._files[j] || null); });
          $$('.sc', root).forEach((c, i) => { for (let j = 0; j < 3; j++) putFile(`long/${run}/saudio${i}_${j}`, (c._auds || [])[j] || null); });
      } catch {}
    }
    root._save = () => { clearTimeout(saveT); saveT = setTimeout(saveNow, 700); };
    root._snap = () => { saveNow(); return JSON.parse(JSON.stringify(loadAll()[root._run] || null)); };   // a stage of the work: the whole project as it is now
    root._openStage = async (proj, sid) => {
      let r = {}; try { r = await (await fetch('/api/long/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: proj.run, id: sid, action: 'restore' }) })).json(); } catch {}
      const all = loadAll(); all[proj.run] = { ...proj, t: Date.now() }; localStorage.setItem(PKEY, JSON.stringify(all));
      root._diskRefs = !!r.refs; try { const ok = await root._openRun(proj.run); return { ok, files: !!r.ok }; } finally { root._diskRefs = false; }
    };
    const putInto = async (input, f) => { if (!input || !(f instanceof File)) return; const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event('change')); };
    root._openRun = async run => {   // load a saved project (from the library: continue this video)
      let p = loadAll()[run], onDisk = null;
      try { onDisk = await (await fetch('/api/long/project?run=' + run)).json(); } catch {}
      if (!p && onDisk && onDisk.project) p = onDisk.project;
      if (!p) return false;
      // A project belongs to the studio that made it. Projects saved before the sections existed were
      // the video studio's (both studios read the same "last" one, which is how a scene list appeared
      // in two places), so an untagged project is only taken by the video studio.
      if (p.sec ? p.sec !== cfg.mode : cfg.mode !== "long") return false;
      const getRef = async key => {   // a picture of the project: the browser's memory, else the copy kept by the program (after a stage is opened: the copy first)
        if (!root._diskRefs) { const f = await memFile('get', `long/${run}/${key}`); if (f instanceof File) return f; }
        const nm = ((onDisk && onDisk.refs) || []).find(x => x.startsWith(key + '.')); if (!nm) return null;
        try { const r = await fetch(`/api/long/ref/${run}/${nm}`); if (!r.ok) return null; return new File([await r.blob()], nm, { type: r.headers.get('content-type') || 'image/png' }); } catch { return null; }
      };
      root._run = run; root._restoring = true;
      const okQ = v => QUALITY_ALL.some(x => x.id === v) ? v : '720p';   // a broken saved value (a mode name instead of a size) must not get through
      Object.assign(S, { aspect: ASPECTS.some(a => a.id === p.aspect) ? p.aspect : S.aspect, q: okQ(p.q || S.q), cw: p.cw || 0, ch: p.ch || 0 });
      $$('.ref .x', imgsEl).forEach(x => x.click());
      for (let i = 0; i < 5; i++) await putInto($$('.ref input', imgsEl)[i], await getRef('img' + i));
      const slotA = $('.rm-auds .slot', root); $('.x', slotA)?.click();
      const aud = await getRef('aud0'); if (aud instanceof File) await putInto($('input', slotA), aud);
      root._loop = p.loop !== false; setSnd(p.snd || 'none'); $('.lm-start', root).value = p.start || '0'; $('.lm-vocals', root).checked = !!p.vocals; setSndState(root._snd);   // подсказка про звук зависит от галочки, а её ставим только что
      // сохранённый уровень музыки ставим в границах ползунка: проект мог быть записан другой версией
      const bdb = Number.isFinite(+p.bed) ? Math.max(-30, Math.min(6, Math.round(+p.bed))) : -10;
      $('.lm-beddb', root).value = bdb; $('.lm-beddbv', root).textContent = String(bdb); $('.lm-bednorm', root).checked = p.bednorm === true;
      $$('.sc', root).forEach(c => c.remove());
      for (const x of p.scenes) addScene(x.prompt, Math.min(x.lng ? 25 : 15, x.sec), !!x.fresh, x.base || 0);
      renumber(); sceneReconcile(root);   // в проекте номер места не хранится: его надо поделить заново
      $$('.sc', root).forEach((c, i) => { c._var = (p.scenes[i] || {}).var || 0; });
      root._sel = 0;
      const cards = $$('.sc', root);
      root._restoring = true;   // shelves fill in asynchronously: while they are empty, no check may call a true tag a lie
      for (const [i, x] of p.scenes.entries()) {
        const n = x.nimg || (x.img ? 1 : 0);   // an old project kept one picture per scene under another name
        for (let j = 0; j < 9; j++) { const f = await getRef(x.nimg ? `simg${i}_${j}` : 'simg' + i); if (f instanceof File) cards[i]._files[j] = f; }   // back to the same place
        cards[i]._paint();
        /* What lies in the project is the piece that went to the model, not the whole song: it has
           to be the editor's source too, or opening the scene shows a seven minute wave and the
           person thinks his cut has burned. The typed words come back with it. */
        const wsel = ((p.scenes[i] || {}).words || []);
        cards[i]._audWords = [0, 1, 2].map(j => wsel[j] || null);
        for (let j = 0; j < 3; j++) {
          const f = await getRef(`saudio${i}_${j}`);
          if (f instanceof File) { cards[i]._auds[j] = f; cards[i]._audSrc[j] = f; cards[i]._audSel[j] = null; if (!f.__key) window.audioKey(f); }
        }
        cards[i]._paintAuds && cards[i]._paintAuds();
        cards[i]._paintRefs && cards[i]._paintRefs();
      }
      root._restoring = false;
      let srcLost = false;
      if (p.src) {
        const sf = p.src.id ? null : await memFile('get', `long/${run}/src`);
        const got = p.src.id ? { id: p.src.id, name: p.src.name } : sf instanceof File ? { file: sf, name: p.src.name } : null;
        // a video from the computer lived only in the browser's memory: if it is gone, say it - the
        // scenes would otherwise continue nothing, and the frame tile would be missing without a word
        if (!got) srcLost = true;
        root._setSrc(got, false);
      }
      else root._setSrc(null, false);
      if (srcLost) toast(`Видео-основа «${p.src.name}» не сохранилось: берите видео заново кнопкой «Своё видео», иначе сцены пойдут как новые.`);
      const okDone = d => d && byId(d.id) ? { sig: d.sig, url: d.url, id: d.id, text: d.text } : null;
      p.scenes.forEach((x, i) => { cards[i]._dn = { final: okDone(x.done), draft: okDone(x.draftDone) }; });
      // the continuation point of the last finished scene must still be on the disk (for the finished row and for the draft row)
      let st = {}; try { st = await (await fetch('/api/long/state?run=' + run)).json(); } catch {}
      for (const mk of ['final', 'draft']) {
        root._q = mk; const ready = readyUpTo(), parts = (mk === 'draft' ? st.draft_parts : st.parts) || [];
        if (ready && !parts.includes(ready - 1)) { cards.forEach(c => { c._dn[mk] = null; }); toast('Точка продолжения не найдена на диске: сцены нужно сделать заново.'); }
      }
      { const tgt = p.qm === 'draft' && root._dmad !== false ? 'draft' : 'final'; root._qBy = { draft: S.q, final: S.q, ...(p.qBy || {}) }; root._qBy.draft = okQ(root._qBy.draft); root._qBy.final = okQ(root._qBy.final); S.q = root._qBy[tgt]; setQ(tgt, true); }
      setMode(p.mode || 'parts'); root._restoring = false; recount(); refreshStates(); RM[cfg.mode]?.upd?.(); root._adopt?.();   // clips that finished while the page was elsewhere come back to their tiles   // the section that owns this project refreshes its own summary
      return true;
    };
    root._restoring = true;   // nothing is saved until the last project has been put back
    setTimeout(async () => {
      try {
        let last = localStorage.getItem(LASTKEY);
        if (last) {   // the disk says which studio a project belongs to: if it disagrees, the local
                      // pointer came from the time when both studios shared one list - forget it
          try {
            const od = await (await fetch('/api/long/project?run=' + last)).json();
            const sec = od && od.project && od.project.sec;
            if (sec && sec !== cfg.mode) {
              const all = loadAll(); delete all[last];
              localStorage.setItem(PKEY, JSON.stringify(all)); localStorage.removeItem(LASTKEY); last = '';
            }
          } catch {}
        }
        if (!last) { const r = await (await fetch('/api/long/project?last=1&sec=' + cfg.mode)).json(); last = r.run || ''; }
        if (last) await root._openRun(last);
      } catch {}
      root._restoring = false; root._save(); root._adopt?.();
    }, 2500);

    const rst = document.createElement('button'); rst.className = 'btn lm-reset'; rst.type = 'button'; rst.hidden = true; rst.textContent = 'Начать заново';
    rst.title = 'Забыть сделанные сцены. Нужно, если меняете изображения героя, размер или звук: следующие сцены не должны продолжать старые.';
    rst.onclick = () => { root._run = Math.random().toString(36).slice(2, 12); $$('.sc', root).forEach(c => { c._dn = { draft: null, final: null }; }); refreshStates(); toast('Начинаем сначала'); };
    $('#lmAdd', root).after(rst);
    /* A scene's decade is given once and never taken back: numbers in the texts stay true after
       the person adds, removes or moves scenes, and the send step translates them into positions. */
    const guessBase = txt => {
      const t = {};
      ((txt || '').match(/<Picture\s*(\d+)>|<Audio\s*(\d+)>/g) || []).forEach(s => {
        const v = +s.replace(/\D+/g, ''); if (v >= 10) { const b = Math.floor(v / 10) * 10; t[b] = (t[b] || 0) + 1; }
      });
      let best = 0, k = 0;
      Object.keys(t).forEach(x => { if (t[x] > best) { best = t[x]; k = +x; } });
      return k;
    };
    const nextBase = () => { let b = 10; $$('.sc', root).forEach(x => { const v = +x._baseFixed || 0; if (v >= b) b = v + 10; }); return b; };
    /* Две сцены с одним номером места тянут одни и те же фото: чипы гаснут, теги в тексте указывают
       не туда, и человеку кажется, что картина и песня «не загрузились». Номера сверяются по порядку
       после всякой пересборки списка и после открытия проекта. */
    const renumber = () => {
      const taken = new Set();
      $$('.sc', root).forEach(c => {
        let b = +c._baseFixed || 0;
        if (!b || taken.has(b)) { b = nextBase(); c._baseFixed = b; }
        taken.add(b); c._base = b;
        c._paint?.(); c._paintAuds?.();
      });
      return taken.size;
    };
    /* Модель обучена примерно до 15 секунд, поэтому длинная сцена - не общее
       настроечное окно, а решение про одну конкретную сцену: включили галочку в её
       ряду - и ползунок, и плюс, и лента считают время только этой сцены до 25 секунд.
       Соседние сцены своего предела не замечают. */
    const SCENE_MAX = 15, SCENE_MAX_LONG = 25;
    window.sceneCap = c => {
      if (!c) return SCENE_MAX;
      const r = $('input[type=range]', c);
      return (c._longSec || (+((r || {}).value) || 0) > SCENE_MAX) ? SCENE_MAX_LONG : SCENE_MAX;
    };
    window.sceneLongOn = (c, on) => {
      if (!c) return;
      c._longSec = !!on;
      const box = $('.sc-long-c', c); if (box) { box.checked = !!on; (box.closest('.sc-long') || box).classList.toggle('on', !!on); }
      const r = $('input[type=range]', c);
      if (r) { r.max = String(on ? SCENE_MAX_LONG : SCENE_MAX); if (!on && +r.value > SCENE_MAX) r.value = String(SCENE_MAX); }
    };
    const addScene = (txt = '', sec = 10, fresh = false, base = 0) => {
      const c = document.createElement('div'); c.className = 'sc'; c._dn = { draft: null, final: null };
      Object.defineProperty(c, '_done', { get: () => c._dn[root._q || 'final'], set: v => { c._dn[root._q || 'final'] = v; }, configurable: true });
      c.style.cssText = 'margin:0 0 10px;padding:12px;border:1px solid var(--line);border-radius:12px';
      c.innerHTML = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><i class="sc-nav" data-dir="-1" title="К предыдущей сцене">‹</i><b class="sc-no" title="Номер сцены: под ним она лежит на ленте и в Библиотеке"></b><i class="sc-nav" data-dir="1" title="К следующей сцене">›</i><input type="range" min="3" max="15" step="1" value="${sec}" style="display:none"><button class="btn sc-m" type="button" title="Короче на секунду" style="padding:2px 9px">−</button><button class="btn sc-p" type="button" title="Длиннее на секунду" style="padding:2px 9px">+</button><output class="sc-sec" title="Длительность этой сцены"></output><label class="sc-long" title="Только для этой сцены: разрешить до 25 секунд. Модель обучена примерно до 15 с, дальше качество держит хуже, а расчёт идёт дольше; соседние сцены не меняются."><input type="checkbox" class="sc-long-c"> 25 с</label><span class="hint sc-win" style="flex:1"></span></div>
        <div data-scenarobox="scene"></div>
<details class="sc-tdet" style="margin-top:8px"><summary class="hint" style="cursor:pointer;font-size:12px">Проба размера для этой сцены</summary><div class="sc-tst" style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="hint" style="font-size:12px">Попробовать только эту сцену в другом размере (остальные не меняются):</span><select class="sc-tq">${QUALITY.map(q => `<option value="${q.id}">${q.res}</option>`).join('')}</select><button class="btn sc-tbtn" type="button" title="Сцена считается отдельно, в выбранном размере, на 8 шагов. Результат появится ниже и в Библиотеке, остальные сцены не затрагиваются.">Сделать пробу</button></div><div class="sc-tests" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"></div></details>
        <div class="sc-refs" style="margin-top:8px"><div class="hint sc-rhint" style="font-size:12px"></div><div class="sc-thumbs" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px"></div></div>`;
      /* Окно «Сценарий» этой сцены: поле, ряд плашек и подпись - всё даёт общий модуль.
         Ряд картинок и аудио у сцены свой, счётчик занятых мест стоит в подписи окна. */
      const scWin = scenarioWindow($('[data-scenarobox="scene"]', c), {
        card: false, kind: 'scene', min: '90px',
        placeholder: 'Что происходит в этой сцене…',
        counter: { cls: 'hint sc-left', text: '' },
        chips: 'below', chipsCls: 'sc-tokens', buttons: true,
      });
      c._win = scWin;
      { const r0 = $('input[type=range]', c);
        if (r0 && sec > 15) { r0.max = '25'; r0.value = String(Math.min(25, sec)); window.sceneLongOn(c, true); } }
      // nine places of their own, made like the common ones: an empty place offers itself, a filled
      // one shows the picture with its number and a cross, and a photo can be dropped right into it
      const box0 = $('.sc-thumbs', c);
      c._ownTiles = [];
      for (let j = 0; j < 9; j++) {
        const lb = document.createElement('label'); lb.className = 'ref own'; lb.dataset.own = j;
        lb.innerHTML = `<input type="file" accept="image/*" hidden><div class="plus">${j + 1}/9<span>Референс сцены</span></div><span class="tag" hidden></span><button class="x" type="button" title="Убрать это фото">✕</button>`;
        lb.style.cssText = 'position:relative;width:64px;height:64px;flex:0 0 64px;border:1.5px dashed var(--line-2);border-radius:8px;cursor:pointer;background:var(--surface-2)';
        const inp = $('input', lb);
        inp.onchange = () => { const f = inp.files[0]; inp.value = ''; if (f) c._setOwn(j, f); };
        lb.querySelector('.x').onclick = e => { e.preventDefault(); e.stopPropagation(); c._setOwn(j, null); };
        lb.addEventListener('dragover', e => e.preventDefault());
        lb.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (f) c._setOwn(j, f); });
        box0.append(lb); c._ownTiles.push(lb);
      }
      c._setOwn = (j, f) => {
        if (f) {
          if (!c._files[j] && $$('.ref.filled', imgsEl).length + c._files.filter(Boolean).length >= 9) {
            toast('В сцену входит девять фото: уберите одно или очистите место'); return;
          }
          c._files[j] = f;
        } else { c._files[j] = null; }
        c._paint(); refreshStates();
      };
      c._tests = [];
      c._paintTests = () => { $('.sc-tests', c).innerHTML = c._tests.map((t, j) => `<button class="btn sc-tt" type="button" data-j="${j}" style="padding:3px 9px;font-size:12px">▶ ${esc(t.res || '')}</button>`).join(''); };
      $('.sc-tq', c).value = S.q; $('.sc-tq', c).onchange = e => { e.target._touched = true; };
      $('.sc-tests', c).onclick = e => { const b = e.target.closest('.sc-tt'); const t = b && c._tests[+b.dataset.j]; if (!t) return; root._sel = $$('.sc', root).indexOf(c); const v = $('.tl-vid', root); v.src = t.url; v.hidden = false; $('.tl-empty', root).hidden = true; v.play().catch(() => {}); };
      $('.sc-tbtn', c).onclick = () => { root._test = { q: $('.sc-tq', c).value }; root._chainPart = null; root._target = $$('.sc', root).indexOf(c); $('.go', $('.rm-preview', root)).click(); };
      c._files = new Array(9).fill(null);   // nine places of their own, an empty one keeps its number
      c._baseFixed = +base > 0 ? +base : (guessBase(txt) || nextBase());
      c._base = c._baseFixed;   // ряд аудио и счётчик мест читают номер до первой отрисовки
      const ownBase = () => c._baseFixed || (c._baseFixed = nextBase());   // the scene's own decade, not its place
      const paintRefs = c._paint = () => {
        const bsHere = ownBase();   // номер места: в первой сцене 10-е, во второй 20-е; подпись плитки обязана
                                    // показывать ровно то число, которое вставляется в текст, а не вечную десятку
        (c._ownTiles || []).forEach((lb, j) => {
          const f = c._files[j], im0 = $('img', lb), plus = $('.plus', lb), tag = $('.tag', lb);
          im0?.remove();
          lb.classList.toggle('filled', !!f);
          if (f) {
            const im = document.createElement('img'); im.src = URL.createObjectURL(f); im.title = `<Picture ${bsHere + j}>`;
            im.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:7px;display:block';
            lb.prepend(im); plus.hidden = true; tag.hidden = false; tag.textContent = `Pic ${bsHere + j}`;
            tag.style.cssText = 'position:absolute;left:4px;bottom:4px;font-size:9.5px;padding:1px 4px;border-radius:6px;background:rgba(0,0,0,.68);color:#fff';
            lb.style.borderStyle = 'solid'; $('.x', lb).style.display = '';
          } else { plus.hidden = false; tag.hidden = true; lb.style.borderStyle = 'dashed'; $('.x', lb).style.display = 'none'; }
        });
        const last = c._files.reduce((a, f, j) => (f ? j : a), -1), shown = Math.min(9, last + 2);
        (c._ownTiles || []).forEach((lb, j) => { lb.hidden = j >= shown; });   // лишние пустые места не светятся
        const tk = $('.sc-tokens', c);
        const bs = ownBase();
        if (tk) tk.innerHTML = c._files.slice(0, shown).map((f, j) => `<button class="token" type="button" data-ins="&lt;Picture ${bs + j}&gt;"${f ? '' : ' disabled'} title="${f ? 'Вставить в текст тег <Picture ' + (bs + j) + '> - ваше фото номер ' + (j + 1) + ' этой сцены' : 'Место ' + (j + 1) + ' свободно - номер ' + (bs + j) + ' оживёт, когда туда что-нибудь положат'}">&lt;Pic ${bs + j}&gt;</button>`).join('')
          + audioTokens(c, bs, root._fauds || []).join('');
        c._base = bs; c._counter?.();
        const n = c._files.filter(Boolean).length;
        $('.sc-rhint', c).textContent = n ? `Своих фото в этой сцене: ${n} (мест до девяти). Номера идут десятками по сценам: в первой <Picture 10>, <Picture 11>, во второй <Picture 20>, <Picture 21> - поэтому в Сценаристе число сразу говорит, о какой сцене речь. Аудио этой сцены зовётся так же: <Audio 10>, <Audio 20>... Общие изображения остаются <Picture 1…5>, фон всего ролика - <Audio 1>.` : 'Своих фото нет: сцена возьмёт общие. У своих мест номера не меняются, даже если убрать другое фото.';
      };
      // (the places take pictures themselves: click a tile or drop a photo into it)
      paintRefs();

      c.querySelectorAll('.sc-nav').forEach(n => {
      n.onclick = () => {
        const all = $$('.sc', root), at = all.indexOf(c), to = at + (+n.dataset.dir);
        if (!all[to]) { toast(n.title); return; }
        root._sel = to; root._target = to; root._q = root._q || 'final';
        renderTL(); showClip(); refreshStates(); recount();
        if (root._save && !root._restoring) root._save();
        all[to].scrollIntoView({ block: 'nearest' });
      };
    });
  $('.sc-m', c).onclick = () => { const r = $('input[type=range]', c); r.value = Math.max(3, +r.value - 1); r.dispatchEvent(new Event('input')); };
      $('.sc-p', c).onclick = () => { const r = $('input[type=range]', c); r.value = Math.min(window.sceneCap(c), +r.value + 1); r.dispatchEvent(new Event('input')); };
      const lbox = $('.sc-long-c', c);
      if (lbox) lbox.onchange = () => {
        const r = $('input[type=range]', c);
        const back = !lbox.checked && +r.value > SCENE_MAX;
        window.sceneLongOn(c, lbox.checked);
        if (back) { r.dispatchEvent(new Event('input')); renderTL(); recount(); refreshStates(); if (root._save && !root._restoring) root._save(); toast('Сцена вернулась к 15 с: выключили длинный режим'); return; }
        renderTL(); recount(); refreshStates();
        if (root._save && !root._restoring) root._save();
      };
      scWin.ta.value = txt;
      /* Ряд плашек этой сцены даёт окно «Сценарий», поэтому сюда добавляются только полки
         аудио: раньше они вставлялись сразу за полем, теперь - сразу за рядом плашек. */
      scWin.foot.insertAdjacentHTML('afterend', '<div class="sc-auds" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px"></div><div class="sc-trimhost" hidden style="margin-top:8px"></div>');
      // - - - audio of THIS scene: up to three files, trimmed with the same instrument as the
      // shared track. They reach the model as references; the text decides where one is used.
      c._auds = c._auds || [null, null, null]; c._audWords = c._audWords || [null, null, null];
      c._audSrc = c._audSrc || [null, null, null];   // the file as it was loaded - never overwritten
      c._audSel = c._audSel || [null, null, null];   // what was cut out of it, so the next edit starts from the full wave
      const esc2 = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
      const ainp = document.createElement('input');
      ainp.type = 'file'; ainp.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a'; ainp.hidden = true; c.append(ainp);
      let apick = -1;                       // which free slot the file dialog should fill
      const applyTrim = () => { if (c._trim && c._trim.dur0) c._trim.out(); };
      const openTrim = j => {
        const host = $('.sc-trimhost', c);
        // «Обрезать» ещё раз по тому же файлу = закрыть; что выделили - то и применили
        if (!host.hidden && c._trim && c._trim._slot === j) {   // повторное нажатие закрывает
          const keep = c._audSel[j] || c._trim._loaded || { start: 0, end: c._trim.dur0 };
          if (c._trim.dur0 && (Math.abs(c._trim.start - keep.start) > .05 || Math.abs(c._trim.end - keep.end) > .05)) applyTrim();
          host.hidden = true;
          c._paintWords && c._paintWords();
          return;
        }
        host.hidden = false;
        if (!c._trim) {
          c._trim = new AudioTrimmer({
            mount: host, limit: 15, agentTarget: cfg.mode,
            whereLabel: q => {                    // in this scope the scenes hang off root, not off R
              const all = $$('.sc', root), at = all.indexOf(c);
              const bs = c._baseFixed || c._base || 10 * ((at < 0 ? all.length : at) + 1);
              return 'сцена ' + (at < 0 ? '?' : at + 1) + ', аудио ' + (q._slot + 1) + ', тег <Audio ' + (bs + q._slot) + '>';
            },
            onFile: f => {
              const j2 = c._trim._slot, src = c._audSrc[j2] || f;
              (c._audDur = c._audDur || [])[j2] = c._trim.len();   // what the model will actually get
              // the name stays the person's own: a cut of the file is still the same song
              c._auds[j2] = new File([f], src.name.replace(/\.[a-z0-9]+$/i, '') + '.wav', { type: 'audio/wav' });
        c._auds[j2]._dur = c._trim.len();
        window.audioKey(c._auds[j2]);   // подпись считается сразу: слова этой сцены - только её
              c._audSel[j2] = { start: c._trim.start, end: c._trim.end, of: src.name };
              c._paintAuds(); paintRefs();
              if (root._save) root._save();
            },
            onState: tr2 => {
              const j3 = tr2._slot;
              if (j3 >= 0 && tr2.dur0 && !c._audSel[j3]) (c._audDur = c._audDur || [])[j3] = tr2.dur0;   // full length of an untouched file
            }
          });
        }
        const src = c._audSrc[j] || c._auds[j];
        if (src && (c._trim._slot !== j || !c._trim.dur0)) {
          c._trim._slot = j;
          c._trim.setFile(src, true);   // the ORIGINAL always opens, so a second cut is possible
          const sel = c._audSel[j];
          if (sel && src === c._audSrc[j] && sel.end <= c._trim.dur0 + .2) {
            c._trim.start = sel.start; c._trim.end = Math.min(sel.end, c._trim.dur0); c._trim._loaded = { start: sel.start, end: c._trim.end };
            c._trim._sync();
          }
        }
        c._paintWords && c._paintWords();   // the editor now shows another song: the words follow
      };
      /* The words of this scene's song live at the bottom of the music editor, right under the
         seconds: that is where the person is when they choose what the scene sings. One scrollable
         line, the same as in the Agent. Fixed words win over what the machine heard, and the Agent
         is told about both. */
      /* After the Agent has rewritten the scene texts, the heard lyric must stand in the card
         itself: a person must see with his eyes that the words are there, and the model gets them
         from the text, not from a favour. Nothing is invented - only what was heard is added. */
      c._carryWords = () => {
        const ta = $('textarea', c); if (!ta) return [];
        const bs = c._baseFixed || c._base || 10;
        const done = [];
        (c._auds || []).forEach((f, j) => {
          if (!f) return;
          const words = agWordsFor(c, j); if (!words) return;
          if (ta.value.toLowerCase().indexOf(words.slice(0, 24).toLowerCase()) >= 0) return;
          const x = agWords(f, Math.max(1, Math.round(bs / 10))) || {};
          ta.value = ta.value.trim() + '\n<d>[' + (x.lang || 'язык аудио') + '] ' + words + '</d>';
          done.push('<Audio ' + (bs + j) + '>');
        });
        if (done.length) { c._counter?.(); refreshStates(); if (root._save) root._save(); }
        return done;
      };
      c._paintWords = () => {
        const trim = c._trim, host = trim ? trim.q('.at-words') : null;
        if (!host) return;
        const slot = trim._slot, f = (slot >= 0 && c._auds) ? c._auds[slot] : null;
        if (!f || ($('.sc-trimhost', c) && $('.sc-trimhost', c).hidden)) { host.hidden = true; host.innerHTML = ''; host.dataset.slot = ''; return; }
        host.hidden = false;
        if (host.dataset.slot !== String(slot)) {
          host.dataset.slot = String(slot);
          host.innerHTML = '<textarea data-w="' + slot + '" rows="1" placeholder="Что поёт эта сцена - модель возьмёт текст отсюда; можно поправить руками"></textarea>'
            + '<div class="sc-wordbtns"><button class="btn mini" type="button" data-again="ru">переслушать по-русски</button>'
            + '<button class="btn mini" type="button" data-again="en">переслушать по-английски</button>'
            + '<button class="btn mini" type="button" data-again="clear">стереть слова</button></div>';
          const ta0 = $('textarea', host);
          ta0.oninput = () => { c._audWords = c._audWords || []; c._audWords[+ta0.dataset.w] = ta0.value; if (root._save) root._save(); };
          $$('button[data-again]', host).forEach(b => {
            b.onclick = async () => {
              const j = +host.dataset.slot, file = c._auds[j]; if (!file) return;
              c._audWords = c._audWords || [];
              const put = v => { c._audWords[j] = v; const t2 = $('textarea', host); if (t2) t2.value = v; };
              if (b.dataset.again === 'clear') { put(''); if (root._save) root._save(); toast('Слова стёрты: модель будет петь на свой слух'); return; }
              if (!AG.status || !AG.status.speech_ready) { try { await agStatus(); } catch (e) { } }
              if (!AG.status || !AG.status.speech_ready) { toast('Распознавание речи не готово: раздел «Сценарист», строчка «Модель сценариста»'); return; }
              const was = b.textContent; b.disabled = true; b.textContent = 'слушаю…';
              try {
                const j2 = await transcribeWav(file, b.dataset.again);
                put((j2.text || '').trim());
                const myKey = await window.audioKey(file);
    const hit = (AG.audios || []).find(a => a.key === myKey)
      || (AG.audios || []).find(a => a.name === file.name && Math.abs((a.dur || 0) - (+file._dur || 0)) < .2);
                if (hit) { hit.text = c._audWords[j]; hit.lang = j2.lang; hit.langName = j2.lang_name; }
                if (typeof showAudioBox === 'function') showAudioBox();
                if (root._save) root._save();
                toast(c._audWords[j] ? ('Услышано заново (' + (j2.lang_name || b.dataset.again) + '): ' + c._audWords[j].slice(0, 60)) : 'Песня не разобралась: слов не слышно');
              } catch (e) { toast('Не удалось переслушать: ' + (e && e.message ? e.message : e)); }
              b.disabled = false; b.textContent = was;
            };
          });
        }
        const ta = $('textarea', host), now = (c._audWords || [])[slot] || agWordsFor(c, slot) || '';
        if (ta && document.activeElement !== ta && ta.value !== now) ta.value = now;
      };
      c._paintAuds = () => {
        const row = $('.sc-auds', c); if (!row) return;
        const full = c._auds.filter(Boolean).length >= 3;
        row.innerHTML = '<button class="btn mini" type="button" data-a="add"' + (full ? ' disabled' : '') +
          ' title="Аудио отдельной сцены: до трёх файлов. Модель получает их как ссылки и применяет там, где вы упомянули файл тегом в тексте сцены; не упомянули - звук делает сама. Обрезать можно до 15 секунд.">Загрузить аудио сцены</button>' +
          '<span class="counter" title="Аудио в этой сцене: не больше трёх">' + c._auds.filter(Boolean).length + ' / 3</span>' +
          c._auds.map((f, j) => f ? `<span class="token" style="display:inline-flex;gap:6px;align-items:center">&lt;Audio ${(c._baseFixed || c._base || 10) + j}&gt; ${esc2(f.name.slice(0, 18))}${c._audSel[j] ? ' <small style="opacity:.75">с ' + c._audSel[j].start.toFixed(1).replace('.', ',') + ' по ' + c._audSel[j].end.toFixed(1).replace('.', ',') + ' с</small>' : ''} <button class="btn mini" type="button" data-a="trim" data-j="${j}" title="Послушать и обрезать: прибор под строкой">Обрезать</button><button class="btn mini" type="button" data-a="del" data-j="${j}" title="Убрать этот файл из сцены">×</button></span>` : '').join('') +
          (full ? '<span class="hint" style="font-size:12px">три аудио в сцене - максимум</span>' : '');
        c._paintWords && c._paintWords();
      };
      ainp.onchange = () => {
        const f = ainp.files && ainp.files[0];
        let j = apick; apick = -1;
        ainp.value = '';
        if (!f) return;
        if (j < 0) j = c._auds.findIndex(x => !x);   // a file may arrive without the button (drag, restore)
        if (j < 0) { toast('Больше трёх аудио в одной сцене нельзя'); return; }
        c._auds[j] = f; c._audSrc[j] = f; c._audSel[j] = null; if (c._audDur) c._audDur[j] = null;
        if (f && !f.__key) { f._dur = f._dur || (c._audDur || [])[j] || 0; window.audioKey(f); }   // своей подписью файл узнаётся с любого входа
        c._paintAuds(); paintRefs();
        if (root._save) root._save();
        toast('Аудио <Audio ' + ((c._baseFixed || c._base || 10) + j) + '> в сцене: ' + f.name + ' - при желании обрежьте (до 15 с)');
      };
      if (!$('.sc-auds', c)) {
        $('textarea', c).insertAdjacentHTML('afterend', '<div class="sc-auds" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px"></div><div class="sc-trimhost" hidden style="margin-top:8px"></div>');
      }
      if (!$('.sc-trimhost', c)) {
        $('.sc-auds', c).insertAdjacentHTML('afterend', '<div class="sc-trimhost" hidden style="margin-top:8px"></div>');
      }
      $('.sc-auds', c).onclick = e => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        const j = +b.dataset.j;
        if (b.dataset.a === 'add') {
          apick = c._auds.findIndex(x => !x);
          if (apick < 0) { toast('Больше трёх аудио в одной сцене нельзя'); return; }
          ainp.click();
        } else if (b.dataset.a === 'del') {
          c._auds[j] = null; c._audSrc[j] = null; c._audSel[j] = null; if (c._audDur) c._audDur[j] = null;
          if (c._trim && c._trim._slot === j) { c._trim.clear(); c._trim._slot = -1; $('.sc-trimhost', c).hidden = true; c._paintWords && c._paintWords(); }
          c._paintAuds(); paintRefs();
          if (root._save) root._save();
        } else if (b.dataset.a === 'trim') openTrim(j);
      };
      c._paintAuds(); c._paintRefs = paintRefs;
      $('textarea', c).addEventListener('input', () => { try { paintRefs(); } catch (e) { } });   // the chips learn which tags the text already holds
      paintRefs();   // the chips row now knows about restored scene audio
      box.append(c);
      c._counter = () => {   // what counts is what the text calls; the frame of your video holds <Picture 1>
        const el = $('.sc-left', c); if (!el) return;
        const places = $$('.ref', imgsEl).map(r => !!r._file), ownPlaces = (c._files || []).map(f => !!f);
        const common = places.filter(Boolean).length, own = ownPlaces.filter(Boolean).length;
        const frame = !!root._srcFrame, cap = frame ? 8 : 9;   // the frame of the video rides along: yours are eight
        const used = new Set();
        ($('textarea', c).value.match(/<\s*Picture\s*(\d+)\s*>/g) || []).forEach(x => {
          const k = +x.replace(/\D+/g, '');
          const bs0 = c._baseFixed || c._base || 10;
          if (k < 10 ? !!places[k - 1] : (k >= bs0 && k < bs0 + 10 && !!ownPlaces[k - bs0])) used.add(k);   // свои номера - своя декада
        });
        c._used = used; c._cap = cap; c._frame = frame;
        const n = used.size, left = cap - n;
        el.textContent = (n > cap ? `в тексте ${n} разных фото - в модель войдут первые ${cap}, новых тегов не берите`
          : n === 0 ? `свободно все ${cap} фото (загружено: общих ${common}, своих ${own})`
          : left > 2 ? `занято ${n} из ${cap} фото`
          : left > 0 ? `занято ${n} из ${cap} - свободно ещё ${left}`
          : `все ${cap} мест заняты - уберите тег, чтобы добавить другое фото`)
          + (frame ? ' · кадр вашего видео идёт сверх этого, отдельно' : '');
        el.style.color = left <= 0 ? 'var(--pink)' : left <= 2 ? 'var(--warn, #e8a31d)' : '';
        // only the scene you write in owns the shared row of common chips: the hidden scenes
        // must not re-enable it from their own texts after every recount
        const owner = (root._ta && root._ta.closest && root._ta.closest('.sc')) || $$('.sc', root)[root._sel];
        const mine = owner === c || c.offsetParent !== null;
        const mark = host => $$('.token', host).forEach(b => {
          if (b.dataset.audio) { b.disabled = false; b.style.opacity = ''; b.style.cursor = ''; return; }   // the audio tag is not one of the nine places
          const k = +(b.textContent.match(/\d+/) || [0])[0];
          if (!b.dataset.otitle) b.dataset.otitle = b.title;
          const bs1 = c._baseFixed || c._base || 10;
          const filled = k < 10 ? !!places[k - 1] : (k >= bs1 && k < bs1 + 10 ? !!ownPlaces[k - bs1] : false);
          const free = filled && (used.has(k) || left > 0);   // a place without a picture never wakes up
          b.disabled = !free;
          b.style.opacity = free ? '' : '.38';
          b.style.cursor = free ? '' : 'not-allowed';
          b.title = free ? b.dataset.otitle : `Мест нет: все ${cap} заняты. Уберите из текста другой тег`;
        });
        mark($('.sc-tokens', c) || document.createElement('i'));
        if (mine) mark($('.rm-tokens', root) || document.createElement('i'));
      };
      $('.sc-tokens', c).onclick = e => {   // a chip puts its tag where the cursor stands
        const b = e.target.closest('[data-ins]'); if (!b) return;
        if (b.disabled) { toast('В это место ещё не загружено своё фото'); return; }
        if (!b.dataset.audio && root._free && !root._free(+b.dataset.ins.replace(/\D+/g, ''), c)) return;   // an audio tag owns no picture place
        const ta = $('textarea', c), at = ta.selectionStart == null ? ta.value.length : ta.selectionStart, add = b.dataset.ins + ' ';
        ta.value = ta.value.slice(0, at) + add + ta.value.slice(at);
        ta.focus(); ta.selectionStart = ta.selectionEnd = at + add.length; recount(); c._counter?.();
        /* Вставка тега плашкой тоже меняет текст сцены: без этого вставленный тег жил до
           ближайшего набора букв и терялся при закрытии программы. */
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (root._save && !root._restoring) root._save();
      };
      c.insertAdjacentHTML('beforeend', `<label class="sc-fl" style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:12.5px" title="Как смена плана в кино: сцена не продолжает прошлую, а строится заново по вашим изображениям. Качество в ней как в первой сцене. Программа делает так сама после трёх продолжений подряд."><input type="checkbox" class="sc-fresh"> Сменить план здесь (кино-склейка)</label><div class="hint sc-auto" hidden style="font-size:12px;margin-top:6px">Программа сама сделает здесь смену плана: цепочка продолжений стала длинной, а так качество не падает.</div><div class="sc-act" style="display:flex;gap:10px;align-items:center;margin-top:8px"><button class="btn mini sc-do" type="button" title="Сделать только эту сцену">Сделать эту сцену</button><button class="btn sc-undo" type="button" hidden title="Вернуть то, что было стёрто или удалено (то же, что Ctrl+Z)">↶ Отменить действие</button><button class="btn mini sc-redogo" type="button" hidden title="Эта сцена считается заново, а потом сами пересчитаются все следующие, уже продолжая новую версию">Переделать и продолжить</button><span class="hint sc-state"></span></div>`);
      $('.sc-fresh', c).checked = !!fresh;
      $('.sc-fresh', c).onchange = () => { c._done = null; recount(); };
      $('.sc-redogo', c).onclick = () => { const i = $$('.sc', root).indexOf(c); c._var = (c._var || 0) + 1; root._chainEnd = null; root._chainPart = i; root._target = i; $('.go', $('.rm-preview', root)).click(); };
      $('.sc-do', c).onclick = () => {
        const i = $$('.sc', root).indexOf(c), ready = readyUpTo();
        const active = QUEUE.some(j => j.mode === 'long' && (j.state === 'queued' || j.state === 'running'));
        if (!root._canGo(i)) {   // the previous scene is not ready
          if (active && root._pending && i === root._pending.k + 1) { root._chainPart = root._pending.k; root._chainEnd = i; toast(`Сцена ${i + 1} запустится сама, когда будет готова сцена ${i}.`); return; }
          $('.sc-fresh', c).checked = true; recount();   // it does not wait: it is made as a new shot (not continuing the previous scene)
          toast(`Сцена ${i + 1} сделается как новый план: сцена ${i} ещё не готова, продолжать нечего.`);
        }
        if (sigOk(c)) c._var = (c._var || 0) + 1;   // «Переделать»: another variant of this scene, not the same clip again
        root._chainPart = null; root._target = i; $('.go', $('.rm-preview', root)).click(); };
      $('.sc-undo', c).onclick = () => root._doUndo?.();
      $('textarea', c).addEventListener('input', () => { refreshStates(); c._counter?.(); });   // first the rebuild, then the count and the lock
      $('textarea', c).addEventListener('focus', e => { root._ta = e.target; c._counter?.(); });   // the row of common chips follows the scene you picked up
      $('input[type=range]', c).oninput = recount;
      /* The cross in the header emptied the text, and the labelled button under the field did the
         same: two controls for one thing, one of them silent. The cross is gone, the button stayed -
         in the row under the field, on one level with the other buttons of the field. A scene is
         still removable: its cross on the ribbon above takes the card out. */
      const clearSceneText = (cc) => {
        root._pushUndo?.();
        const t2 = $('textarea', cc); if (!t2) return;
        t2.value = ''; t2.dispatchEvent(new Event('input', { bubbles: true }));
        cc._paint?.(); recount(); refreshStates();
        if (root._save && !root._restoring) root._save();
        toast('Текст сцены очищен · её фото и песни остались на местах');
      };
      {
        const clr = document.createElement('button');
        clr.type = 'button'; clr.className = 'btn mini ta-clear';
        clr.textContent = 'Очистить текст';
        clr.title = 'Стереть текст этой сцены; её фото и песни останутся на полках, «шаг назад» вернёт текст';
        clr.onclick = () => {
          const ta = $('textarea', c);
          if (!ta || !ta.value.trim()) { toast('В этой сцене текст и так пустой'); return; }
          const idx = $$('.sc', root).indexOf(c) + 1;
          confirmBox('Стереть текст сцены ' + idx + '?',
            'Фотографии и песни сцены останутся на своих полках. «Шаг назад» вернёт текст целиком.', 'Стереть текст', () => {
              clearSceneText(c);
            });
        };
        // очистка - последняя в ряду кнопок окна сцены, у правого края
        if (c._win) c._win.addButton(clr);
      }
      recount();
    };

    $('#lmAdd', root).onclick = () => { if ($$('.sc', root).length >= 20) { toast('Не больше 20 сцен — это уже полчаса расчёта'); return; } root._sel = $$('.sc', root).length; addScene('', 10); };
    queueMicrotask(() => { addScene('', 10); });   // a blank start holds ONE scene; «+» in the ribbon makes the next  // after the rest of the set-up is done
    root._addScene = addScene;
    /* --- video studio: a ribbon of fragments, one fragment is open for settings, a player, draft / finished quality --- */
    root._sel = 0; root._q = 'final'; root._dmad = null;
    const tl = $('.tl', root), vid = $('.tl-vid', root), TL_PPS = 26;   // pixels per second on the ribbon: the length of a fragment is its width
    function renderTL() {
      const all = $$('.sc', root), fr = freshAt(), ready = readyUpTo();
      root._sel = Math.max(0, Math.min(all.length - 1, root._sel || 0));
      all.forEach((c, j) => c.classList.toggle('sel', j === root._sel));
      // стрелки у кружка номера живут соседними сценами: где соседа нет, там стрелка гаснет
      all.forEach((c, i) => {
        $$('.sc-nav', c).forEach(n => {
          const to = i + (+n.dataset.dir);
          const ok = !!all[to];
          n.classList.toggle('off', !ok);
          n.title = ok ? ('К сцене ' + (to + 1)) : (Number(n.dataset.dir) < 0 ? 'Это первая сцена' : 'Это последняя сцена');
        });
      });
      tl.innerHTML = all.map((c, i) => {
        const sec = +$('input[type=range]', c).value, done = sigOk(c), draft = root._q === 'draft', old = !done && !!(c._old || {})[root._q];
        /* How much of the scene really lies in the finished clip: the slider may already show another
           number than what was rendered, and then a person re-renders seconds he already has, or
           believes he has more than he does. A thin red line stands where the ready clip stops; a
           scene that was never made has no line at all. The length also comes from the library card
           of the clip, so scenes rendered before this rule get their line too. */
        const dn = (c._dn || {})[draft ? 'draft' : 'final'] || (c._dn || {}).final || (c._dn || {}).draft;
        const rec = dn && dn.id && typeof byId === 'function' ? byId(dn.id) : null;
        const mkSec = Math.max(0, +(dn && dn.sec) || +(rec && rec.len) || 0);
        const capC = window.sceneCap(c);   // предел длины - у сцены свой: у длинной шкала 3-25
        const mkTxt = mkSec >= 3 && Math.abs(mkSec - sec) > .05 ? ' · в клипе ' + (Math.round(mkSec * 10) / 10).toString().replace('.', ',') + ' с' : '';
        const mk = mkSec >= 3 ? `<i class="tl-mark" style="width:calc((100% - 42px - 44px) * ${Math.round((Math.min(capC, mkSec) - 3) / (capC - 3) * 100)} / 100)" title="Красная полоска внизу: ${mkSec.toFixed(1).replace('.', ',')} с этой сцены уже лежат в готовом клипе"></i>` : '';
        // the filled part of the chip is the scene's length: 3 s at the left edge, 15 s at the right
      const pct = Math.round((sec - 3) / (capC - 3) * 100);
      return `<div class="tl-b${i === root._sel ? ' sel' : ''}${done ? (draft ? ' draft' : ' done') : old ? ' stale' : ''}${fr[i] ? ' cut' : ''}" data-i="${i}" title="${fr[i] ? 'Новый план (смена кадра). ' : ''}Тяните внутри фрагмента - время сцены · за правый край - точно · ручкой слева - порядок"><i class="tl-grip" draggable="true" data-grip="${i}" title="Сцена ${i + 1}. Кружок перетаскивает сцену и открывает её; когда сцена выбрана - кружок залит">${i + 1}</i><i class="tl-fill" style="width:calc((100% - 42px - 44px) * ${pct} / 100)"></i>${mk}<div class="tl-l">${sec} с${done ? (draft ? ' · черновик ✓' : ' · готово ✓') : old ? ' · старая версия' : ''}${mkTxt}${fr[i] ? ' · ✂ новый план' : ''}</div><i class="tl-x" data-scdel="${i}" title="Убрать эту сцену">✕</i><i class="tl-h" title="Тяните: длина сцены"></i></div>`;
      }).join('') + '<div class="tl-b tl-add" data-add="1" style="align-items:center;justify-content:center" title="Добавить фрагмент">+</div>';
      const dmb = $('.lm-q button[data-mq="draft"]', root);
      dmb.disabled = false;   // pressing it is how you find out you need a file - and how you get it
      dmb.classList.toggle('need', root._dmad === false);
      dmb.title = root._dmad === false ? 'Для черновика нужен файл ускорения: нажмите, и программа предложит его скачать' : ''
    }
    root._renderTL = renderTL;
    function showClip() {
      const c = $$('.sc', root)[root._sel], d = c && (c._dn[root._q] || (c._old || {})[root._q] || c._dn[root._q === 'draft' ? 'final' : 'draft']);
      const pl = $('.tl-player', root), em = $('.tl-empty', root);
      const n = root._sel + 1;
      if (d && d.url) { if (!vid.src.endsWith(d.url)) vid.src = d.url; vid.hidden = false; em.hidden = true; pl.classList.remove('empty'); }
      /* Removing the address is not enough: Chromium keeps showing the frame it had already
         buffered, so a cleared project left a clip standing in the player as if nothing happened.
         The element has to be reloaded empty. */
      else { vid.pause(); vid.removeAttribute('src'); vid.load(); vid.hidden = true; em.hidden = false; pl.classList.add('empty'); }
      em.textContent = `Сцена ${n}: здесь появится её готовое видео. Собрать или пересобрать её можно кнопкой «Сделать сцену ${n}».`;
      $('.rm-preview', root)._syncLabel?.();
    }
    root._showClip = showClip;
    tl.addEventListener('pointerdown', e => {   // drag the right edge of a fragment: shorter / longer
      const h = e.target.closest('.tl-h'); if (!h) return; e.preventDefault();
      const i = +h.closest('.tl-b').dataset.i, sl = $('input[type=range]', $$('.sc', root)[i]);
      root._drag = { i, x0: e.clientX, sec0: +sl.value, sl }; tl.setPointerCapture(e.pointerId);
    });
    tl.addEventListener('pointerdown', e => {
      // a press on the body of a chip is a hand on the scene's time: the filled part follows the finger
      const b = e.target.closest('.tl-b');
      if (!b || b.dataset.add || e.target.closest('.tl-h') || e.target.closest('.tl-x') || e.target.closest('[data-grip]')) return;
      const c = $$('.sc', root)[+b.dataset.i]; if (!c) return;
      const sl = $('input[type=range]', c); if (!sl) return;
      e.preventDefault();
      root._dragSec = { i: +b.dataset.i, sl: sl, x0: e.clientX, moved: 0 };
      try { tl.setPointerCapture(e.pointerId); } catch (err) { }
    });
    const secAt = (b, clientX) => {
      // 3 секунды начинаются там, где кончается кружок с номером: полоса времени и рука
      // человека должны считать один и тот же отрезок, иначе минимальная сцена тянется
      // из-под номера и первая треть жеста ничего не меняет
      const r = b.getBoundingClientRect(), off = 42, back = 44;   // the same inset on the right: the cap must not sit on the cross

      const avail = Math.max(1, r.width - off - back);
      const p = Math.min(1, Math.max(0, (clientX - r.left - off) / avail));
      const capC = window.sceneCap($$('.sc', root)[+b.dataset.i] || null);
      return Math.max(3, Math.min(capC, Math.round(3 + p * (capC - 3))));
    };
    tl.addEventListener('pointermove', e => {
      const s = root._dragSec;
      if (s) {
        s.moved += Math.abs(e.clientX - s.x0); s.x0 = e.clientX;
        const b = $$('.tl-b', tl)[s.i]; if (!b) return;
        const sec = secAt(b, e.clientX);
        if (+s.sl.value !== sec) { s.sl.value = sec; s.sl.dispatchEvent(new Event('input')); }
        return;
      }
      const d = root._drag; if (!d) return;
      const sec = Math.max(3, Math.min(window.sceneCap($$('.sc', root)[d.i] || null), Math.round(d.sec0 + (e.clientX - d.x0) / TL_PPS)));
      if (+d.sl.value !== sec) { d.sl.value = sec; d.sl.dispatchEvent(new Event('input')); }
    });
    tl.addEventListener('pointerup', () => { root._drag = null; root._dragSec = null; });
    tl.addEventListener('pointercancel', () => { root._drag = null; root._dragSec = null; });
    /* The order of the scenes is the order of the film, and the hand wants to change it without
       dragging whole cards around: chips of the ribbon carry their scene number, and dropping one
       onto another moves the scene there. Everything keyed by the card itself - its text, photos,
       songs, ready clips - travels with it. */
    let tlDrag = -1;
    const moveScene = (from, to) => {
      const cards = $$('.sc', root), c = cards[from];
      if (!c || from === to || to < 0 || to >= cards.length) return;
      const box = $('.lm-scenes', root) || root, keep = cards[root._sel];
      box.insertBefore(c, to > from ? (cards[to].nextSibling || null) : cards[to]);
      root._sel = Math.max(0, $$('.sc', root).indexOf(keep));
      renderTL(); showClip(); recount(); refreshStates();
      // the decades travel with the scenes, so nothing in the texts has to be rewritten here
      if (root._save && !root._restoring) root._save();
      toast('Сцена ' + (from + 1) + ' переставлена на место ' + (to + 1));
    };
    tl.addEventListener('dragstart', e => {
      const g = e.target.closest('[data-grip]');
      if (!g) { e.preventDefault(); return; }   // the body of a chip belongs to the time, not to the move
      const b = g.closest('.tl-b');
      if (!b || b.dataset.add) { e.preventDefault(); return; }
      tlDrag = +b.dataset.i;
      b.classList.add('dragging');
      try { e.dataTransfer.setData('text/h3scene', String(tlDrag)); e.dataTransfer.effectAllowed = 'move'; } catch (err) { }
    });
    tl.addEventListener('dragend', () => {
      tlDrag = -1; $$('.tl-b', tl).forEach(x => x.classList.remove('dragging', 'over'));
    });
    tl.addEventListener('dragover', e => {
      const b = e.target.closest('.tl-b');
      if (!b || b.dataset.add || tlDrag < 0) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { }
      $$('.tl-b', tl).forEach(x => x.classList.toggle('over', x === b));
    });
    tl.addEventListener('drop', e => {
      const b = e.target.closest('.tl-b');
      if (!b || b.dataset.add) return;
      let from = tlDrag;
      try { const v = +e.dataTransfer.getData('text/h3scene'); if (!isNaN(v) && v >= 0) from = v; } catch (err) { }
      e.preventDefault(); e.stopPropagation();
      $$('.tl-b', tl).forEach(x => x.classList.remove('dragging', 'over'));
      tlDrag = -1;
      if (from < 0) return;
      moveScene(from, +b.dataset.i);
    });
    tl.onclick = e => {
      if (e.target.closest('.tl-h')) return;
      const x = e.target.closest('[data-scdel]');
      if (x) {                          // a scene can be dropped right on the ribbon
        e.stopPropagation();
        if ($$('.sc', root).length < 2) { toast('Оставлена одна сцена - из одной ролик не соберёшь'); return; }
        const idx = +x.dataset.scdel, c = $$('.sc', root)[idx]; if (!c) return;
        /* Removing a scene takes its text with it, and the ribbon does not show what was thrown away.
           The cross now asks first; «Шаг назад» stays the way back if the person changes his mind. */
        confirmBox('Убрать сцену ' + (idx + 1) + ' с ленты?',
          'Текст сцены уйдёт вместе с ней. Её фотографии и песни на полках останутся и дождутся новой сцены, а «Шаг назад» вернёт сцену целиком.',
          'Убрать сцену', async () => {
            root._pushUndo?.(); c.remove(); recount(); renderTL(); showClip(); refreshStates();
            if (root._save && !root._restoring) root._save();
            toast('Сцена ' + (idx + 1) + ' убрана с ленты · «Шаг назад» вернёт её');
          });
        return;
      }
      const b = e.target.closest('.tl-b'); if (!b) return;
      if (b.dataset.add) { $('#lmAdd', root).click(); return; }
      root._sel = +b.dataset.i; root._target = root._sel;   // the run button works on the scene you picked
      renderTL(); showClip(); refreshStates();
    };
    $('.tl-join', root).onclick = () => {   // the finished scenes, in order, go to the Montage page: one click there joins them into a single file
      const q = root._q, cards = $$('.sc', root);
      const ids = cards.map(c => (c._dn[q] || {}).id).filter(id => id && byId(id) && !byId(id).missing);
      if (ids.length < 2) { toast(ids.length ? 'Готова только одна сцена: сохранить её можно из Библиотеки. Для ролика нужно хотя бы две готовые сцены.' : 'Пока нет готовых сцен'); return; }
      if (ids.length < cards.length) toast(`Готово ${ids.length} из ${cards.length} сцен: в Монтаж отправлены только готовые`);
      window.montageLoad(ids); goTo('montage');
    };
    $('.tl-all', root).onclick = () => {   // the finished fragments one after another
      const urls = $$('.sc', root).map(c => (c._dn[root._q] || {}).url).filter(Boolean);
      if (!urls.length) { toast('Пока нет готовых фрагментов'); return; }
      let n = 0; vid.hidden = false; $('.tl-empty', root).hidden = true; $('.tl-player', root).classList.remove('empty');
      const next = () => { if (n >= urls.length) { vid.onended = null; vid.loop = true; return; } vid.loop = false; vid.src = urls[n++]; vid.play().catch(() => {}); };
      vid.onended = next; next();
    };
    const sz = q => resFor(S.aspect, q).join('×');
    const szOf = v => sz(v === root._q ? S.q : (root._qBy || {})[v] || S.q);
    const Q_HINT = v => v === 'draft'
      ? `Черновик: ${szOf('draft')}, 4 шага, быстро. Понравился, его можно просто увеличить или пересчитать кнопкой «Сделать всё в хорошем качестве».`
      : `Хорошее качество: ${szOf('final')}, ${cfg.mode === 'actionsc' ? '8 + 4 шага на гибридной модели' : '8 шагов'}. Размер выбирается ниже, в «Формат» и «Качество».`;
    root._paintQ = () => {
      $('.lm-q button[data-mq="draft"] small', root).textContent = `${szOf('draft')} · 4 шага, быстро`;
      $('.lm-q button[data-mq="final"] small', root).textContent = `${szOf('final')} · 8 шагов, итог`;
      const qn = $('.lm-qnote', root); if (qn) qn.textContent = root._q === 'draft' ? 'Размер ниже выбирается для ЧЕРНОВИКА (режим переключается кнопками в блоке «Сцены»).' : 'Размер ниже выбирается для ХОРОШЕГО КАЧЕСТВА (режим переключается кнопками в блоке «Сцены»).';
      $('.lm-q-hint', root).innerHTML = root._dmad === false
        ? 'Черновику нужен файл ускорения DMAD (340 МБ) - его нет в папке моделей. '
          + '<button class="btn mini lm-dmad" type="button">Скачать и включить черновик</button> Сейчас сцены считаются в хорошем качестве.'
        : Q_HINT(root._q);
      $$('.sc-tq', root).forEach(sel => { if (!sel._touched) sel.value = S.q; });
    };
    root._qBy = { draft: S.q, final: S.q };
    function setQ(v, force) {
      if (!force && v !== root._q) { root._qBy[root._q] = S.q; S.q = QUALITY_ALL.some(x => x.id === root._qBy[v]) ? root._qBy[v] : '720p'; S._upd?.(); }   // the size chosen in «Параметры» belongs to the row that is open
      root._q = cfg.mode === 'actionsc' ? 'final' : v;   // the action graph has no draft pass:
    // the switch stays visible so the size is readable, but the draft answer is disabled and explained
    $$('.lm-q button', root).forEach(b => b.classList.toggle('on', b.dataset.mq === v));
      root._paintQ();
      vid.onended = null; vid.loop = true; refreshStates(); renderTL(); showClip(); onScenes();
    }
    root._setQ = setQ;
    const askDmad = () => confirmBox('Черновику нужен файл ускорения',
      'Черновик считается в четыре шага на файле ускорения DMAD (340 МБ). Сейчас его нет в папке моделей вашего ComfyUI. Скачать его прямо сейчас?',
      'Скачать и включить', async () => {
        mdStart(['dmad_lora']);
        toast('Качаем. Черновик включится сам, как только файл появится');
        let tries = 0;
        const timer = setInterval(() => {
          if (++tries > 80) { clearInterval(timer); return; }
          checkDmad(true).then(ok => { if (ok) clearInterval(timer); });
        }, 6000);
      });
    root._askDmad = askDmad;
    $('.lm-q', root).onclick = e => {
      if (e.target.closest('.lm-dmad')) { askDmad(); return; }
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.mq === 'draft' && root._dmad === false) { askDmad(); return; }
      setQ(b.dataset.mq);
    };
    $('.lm-final', root).onclick = () => { setQ('final'); $('.lm-chain', root).click(); };
    const checkDmad = fresh => fetch('/api/models/have?role=dmad_lora' + (fresh ? '&fresh=1' : '')).then(r => r.json()).then(r => {
      const found = !!r.have;   // the same answer generation uses: the file may sit in any subfolder ComfyUI sees
      if (!found && r.slow) { root._dmad = null; root._paintQ?.(); return false; }   // ComfyUI did not answer: that is not "no file", and we must not nag
      const was = root._dmad;
      root._dmad = found;
      if (was === false && found) { setQ('draft'); toast('Файл ускорения на месте - черновик включён'); return true; }
      if (was === null) {
        if (!found) { setQ('final'); }
        else if (!root._restoring && !readyUpTo()) { setQ('draft'); }
        renderTL();
      } else { root._paintQ(); }
      return found;
    }).catch(() => { root._dmad = false; return false; });
    root._checkDmad = checkDmad;
    checkDmad();
    queueMicrotask(() => { setQ('final'); });
    queueMicrotask(() => queueMicrotask(() => {   /* the order of the page: main settings, pictures, scenes; the rare things are folded */
      const col = $('.col', root), top = $('.rm-params', root), refsCard = $('.rm-imgs', root).closest('.card'), musCard = $('.lm-snd', root).closest('.card'), scCard = $('.lm-scenes', root).parentElement;
      const hdr = $('.card-h', top), mk = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };
      $('h3', hdr).innerHTML = '<span class="n">4</span>Параметры';
      $('.lm-qnote', root)?.remove();
      const how = $('details.agvar', top); if (how) how.open = false;
      // mode first, then format, quality, sound
      const q = $('.lm-q', root), qh = $('.lm-q-hint', root);
      qh.style.margin = '0 0 4px';
      const rows = $$(':scope > .row', top);
      // found by their caption, not by position: the extra row of the section (the sharpness slider in
      // the action studio) is inserted first, and counting from zero silently shifted every one of
      // these three onto the wrong row - format became the slider, quality became the format
      const byCaption = rx => rows.find(x => rx.test((x.querySelector('.row-l') || {}).textContent || ''));
      const fmt = byCaption(/Формат/), qual = byCaption(/Качество/), own = byCaption(/Свой размер/);
      const snd = $('.lm-snd', root), sh = $('.lm-snd-hint', root);
      // one column, the way every other section shows its settings: the two-column grid of the studio
      // (mode and sound on the left, format and quality on the right) is what made this card look
      // foreign, so the rows simply stand under each other in the usual order
      const modeRow = mk('row', '<div class="row-l">Режим</div>'); modeRow.append(q, qh);
      const sndRow = mk('row', '<div class="row-l">Звук</div>'); sndRow.append(snd, sh);
      const modeSeg = $('.lm-mode', root), modeHint = $('.lm-mode-hint', root);
      const how2 = mk('row', '<div class="row-l">Как считать</div>'); how2.append(modeSeg, modeHint);
      (how || hdr).after(...[fmt, qual, modeRow, how2, sndRow].filter(Boolean));   // format and quality first, as elsewhere
      // what the work stands on is decided first of all, before the settings it changes
      const baseSeg = $('.lm-base', root), baseHint = $('.lm-base-hint', root), ownBox = $('.lm-srcpick', root);
      if (baseSeg) {
        const baseRow = mk('row', '');   // no caption: the two buttons say everything
        if (cfg.mode === 'actionsc') {
    const dq = $('.lm-q [data-mq="draft"]', root);   // черновика в этом режиме нет: 8 + 4 шага сразу
    if (dq) { dq.disabled = true; dq.title = 'Черновика в Экшн-видеостудии нет: сцена сразу считается 8 шагов в уменьшенном кадре и 4 в полном. Здесь видно размер хорошего качества.'; }
  }
  if (cfg.mode === 'actionsc') baseRow.classList.add('no-base');   // this studio has no base video yet: the row and its guide would only stand empty
        baseSeg.style.marginBottom = '0';
        baseSeg.style.gridTemplateColumns = '';   // the inline halves made the buttons as wide as the strip
        baseRow.append(baseSeg);
        /* «Очистить всё» belongs to this row of choices, not to the pictures' card. The button cannot
           simply be written here in the markup: its handler is attached while the first template is
           still the whole page, long before this row exists - the markup variant left the handler with
           nothing to attach to and the entire section failed to open. Carrying the node here keeps the
           handler on it. In the action studio this row is hidden, and there the button stays in the
           card, where it is still reachable. */
        { const cbtn = $('.rm-clear', root);
          if (cbtn && cfg.mode !== 'actionsc') { cbtn.style.marginLeft = 'auto'; cbtn.style.flex = 'none'; baseRow.append(cbtn); } }
        if (ownBox) ownBox.style.marginTop = '8px';   // appended after the guide button, see below
        root._baseHost = baseRow;   // put above the first card once the whole set-up is done
      // the video you continue is part of this choice, so the note with «Убрать» stands right here
      const srcNote = $('.lm-src', root);
      // the button that takes the video off stands with the buttons that put it on
      const unBtn = $('.lm-srcx', root), srcRow = ownBox && [...ownBox.children].find(x => /flex/.test(x.getAttribute('style') || ''));
      if (unBtn && srcRow) { unBtn.style.margin = '0'; srcRow.append(unBtn); }
      if (srcNote) { srcNote.classList.remove('note'); srcNote.classList.add('hint'); srcNote.style.cssText = 'margin:8px 0 0;font-size:12.5px;display:block'; }
      // one mini instruction instead of notes spread over the page: the fold in the settings card
      if (how && !baseRow.contains(how)) baseRow.append(how);   // it must stand with the switch, not in the settings
      const guide = how || (() => { const d = document.createElement('details'); d.className = 'agvar'; d.innerHTML = '<summary>Как работает</summary>'; baseRow.append(d); return d; })();
      const box = document.createElement('div'); box.className = 'lm-guide'; box.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:8px';
      (guide.querySelector('summary') || guide).insertAdjacentElement('afterend', box);
      const scNote = [...scCard.children].filter(x => x.classList.contains('note')).pop();
      const rmNote = [...refsCard.children].filter(x => x.classList.contains('note')).pop();
      [baseHint, scNote, rmNote].filter(Boolean).forEach(n => { n.style.margin = '0'; box.append(n); });
      box.insertAdjacentHTML('beforeend', '<div class="hint" style="font-size:12.5px"><b>Места для фото.</b> Сцена несёт девять картинок: сначала общие (<Picture 1>, <Picture 2>…), потом её собственные (<Picture 10>, <Picture 11>…) - программа сама ставит их в расчёт после общих. Когда вы продолжаете своё видео, его последний кадр идёт отдельной плиткой сверх этих девяти, и ваших мест остаётся восемь. Плашки с номерами стоят под текстом сцены; занятые места гасят те, что текст не вызывает.</div>');
      // the labels and their tooltips live in the markup of the switch itself: these
      // buttons are built later than this point, so code here never reached them
      const gsum = guide.querySelector('summary');
      if (gsum) {
        const gb = document.createElement('button'); gb.type = 'button'; gb.className = 'btn mini lm-howb';
        gb.textContent = 'Как работает студия'; gb.title = 'Открыть объяснение, модели и нюансы режима в отдельном окне';
        const gwrap = document.createElement('div'); gwrap.className = 'lm-guidewrap';
        [...guide.childNodes].forEach(x => { if (x !== gsum) gwrap.append(x); });
        guide.replaceWith(gb);
        gb.onclick = () => {
          let m = document.getElementById('lmHowM');
          if (!m) {
            m = document.createElement('div'); m.className = 'modal'; m.id = 'lmHowM'; document.body.append(m);
            // a window built after the start of the page gets no share of the common closer, so it
            // has to close itself: that is why «Закрыть» did nothing before
            m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-x]')) m.hidden = true; });
          }
          m.hidden = false;
          m.innerHTML = '<div class="box" style="padding:22px;max-width:740px;max-height:calc(var(--vh,1vh)*86);overflow:auto"><div class="card-h"><h3>Как работает студия</h3><button class="btn" data-x type="button">Закрыть</button></div><div class="lm-guide"></div></div>';
          const body = $('.lm-guide', m);
          // --- what the window tells: add a section here, one block per topic ---
          // Всё новое, что мы добавляем в студию, описываем здесь - одним блоком в этом списке.
          const EXTRA = [
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Звук.</b> Переключателя больше нет - решает сам файл. <b>Аудио лежит</b>: видео подстраивается под него, каждая сцена берёт свой кусок по порядку (он подписан в карточке сцены), а в ролике играет ваш трек целиком. <b>Аудио нет</b>: модель сочиняет звук сама по описаниям сцен, и на стыках придуманный звук продолжается, чтобы не было щелчка. Что герои говорят и какая музыка за кадром - пишите в тексте сцен.</div>',
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Работа со звуком (карточка «Аудио»).</b> Файл берётся кнопкой «Загрузить аудио» или перетаскиванием на строку. Ниже - прибор как в LipSync: прослушать выделенное, волна, <b>рамка выделения с ручками по краям</b> (края тянутся независимо), приближение для точной резки, два режима - «что оставить в клипе» и «что вырезать», кнопки «Оставить выделенное», «Убрать паузы», «Отделить голос», «Отменить», поля «Начало» и «Конец» с длиной и предупреждением про 15 секунд. Готовый фрагмент подставляется вместо файла: расчёт видит обычный загруженный файл.</div>',
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Тег &lt;Audio 1&gt;.</b> Когда аудио лежит, под текстом сцены появляется плашка &lt;Audio 1&gt; - клик вставляет тег туда, где стоит курсор. Он не выбирает, брать ли ваш файл (файл уже взят), а объясняет модели, что этот звук - фон данной сцены. Плашка не занимает ни одного из девяти мест под картинки; аудио в проекте одно, поэтому тег - всегда &lt;Audio 1&gt;.</div>',
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Длина фонового звука.</b> Обычное правило «не больше 15 секунд» к общему треку больше не применяется: ролик длиннее сцены, и весь трек выделяется целиком. Если трек короче ролика, включите «пустой фон по кругу» - тогда звук начнётся сначала и дойдёт до конца; с выключенной галкой музыка оборвётся там, где кончился файл. Для аудио отдельной сцены 15 секунд останутся в силе: сцена сама не длиннее.</div>',
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Аудио отдельной сцены.</b> Под текстом сцены есть кнопка «Загрузить аудио сцены» - до трёх файлов. У каждой сцены свои номера десятками: во второй сцене это &lt;Audio 20&gt;, &lt;Audio 21&gt;, &lt;Audio 22&gt;, в третьей - от 30; первый номер &lt;Audio 1&gt; оставлен фону всего ролика. Модель получает их как ссылки, а применяет там, где вы упомянули файл тегом в тексте сцены: не упомянули - звук в сцене делает модель. Кнопка «Обрезать» открывает тот же прибор, что и в карточке «Аудио», но с правилом 15 секунд - сцена длиннее всё равно не будет. Файлы хранятся вместе с проектом.</div>',
            ,
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Аудио в Референсах, Актёре и Экшн-видео.</b> Здесь у звука своя карточка «Аудио». Файлы не выкладываются тремя пустыми плашками: нажимаете «Загрузить аудио» - и файл становится отдельной меткой с названием, длиной и тегом &lt;Audio 1&gt;, &lt;Audio 2&gt;, &lt;Audio 3&gt;. Нажатие на метку ставит тег в текст, «Обрезать» открывает тот же прибор, что и в Видеостудии: волна, перетаскивание, прослушивание, до 15 секунд. Второе нажатие закрывает окно и применяет выделенное, а открывается снова целый файл - резать можно сколько раз угодно, файл на диске при этом не портится. Больше трёх аудио нельзя: кнопка гаснет сама.</div>',
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Референс-видео.</b> В Референсах у видео своя карточка, а в «Замене персонажа» под окном видео стоит тот же верстак. Файлы добавляются по одному, каждый подписан &lt;Video 1&gt;, &lt;Video 2&gt;, &lt;Video 3&gt; - нажатие на метку ставит тег в текст. <b>Дальше 25 секунд модель не смотрит</b>, поэтому лишнее стоит отрезать. кнопка «Монтаж» открывает верстак: над лентой окно просмотра, на ленте - сами кадры, жёлтый маркер (в левом верхнем углу ленты всегда показаны его секунды), а прямо у маркера стрелки покадровой прокрутки (один кадр = 1/24 с) и ножницы: левые убирают всё до маркера, правые - всё после. Ползунок и кнопки «−» «+» меняют <b>ширину ленты</b> (сколько пикселей приходится на секунду), «По ширине» возвращает весь клип в окно. Клик по ленте слева от метки играет от начала куска до метки, справа - от метки до конца, а окно просмотра стоит на маркере и показывает его как стоп-кадр. Края выделенного участка тянутся мышью, двойной клик возвращает целый клип, убрать файл совсем можно крестиком на его метке в карточке, «Отменить» шагает назад. «Оставить выбранное» режет по-настоящему, настоящим декодером: в карточке останется кусок, а для новой резки всегда открывается целый файл. «🤖 К сценаристу» отправляет клип сценаристу - он посмотрит на него как на кадры.</div>',
            () => '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>«🤖 К сценаристу».</b> Отправляет выделенный кусок в раздел «Сценарист»: он распознаёт слова и пишет промпт уже зная, что говорится. Перед отправкой Сценарист сам переключается на Видеостудию, чтобы не писать в чужой раздел. Если распознавание речи ещё не скачано, кнопка об этом скажет - строчка «Модель сценариста», кнопка «Докачать».</div>',
            () => {
              const mp = root.querySelector('.mdl-pick'); if (!mp) return '';
              const cur = ($('.mp-cur', mp) || {}).textContent || '—';
              const src = ($('.mp-src', mp) || {}).textContent || 'встроенная';
              const l = $('.mp-loras', mp);
              const loras = l ? [...l.querySelectorAll('.mp-l')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' · ') : '';
              return '<div class="hint" style="font-size:12.5px;line-height:1.55"><b>Модели этого режима.</b> Сейчас стоит <b>' + esc(cur) +
                '</b> (' + esc(src) + ').' + (loras ? '<br>LoRA режима: ' + esc(loras) : '') +
                '</div>';
            },
          ];
          EXTRA.forEach(f => { try { const h = f(); if (h) body.insertAdjacentHTML('beforeend', h); } catch (e) {} });
          body.append(gwrap);
        };
      }
      if (ownBox) baseRow.append(ownBox);   // under the buttons: the guide button never moves sideways
      // (the run buttons are placed further down, once the scenes card stopped claiming them)
        // the choice's own words already sit in the guide inside the fold
      }
      // nothing is folded away in the studios: the seed, the size of your own and the memory warning
      // all stand in the open, like everywhere else
      if (qual && own) qual.after(own);
      // pictures right after the settings, then the scenes
      $('h3', refsCard).innerHTML = '<span class="n">1</span>Изображения героя и места';
      $('h3', musCard).innerHTML = '<span class="n">2</span>Аудио';
      if (!$('.mus-film', musCard)) {   // three files for the whole film, on the same terms as a scene's
        const fw = document.createElement('div');
        fw.className = 'mus-film';
        fw.style.cssText = 'margin:0 0 10px';
        fw.innerHTML = '<div class="sub-l"><span>Аудио на весь ролик</span></div>' +
          '<div class="mus-filmrow"></div>' +
          '<div class="mus-extra"></div>' +
          '<small class="hint" style="display:block;margin-top:6px"><b>Первый файл - звук ролика</b> (тег &lt;Audio 1&gt;): модель перекладывает его в видео,' +
          ' правило 15 секунд на него не действует. <b>Второй и третий - образцы</b> (теги &lt;Audio 2&gt; и &lt;Audio 3&gt;): голос, ритм, атмосфера,' +
          ' которые можно сослать в тексте любой сцены. Обрезать и глушить лесенкой можно каждый. Кнопка «🎧 Всё к сценаристу» живёт в заголовке этой карточки - она видна, даже когда карточка свёрнута.</small>';
        $('.card-h', musCard).insertAdjacentElement('afterend', fw);
        // the old tile stays in the tree - the calculation reads its field - but it is not shown:
        // the row above is what the person sees and uses
        const media = $('.rm-media', musCard);
        if (media) { const cp = $('.sub-l', media), hn = $('.media-hint', media); if (cp) cp.hidden = true; if (hn) hn.hidden = true; }
        const audsRow = $('.rm-auds', root); if (audsRow) audsRow.hidden = true;
        const frow = new AudioRow({
          mount: $('.mus-filmrow', fw), base: 1, limit: 0,
          whereLabel: j => (j === 0 ? 'фон всего ролика' : 'образец ролика номер ' + j) + ', аудио ' + (j + 1) + ', тег <Audio ' + (1 + j) + '>',
          onChange: j => { syncFilm(j); if (root._save) root._save(); $$('.sc', root).forEach(cc => { try { cc._paintRefs && cc._paintRefs(); } catch (e) { } }); },
        });
        root._faudRow = frow;
        // the calculation still reads the old field: the first file of the row is written into it,
        // so every flag above the row (start, voice, music, loop) keeps working off the same file
        const slotInp = () => { const s = $('.rm-auds .slot', root); return s && $('input', s); };
        root._fauds = [null, frow.files[1], frow.files[2]];
        const keepMirror = () => {
          root._fauds = [null, frow.files[1], frow.files[2]];
          const i2 = slotInp(), f = frow.files[0];
          if (!i2 || frow._mirrored === (f && f.name + f.size)) return;
          frow._mirrored = f ? f.name + f.size : null;
          try {
            if (f) { const dt = new DataTransfer(); dt.items.add(f); i2.files = dt.files; }
            else i2.files = new DataTransfer().files;
            i2.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) { }
        };
        const chipRow = () => $('.rm-tokens', root);
        const syncFilm = () => {
          const f = frow.files[0];
          const s = $('.rm-auds .slot', root);
          const want = f ? 'own' : 'none';
          if (root._snd !== want) { try { setSnd(want); } catch (e) { } }
          const row = chipRow();
          if (row) {
            let ch = row.querySelector('.tok-aud');
            if (f && !ch) {
              ch = document.createElement('button'); ch.type = 'button'; ch.className = 'token tok-aud'; ch.dataset.audio = '1';
              ch.innerHTML = '&lt;Audio 1&gt;';
              ch.title = '<Audio 1> - звук ролика: модель возьмёт его как фоновый звук сцены';
              row.append(ch);
            } else if (!f && ch) ch.remove();
          }
          // the counters belong to a block built later than this one, so the refresh waits a step
          queueMicrotask(() => { try { recount(); } catch (e) { } });
          const lp = $('.at-loop', mus);
          if (lp) lp.hidden = !f;
          keepMirror();
        };
        const extra = $('.mus-extra', fw);
        const lp = document.createElement('label');
        lp.className = 'at-loop';
        lp.hidden = true;
        lp.style.cssText = 'display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--muted);cursor:pointer;margin:8px 0 0';
        lp.innerHTML = '<input type="checkbox" class="lm-loop"><span>Пустой фон по кругу - если ваш трек короче ролика, остаток заполняется им же, без тишины</span>';
        const ab = document.createElement('button');
        ab.type = 'button'; ab.className = 'btn mini at-all agall-h';
        ab.textContent = '🎧 Всё к сценаристу';
        ab.title = 'Сложить в чат сценариста всё аудио - фон ролика, его образцы и аудио всех сцен; он допишет к тому, что уже есть, и ничего не очистит';
        // the button belongs to the card's heading, not to its body: the audio card is folded most
        // of the time, and a control hidden inside a fold is a control nobody finds
        const head = $('.card-h', musCard);
        (head || extra).append(ab);
        // the button wakes only when there is audio to take: the film's background, its samples or a
        // scene's own track - and sleeps again when the last of them is removed
        ab._agCount = () => ((root._filmFiles ? root._filmFiles() : [])[0] ? 1 : 0)
          + (root._fauds || []).filter((f, j) => f && j > 0).length
          + $$('.sc', root).reduce((z, cc) => z + ((cc._auds || []).filter(Boolean).length), 0);
        extra.append(lp);
        const voc = $('.lm-vocals', root), vocRow = voc && voc.closest('label');
        if (vocRow) extra.append(vocRow);   // «музыка в готовом ролике целиком» - флаг остаётся на виду
        const bedRow = $('.lm-bed', root);
        if (bedRow) extra.append(bedRow);   // ползунок уровня музыки и выравнивание - рядом с остальными флагами фона
        lp.querySelector('input').checked = root._loop !== false;
        lp.onchange = e => { root._loop = e.target.checked; if (root._save) root._save(); };
        Object.defineProperty(root, '_trim', { get: () => frow._tr, configurable: true });
        root._faudsSync = syncFilm;
        root._filmFiles = () => frow.files.slice();
        const s0 = $('.rm-auds .slot', root);   // a restored project may already carry the film's sound
        if (s0 && s0._file) { frow.set(0, s0._file); } else { syncFilm(); }
      }
      if (!$('.mus-cap', musCard)) {   // how many pieces of audio this place allows, said once and in words
        const cap = document.createElement('div'); cap.className = 'hint mus-cap';
        cap.style.margin = '0 0 8px';
        cap.innerHTML = '<b>Общие аудио</b> - до трёх на весь ролик (теги &lt;Audio 1&gt;, &lt;Audio 2&gt;, &lt;Audio 3&gt;). Аудио отдельной сцены - <b>до трёх</b> на сцену,' +
          ' их номера идут десятками. На фон правило 15 секунд не действует: трек может быть длиннее сцены,' +
          ' а если он короче ролика - включите «пустой фон по кругу».';
        $('.card-h', musCard).insertAdjacentElement('afterend', cap);
      }
      // in the action studio there is no music at all, so the audio card must not stand empty
      // the audio card is always there now: a file in it means "play this", an empty one means
      // "let the model invent the sound", so nothing about the card itself has to be hidden
      const syncMus = () => { musCard.hidden = false; };   // the action studio has a soundtrack of its own now
      new MutationObserver(syncMus).observe($('.lm-own', root), { attributes: true, attributeFilter: ['hidden'] }); syncMus();
      $('h3', scCard).innerHTML = '<span class="n">3</span>Сцены';
      // under the open scene: the big buttons, the tags; the rest is folded
      const sceneBox = $('.lm-scenes', root), chain = $('.lm-chain', root), fin = $('.lm-final', root), src = $('.lm-src', root), foot = $('.ta-foot', scCard);
      // the prompt of the open scene comes first, then the ribbon of fragments, then the player
      const player = $('.tl-player', scCard), allRow = player.nextElementSibling, tlEl = $('.tl', scCard), tlHint = tlEl.nextElementSibling;
      $('.card-h', scCard).after(sceneBox, tlEl, tlHint, player, allRow);
      allRow.after(chain, fin, src, foot);
      // the note about the continued video belongs to the choice of where it comes from
      const bRow = $('.lm-base', root)?.closest('.row'), srcN = $('.lm-src', root);
      if (bRow && srcN) { srcN.classList.remove('note'); srcN.classList.add('hint'); srcN.style.cssText = 'margin:8px 0 0;font-size:12.5px;display:block'; bRow.append(srcN); }
      // the right bar is the run panel: first a reminder of what is running, then the ways to run it
      const bar = $('.rm-preview', root);
      if (bar) {
        const memo = document.createElement('div');
        memo.className = 'hint lm-memo';
        memo.style.cssText = 'margin:14px 0 8px;font-size:13px;text-align:center;font-weight:700';
        const plate = document.createElement('div');
        plate.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px';
        const chainB = $('.lm-chain', root), joinB = $('.tl-join', root), watchB = $('.tl-all', root);
        if (watchB) {
          watchB.textContent = 'Отправить в монтаж';
          watchB.title = 'Все готовые сцены лягут в ленту «Монтажа»; сами вы туда не перелетаете - перейдите и склейте, когда захотите';
          watchB.onclick = () => {
            const ids = $$('.sc', root).map(c => (c._dn[root._q] || {}).id).filter(id => id && byId(id) && !byId(id).missing);
            if (!ids.length) { toast('Пока нет готовых сцен'); return; }
            window.montageLoad(ids);
            toast('Сцены лежат в «Монтаже»: откройте его и склейте, когда будет нужно.');
          };
        }
        // the combined "make all scenes AND send to Montage" button is gone: it only sent what was
        // already made, so it answered "there are no finished scenes" and duplicated two honest buttons
        if (joinB) joinB.hidden = true;
        // one column, one measure: the scene you picked, then all scenes, then the hand-off
        const goB = $('.go', bar);
        const plates = [chainB, watchB].filter(Boolean);
        const same = 'width:100%;margin:0;padding:12px 14px;font-size:14px;font-weight:700;border-radius:12px';
        [goB, chainB, watchB].filter(Boolean).forEach(b => { if (!b.classList.contains('pri')) b.classList.add('btn', 'pri'); b.style.cssText = same; plate.append(b); });
        root._plates = plates;
        root._memo = () => {
          const q = root._q === 'draft' ? 'Черновик' : 'Хорошее качество';
          memo.textContent = root._mode === 'parts' ? `${q} · по частям` : `${q} · весь ролик одним файлом`;
          (root._plates || []).forEach(b => { b.hidden = root._mode !== 'parts'; });   // the whole-film mode keeps only the run button
        };
        bar.append(memo); bar.append(plate);   // the reminder stands right above the run buttons
        root._memo();
      }
      // the order of the section, the same as everywhere else: media, text, settings
      col.prepend(refsCard);
      refsCard.after(musCard); musCard.after(scCard);   // pictures, audio, scenes - audio used to fall under the scenes
      col.append(top);
      if (root._baseHost) col.prepend(root._baseHost);   // the switch, the file and the button, above card one
      /* undo: what was cleared or deleted can be brought back (button «Отменить действие» or Ctrl+Z) */
      root._undo = [];
      const refsFiles = () => $$('.ref', imgsEl).map(r => r._file || null);
      root._pushUndo = () => {
        root._undo.push({ run: root._run, sel: root._sel, refs: refsFiles(), scenes: $$('.sc', root).map(c => ({ prompt: $('textarea', c).value, sec: +$('input[type=range]', c).value, fresh: !!$('.sc-fresh', c)?.checked, base: c._baseFixed || 0, files: [...c._files], dn: { ...c._dn }, old: c._old, tests: [...c._tests], var: c._var || 0 })) });
        if (root._undo.length > 10) root._undo.shift();
      };
      root._doUndo = async () => {
        const u = root._undo.pop(); if (!u) return;
        $$('.sc', root).forEach(c => c.remove()); root._run = u.run;
        u.scenes.forEach(x => { addScene(x.prompt, x.sec, x.fresh, x.base || 0); const c = $$('.sc', root).pop(); c._files = x.files; c._paint(); c._dn = x.dn; c._old = x.old; c._tests = x.tests; c._paintTests(); c._var = x.var; });
        const names = a => JSON.stringify(a.map(f => f && f.name));
        if (names(refsFiles()) !== names(u.refs)) { $$('.ref .x', imgsEl).forEach(x => x.click()); for (let i = 0; i < u.refs.length; i++) if (u.refs[i]) await putInto($$('.ref input', imgsEl)[i], u.refs[i]); }
        root._sel = u.sel; renumber(); sceneReconcile(root); recount(); refreshStates(); toast('Действие отменено');
      };
      document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'z' && $('#view-long.active') && !e.target.closest('textarea, input') && root._undo.length) { e.preventDefault(); root._doUndo(); } });
      /* One scene, then all of them: the button that empties a single scene stands first, right
         under the ribbon, in the same quiet style, so the two are read as one pair - and both ask. */
      const clrOne = document.createElement('button'); clrOne.type = 'button'; clrOne.className = 'btn mini lm-clearone';
      clrOne.textContent = 'Очистить сцену';
      clrOne.style.cssText = 'margin:0 6px 10px 0';
      clrOne.title = 'Стирает текст, фото, песни и отметку о готовом клипе только выбранной сцены';
      clrOne.onclick = () => {
        const cards = $$('.sc', root), i = Math.max(0, Math.min(cards.length - 1, root._sel || 0)), c = cards[i];
        if (!c) { toast('Сцена не выбрана'); return; }
        confirmBox('Очистить сцену ' + (i + 1) + '?',
          'Её текст, собственные фото, песни и отметка о готовом клипе будут стёрты. Общие изображения героя и места, а также клипы других сцен не трогаются; «Шаг назад» вернёт сцену целиком.',
          'Очистить сцену', () => {
            root._pushUndo?.();
            const ta = $('textarea', c); if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
            c._files = []; (c._auds || []).forEach((x, j) => { c._auds[j] = null; });
            c._dn = { draft: null, final: null }; c._old = null; c._tests = []; c._var = 0;
            const sf = $('.sc-fresh', c); if (sf) sf.checked = false;
            c._paint?.(); c._paintAuds?.(); c._paintTests?.();
            refreshStates(); recount(); renderTL(); showClip();
            if (root._save && !root._restoring) root._save();
            toast('Сцена ' + (i + 1) + ' очищена · «Шаг назад» вернёт её');
          });
      };
      const clrSc = document.createElement('button'); clrSc.type = 'button'; clrSc.className = 'btn mini lm-clearscenes';
      clrSc.textContent = 'Очистить все сцены';
      clrSc.style.cssText = 'margin:0 0 10px';
      clrSc.title = 'Стирает тексты всех сцен и их собственные фото. Общие изображения героя и места остаются на месте';
      clrSc.onclick = () => confirmBox('Очистить все сцены?',
        'Тексты всех сцен и их собственные фото будут стёрты, останется одна пустая сцена. Общие изображения, звук и готовые видео не трогаются.', 'Очистить', () => {
          root._pushUndo?.();
          $$('.sc', root).forEach(x => x.remove());
          root._run = Math.random().toString(36).slice(2, 12); root._sel = 0;
          addScene('', 10); recount(); refreshStates(); renderTL(); showClip();
          const pv = $('.rm-preview', root); if (pv && pv._reset) pv._reset();   // и предпросмотр сцены пустеет
          toast('Сцены очищены: осталась одна пустая, общие фото на месте');
        });
      const chips = $('.rm-tokens', root)?.closest('.ta-foot'), ta0 = $('.col textarea', root);
      // the names you can insert belong where you write: put them under the card that holds the text
      const host = ta0 && (ta0.closest('.sc') || ta0.closest('.card'));
      if (chips && host && !host.contains(chips)) host.insertAdjacentElement('afterend', chips);
      const tlRow = ($('.tl', root) || {}).nextElementSibling || $('.tl', root);
      if (tlRow) { tlRow.insertAdjacentElement('afterend', clrSc); clrSc.insertAdjacentElement('beforebegin', clrOne); } else fin.after(clrSc);   // right under the scene chips: first this scene, then all
      $('#lmAdd', root).hidden = true;   // the plus on the ribbon is the way to add a scene
      // the base choice and its file button were placed in the settings card above
    }));
    $('#lmAdd', root).onclick = () => {
      if ($$('.sc', root).length >= 20) { toast('Не больше 20 сцен — это уже полчаса расчёта'); return; }
      addScene('', 10);
      // the scene you asked for is the scene you want to write: it opens right away
      root._sel = $$('.sc', root).length - 1; root._target = root._sel;
      renderTL(); showClip(); refreshStates();
    };
    queueMicrotask(() => { addScene('', 10); });   // a blank start holds ONE scene; «+» in the ribbon makes the next  // after the rest of the set-up is done
    // the «Очистить» button of the section: in this mode the scenes are the text
    root._hasText = () => $$('.sc textarea', root).some(t => t.value.trim());
    root._clearScenes = () => {
      $$('.sc', root).forEach(c => c.remove());
      addScene('', 10);
      root._run = Math.random().toString(36).slice(2, 12);   // the new scenes continue nothing from the old ones
      // клип последней сцены жил в проигрывателе ленты: без этой пары он оставался на экране
      // и после того, как сцен уже нет, - человек читал это как «очистка не сработала»
      recount(); renderTL(); showClip(); refreshStates();
    };
    const mus = document.createElement('div'); mus.className = 'card';
    root._snd = 'none';
    mus.innerHTML = `<div class="card-h"><h3><span class="n">3</span>Звук</h3></div>
      <div class="seg lm-snd" hidden></div>
      <div class="hint lm-snd-hint" hidden></div>
      <div class="hint lm-sndstate" style="margin:2px 0 8px"></div>
      <div class="lm-own">
        <div class="mus-slot"></div>
        <div class="note warn lm-warn" hidden style="margin:8px 0"><span></span></div>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:8px"><label>Начать с <input class="lm-start" inputmode="numeric" value="0" style="width:60px"> секунды</label>
          <button class="btn" type="button" id="lmVoice" title="Оставить в аудио только голос, без музыки (как в «Клипе»)">Отделить голос от музыки</button><button class="btn" type="button" id="lmVoiceBack" hidden>Вернуть исходное аудио</button></div>
        <label style="display:flex;gap:6px;align-items:center;margin-top:10px" title="Модель держит ваш голос: губы точные, голос в ролике ваш. Музыка из файла играет в ролике фоном тише"><input type="checkbox" class="lm-vocals"> Музыку в ролике оставить, но модель слушает только голос (точнее губы)</label>
        <div class="lm-bed" style="margin-top:10px">
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
            <label style="display:flex;gap:8px;align-items:center" title="Насколько слышна ваша музыка под звуком ролика: 0 - играть своей громкостью, -10 - примерно втрое тише, -30 - почти не слышно"><span>Уровень музыки</span><input type="range" class="lm-beddb" min="-30" max="6" step="1" value="-10" style="width:150px"><b class="lm-beddbv">-10</b> дБ</label>
            <label style="display:flex;gap:6px;align-items:center" title="Файл приводится к одной заданной громкости, и положение ползунка перестаёт зависеть от того, насколько громким был файл"><input type="checkbox" class="lm-bednorm"> Выровнять громкость трека</label>
          </div>
          <div class="hint" style="margin-top:4px">Выравнивание приводит трек к одной заданной громкости: после него -12 дБ одинаково тихо и в громком файле, и в тихом. Без него ползунок отсчитывает громкость от вашего файла, каким он пришёл.</div>
        </div>
      </div>`;
    $('.mus-slot', mus).append($('.rm-media', root));
      const sendAllToAgent = async () => {
        const items = [];
        const f0 = (root._filmFiles ? root._filmFiles() : [])[0];
        if (f0) items.push({ file: f0, name: f0.name, where: 'фон всего ролика, тег <Audio 1>' });
        const ff = root._fauds || [];
        ff.forEach((f, j) => { if (f && j > 0) items.push({ file: f, name: f.name, where: 'образец ролика, тег <Audio ' + (1 + j) + '>' }); });
        $$('.sc', root).forEach((cc, i) => (cc._auds || []).forEach((f, j) => { if (f) items.push({ file: f, name: f.name, where: 'сцена ' + (i + 1) + ', тег <Audio ' + ((cc._baseFixed || cc._base || 10 * (i + 1)) + j) + '>' }); }));
        if (!items.length) { toast('Готового аудио нет: сначала загрузите файл'); return; }
        if (!AG.status || !AG.status.speech_ready) { try { await agStatus(); } catch (e) {} }
        agGo();
        const host = $('#agTarget [data-t="' + (cfg.mode || 'long') + '"]');
        if (host && !host.classList.contains('on')) host.click();   // an already chosen target is left alone
        let ok = 0;
        for (const it of items) {
          try {
            let buf = it.buf, s = it.s || 0, e = it.e;
            if (!buf) {
              const ac = setActx();
              buf = await ac.decodeAudioData(await it.file.arrayBuffer());
              s = 0; e = Math.min(buf.duration, 15);
              if (buf.duration > 15) it.where += ' (обрезку не делали - берём первые 15 с)';
            }
            const piece = wavSlice(buf, s, Math.min(e, buf.duration));
            const done = await setChatAudio(piece, it.name, Math.min(e, buf.duration) - s, it.where);
            if (done) ok++;
          } catch (err) { toast('Не удалось передать «' + it.name + '»: ' + err.message); }
        }
        toast(ok ? ('В Сценарист передано аудио: ' + ok + ' из ' + items.length) : 'Сценарист не принял аудио - проверьте распознавание речи');
      };
      /* The button is created by the block above, which runs later than this code: looking it up here
         found nothing, the press found no handler and stayed silent. The click is caught where it
         bubbles instead - whoever creates the button, and whenever, the press works. */
      if (!root._atAllWire) {
        root._atAllWire = true;
        // caught on the way down, not on the way up: the same click reaches the card heading, which
        // would fold the card the person is looking at. Stopping it here runs the transfer once and
        // leaves the card exactly as it was.
        root.addEventListener('click', e => {
          const b = e.target.closest && e.target.closest('.at-all');
          if (!b) return;
          e.preventDefault(); e.stopPropagation();
          sendAllToAgent();
        }, true);
      }
    c1.after(mus);
    queueMicrotask(() => { const pc = $('.rm-params', root), hw = $('details.agvar', pc); if (hw) $('.card-h', pc).after(hw); const nt = document.createElement('div'); nt.className = 'note lm-qnote'; nt.style.margin = '10px 0'; $('.card-h', pc).after(nt); root._paintQ?.(); });   // "how it works" goes to the top of the parameters
    c1.after($('.rm-params', root));   // size and quality first: they are chosen before the scenes are written
    // что ляжет в готовый ролик, зависит от галочки про голос: без неё модель сочиняет звук сама и
    // музыка человека играет под ним фоном тише; с ней модель держит голос из файла, музыка - фоном
    const HINT = {
      none: () => 'Аудио нет: модель сочинит звук сама по описаниям сцен - что говорят герои и какая музыка за кадром, пишите в тексте сцен. На стыках придуманный звук продолжается, чтобы не было щелчка.',
      own: voc => 'Аудио есть: каждая сцена получает свой кусок по порядку (он подписан в карточке сцены). '
        + (voc ? 'Модель слушает только ваш голос и держит его как есть: губы точные, голос в ролике ваш, а музыка из файла играет фоном тише.'
               : 'Модель сочиняет звук сама, а ваша музыка играет в ролике фоном тише, чтобы речь была слышна.')
        + ' Тег <Audio 1> в тексте сцены говорит модели, что это фоновый звук именно этой сцены.'
        + ' Уровень музыки задаётся ползунком, а «Выровнять громкость трека» приводит файл к общей громкости; если трек короче фильма, музыка кончится там, где кончился файл, а звук ролика продолжится.'
    };
    const setSndState = v => { const el = $('.lm-sndstate', root), voc = $('.lm-vocals', root); if (el && HINT[v]) el.textContent = HINT[v](!!(voc && voc.checked)); };
    // галочка меняет не только расчёт, но и то, что написано над ней: подсказка должна говорить правду
    const vocBox = $('.lm-vocals', root);
    if (vocBox) vocBox.onchange = () => setSndState(root._snd);
    // ползунок уровня музыки: число показываем сразу же, проект запоминаем при каждом движении
    const bedDb = $('.lm-beddb', root), bedVal = $('.lm-beddbv', root), bedNorm = $('.lm-bednorm', root);
    const bedShow = () => { if (bedDb && bedVal) bedVal.textContent = bedDb.value; };
    if (bedDb) bedDb.oninput = () => { bedShow(); if (root._save) root._save(); };
    if (bedNorm) bedNorm.onchange = () => { if (root._save) root._save(); };
    bedShow();
    const setSnd = v => {
      root._snd = v; $$('.lm-snd button', root).forEach(b => b.classList.toggle('on', b.dataset.s === v));
      setSndState(v); recount();
    };
    $('.lm-snd', root).onclick = e => { const b = e.target.closest('button'); if (b) setSnd(b.dataset.s); };
    $('.lm-start', root).oninput = () => recount();
    const slot = $('.rm-auds .slot', root);
    new MutationObserver(() => {   // keep the real length of the chosen audio
      const f = slot._file; root._adur = f ? (slot._dur || 0) : 0; if (f && !slot._orig) { slot._orig = null; } recount();
    }).observe(slot, { attributes: true, subtree: true, childList: true, characterData: true });
    $('#lmVoice', root).onclick = async () => {
      if (!slot._file) { toast('Сначала загрузите аудио'); return; }
      const b = $('#lmVoice', root), old = b.textContent; b.disabled = true; b.textContent = 'Отделяем голос…';
      try {
        const info = await (await fetch('/api/audio/info')).json();
        if (!info.available) throw new Error('Недоступно: ' + info.reason);
        const fd = new FormData(); fd.append('file', slot._file, slot._file.name);
        const r = await fetch('/api/audio/separate', { method: 'POST', body: fd });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Не удалось отделить голос');
        const blob = await r.blob();
        slot._orig = slot._orig || slot._file;
        const nf = new File([blob], slot._orig.name.replace(/\.[^.]+$/, '') + '_голос.flac', { type: blob.type || 'audio/flac' });
        slot._file = nf; $('span', slot).textContent = nf.name; $('#lmVoiceBack', root).hidden = false;
        $('.lm-vocals', root).checked = false; setSndState(root._snd);   // галочку сняли программно: подсказку надо перекрасить
        toast('Голос отделён: музыки в файле больше нет. С галочкой «модель слушает только голос» голос останется в ролике своим звуком, без неё ролик озвучит модель, а голос будет слышен тише. Вернуть исходное - кнопка рядом.');
      } catch (err) { toast(err.message); }
      b.textContent = old; b.disabled = false;
    };
    $('#lmVoiceBack', root).onclick = () => {
      if (!slot._orig) return; slot._file = slot._orig; slot._orig = null; $('span', slot).textContent = slot._file.name; $('#lmVoiceBack', root).hidden = true; toast('Исходное аудио возвращено');
    };
    queueMicrotask(() => setSnd('none'));
  }
  const files = sel => $$(sel, root).filter(x => x._file);
  function changed() {
    const slots = $$('.ref', imgsEl), imgs = slots.filter(r => r._file);
    slots.forEach((r, i) => {
      const tag = $('.tag', r), cn = $('.cnt', r);
      if (cn) cn.textContent = `${i + 1}/${slots.length}`;
      if (tag) tag.textContent = `Picture ${i + 1}`;   // the number of the place, the same always
    });
    const nv = vidsEl ? files('.rm-vids .slot').length : 0, na = files('.rm-auds .slot').length;
    const total = imgs.length + nv + na;
    $('.rm-count', root).textContent = `${total} / 12`;
    if (cfg.scenes && root._save && !root._restoring) root._save();
    $('.rm-count', root).style.color = total > 12 ? 'var(--pink)' : '';
    // all places are listed from the start; a chip wakes up when its place gets a photo
    $('.rm-tokens', root).innerHTML = slots.map((r, i) => `<button class="token" type="button" data-slot="${i}"${r._file ? '' : ' disabled'} title="${r._file ? 'Вставить в текст сцены' : 'В это место ещё не загружено фото - плашка оживёт, когда оно появится'}">&lt;Picture ${i + 1}&gt;</button>`).join('')
      // the audio chips belong to the same row. They used to stand AFTER the semicolon, which made the
      // second line a separate statement that threw its result away - so the audio chip never appeared
      // anywhere, in any mode, and no syntax check could see anything wrong with it.
      + $$('.rm-auds .slot', root).map((s, i) => s._file
        ? `<button class="token tok-aud" type="button" data-audio="${i + 1}" title="&lt;Audio ${i + 1}&gt; - ссылка на это аудио: вставьте тег туда, где звук должен пригодиться">&lt;Audio ${i + 1}&gt;</button>`
        : '').join('')
      + $$('.rm-vids .slot', root).map((s, i) => s._file
        ? `<button class="token tok-vid" type="button" data-video="${i + 1}" title="&lt;Video ${i + 1}&gt; - ссылка на это видео: модель возьмёт из него движение">&lt;Video ${i + 1}&gt;</button>`
        : '').join('');
    $$('.sc', root).forEach(x => x._counter?.());   // after the row was rebuilt, or the lock it puts on the chips is wiped
    if (cfg.swap) { const w2 = $('.rm-who[data-i="1"]', root); if (w2) w2.hidden = imgs.length < 2; }
    if (cfg.swap && S.autoLen !== false) { const v = files('.rm-vids .slot')[0]; if (v && v._dur) { S.dur = Math.min(15, Math.max(3, Math.round(v._dur))); root._upd?.(); } }
    const tooLong = !cfg.scenes && [...files('.rm-vids .slot'), ...files('.rm-auds .slot')].some(s => s._dur > 15);
    if (tooLong) toast('Референс-видео и аудио — до 15 секунд');
  }
    // the row is rebuilt on every recount, so a listener put on the row itself dies with it:
    // we listen on its parent, which never gets rewritten, and the audio tag inserts without
    // touching the picture places
    const footEl = $('.rm-tokens', root).closest('.ta-foot') || $('.rm-tokens', root).parentNode;
    footEl.addEventListener('click', e => {
      const b = e.target.closest && (e.target.closest('[data-audio]') || e.target.closest('[data-video]'));
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const own = (root._ta && root._ta.closest && root._ta.closest('.sc')) || $$('.sc', root)[root._sel] || $$('.sc', root).find(x => x.offsetParent !== null);
      const box = (own && $('textarea', own)) || promptEl();
      if (!box) { toast('Откройте сцену, куда вставить тег'); return; }
      const at = box.selectionStart == null ? box.value.length : box.selectionStart;
      const isVid = b.dataset.video != null;
      const an = +(isVid ? b.dataset.video : b.dataset.audio) || 1;
      const tag = '<' + (isVid ? 'Video' : 'Audio') + ' ' + an + '> ';   // the chip carries its own number
      box.value = box.value.slice(0, at) + tag + box.value.slice(box.selectionEnd || at);
      box.focus(); box.selectionStart = box.selectionEnd = at + tag.length;
      box.dispatchEvent(new Event('input'));
      if (root._save) root._save();
      toast(isVid ? 'Тег <Video ' + an + '> вставлен: модель возьмёт движение из этого видео'
        : 'Тег <Audio ' + an + '> вставлен: звук применится там, где его тег назван в тексте');
    }, true);
    $('.rm-tokens', root).onclick = e => {
    const t = e.target.closest('.token'); if (!t) return;
    if (t.disabled) { toast('В это место ещё не загружено фото'); return; }
    const sc = (root._ta && root._ta.closest && root._ta.closest('.sc')) || $$('.sc', root)[root._sel] || $$('.sc', root).find(x => x.offsetParent !== null);
    if (root._free && !root._free(+t.textContent.replace(/\D+/g, ''), sc)) return;
    const ta = cfg.scenes && root._ta && root._ta.isConnected ? root._ta : promptEl(), p = ta.selectionStart, txt = t.textContent + ' ';
    ta.value = ta.value.slice(0, p) + txt + ta.value.slice(ta.selectionEnd); ta.focus(); ta.selectionStart = ta.selectionEnd = p + txt.length;
    $$('.sc', root).forEach(x => x._counter?.());   // the common pictures count from the first click, not from the first scene photo
  };
  changed();

  /* the sharpness slider keeps its own value between sessions and paints its number */
  (function () {
    const sl = $('#usSharp', root), out = $('#usSharpV', root);
    if (!sl) return;
    const set = v => { sl.value = v; if (out) out.textContent = v; };
    const saved = localStorage.getItem('h3-usarp');
    if (saved) set(Math.max(1, Math.min(6, +saved || 2)));
    sl.addEventListener('input', () => { if (out) out.textContent = sl.value; localStorage.setItem('h3-usarp', sl.value); changed(); });
  })();

  const prev = previewPanel($('.rm-preview', root), S, {
    singleScene: () => cfg.scenes && root._mode === 'parts' && root._chainPart == null,
    goLabel: () => !cfg.scenes ? 'Сгенерировать' : root._mode === 'parts'
      ? `Сделать сцену ${root._sel + 1}` : 'Сгенерировать видеоролик',   // the number follows the scene you picked
    extraLabel: cfg.mode === 'refs' || cfg.mode === 'actor' || cfg.swap || cfg.scenes ? 'Шаги' : 'Схема',
    extra: () => cfg.scenes ? (root._paintQ?.(), root._mode === 'parts' ? (root._q === 'draft' ? '4 шага · черновик' : (cfg.mode === 'actionsc' ? '8 + 4 шага · гибрид' : '8 шагов · Pika')) : (root._q === 'draft' ? '4 шага · черновик' : '8 шагов · Pika')) : cfg.mode === 'actor' || cfg.swap ? '10 · 1 проход' : cfg.mode === 'refs' ? `${S.steps} · 1 проход` : (S.faithful ? 'точная копия' : '8 + 4 шага'),
    passes: () => cfg.scenes ? $$('.sc', root).map(() => root._q === 'draft' ? 4 : 8) : cfg.mode === 'actor' || cfg.swap ? [10] : cfg.mode === 'refs' ? [S.steps] : S.faithful ? [13] : [8, 4],
    get twoPass() { return (cfg.mode === 'action' || cfg.mode === 'actionsc') && !S.faithful; },
    target: () => $('.ref img', imgsEl),
    meta: () => ({ mode: cfg.mode, prompt: promptEl().value.trim(), sub: '' }),
    onDone: item => { addToLib(item); if (cfg.scenes && item.long && root._partDone) root._partDone(item); },
    /* панель предпросмотра собирает предмет сама (режим, промпт, размер) и не знает ни id файла,
     ни метки сцены - по ней ленту заполнять нельзя, это делает рассылка о готовом задании */
    validate: () => cfg.swap ? (!files('.rm-vids .slot').length ? 'Добавьте видео, в котором нужно заменить человека' : !$$('.ref.filled', imgsEl).length ? 'Добавьте изображение нового персонажа' : '')
      : !cfg.scenes && !$$('.ref.filled', imgsEl).length && !(vidsEl && files('.rm-vids .slot').length) ? 'Добавьте хотя бы одно референс-изображение'
      : $$('.ref.filled', imgsEl).length + (vidsEl ? files('.rm-vids .slot').length : 0) + files('.rm-auds .slot').length > 12 ? 'Всего не больше 12 референсов'
      /* Показатель своего звука - сам файл: переключателя «без аудио» в интерфейсе
         больше нет. Флаг мог остаться «свой звук» после очистки файлов или возврата
         проекта, и кнопка требовала аудио, которое включить негде, - тупик. Здесь флаг
         догоняет файлы: нет файла - ролик без своего звука, модель озвучит его сама по
         описаниям сцен, и запуск проходит дальше. */
      : cfg.scenes ? ((root._snd === 'own' && !files('.rm-auds .slot').length && (root._snd = 'none', toast('Аудиофайла нет - ролик будет без своего звука: модель озвучит его сама по описаниям сцен'), ($('.lm-sndstate', root) || {}).textContent = HINT.none())) ? '' : sceneList().some(x => !x.prompt) ? 'Заполните описание каждой сцены или уберите лишнюю' : '') : !promptEl().value.trim() ? 'Напишите промпт' : '',
    real: {
      url: '/api/generate/' + cfg.mode,
      form: () => {
        const fd = new FormData();
        {
        const base = cfg.swap ? ($('.rm-who[data-i="0"]', root).value.trim() || 'замена персонажа') : promptEl().value.trim();
        fd.append('prompt', cfg.scenes ? base : wordsIntoPrompt(base, files('.rm-auds .slot').map(s => s && s._file)));
      }
        fd.append('note', ownWords(promptEl()));       // our own words: the repeat puts these back, not the composed text
        if (cfg.swap) {
          const own = promptEl().value.trim();   // the user's own prompt is used as it is, in one pass; empty: the program writes it (and swaps shot by shot)
          if (own) fd.append('raw_prompt', own);
          $$('.rm-who', root).forEach(w => fd.append('who' + w.dataset.i, w.value.trim()));
          const vd = (files('.rm-vids .slot')[0] || {})._dur || 0, nImg = $$('.ref.filled', imgsEl).length;
          const cuts = own ? [] : ($('.sw-cuts', root).value || '').split(/[;,\s]+/).map(Number).filter(x => x > 0.5 && vd && x < vd - 0.5).sort((a, b) => a - b);
          if (cuts.length && vd) {   // each plan is swapped on its own: plan k gets picture k (the last picture if there are fewer)
            let bounds = [0, ...cuts, vd], parts = [];
            for (let i = 0; i < bounds.length - 1; i++) {
              if (parts.length && bounds[i + 1] - bounds[i] < 2) parts[parts.length - 1].e = bounds[i + 1]; else parts.push({ s: bounds[i], e: bounds[i + 1] });
            }
            if (parts.length > 1) {
              const whos = $$('.rm-who', root).map(w => w.value.trim());
              const ae = S.sound === 'lock' ? parseFloat(($('.sw-aend', root).value || '').replace(',', '.')) : NaN;
              fd.append('shots', JSON.stringify(parts.map((p, k) => { const o = { s: p.s, e: p.e, pic: Math.min(k, nImg - 1), who: whos[Math.min(k, nImg - 1)] || whos[0] || '' }; if (k === 0 && ae > 0 && ae < p.e - p.s) o.a_end = ae; return o; })));
            }
          }
        }
        sizeForm(S, fd); fd.append('aspect', S.aspect); fd.append('quality', S.q); fd.append('duration', S.dur);
        fd.append('steps', S.steps); fd.append('ref_size', S.refSize); if (cfg.mode === 'refs' || cfg.swap) fd.append('accel', S.accel);
        if (cfg.swap) { fd.append('sound', S.sound); fd.append('small_ref', S.smallRef ? '1' : '0'); }
        if (cfg.mode === 'action' || cfg.mode === 'actionsc') {
          const us = $('#usSharp', root);
          fd.append('usarp', String(us ? +us.value : 2));
        }
        if (cfg.scenes && root._mode === 'parts') {
          const all = $$('.sc', root);
          if (root._target == null) root._chainPart = null;   // the big button alone makes one scene, never a chain
          let k = root._target; root._target = null;
          const tst = root._test; root._test = null;
          if (k == null) k = root._ready();
          if (k >= all.length) throw new Error('Все сцены уже сделаны. Чтобы переделать одну, нажмите «Переделать» в её карточке.');
          if (!tst && !root._canGo(k)) throw new Error(`Сначала сделайте сцену ${k}: эта продолжает её конец. Или отметьте у сцены «Сменить план здесь».`);
          fd.append('part', k); fd.append('run', root._run); if (root._q === 'draft' && !tst) fd.append('draft', '1'); fd.append('variant', String(all[k]._var || 0));
          if (tst) { fd.set('quality', tst.q); fd.delete('width'); fd.delete('height'); fd.append('test', '1'); }   // a size test: the scene alone, in the chosen size
          else {
            if (root._src) { fd.append('src_project', '1'); if (k === 0) { if (root._src.id) fd.append('src_item', root._src.id); else if (root._src.file) fd.append('srcvid', root._src.file); } }
            root._pending = { k, sig: root._sig(all[k]) };
            (root._sent = root._sent || {})[k] = root._pending.sig; (root._sentText = root._sentText || {})[k] = $('textarea', all[k]).value;
          }
        }
        if (cfg.scenes && root._mode !== 'parts') { fd.append('run', root._run); if (root._q === 'draft') fd.append('draft', '1'); }
        try { if (!root._restoring) agRefWarn(cfg.mode, 'Перед генерацией: '); } catch (e) { }
        if (cfg.scenes) {
          /* The server numbers a scene's media by the decade of its PLACE, so what leaves the app is
             not what stands on the card: the cards keep the scene's own numbers, the text gets the
             numbers of the places. The person sees his numbers, the model gets the right files. */
          const sCards = $$('.sc', root);
          const sPlans = sCards.map((c, i) => sceneAudioPlan(c, root._fauds || [], 10 * (i + 1)));
          /* The song's words only reach the model if they stand in the scene's text: the reference
             audio carries a voice, not a lyric. If the Agent dropped them, the program puts the heard
             words into the line it sends and says so out loud - a person must never guess that his
             song went in silent and the model sang something of its own. */
          try {
            sCards.forEach((c, i) => {
              const pl = sPlans[i]; if (!pl) return;
              const add = [], tags = [];
              const bs = c._baseFixed || 10 * (i + 1);
              (c._auds || []).forEach((f, j) => {
                if (!f) return;
                const words = agWordsFor(c, j); if (!words) return;
                const probe = words.slice(0, 24).toLowerCase();
                const x = agWords(f, i + 1) || {};
                if ((pl.text || '').toLowerCase().indexOf(probe) < 0) add.push('<d>[' + (x.lang || 'язык аудио') + '] ' + words + '</d>');
                tags.push('<Audio ' + (bs + j) + '>');
              });
              if (add.length || tags.length) {
                /* Order matters, and getting it wrong destroyed the lyric: the music field reaches to
                   the end of its line, so writing the sung line onto that same line made the rewrite
                   swallow the words. Fix the field first, then put the sung line on lines of its own. */
                if (tags.length) pl.text = (pl.text || '').replace(/non_diegetic_music\s*:\s*(?:N\/A|[^\n]*)/i, 'non_diegetic_music: ' + tags.join(' ') + ' (the reference audio of this scene)');
                if (add.length) pl.text = (String(pl.text || '').trim() ? String(pl.text).trim() + '\n' : '') + add.join('\n');
                pl.text = pl.text.trim();
                if (add.length) toast('Сцена ' + (i + 1) + ': в текст для модели добавлены слова её песни (' + add.join(' · ').slice(0, 70) + '…)');
              }
            });
          } catch (e) { }
          fd.append('scenes', JSON.stringify(sceneList().map((x, i) => Object.assign({}, x, { prompt: (sPlans[i] || {}).text || x.prompt }))));
          sCards.forEach((c, i) => c._files.forEach((f, j) => { if (f) fd.append(`simg${i}_${j}`, f); }));
          sCards.forEach((c, i) => {
            const plan = sPlans[i];
            plan.files.forEach((f, j) => { if (f) fd.append(`saudio${i}_${j}`, f); });
            if (plan.rewritten && root._sentText) root._sentText[i] = plan.text;   // the model gets the numbers of the places
            if (plan.lostPics && plan.lostPics.length) toast('Сцена ' + (i + 1) + ': под тегами ' + plan.lostPics.map(t => '<Picture ' + t + '>').join(', ')
              + ' в этой сцене нет фото - они убраны из текста, чтобы модель не рисовала наугад');
            if (plan.dropped && plan.dropped.length) toast('Сцена ' + (i + 1) + ': модель слушает три аудио, поэтому ' + plan.dropped.map(t => '<Audio ' + t + '>').join(', ') + ' в этот раз не пойдёт - уберите лишний тег или замените его');
          }); fd.append('start', $('.lm-start', root).value || '0'); if (root._loop !== false) fd.append('music_loop', '1'); if (root._adur) fd.append('audio_dur', String(Math.round(root._adur * 1000) / 1000)); fd.append('vocals', root._snd === 'own' && $('.lm-vocals', root).checked ? '1' : '0'); fd.append('bed_db', $('.lm-beddb', root).value); fd.append('bed_norm', $('.lm-bednorm', root).checked ? '1' : '0'); if (cfg.mode === 'actionsc') loraForm(S, fd); }
        else loraForm(S, fd);
        seedForm(S, fd);
        /* The scene studios read the reference files BY PLACE: the server takes img0, img1, img2…
           one per slot and leaves the holes alone, exactly so that «<Picture 3>» keeps meaning the
           third slot. Sending the filled pictures as a tight row shifted every later photo onto a
           smaller number, and the model was handed another man, another woman and no fox at all.
           The other sections still count their references densely, so they keep the old way. */
        if (cfg.scenes) $$('.ref', imgsEl).forEach((r, i) => { if (r._file) fd.append('img' + i, r._file); });
        else $$('.ref', imgsEl).filter(r => r._file).forEach((r, i) => fd.append('img' + i, r._file));
        // кадры начала и конца уходят отдельными полями first и last, как в режиме «Видео»;
        // если картинка не выбрана, поля в запросе нет
        framePlates.forEach(r => { if (r._file) fd.append(r._frameKey, r._file); });
        if (cfg.scenes && root._srcFrameFile) fd.append('srcframe', root._srcFrameFile);   // the frame of the continued video: a picture of its own
        if (vidsEl) files('.rm-vids .slot').forEach((s, i) => fd.append('vid' + i, s._file));
        (cfg.scenes && root._snd !== 'own' ? [] : files('.rm-auds .slot')).forEach((s, i) => fd.append('aud' + i, s._file));
        return fd;
      },
    },
  });
  onScenes = () => prev();
  const STEPS_HINT = {
    4: 'Быстро, но без запаса: в речи могут теряться слова. Для простых сцен — разговор, ходьба, предмет в руках.',
    6: 'Золотая середина: разговор на камеру, ходьба, медленные движения.',
    8: 'Высокая динамика: танцы, свободные взмахи руками, толпы, дождь, листва на фоне.',
  };
  const extraRow = cfg.swap ? `<div class="row"><div class="row-l">Скорость и качество</div>
      <div class="seg rm-acc" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-x="pika">Pika Flex<small>8 шагов, рекомендуется</small></button><button data-x="old">Прежнее<small>другое ускорение</small></button></div>
      <div class="hint rm-acc-hint"></div></div>
    <div class="row"><div class="row-l">Звук и губы</div>
      <div class="seg sw-snd" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) 1fr"><button data-v="original">Звук видео<small>основной вариант</small></button><button data-v="lock">Подгонка губ<small>пробный, может сломать замену</small></button><button data-v="model">Звук модели<small>если в видео нет звука</small></button></div>
      <div class="hint sw-snd-hint"></div>
      <div class="sw-aend-row" hidden style="margin-top:8px"><label style="font-size:12.5px">Где первый герой замолкает, секунды <input class="sw-aend" inputmode="decimal" placeholder="например 1.75" style="width:110px"></label>
        <div class="hint">Только для «Подгонки губ» при смене плана: до этой секунды говорит первый герой, дальше он молчит и рот закрыт. Оставьте пустым, если не знаете.</div></div></div>
    <div class="row"><label class="cw-chk" style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="sw-small" checked> Уменьшать загруженное видео до размера результата (быстрее)</label>
      <div class="hint">Быстрее, на результат почти не влияет.</div></div>
    <div class="rm-loras"></div>
    <div class="row"><label class="cw-chk" style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="sw-auto" checked> Длина как у загруженного видео</label>
      <div class="hint">Выключите, чтобы задать длину ползунком ниже.</div></div>
    <div class="note warn rm-swapneed" hidden><span>Для этого пресета нужен маленький файл (0,16 ГБ). <button class="btn mini pri" type="button" id="swapGet">Скачать</button></span></div>`
    : cfg.mode === 'refs' ? `
    <div class="row"><div class="row-l">Ускорение</div>
      <div class="seg rm-acc" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-x="pika">Pika Flex<small>8 шагов, лучше звук</small></button><button data-x="old">Прежнее<small>4–8 шагов</small></button></div>
      <div class="hint rm-acc-hint"></div></div>
    <div class="row"><div class="row-l">Шаги</div>
      <div class="seg rm-steps" style="grid-template-columns:repeat(3,1fr)">
        <button data-s="4">4<small>быстро</small></button><button data-s="6">6 <small>баланс</small></button><button data-s="8">8<small>динамика</small></button>
      </div><div class="hint rm-steps-hint"></div></div>
    <div class="row"><div class="row-l">Точность переноса с изображений</div>
      <div class="seg rm-rs" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-r="match">Быстро<small>изображения уменьшаются</small></button><button data-r="max">Максимум<small>лучшее сходство</small></button></div>
      <div class="hint rm-rs-hint"></div></div>
    <div class="rm-loras"></div>`
    : cfg.mode === 'actionsc' ? `<div class="row"><div class="row-l">Как запускается</div><div class="status-box rm-act"><span class="hint">Проверяем ComfyUI…</span></div></div>
    <div class="rm-loras"></div>`
    : cfg.scenes ? `<details class="agvar" open><summary>Как работает</summary><div class="hint" style="font-size:12.5px;line-height:1.55">
      <b>1.</b> Загрузите изображения героя и места (необязательно: можно только текстом). <b>2.</b> Выберите формат и размер. <b>3.</b> Добавьте сцены: нажмите «+» на ленте, напишите, что происходит. Длину сцены меняйте, потянув правый край блока на ленте. У каждой сцены можно загрузить свои изображения, иначе берутся общие.<br>
      <b>Черновик</b> считается быстро (4 шага, меньший размер): так видно, что получится. Когда всё нравится, нажмите «Сделать всё в хорошем качестве»: сцены пересчитаются с теми же текстами, детали станут лучше. Одну сцену можно переделать отдельно кнопкой «Переделать».<br>
      Каждая следующая сцена по умолчанию продолжает конец прошлой, но при долгой цепочке изображение портится, поэтому смену плана программа ставит сама (знак ✂ на ленте). Ориентир по времени: около минуты расчёта на секунду на RTX 4060 Ti 16 ГБ.</div></details>`
    : cfg.mode === 'actor' ? `<details class="agvar"><summary>Как работает</summary><div class="hint" style="font-size:12.5px;line-height:1.5">Один проход, 10 шагов — настройки из вашего workflow «Direct AI Actor» (ER-SDE, разреженное внимание). Первое изображение — стартовый кадр. Голос берётся из загруженного аудио только как тембр, а слова — те, что вы напишете в промпте в &lt;d&gt;[Язык] …&lt;/d&gt;.</div></details>
    <div class="rm-loras"></div>`
    : `<div class="row"><div class="row-l">Как запускается</div><div class="status-box rm-act"><span class="hint">Проверяем ComfyUI…</span></div></div>
    <div class="rm-loras"></div>`;
  const upd = paramsCard($('.rm-params', root), S, {
    n: cfg.scenes ? 2 : 3, duration: !cfg.scenes,
    extraRow: (cfg.mode === 'action' || cfg.mode === 'actionsc' ? `
      <div class="row">
        <div class="row-l">Резкость второго прохода <b id="usSharpV">2</b></div>
        <input type="range" id="usSharp" min="1" max="6" step="1" value="2">
        <div class="ticks"><span>1 точнее</span><span>3</span><span>6 детали</span></div>
        <div class="hint">Работает, пока во втором проходе стоит 2D-апскейлер (он выбран по умолчанию):
          1 — ближе к оригиналу, 6 — больше деталей, но дальше от исходной картинки.</div>
      </div>` : '') + extraRow,
    onChange: () => {
      prev();
      $$('.rm-steps button', root).forEach(b => b.classList.toggle('on', +b.dataset.s === S.steps));
      $$('.rm-rs button', root).forEach(b => b.classList.toggle('on', b.dataset.r === S.refSize));
      const h = $('.rm-steps-hint', root); if (h) h.textContent = STEPS_HINT[S.steps];
      const rh = $('.rm-rs-hint', root); if (rh) rh.textContent = REF_HINT[S.refSize];
      if (cfg.swap) { const d = $('.dur', root); if (d) { d.max = 15; d.disabled = S.autoLen !== false; } root._paintSnd && root._paintSnd(); }
      $$('.rm-acc button', root).forEach(b => b.classList.toggle('on', b.dataset.x === S.accel));
      const ah = $('.rm-acc-hint', root); if (ah) ah.textContent = S.accel === 'pika'
        ? 'Pika H3 Flex Turbo: звук получается заметно лучше. Работает на 6–8 шагах (4 шага для неё поднимутся до 6).' + (S.pikaHave === false ? ' Файла Pika нет — скачайте его в разделе «Настройки».' : '')
        : 'Прежнее ускорение (LoRA на 4 шага): быстрее, но звук проще.';
    },
  });
  root._upd = upd;
  if (cfg.swap) {
    S.sound = 'original'; S.smallRef = true;
    const SND_HINT = { lock: 'Пробный режим: модель рисует рот под звук вашего видео, голоса остаются на своих героях. Но при двух героях и смене плана вторая замена может не получиться. Нужен звук в видео.',
      original: 'Основной вариант: в результат кладётся звук вашего видео, а замена героев работает надёжнее. Губы модель рисует сама, поэтому они могут не попадать в слова.',
      model: 'Звук придумает модель. Выберите, если в вашем видео нет звука.' };
    const paintSnd = () => { $('.sw-aend-row', root).hidden = S.sound !== 'lock'; $$('.sw-snd button', root).forEach(b => b.classList.toggle('on', b.dataset.v === S.sound)); $('.sw-snd-hint', root).textContent = SND_HINT[S.sound]; };
    $('.sw-snd', root).onclick = e => { const b = e.target.closest('button'); if (b) { S.sound = b.dataset.v; paintSnd(); } };
    $('.sw-small', root).onchange = e => { S.smallRef = e.target.checked; };
    $('.sw-auto', root).onchange = e => { S.autoLen = e.target.checked; changed(); upd(); };
    paintSnd(); root._paintSnd = paintSnd;
    mountLoras($('.rm-loras', root), S, ['realism', 'motion']);
    S.loras.realism.on = false; S.loras.motion.on = false; S._paintLoras && S._paintLoras();
  }
  $('.rm-params', root).addEventListener('click', e => {
    const s = e.target.closest('.rm-steps button'); if (s) { S.steps = +s.dataset.s; upd(); }
    const r = e.target.closest('.rm-rs button'); if (r) { S.refSize = r.dataset.r; upd(); }
    const x = e.target.closest('.rm-acc button'); if (x) { S.accel = x.dataset.x; if (S.accel === 'pika' && S.steps < 6) S.steps = 8; upd(); }
  });
  upd();
  if (cfg.mode === 'refs') mountLoras($('.rm-loras', root), S, ['realism', 'motion']);
  if ((cfg.mode === 'refs' || cfg.swap) && API) fetch('/api/status').then(r => r.json()).then(st => {  // Pika is the default when its file is there
    const m = (st.models || []).find(x => x.role === 'pika_lora'); S.pikaHave = !!(m && m.have);
    if (S.pikaHave) { S.accel = 'pika'; S.steps = 8; }
    upd();
  }).catch(() => {});
  if (cfg.mode === 'actor') { S.loras = { realism: { on: true, v: .7 } }; mountLoras($('.rm-loras', root), S, ['realism']); }

  if ((cfg.mode === 'action' || cfg.mode === 'actionsc') && API) {
    const box = $('.rm-act', root);
    const check = async () => {
      try {
        const a = await (await fetch('/api/action/info')).json();
        S.faithful = a.faithful; upd();
        // only the LoRAs this ComfyUI actually has can be switched and tuned
        mountLoras($('.rm-loras', root), S, [...(a.dmad ? ['dmad'] : []), ...(a.speed ? ['speed'] : [])]);
        const row = (ok, t) => `<div class="${ok ? 'ok-t' : 'warn-t'}">${ok ? '' : '—'} ${t}</div>`;
        box.innerHTML = (a.faithful ? '<b class="ok-t">Точная копия вашего workflow</b> <span class="hint">· со второй сцены продолжение идёт обычной схемой: нода точного режима не умеет принимать маску продолжения</span>' : '<b class="warn-t">Упрощённая схема (то же 8 + 4 шага)</b>')
          + row(a.selflift, 'SelfLift сэмплер (8 шагов в низком разрешении + 4 в высоком)')
          + row(a.refiner, 'H3 Sigma Refiner (+1 финальный шаг)')
          + row(a.upscaler, 'апскейлер h3_upscaler_lms')
          + row(!!a.dmad, 'LoRA DMAD') + row(!!a.speed, 'LoRA Speed Slider')
          + (a.faithful ? '' : '<span class="hint">Чего нет — заменяется ближайшим: обычный двухпроходный сэмплинг с тем же графиком 8 + 4. Установите недостающее в ComfyUI, и приложение само переключится на точную копию.</span>');
      } catch { box.innerHTML = '<span class="hint">ComfyUI не отвечает</span>'; }
    };
    onNav(cfg.mode, check);
    check();
  }
  /* Every group of files this mode holds gets the same button in the heading above it: «Всё к сценаристу».
     One action everywhere - only the icon says what is being sent. The Agent is filled, never
     restarted: whatever a person has typed and whichever «Промт для» they chose stay as they are. */
  const agHeadBtn = (host, icon, what) => {
    if (!host) return null;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn mini agall-h';
    b.textContent = icon + ' Всё к сценаристу';
    b.title = 'Сложить в чат сценариста ' + what + ' - он допишет к тому, что уже лежит, и ничего не очистит';
    b.addEventListener('click', e => e.stopPropagation());   // a press here must not fold the card
    host.append(b);
    return b;
  };
  // a button with nothing to take is a dead button: it lies grey until a file appears
  const agCount = (btn, fn) => { btn._agCount = fn; btn.dataset.agKind = '1'; return btn; };
  const agSay = (what, added, again, tail) => {
    toast(added ? ('В чат сценариста добавлено ' + what + ': ' + added + (again ? ' · ' + again + ' уже лежало' : '') + (tail || ''))
                : ('Всё это ' + what + ' уже лежит в чате сценариста' + (tail || '')));
  };

  // ···· images: the common places, and in the studios also every scene's own places
  const imgBtn = agHeadBtn($('.card-h', $('.rm-imgs', root).closest('.card')), '🖼',
    'все изображения - и общие, и те, что лежат в отдельных сценах');
  if (imgBtn) agCount(imgBtn, () => $$('label.ref', imgsEl).filter(r => r._file).length
    + $$('.sc', root).reduce((z, cc) => z + ((cc._files || []).filter(Boolean).length), 0)
    + (cfg.videos && cfg.swap ? $$('.slot', vidsEl).filter(s => s._src || s._file).length : 0));
  if (imgBtn) imgBtn.onclick = async () => {
    const want = [];
    // the number of a tag is the place the picture stands in, not its rank among the filled ones
    $$('label.ref', imgsEl).forEach((r, j) => { if (r._file) want.push({ f: r._file, note: 'общий референс, тег <Picture ' + (j + 1) + '>' }); });
    $$('.sc', root).forEach((cc, i) => (cc._files || []).forEach((f, j) => { if (f) want.push({ f, note: 'сцена ' + (i + 1) + ', своё фото, тег <Picture ' + ((cc._baseFixed || cc._base || 10 * (i + 1)) + j) + '>' }); }));
    // in «Замена» the video stands in the same row as the pictures and has no heading of its own, so
    // this button takes it too; elsewhere the video has its own button and must not be doubled
    if (cfg.videos && cfg.swap) $$('.slot', vidsEl).forEach((s, j) => { const f = s._src || s._file; if (f) want.push({ f, vid: true, note: 'видео, в котором меняем, тег <Video ' + (j + 1) + '>' }); });
    if (!want.length) { toast('Изображений нет - сначала добавьте их'); return; }
    // whatever goes into the chat, the Agent writes for the section the person pressed the button in
    const moved = agPickTarget(cfg.mode);
    let added = 0, again = 0, own = 0;
    try {
      for (const it of want) {
        if (it.vid) { if (AG.att.some(a => a.frame && a.vname === it.f.name)) { again++; continue; } if (await agAttachFile(it.f)) added++; else again++; continue; }
        if (AG.att.some(a => a.file && a.file.name === it.f.name && a.file.size === it.f.size && (a.note || '') === (it.note || ''))) { again++; continue; }
        await agAttachFile(it.f, it.note); added++;
        if (it.note.startsWith('сцена')) own++;
      }
      agGo();
      const common = added - own;
      toast(added ? ('В чат сценариста добавлено изображений: ' + added
          + (common && own ? ' (общих ' + common + ', из сцен ' + own + ')' : own ? ' (все из сцен)' : '')
          + (again ? ' · ' + again + ' уже лежало' : '') + moved)
          : 'Все эти изображения уже лежат в чате сценариста' + moved);
    } catch { toast('Не удалось передать изображения сценаристу'); }
  };

  // ···· reference videos: the Agent receives them as frames, which is how a video reaches the model
  if (cfg.videos && !cfg.swap) {
    const vb = $('.rm-vids', root);
    const vidBtn = (vb && !vb.closest('.ra-tiles')) ? agHeadBtn($('.sub-l', vb.parentElement), '🎞',
      'референс-видео - модель получит их кадрами') : null;
    if (vidBtn) agCount(vidBtn, () => $$('.slot', vidsEl).filter(s => s._src || s._file).length);
    if (vidBtn) vidBtn.onclick = async () => {
      const list = $$('.slot', vb).map(s => s._src || s._file).filter(Boolean);
      if (!list.length) { toast('Референс-видео нет - сначала добавьте его'); return; }
      const moved = agPickTarget(cfg.mode);
      let added = 0, again = 0;
      try {
        for (const f of list) {
          if (AG.att.some(a => a.frame && a.vname === f.name)) { again++; continue; }
          if (await agAttachFile(f)) added++;
        }
        agGo();
        agSay('видео (кадрами)', added, again, moved);
      } catch (err) { toast('Не удалось передать видео сценаристу: ' + (err && err.message ? err.message : '')); }
    };
  }

  // ···· reference audio (the studios have their own audio card and its button)
  if (!cfg.scenes) {
    const ab = $('.rm-auds', root);
    const audBtn = (ab && !ab.closest('.ra-tiles')) ? agHeadBtn($('.sub-l', ab.parentElement), '🎧',
      'весь референс-аудио: Сценарист распознает слова и вставит их в промпт') : null;
    if (audBtn) agCount(audBtn, () => $$('.slot', audsEl).filter(s => s._file).length);
    if (audBtn) audBtn.onclick = async () => {
      const list = $$('.slot', ab).map(s => s._file).filter(Boolean);
      if (!list.length) { toast('Референс-аудио нет - сначала добавьте его'); return; }
      if (await speechReady()) return;
      let added = 0, again = 0;
      for (let j = 0; j < list.length; j++) {
        const f = list[j];
        try {
          const ac = setActx();
          const buf = await ac.decodeAudioData(await f.arrayBuffer());
          const e = Math.min(buf.duration, 15);
          const where = 'референс-аудио ' + (j + 1) + ', тег <Audio ' + (j + 1) + '>'
            + (buf.duration > 15 ? ' (берём первые 15 с)' : '');
          if (await setChatAudio(wavSlice(buf, 0, e), f.name, e, where)) added++; else again++;
        } catch (err) { toast('Не удалось передать «' + f.name + '»: ' + (err && err.message ? err.message : '')); }
      }
      const moved = agPickTarget(cfg.mode);
      agGo();
      agSay('аудио', added, again, moved);
    };
  }

  // ···· the prompt card: a way in that also chooses what the Agent is writing for
  {
    const pe = $('.rm-prompt', root) || $('.lm-scenes', root) || (cfg.scenes ? $('.sc textarea', root) : null);
    const pcard = pe && pe.closest('.card');
    if (pcard) {
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'btn mini agall-h';
      // the draft leaves the mode whole, tags and all, and the finished text is expected back here
      if (cfg.scenes) {
    // the same one-click round trip the single field has, but for the whole sheet at once
    const gg = document.createElement('button');
    gg.className = 'btn mini agall-h';
    gg.textContent = '🤖 Сценарист перепишет сцены';
    gg.title = 'Отправить все сцены сценаристу одним сообщением: он перепишет их, и каждая вернётся в свою карточку. Фото и песни сцен остаются на местах.';
    gg.onclick = () => agGenerate(gg, { mode: cfg.mode, scenes: true, text: () => agScenesText(root) });
    pcard.querySelector('.card-h').append(gg);
    gg._agCount = () => $$('.sc', root).filter(c => ($('textarea', c) || {}).value.trim()).length;
    /* After a run ComfyUI keeps its models in the card's memory - that is a cache, not a leak, but
       the agent's model needs the same gigabytes and answers «Остановлено» while they are held. */
    const fz = document.createElement('button');
    fz.type = 'button'; fz.className = 'btn mini';
    fz.textContent = 'Освободить память';
    fz.title = 'Остановить модель сценариста и сбросить кэш ComfyUI: пока память занята, вторая сторона не загружается и отвечает «Остановлено»';
    fz.onclick = () => window.kadrFreeMem(fz);
    pcard.querySelector('.card-h').append(fz);
  }
  go.textContent = cfg.scenes ? '🤖 Все тексты к сценаристу' : '🤖 Текст к сценаристу';
      go.title = cfg.scenes
        ? 'Перенести тексты всех сцен по порядку в чат сценариста и включить «Промт для: ' + cfg.title + '»; ответ вернётся в те же сцены'
        : 'Перенести текст раздела в чат сценариста целиком, с тегами, и включить «Промт для: ' + cfg.title + '»; ответ вернётся в это же поле';
      $('.card-h', pcard).append(go);
      go.onclick = () => agDraftOut(cfg.scenes ? agScenesText(root) : (pe ? pe.value : ''), cfg.mode,
        cfg.scenes ? 'тексты сцен' : 'черновик промпта');
    }
  }
  /* Раздел говорит сценаристу, где его окно сценария. В режиме с одним полем это оно, а в
     студии сцен - окно той сцены, на которой человек сейчас; если ни на какой - первой
     пустой сцены, а если все заполнены, последней. Сам сценарист про это не знает. */
  scenarioResolvers.set(cfg.mode, cfg.scenes
    ? () => {
      const list = $$('.sc', root).filter(c => c._win);
      if (!list.length) return null;
      if (root._sel != null && list[root._sel]) return list[root._sel]._win;
      return (list.find(c => !c._win.value().trim()) || list[list.length - 1])._win;
    }
    : () => scWin);
  return { root, S, upd, voice: () => files('.rm-auds .slot').length, prompt: () => promptEl(), imgSlots: () => $$('.ref input', imgsEl) };
}
export const RM = {
  refs: makeRefMode({
    mode: 'refs', title: 'Видеостудия', pill: 'Singularity Ref2V · 1 проход', dur: 6, maxImages: 9, videos: true, frames: true,
    sub: 'Видео по изображениям, видео и аудио: персонаж, локация, движение, голос',
    refHint: 'Изображения — персонажи, локация, предметы (до 9). Видео задаёт движение или камеру, аудио — голос, ритм или атмосферу (всего до 12 файлов). В промпте ссылайтесь на изображения как &lt;Picture 1&gt;, &lt;Picture 2&gt;…',
    placeholder: '<Picture 1> идёт по ночной улице к камере, дождь, неон…',
  }),
  actor: makeRefMode({
    mode: 'actor', title: 'Актёр', pill: 'Singularity Ref2V · 10 шагов', dur: 14, maxImages: 3, videos: false,
    sub: 'Диалоги и крупные планы: актёрская игра, эмоции и голос по образцу — лучше всего для реализма',
    refHint: 'Первое изображение — стартовый кадр видео (его композиция сохранится). Аудио — образец голоса: из него берётся только тембр и манера, а слова произносятся новые, из вашего промпта. Нужны два голоса — запишите оба в одно аудио. Промпт удобно писать в разделе «Сценарист» (цель «Актёр»).',
    placeholder: '@image1 - keyframe, first frame of the target video… Лучше всего писать в «Сценаристе»: он знает формат этого режима',
  }),
  swap: makeRefMode({
    mode: 'swap', title: 'Замена', pill: 'Готовый пресет · Ref2V + LoRA замены', dur: 6, maxImages: 2, videos: true, swap: true,
    sub: 'Берём ваше видео и меняем в нём человека на своего персонажа',
    refHint: '<b>Важно:</b> видео до 15 секунд. Размер результата не больше 720p (1280×736), иначе очень долго. На изображении один герой и простой фон. Используйте лица людей только с их согласия.',
    placeholder: '',
  }),
  long: makeRefMode({
    mode: 'long', title: 'Киностудия', pill: 'Сцены подряд · Pika', dur: 20, maxImages: 5, videos: false, scenes: true,
    sub: 'Клипы и ролики по сценам: каждая сцена до 15 секунд и продолжает прошлую. Музыка — общая на ролик или своя в каждой сцене',
    refHint: 'До 5 изображений-референсов: персонаж, локация, предмет, одежда, стиль — всё, что должно сохраняться. Они подаются в каждую сцену, поэтому лицо и место не «плывут». В тексте сцены ссылайтесь на них как &lt;Picture 1&gt;, &lt;Picture 2&gt;… Чем больше референсов, тем тяжелее и дольше считается сцена.',
    placeholder: '',
  }),
  action: makeRefMode({
    mode: 'action', title: 'Экшн-видео', pill: 'Hybrid · 8 + 4 шага', dur: 8, maxImages: 6, videos: false,
    sub: 'Бой, погоня, бег, стрельба — динамичные сцены с вашими персонажами',
    refHint: 'До 6 изображений: персонажи и локация. До 3 аудио: голос, ритм или атмосфера (вместе с изображениями). В промпте: &lt;Picture 1&gt; или роли вида «@image1 - character reference».',
    placeholder: '@image1 - character reference. Девушка с @image1 убегает по ночному рынку, опрокидывает корзины…',
  }),
  actionsc: makeRefMode({
    mode: 'actionsc', title: 'Экшн-студия', pill: 'Гибрид · 8 + 4 шага · сцены подряд', dur: 10, maxImages: 5, videos: false, scenes: true,
    sub: 'Длинный экшн по сценам: каждая следующая продолжает прошлую, готовые клипы склеиваются в один ролик',
    refHint: 'До 5 изображений: персонажи, локация, предмет. В тексте сцены ссылайтесь на них &lt;Picture 1&gt;, &lt;Picture 2&gt; - программа сама поставит номера по местам. Звук модель делает сама, но им можно управлять: в карточке «Аудио» кладут фон на весь ролик (один файл) и до трёх аудио на каждую сцену — их номера идут десятками, и промпт решает, где какой слушать.',
    placeholder: '',
  }),
};

export async function swapCheck() {
  const have = await presetsHave(), n = $('.rm-swapneed', $('#view-swap')); if (n) n.hidden = have.swap_lora !== false;
}
$('#swapGet').addEventListener('click', () => mdStart(['swap_lora']));
onNav('presets', async () => { PR.tab = ''; presetsPaint(); });
presetsPaint();
if (typeof window !== 'undefined') window.h3SwapCheck = swapCheck;   // нужна tabs.goTo, когда кнопки нет
/* Общий хаб не импортирует разделы (иначе он исполнялся бы позже нас, и чтение
   общего состояния в нашем теле падало). О своих значениях сообщаем сами. */
registerViews({ L, RM, V, lTrim, lUpd, loadAudio, refsEl, syncSel, vUpd });
