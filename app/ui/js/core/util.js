import { postJSON } from './net.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
/* Номер места обязан совпадать с числами в тексте сцены: если плитка подписана «Pic 30», а в тексте
   стоит <Picture 20>, модель получает номер, под которым в этой сцене ничего не лежит, и картина
   человека в расчёт не входит. Номер правится по тексту сцены, когда он никем не занят. */
export function sceneReconcile(root) {
  const cs = $$('.sc', root);
  const decadeOf = c => {
    const n = [...String((($('textarea', c) || {}).value) || '').matchAll(/<(?:Picture|Audio)\s*(\d{2,})>/g)]
      .map(m => Math.floor(+m[1] / 10) * 10);
    return n.length ? Math.min(...n) : 0;
  };
  const held = new Set(cs.map(c => +c._baseFixed || 0));
  cs.forEach(c => {
    if (!((c._files || []).some(Boolean) || (c._auds || []).some(Boolean))) return;
    const want = decadeOf(c);
    if (!want || want === (+c._baseFixed || 0) || held.has(want)) return;
    held.delete(+c._baseFixed || 0); held.add(want);
    c._baseFixed = want; c._base = want;
    c._paint?.(); c._paintAuds?.();
  });
}

/* the blue part of a slider has to follow its handle, wherever that slider was built (the scene
   cards in the long mode are created later and never painted, so the fill stood still there) */
export const paintRange = r => {
  if (!r || r.type !== 'range') return;
  const min = +r.min || 0, max = +r.max || 100;
  if (max > min) r.style.setProperty('--p', ((+r.value - min) / (max - min) * 100) + '%');
};
document.addEventListener('input', e => { if (e.target && e.target.type === 'range') paintRange(e.target); }, true);
addEventListener('load', () => $$('input[type=range]').forEach(paintRange));
/* The mouse and the keys fire 'input', so a hand always saw the fill follow the handle. A program does
   not: assigning .value fires no event in a browser, and every slider moved by a button - the scale of
   the strip, the seconds of a scene, a value restored from a saved project - left its green part behind
   the knob. Rather than teaching each caller to remember the repaint, the property itself now repaints:
   one place, every slider, including the ones written tomorrow. */
(function () {
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (!d || !d.set) return;
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) { d.set.call(this, v); if (this.type === 'range' && typeof paintRange === 'function') paintRange(this); },
  });
})();

/* a wall of empty plates is noise: show the filled ones plus one free slot, the rest appear as they
   get filled (the long mode and references had up to twelve plates from the start) */
export const foldSlots = box => {
  if (!box) return;
  const slots = $$(':scope > .ref, :scope > .slot', box);
  let last = -1;
  slots.forEach((s, i) => { if (s.classList.contains('filled')) last = i; });
  slots.forEach((s, i) => { s.hidden = i > Math.max(0, last + 1); });
};
export const watchSlots = box => {
  if (box && !box._folded) { box._folded = true; new MutationObserver(() => foldSlots(box)).observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); }
};

/* ---------- файлы из проводника: бросаете пачку куда угодно, программа раскладывает по слотам ----------
   Файл определяется по расширению (тип из проводника Windows часто пуст), попадает в свободные
   слоты текущего раздела по типу; чужой формат и кончившиеся места — отдельное предупреждение. */
export const FILE_KIND = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus'],
};
export const fileKind = f => {
  const ext = (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
  for (const k in FILE_KIND) if (FILE_KIND[k].includes(ext)) return k;
  const t = (f.type || '').split('/')[0];
  return FILE_KIND[t] ? t : '';
};
// проводник не всегда сообщает тип: картинку узнаём и по расширению, иначе слот молча её отклонит
export const isImage = f => !!f && ((f.type || '').startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i.test(f.name || ''));
// контекст один на все распаковки звука: новых контекстов браузер разрешает мало
export const sharedAudioCtx = () => (sharedAudioCtx.c = sharedAudioCtx.c || new (window.AudioContext || window.webkitAudioContext)());
export const PIC_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
                  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' };
export async function clipboardHasImage() {
  try { const j = await (await fetch('/api/clipboard/has-image', { cache: 'no-store' })).json(); return j.have === true; }
  catch { return false; }
}
/* the clipboard holds PNG, so the picture is redrawn on a canvas first — the size stays exactly as it was */
export async function pngOf(source, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  return new Promise(res => c.toBlob(res, 'image/png'));
}
export async function copyPictureToClipboard(it) {
  const url = it && (it.url || it.thumb);
  if (!url) { toast('Картинки ещё нет'); return; }
  try {
    const img = $('#viewer img'), vid = $('#viewer video');
    let png = null;
    if (it.kind !== 'image' && !vid.hidden && vid.videoWidth) png = await pngOf(vid, vid.videoWidth, vid.videoHeight);
    else if (!img.hidden && img.complete && img.naturalWidth) png = await pngOf(img, img.naturalWidth, img.naturalHeight);
    else {
      const blob = await (await fetch(url)).blob();
      if (blob.type === 'image/png') png = blob;
      else { const bmp = await createImageBitmap(blob); png = await pngOf(bmp, bmp.width, bmp.height); bmp.close(); }
    }
    if (!png) { toast('Не удалось подготовить картинку'); return; }
    const r = await fetch('/api/clipboard/image', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png });
    toast(r.ok ? 'Картинка в буфере обмена — вставляйте в любую программу' : 'Буфер обмена не принял картинку');
  } catch (e) { toast('Не удалось скопировать картинку: ' + (e.message || e)); }
}
export function shortCpu(name) {
  // Names come from the registry and no two vendors write them alike:
  //   "Intel(R) Core(TM) i7-14700K"   "13th Gen Intel(R) Core(TM) i5-13400"
  //   "AMD Ryzen 7 9800X3D 8-Core Processor"   "Intel(R) Xeon(R) W-2245 CPU @ 3.90GHz"
  // The noise goes first - brackets, (R)/(TM), "Processor", cores, threads, the clock, "with
  // graphics", the generation number. Of what is left we keep the family, up to three words, and
  // the model number even if it stands further along the name: "Ryzen 7" alone is not a computer.
  let s = ' ' + String(name || '') + ' ';
  s = s.replace(/\((r|tm|c)\)/gi, ' ')
       .replace(/\(with[^)]*\)/gi, ' ')
       .replace(/\b\d+(st|nd|rd|th)\s+gen\b/gi, ' ')
       .replace(/\b(processor|cpu|series|desktop|socket|64-bit|based|with)\b/gi, ' ')
       .replace(/@\s*[\d.]+\s*ghz/gi, ' ')
       .replace(/\b\d+\s*-\s*(core|threaded|cores)\b/gi, ' ')
       .replace(/\bamd technologies,?\b/gi, 'AMD')
       .replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(Boolean);
  // a known family speaks for itself, the vendor's name only eats the place
  const family = /\b(ryzen|epyc|athlon|sempron|phenom|core|xeon|arc|ultra|cortex|apple|ryzen\d)/i;
  let out = [];
  for (const t of words) {
    if (out.length >= 3) break;
    if (/^(intel|amd|via|hygoc|huawei|qualcomm|nvidia)$/i.test(t) && family.test(words.join(' '))) continue;
    out.push(t);
  }
  const num = words.find(t => /\d/.test(t) && !out.includes(t));
  if (num && (out.join(' ') + ' ' + num).length <= 24) out.push(num);
  return (out.join(' ') || String(name || '')).trim().slice(0, 24);
}
(function () {
  const head = document.getElementById('sysHead'), body = document.getElementById('sysBody');
  if (!head || !body) return;
  const KEY = 'h3-sys-folded';
  // no stored choice means "the program decides": on a short screen the open box does not fit
  const wantFolded = () => { const v = localStorage.getItem(KEY); return v === null ? (window.innerHeight || 900) < 1050 : !!v; };
  const folded = () => document.body.classList.toggle('sys-folded', wantFolded());
  head.onclick = () => { localStorage.setItem(KEY, wantFolded() ? '' : '1'); folded(); };
  window.addEventListener('resize', () => { if (localStorage.getItem(KEY) === null) folded(); });
  head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } };
  folded();
  // the brief line carries what matters while the box is closed
  const bi = new MutationObserver(() => {
    if (!document.body.classList.contains('sys-folded')) return;
    const g = id => ($(id) || {}).textContent || '';
    $('#sysBrief').textContent = [g('#gpuLoad'), g('#vramTxt')].filter(x => x && x !== '—').join(' · ');
  });
  bi.observe(document.querySelector('#gpuLoad') || document.body, { childList: true, characterData: true, subtree: true });
})();

/* the program's own mark answers for the engine: it pulses red while the engine is not with us
   yet and settles on green when it is, so the answer to "can I press Start" is visible from
   the far side of the room, without reading the small print */
(function () {
  /* значок живёт в верхнем баре и появляется позже этого файла: искать его при каждой
     проверке, а не один раз на старте - иначе приёмник нагрузки не создаётся вовсе,
     а панель нагрузки спотыкается о него на первой строке и замирает */
  const getMark = () => document.querySelector('.brand-mark');
  const cap = document.getElementById('engTxt');
  const st = () => {
    const mark = getMark(); if (!mark) return;
    const dot = document.getElementById('engDot');
    const on = dot && !dot.classList.contains('off');
    const wait = cap && /запуск|поднима|жд|не запущен|start/i.test(cap.textContent || '');
    mark.classList.toggle('eng-wait', !on);
    mark.classList.toggle('eng-on', !!on);
    /* Режим работы сценариста живёт в подсказке той же метки: во время работы
       на первом месте его слово, в покое - чем сценарист сейчас готов быть. */
    const agn = window._agNote || '', agm = window._agMode || '';
    mark.title = (agn ? agn + ' · ' : '') + (on ? 'Движок работает - можно снимать' : (wait ? 'Движок поднимается: подождите пару минут' : 'Движок не запущен: нажмите «Движок» внизу'))
      + (agn || !agm ? '' : ' · Сценарист: ' + agm);
  };
  st();
  new MutationObserver(st).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  setInterval(st, 3000);
  /* Ядро трудится - значок тихо краснеет: когда видеокарта или процессор
     грузятся выше 70 %, зелёный кадр плавно наливается бледно-красным.
     Это честный признак работы: видно из любого окна и не зависит от того,
     из какого раздела что запущено. Порог один на видеокарту и процессор. */
  const load = { gpu: 0, cpu: 0 };
  let hot = false;
  window._chipLoad = (id, pct) => {
    if (id === '#gpuLoad') load.gpu = pct || 0; else load.cpu = pct || 0;
    const now = load.gpu > 70 || load.cpu > 70;
    if (now !== hot) { hot = now; const m = getMark(); if (m) m.classList.toggle('hot', hot); }
  };
})();

/* the about page speaks in values, not in promises: it reads the same answers the rest of the
   program works with, so a person sees where his files really lie */
(function () {
  const put = (id, txt) => { const e = document.getElementById(id); if (e && txt) e.textContent = txt; };
  async function fill() {
    try {
      const v = await (await fetch('/api/version')).json();
      put('abVer', 'Kadr ' + (v.version || ''));
      put('abFacts', 'Версия ' + (v.version || '?') + (v.built ? ' · сборка от ' + v.built : '') +
        '. Программа работает на этом компьютере и не отправляет ваши файлы никуда.');
    } catch {}
    try {
      /* the same fact belongs here: the settings page is where people look for what is installed */
      const a = await (await fetch('/api/agent/status')).json();
      const sp = a.speech || {}, bt = sp.better || {};
      put('abSpeech', sp.ready
        ? 'Распознавание речи (им читаются слова песен): ' + (sp.model || '?') + (sp.model_size ? ' · ' + Math.round(sp.model_size / 1048576) + ' МБ' : '')
          + (bt.present ? ' · точная модель, она разбирает пение' : ' · модель маленькая: песни слышит плохо')
          + '. Выбрать другую или докачать - раздел «Сценарист», строчка «Модель сценариста».'
        : 'Распознавание речи не скачано: раздел «Сценарист», строчка «Модель сценариста», кнопка «Докачать».');
    } catch { }
    try {
      const s = await (await fetch('/api/status')).json();
      const p = s.paths || {};
      put('abData', s.data_dir || 'рядом с программой');
      ['abOut', 'abEng', 'abGpu'].forEach(id => { const e = document.getElementById(id); if (e && e.textContent === 'уточняем…' && !s[id === 'abOut' ? 'output_dir' : id === 'abEng' ? 'engine' : 'gpu']) e.textContent = 'нет данных'; });
      put('abOut', s.output_dir || 'рядом с программой');
      put('abEng', s.engine === 'managed' ? 'ComfyUI, который программа ведёт сама' : s.engine === 'external' ? 'ваш собственный ComfyUI' : s.engine === 'cloud' ? 'арендованный сервер' : (s.engine || '—'));
      put('abGpu', (s.gpu || '—') + (s.vram_total ? ' · ' + Math.round(s.vram_total / 1073741824) + ' ГБ памяти' : '') +
        ' · режимов: ' + ((s.modes || []).length));
    } catch {}
  }
  let busy = false;
  const run = () => { if (!busy && document.querySelector('#view-about.active')) { busy = true; fill().finally(() => { busy = false; }); } };
  const mo = new MutationObserver(run);
  mo.observe(document.querySelector('.main') || document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  // the engine answers about itself slowly, so the lines say "уточняем" and fill in when they can
  const wait = document.querySelectorAll('#abData, #abOut, #abEng, #abGpu');
  wait.forEach(e => { if (e.textContent === '—') e.textContent = 'уточняем…'; });
  run();
  setInterval(run, 4000);
})();

/* live load of this computer in the sidebar (CPU, RAM, video card, disk) */
export function meter(valId, barId, pct, text) {
  $(valId).textContent = text;
  const bar = $(barId); bar.style.width = Math.min(100, Math.max(0, pct || 0)) + '%';
  bar.className = pct > 90 ? 'hi' : pct > 75 ? 'mid' : '';
  /* Ядро работает - значит, живой значок должен это показывать: окно нагрузки
     знает правду раньше всех, отсюда и зовём метку. */
  if (valId === '#gpuLoad' || valId === '#cpuTxt') window._chipLoad(valId, pct);
}
export const g1 = n => (+n).toFixed(n >= 100 ? 0 : 1).replace(/\.0$/, '');
export const normItem = it => ({ ...it, date: new Date(it.date) });

export const newSeed = () => String(Math.floor(Math.random() * 2 ** 50));
/* ---------- live preview rendering (demo: imitates denoising toward a target) ---------- */
export const offCv = document.createElement('canvas'), noiseCv = document.createElement('canvas');
noiseCv.width = 160; noiseCv.height = 100;
export function drawCover(c, src, w, h, z = 1, sx = 0) {
  const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
  const s = Math.max(w / iw, h / ih) * z, dw = iw * s, dh = ih * s;
  c.drawImage(src, (w - dw) / 2 + sx * w, (h - dh) / 2, dw, dh);
}
export const fmtTime = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/* ---------- SETUP & MODELS view ---------- */
export const GB = b => b < 1e9 ? Math.round(b / 1e6) + ' МБ' : (b / 1e9).toFixed(1).replace(/\.0$/, '') + ' ГБ';
export function copyText(text, okMsg) {
  const s = String(text == null ? '' : text);
  const viaArea = () => {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-1200px;top:0;opacity:0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    let done = false;
    try { done = document.execCommand('copy'); } catch (e) { done = false; }
    ta.remove();
    return done;
  };
  const fail = () => { if (s.length <= 90) toast(s); else toast('Не удалось скопировать: окно не активно'); };
  if (!s) { toast('Копировать нечего'); return Promise.resolve(false); }
  const nav = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(s) : null;
  if (nav && nav.then) {
    return nav.then(() => { if (okMsg) toast(okMsg); return true; },
                    () => { const ok = viaArea(); if (ok) { if (okMsg) toast(okMsg); } else { fail(); } return ok; });
  }
  const ok = viaArea();
  if (ok) { if (okMsg) toast(okMsg); } else { fail(); }
  return Promise.resolve(ok);
}

export const ICON = {
  use: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5l-5.5 2.9 1-6.3L3 9.7l6.2-.9z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
};
// last messages and script errors: they go into the report for the author
export const TOASTS = [];
export const noteMsg = s => {
  const line = new Date().toLocaleTimeString('ru') + ' ' + String(s).slice(0, 300);
  TOASTS.push(line); if (TOASTS.length > 20) TOASTS.shift();
  /* и в журнал программы: без этого страница молчит, а причина ищется наугад */
  try { postJSON('/api/log', { text: line }).catch(() => { }); } catch { }
};
window.addEventListener('error', e => noteMsg('Ошибка скрипта: ' + e.message + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')'));
window.addEventListener('unhandledrejection', e => noteMsg('Ошибка: ' + (e.reason && e.reason.message || e.reason)));
export function toast(msg) {
  noteMsg(msg);
  /* A message must never be the thing that breaks the action it reports: some views build their own
     DOM and leave no place for the line, so the line is created on the spot when it is gone. */
  let t = (typeof $ === 'function' ? $('#toast') : null) || document.getElementById('toast') || document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.id = 'toast'; document.body.append(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2600);
}
export function fmtDate(d) {
  const now = new Date(), hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  return days === 0 ? `сегодня, ${hm}` : days === 1 ? `вчера, ${hm}` : d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }) + `, ${hm}`;
}
/* настоящее имя файла, а не составленное из режима и даты: человек копирует его, чтобы найти
     ролик на диске или показать другому - выдуманное имя уводило в никуда */
export const fileName = it => {
  const p = String(it.local || '').replace(/[\\/]+$/, '');
  if (p) return p.split(/[\\/]/).pop();
  return it.file || (it.id ? `${it.id}.${it.ext || 'mp4'}` : '');
};

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* ---------- REFS & ACTION views ---------- */
export const ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
export const ICON_VID = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>';
export const ICON_AUD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

export const fileToDataURL = (file, max = 1024) => new Promise(res => {
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    res(c.toDataURL('image/jpeg', 0.88)); URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
});
export function fmtShort(iso) { return iso ? fmtDate(new Date(iso)) : ''; }
export function confirmBox(title, text, ok, fn, cancel) {
  const cn0 = $('#confirm [data-close]'); if (cn0) cn0.style.display = '';   // окно «Понятно» прячет отмену - вернём на место
  $('#cfTitle').textContent = title;
  const tx = $('#cfText'); tx.textContent = text;
  tx.style.whiteSpace = String(text).indexOf('\n') >= 0 ? 'pre-line' : '';   // a list of problems reads line by line, not one line
  $('#cfOk').textContent = ok;
  const cn = $('#confirm [data-close]'); if (cn) cn.textContent = cancel || 'Отмена';
  $('#confirm').hidden = false;
  $('#cfOk').onclick = async () => {
    $('#confirm').hidden = true; $('#cfOk').textContent = 'Удалить';
    if (cn) cn.textContent = 'Отмена';
    await fn();
  };
}
/* ---------- Окно предупреждений ----------
   Тост не может показать «все предупреждения»: все они пишутся в одну строку, и каждое
   новое затирает прежнее. Предупреждения, влияющие на результат, копятся в список и
   показываются ОДНИМ окном списком - человек успевает прочитать и решить. */
export const WARN = [];
export function warn(msg) { const s = String(msg || '').trim(); if (s && !WARN.includes(s)) WARN.push(s); }
export function warnTake() { return WARN.splice(0, WARN.length); }
/* Два окна одновременно нельзя (в коде это признано уже: system.js ждёт освобождения) -
   новое становится в очередь за открытым. */
function boxWait(fn) {
  const box = (typeof $ === 'function' ? $('#confirm') : null) || document.getElementById('confirm');
  if (box && !box.hidden) { setTimeout(() => boxWait(fn), 400); return; }
  fn();
}
/* Окно с одной кнопкой: отменять здесь нечего, факт уже случился - важно только,
   чтобы человек его увидел. */
export function warnBox(title, lines, ok = 'Понятно') {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).map(String);
  if (!list.length) return;
  boxWait(() => {
    confirmBox(title, list.length > 1 ? list.map((s, i) => (i + 1) + '. ' + s).join('\n') : list[0], ok, () => { });
    const cn = $('#confirm [data-close]'); if (cn) cn.style.display = 'none';
  });
}
/* Предупреждения, которые рождаются толпой за секунды (ответ сценариста, раскладка
   по сценам), показываются одним окном, когда толпа закончится. */
export function warnSoon(title, ms = 1800) {
  clearTimeout(warnSoon._h);
  warnSoon._h = setTimeout(() => { const l = warnTake(); if (l.length) warnBox(title, l); }, ms);
}

/* interface zoom and library card size (buttons and Ctrl + mouse wheel) */
export const UI_Z = { ui: 1, lib: 230 };
try { UI_Z.ui = +localStorage.getItem('h3-ui-zoom') || 1; UI_Z.lib = +localStorage.getItem('h3-lib-size') || 230; } catch {}
// with a zoomed page the browser's vh units stay those of the real window: windows stopped above the bottom edge. --vh is 1/100 of the visible height in page units.
export function setVh() { document.documentElement.style.setProperty('--vh', (innerHeight / (UI_Z.ui || 1) / 100) + 'px'); }
addEventListener('resize', setVh);
export function applyZoom() {
  UI_Z.ui = Math.min(1.5, Math.max(0.6, Math.round(UI_Z.ui * 20) / 20));
  UI_Z.lib = Math.min(420, Math.max(110, Math.round(UI_Z.lib / 10) * 10));
  document.documentElement.style.zoom = UI_Z.ui;
  setVh();
  $('#lib').style.setProperty('--lib-min', UI_Z.lib + 'px');
  $('#uiPct').textContent = Math.round(UI_Z.ui * 100) + '%';
  try { localStorage.setItem('h3-ui-zoom', UI_Z.ui); localStorage.setItem('h3-lib-size', UI_Z.lib); } catch {}
}
$('#uiSm').onclick = () => { UI_Z.ui -= 0.1; applyZoom(); };
$('#uiLg').onclick = () => { UI_Z.ui += 0.1; applyZoom(); };
$('#uiPct').onclick = () => { UI_Z.ui = 1; applyZoom(); };
$('#libSm').onclick = () => { UI_Z.lib -= 30; applyZoom(); };
$('#libLg').onclick = () => { UI_Z.lib += 30; applyZoom(); };
window.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const up = e.deltaY < 0;
  if (e.target.closest && e.target.closest('#view-library')) UI_Z.lib += up ? 20 : -20; else UI_Z.ui += up ? 0.05 : -0.05;
  applyZoom();
}, { passive: false });
applyZoom();
/* The engine chosen in the window decides which «Промт для» the Agent has to serve, and the window
   itself decides where the finished text goes back to. */
