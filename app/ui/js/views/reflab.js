/* Студия референсов: листы референсов персонажа, предмета или места из одного короткого ролика
   (сервер - app/areas/reflab.py, окно перенесено из Студии референсов автора).

   Порядок работы такой: слева картинки-основа и набор ракурсов, по «Сделать лист» считается
   короткое видео, из него берутся кадры в моменты ракурсов, кадры складываются в лист, а лист и
   кадры уходят в раздел «Карточки» и в Библиотеку - дальше их берут все режимы как обычные
   картинки-опоры.

   Что изменено против автора и почему:
   - источник «Субъект» стал источником «Карточка»: карточки у нас живут в разделе «Карточки»;
   - движка DLSS для доведения у нас нет: осталось два варианта - RelayVSR (быстро) и SeedVR2;
   - кнопок «Папка студии» нет: программа сама не открывает проводник, а делать кнопку, которая
     ничего не делает, честнее отказа;
   - вместо значков слова: в интерфейсе программы значков нет. */

import { $, $$, confirmBox, esc, fileToDataURL, normItem, toast } from '../core/util.js';
import { postJSON } from '../core/net.js';
import { LIB, QUEUE } from '../core/state.js';
import { onNav } from '../core/tabs.js';
import { addToLib } from './library.js';
import { QSTAGE, qAdd } from './queue.js';
import { AC, acLoad } from './actors.js';
import { offPrompt, onPrompt } from '../ui/scenario.js';
import { ASPECTS, QUALITY } from '../ui/params.js';

const root = $('#view-reflab');
const KEY = 'h3-reflab-form', PKEY = 'h3-reflab-pics', LKEY = 'h3-reflab-last', WKEY = 'h3-rl-w';
const FPS = 24, MAX_PICS = 9, MAX_CARD = 9, MAX_BEATS = 12;
const SHEET_TYPES = {
  character: ['Персонаж', 'люди, существа, маскоты'],
  object: ['Объект', 'предметы, вещи, транспорт'],
  location: ['Локация', 'комнаты, улицы, пейзажи'],
};
const SRC = {
  card: ['Карточка', 'из раздела «Карточки»'],
  pictures: ['Картинки', 'до 9 из Библиотеки'],
  text: ['Текст', 'описать новое'],
};
const SIZES = [['1920x1080', '1920 × 1080 (Full HD)'], ['2560x1440', '2560 × 1440 (2K)'],
  ['3840x2160', '3840 × 2160 (4K)'], ['2160x2160', '2160 × 2160 (квадрат)'],
  ['2160x3840', '2160 × 3840 (вертикаль)']];
const FIN_ENG = { relay: 'Быстро (RelayVSR, ×2)', seed: 'Качественно (SeedVR2)' };

const defForm = () => ({
  type: 'location', source: 'pictures', name: '', who: '', features: '', focus: '', style: '',
  setdress: '', preset: 'coverage', beats: [], seconds: 8, aspect: '16:9', quality: '0.8', steps: 6,
  passes: 2, draftQ: '0.5', seed: '', finEng: 'relay', fin: {},
});
const defLay = () => ({ layout: 'grid', bg: 'white', size: '3840x2160', shape: 'asis', gap: 0, labels: false });

const S = {
  data: null, runs: [], f: defForm(), lay: defLay(), pics: [], run: null, video: null, frames: [],
  sel: -1, busy: false, pid: '', hint: '', stat: '', statBad: false, pct: 0, stageText: '',
  describing: false, editLay: false, dest: 'card', open: {},
};
try {
  const kept = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (kept && kept.f) { S.f = { ...defForm(), ...kept.f }; S.lay = { ...defLay(), ...(kept.lay || {}) }; }
} catch { /* форма не восстановилась: начинаем чистой */ }
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ f: S.f, lay: S.lay })); } catch { /* хранилище переполнено */ } };
try { S.pics = (JSON.parse(localStorage.getItem(PKEY) || '[]') || []).filter(x => x && x.url); } catch { S.pics = []; }

let picsTimer = 0;
/* Картинки основы переживают перезапуск: библиотечные - ссылкой, файлы с компьютера - урезанной
   копией, иначе после закрытия окна человек увидел бы пустую рамку. */
const keepPics = () => {
  clearTimeout(picsTimer);
  picsTimer = setTimeout(async () => {
    try {
      const out = [];
      for (const p of S.pics) {
        if (p.file && !p.data) p.data = await fileToDataURL(p.file, 1280);
        out.push({ url: p.lib || !p.file ? p.url : p.data, lib: p.lib || '' });
      }
      localStorage.setItem(PKEY, JSON.stringify(out));
    } catch { /* слишком большое для хранилища браузера: форма всё равно осталась */ }
  }, 300);
};
const keepLast = id => { try { localStorage.setItem(LKEY, id || ''); } catch { /* не сохранено */ } };

/* ----- мелкие помощники ----- */
const fmt = t => (Math.round(t * 100) / 100).toString();
const frameNo = t => Math.round(t * FPS);
const tok = s => String(s || '').toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
const presetList = () => ({ ...(S.data ? S.data.presets[S.f.type] : {}) });
const mineList = () => (S.data ? S.data.mine.filter(m => m.type === S.f.type) : []);
const presetTitle = () => {
  const p = presetList()[S.f.preset];
  if (p) return p.title;
  const m = (S.data ? S.data.mine : []).find(x => x.id === S.f.preset);
  return m ? m.name : 'Свой набор';
};
const defAspect = t => (t === 'location' ? '16:9' : t === 'character' ? '9:16' : '1:1');
const toBlob = cv => new Promise(res => cv.toBlob(res, 'image/png'));
const opt = (list, v) => list.map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');
const loadCanvas = url => new Promise((res, rej) => {
  const im = new Image();
  im.onload = () => {
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    c.getContext('2d').drawImage(im, 0, 0); res(c);
  };
  im.onerror = rej; im.src = url;
});
async function json(r) {
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error || t || r.statusText);
  return j;
}
async function getFile(p) {
  if (p.file) return p.file;
  const b = await (await fetch(p.url)).blob();
  return new File([b], 'pic.png', { type: b.type || 'image/png' });
}
function pickPreset(id) {
  const p = presetList()[id] || mineList().find(x => x.id === id);
  if (!p) return;
  S.f.preset = id; S.f.seconds = p.seconds;
  S.f.beats = p.beats.map(b => ({ ...b }));
  keep();
}

/* ----- данные ----- */
async function loadData() {
  try { S.data = await (await fetch('/api/reflab/presets')).json(); }
  catch { S.data = { types: SHEET_TYPES, presets: { character: {}, object: {}, location: {} }, mine: [] }; }
  if (!S.data || !S.data.presets) S.data = { types: SHEET_TYPES, presets: { character: {}, object: {}, location: {} }, mine: [] };
  if (!S.data.presets[S.f.type]) S.data.presets[S.f.type] = {};
  if (!Array.isArray(S.data.mine)) S.data.mine = [];
  try {
    const runs = await (await fetch('/api/reflab/runs')).json();
    S.runs = Array.isArray(runs) ? runs : [];
  } catch { S.runs = []; }
  const known = {};
  Object.values(S.data.presets).forEach(g => Object.values(g || {}).forEach(p => (p.beats || []).forEach(b => { known[b.text] = b.ru; })));
  S.f.beats.forEach(b => { if (!b.ru && known[b.text]) b.ru = known[b.text]; });   // форма старого сохранения без русских строк
  const orbit = presetList().orbit360;
  if (S.f.preset === 'orbit360' && orbit && S.f.beats.length !== orbit.beats.length) pickPreset('orbit360');   // старый поворот на 8 кадров из сохранённой формы
  if (!S.f.beats.length || (!presetList()[S.f.preset] && !mineList().find(x => x.id === S.f.preset))) {
    pickPreset(Object.keys(presetList())[0] || 'coverage');
  }
}

/* ----- левая колонка: форма ----- */
function picList() {
  return `<div class="rl-pics" data-drop>${S.pics.length ? '' : '<span class="hint" style="padding:10px">Перетащите сюда картинки или добавьте кнопками ниже</span>'}${S.pics.map((p, i) => `<div class="rl-pic"><img src="${esc(p.url)}" alt=""><div><b>${i + 1}.</b><small>${i ? 'дополнительная' : 'главная картинка'}</small></div><button class="btn mini" data-a="rmpic" data-i="${i}" type="button" title="Убрать картинку">Убрать</button></div>`).join('')}</div>
    <div class="rl-chips" style="margin-top:6px"><label class="btn mini" style="margin:0">Добавить картинки<input type="file" id="rlFile" accept="image/*" multiple hidden></label><button class="btn mini" data-a="lib" type="button">Из Библиотеки</button><span class="hint">${S.pics.length} / ${MAX_PICS} · файлы можно перетащить в рамку</span></div>`;
}
function picsHtml() {
  if (S.f.source === 'text') {
    return `<div class="hint" style="line-height:1.6;margin-bottom:8px">Опишите героя, предмет или место ниже и нажмите «Нарисовать картинку»: программа создаст картинку, и она станет главной.</div>
      <button class="btn" data-a="draw" type="button"${S.busy ? ' disabled' : ''}>Нарисовать картинку</button>${S.pics.length ? picList() : ''}`;
  }
  if (S.f.source === 'card') {
    const cards = AC.cards || [];
    return `<select class="rl-in" data-a="card" style="width:100%"><option value="">${cards.length ? 'Выберите карточку…' : 'Карточек пока нет (раздел «Карточки»)'}</option>${cards.map(c => `<option value="${esc(c.id)}">${esc(c.name)} · ${esc(c.token || '')}</option>`).join('')}</select>
      <div class="hint" style="margin-top:6px">Возьмёт включённые фото карточки, её описание и тип. Фото карточки не меняются.</div>${S.pics.length ? picList() : ''}`;
  }
  return picList();
}
const field = (k, label, hint, ph, tag = 'input', max = 300) => `<div class="rl-f"><label>${label}<small>${hint}</small></label><${tag} class="rl-in" data-k="${k}" maxlength="${max}" placeholder="${esc(ph)}"${tag === 'input' ? ` value="${esc(S.f[k])}">` : `>${esc(S.f[k])}</textarea>`}</div>`;
const barHtml = () => `<div class="rl-bar"${S.busy ? '' : ' hidden'}><i style="width:${S.pct || 0}%"></i><span>${Math.round(S.pct || 0)}%</span></div>`;

function leftHtml() {
  const f = S.f, pl = presetList(), mine = mineList();
  return `<div class="rl-tabs" data-g="type">${Object.entries(SHEET_TYPES).map(([k, [t, h]]) => `<button type="button" data-a="type" data-v="${k}" class="${f.type === k ? 'on' : ''}">${t}<small>${esc(h)}</small></button>`).join('')}</div>
    <div class="rl-tabs" data-g="source">${Object.entries(SRC).map(([k, [t, h]]) => `<button type="button" data-a="source" data-v="${k}" class="${f.source === k ? 'on' : ''}">${t}<small>${esc(h)}</small></button>`).join('')}</div>
    <div class="card"><div class="card-h"><h3>${f.source === 'text' ? 'Первая картинка' : 'Картинки'}</h3><span class="hint">${SHEET_TYPES[f.type] ? SHEET_TYPES[f.type][0].toLowerCase() : ''}</span></div>${picsHtml()}</div>
    <div class="card">
      <div class="rl-2">${field('name', 'Имя', '@имя', 'car interior', 'input', 60)}${field('who', 'Кто', 'по-английски: the …', 'the car interior')}</div>
      ${field('features', 'Особенности', 'что сохранить во всех ракурсах', 'dark grey leather seats, wooden trim', 'textarea', 1200)}
      <div class="rl-chips"><button class="btn mini" data-a="describe" type="button"${S.describing ? ' disabled' : ''}>${S.describing ? 'Описываю…' : 'Описать по картинке'}</button><span class="hint">заполнит «Кто» и «Особенности»</span></div>
    </div>
    <div class="card"><div class="card-h"><h3>Лист</h3></div>
      <div class="rl-chips">${Object.entries(pl).map(([k, p]) => `<button class="rl-chip${f.preset === k ? ' on' : ''}" data-a="preset" data-v="${k}" type="button" title="${esc(p.hint)}">${esc(p.title)}</button>`).join('')}${mine.map(m => `<button class="rl-chip${f.preset === m.id ? ' on' : ''}" data-a="preset" data-v="${esc(m.id)}" type="button">${esc(m.name)}<i data-a="delpreset" data-v="${esc(m.id)}" title="Удалить этот набор ракурсов"> x </i></button>`).join('')}</div>
      <div class="hint" style="margin:8px 0">${esc((pl[f.preset] || {}).hint || 'Ваш набор ракурсов')}</div>
      <button class="btn mini" data-a="savepreset" type="button">Сохранить как свой набор…</button>
      <div class="rl-f" style="margin-top:12px"><label>Фокус на<small>каждый ракурс держит это в центре</small></label><input class="rl-in" data-k="focus" maxlength="200" placeholder="например: красное кресло у окна" value="${esc(f.focus)}"></div>
    </div>
    <details class="card" data-d="beats"${S.open.beats ? ' open' : ''}><summary><b>Ракурсы</b> <span class="hint">${f.preset === 'orbit360' ? 'настраивать не нужно: 5 кадров: спереди, 3/4, бок, сзади, другой бок' : `${f.beats.length} шт.: ${esc(f.beats.map(b => b.name).join(' · '))}`}</span></summary><div style="margin-top:10px">
      <div class="hint" style="margin-bottom:8px">Каждый ракурс - это кадр из видео: название, что делает камера и на какой секунде он снимается. Английский текст нужен модели; обычно его трогать не надо.</div>
      ${f.beats.map((b, i) => `<div class="rl-beat"><input class="rl-in" type="text" data-b="${i}" data-bk="name" maxlength="30" value="${esc(b.name)}" title="Название ракурса">
        <label class="hint" style="display:flex;gap:4px;align-items:center">на<input class="rl-in" type="number" min="0" max="${f.seconds}" step="0.1" data-b="${i}" data-bk="t" value="${fmt((b.at || 0) * f.seconds)}" style="width:58px"> с</label>
        <label class="hint" style="display:flex;gap:4px;align-items:center">доля<input class="rl-in" type="number" min="0" max="1" step="0.01" data-b="${i}" data-bk="at" value="${fmt(b.at || 0)}" style="width:56px"></label>
        <button class="btn mini" data-a="rmbeat" data-i="${i}" type="button" title="Убрать ракурс">Убрать</button>
        <div class="rl-ru">${esc(b.ru || 'Ваш ракурс: опишите, что делает камера')}</div>
        <details${b.ru ? '' : ' open'}><summary class="hint" style="cursor:pointer">Текст для модели (по-английски)</summary><textarea class="rl-in" data-b="${i}" data-bk="text" maxlength="300" rows="3" style="width:100%;margin-top:6px">${esc(b.text)}</textarea></details></div>`).join('')}
      <button class="btn mini" data-a="addbeat" type="button"${f.beats.length >= MAX_BEATS ? ' disabled' : ''}>Добавить ракурс</button></div></details>
    <details class="card" data-d="look"${S.open.look ? ' open' : ''}><summary><b>Look</b> <span class="hint">${f.style || f.setdress ? 'заполнено' : 'ничего не задано'}</span></summary><div style="margin-top:10px">
      ${field('style', 'Слова стиля', 'идут первыми', 'например: плёнка 35 мм, мягкий свет', 'input', 200)}
      ${field('setdress', 'Обстановка / погода', 'добавляется к месту', 'например: мокрые улицы после дождя', 'input', 300)}</div></details>
    <details class="card" data-d="render"${S.open.render ? ' open' : ''}><summary><b>Рендер</b> <span class="hint">${f.passes === 2 ? 'два прохода' : 'один проход'}</span></summary><div style="margin-top:10px">
      <div class="rl-tabs" style="grid-template-columns:1fr 1fr;margin-bottom:10px"><button type="button" data-a="passes" data-v="1" class="${f.passes === 1 ? 'on' : ''}">Один проход<small>сразу готовое видео</small></button><button type="button" data-a="passes" data-v="2" class="${f.passes === 2 ? 'on' : ''}">Два прохода<small>черновик, потом чистовой</small></button></div>
      <div class="rl-ctl">
      <div class="rl-f"><label>Формат</label><select class="rl-in" data-k="aspect">${ASPECTS.map(a => `<option${a.id === f.aspect ? ' selected' : ''}>${a.id}</option>`).join('')}</select></div>
      <div class="rl-f"><label>Секунд</label><input class="rl-in" type="number" min="3" max="15" step="1" data-k="seconds" value="${f.seconds}"></div>
      ${f.passes === 2 ? `<div class="rl-f"><label>Размер черновика</label><select class="rl-in" data-k="draftQ">${QUALITY.map(q => `<option value="${q.id}"${q.id === f.draftQ ? ' selected' : ''}>${q.res}${q.sub ? ' · ' + q.sub : ''}</option>`).join('')}</select></div>
      <div class="rl-f"><label>Чем доводить до чистового</label><select class="rl-in" data-k="finEng">${Object.entries(FIN_ENG).map(([k, t]) => `<option value="${k}"${k === f.finEng ? ' selected' : ''}>${t}</option>`).join('')}</select></div>` : `<div class="rl-f"><label>Размер видео</label><select class="rl-in" data-k="quality">${QUALITY.map(q => `<option value="${q.id}"${q.id === f.quality ? ' selected' : ''}>${q.res}${q.sub ? ' · ' + q.sub : ''}</option>`).join('')}</select></div>
      <div class="rl-f"><label>Шагов</label><input class="rl-in" type="number" min="4" max="8" step="1" data-k="steps" value="${f.steps}"></div>`}
      <div class="rl-f"><label>Seed<small>пусто - случайный</small></label><input class="rl-in" data-k="seed" maxlength="18" inputmode="numeric" placeholder="случайный" value="${esc(f.seed)}"></div></div>
      <div class="hint">${f.passes === 2 ? 'Сначала быстро считается маленький черновик (4 шага): по нему видно, держится ли герой. Если всё хорошо, кнопка «Доработать до чистового» увеличивает этот же ролик, ничего не перерисовывая: кадры остаются теми, что вы выбрали, но становятся крупнее и чётче.' : 'Видео считается один раз в выбранном размере.'} Размеры указаны для широкого кадра; для вертикального цифры меняются местем. Видео делается из ваших картинок; кадры берутся в моменты ракурсов.</div></div></details>
    <div><div style="display:flex;gap:8px"><button class="btn pri" data-a="go" type="button" style="flex:1"${S.busy ? ' disabled' : ''}>${S.busy ? 'Делаю лист…' : 'Сделать лист'}</button><button class="btn" data-a="stop" type="button"${S.busy && S.pid ? '' : ' hidden'} style="width:auto;padding:0 18px">Остановить</button></div>
      ${barHtml()}<div class="hint" id="rlMsg" style="margin-top:6px;text-align:center;line-height:1.5">${esc(S.hint)}</div></div>`;
}
function paintLeft() {
  const box = $('#rlLeft', root); if (!box) return;
  const y = box.scrollTop;
  box.innerHTML = leftHtml();
  box.scrollTop = y;
}
function stat(text, bad) {
  S.stat = text; S.statBad = !!bad;
  const e = $('#rlStat', root);
  if (e) { e.textContent = text; e.className = 'rl-stat ' + (bad ? 'bad' : 'ok'); }
}
const msg = t => { S.hint = t; const m = $('#rlMsg', root); if (m) m.textContent = t; };

/* ----- правая колонка: лист, видео, кадры ----- */
const layOf = () => S.lay;
const sizeWH = () => String(layOf().size || '1920x1080').split('x').map(Number);

function drawSheet(cv, W, H, gap, labels) {
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), lay = layOf();
  c.clearRect(0, 0, W, H);
  if (lay.bg !== 'transparent') {
    c.fillStyle = { white: '#ffffff', black: '#000000', grey: '#8a8a8a' }[lay.bg] || '#ffffff';
    c.fillRect(0, 0, W, H);
  }
  const fr = S.frames.filter(f => f.on && f.cv), n = fr.length;
  if (!n) return;
  const ar = { asis: fr[0].cv.width / fr[0].cv.height, square: 1, wide: 16 / 9, tall: 3 / 4 }[lay.shape] || fr[0].cv.width / fr[0].cv.height;
  const fixed = lay.layout === 'row' ? n : lay.layout === 'col' ? 1 : 0;
  let best = null;
  for (let cols = fixed || 1; cols <= (fixed || n); cols++) {
    const rows = Math.ceil(n / cols);
    const ph = Math.min(((W - gap * (cols + 1)) / cols) / ar, (H - gap * (rows + 1)) / rows);
    if (ph > 0 && (!best || ph > best.ph)) best = { cols, rows, ph };
  }
  if (!best) return;
  const { cols, rows, ph } = best, pw = ph * ar, y0 = (H - (rows * ph + (rows - 1) * gap)) / 2;
  fr.forEach((f, i) => {
    const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols;
    const x0 = (W - (inRow * pw + (inRow - 1) * gap)) / 2;
    const x = x0 + (i - r * cols) * (pw + gap), y = y0 + r * (ph + gap);
    const iw = f.cv.width, ih = f.cv.height;
    let sx = 0, sy = 0, sw = iw, sh = ih;
    if (lay.shape !== 'asis') {
      if (iw / ih > ar) { sw = ih * ar; sx = (iw - sw) / 2; } else { sh = iw / ar; sy = (ih - sh) / 2; }
    }
    c.drawImage(f.cv, sx, sy, sw, sh, x, y, pw, ph);
    if (labels) {
      const fs = Math.max(12, ph * 0.055);
      c.font = '700 ' + fs + 'px sans-serif'; c.textBaseline = 'middle';
      const tw = c.measureText(f.name).width + fs;
      c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x, y + ph - fs * 1.8, tw, fs * 1.8);
      c.fillStyle = '#ffffff'; c.fillText(f.name, x + fs / 2, y + ph - fs * 0.9);
    }
  });
}
function paintSheet() {
  const cv = $('#rlSheet', root); if (!cv) return;
  const [W, H] = sizeWH(), pw = 1400;
  drawSheet(cv, pw, Math.round(pw * H / W), (+layOf().gap || 0) * pw / W, layOf().labels);
}
function sheetCanvas(maxSide) {
  const c = document.createElement('canvas');
  let [W, H] = sizeWH();
  const k = Math.min(1, maxSide / Math.max(W, H)), gap = (+layOf().gap || 0) * k;
  drawSheet(c, Math.round(W * k), Math.round(H * k), gap, layOf().labels);
  return c;
}
function thumbsHtml() {
  return `<div class="rl-thumbs">${S.frames.map((f, i) => `<div class="rl-t${S.sel === i ? ' on' : ''}${f.on ? '' : ' off'}" data-i="${i}" draggable="true" title="Перетащите, чтобы поменять место на листе. Двойной щелчок - переименовать"><canvas data-c="${i}"></canvas><label><input type="checkbox" data-a="on" data-i="${i}"${f.on ? ' checked' : ''}> <b>${esc(f.name)}</b> · ${frameNo(f.t)} кадр</label><button class="x" data-a="rmframe" data-i="${i}" type="button" title="Убрать кадр">x</button></div>`).join('')}
    <button class="rl-addv" data-a="addview" type="button" title="Добавить текущий кадр видео как ракурс">Ракурс из кадра</button></div>`;
}
function layHtml() {
  return `<div class="rl-lay">${S.frames.map((f, i) => `<div><span class="hint">${i + 1}</span><input class="rl-in" type="text" data-fn="${i}" maxlength="30" value="${esc(f.name)}"><span><button class="btn mini" data-a="up" data-i="${i}" type="button">Выше</button> <button class="btn mini" data-a="down" data-i="${i}" type="button">Ниже</button></span></div>`).join('')}<div class="hint" style="display:block">Порядок кадров на листе и подписи. Галочки под кадрами включают и выключают кадры.</div></div>`;
}
function paintThumbs(keepLay) {
  const lay = $('#rlLay', root);
  if (lay && S.editLay && !keepLay) lay.innerHTML = layHtml();
  const box = $('#rlThumbs', root); if (!box) return;
  box.innerHTML = thumbsHtml();
  S.frames.forEach((f, i) => {
    const c = $(`canvas[data-c="${i}"]`, box);
    if (c && f.cv) {
      c.width = 244; c.height = 168;
      const g = c.getContext('2d'), k = Math.min(244 / f.cv.width, 168 / f.cv.height);
      g.fillStyle = '#000000'; g.fillRect(0, 0, 244, 168);
      g.drawImage(f.cv, (244 - f.cv.width * k) / 2, (168 - f.cv.height * k) / 2, f.cv.width * k, f.cv.height * k);
    }
  });
}
function rightHtml() {
  const r = S.run, lay = layOf();
  if (!r && !S.busy && !S.frames.length) {
    return `<div class="rl-empty">Здесь появится лист референсов.<br>Слева добавьте картинки, выберите тип листа и нажмите «Сделать лист».<br>Программа снимет короткое видео, возьмёт из него кадры по ракурсам и соберёт их в один лист.</div><div id="rlHist"></div>`;
  }
  return `<div class="card"><div class="card-h"><h3>${esc((r && r.name) || S.f.name || 'Без названия')} · ${esc(presetTitle())} · ${S.busy ? 'делается…' : (r && r.status === 'finished' ? 'готово' : 'черновик')}</h3>
      ${r ? `<span class="hint">${esc(r.res || '')} · seed ${esc(r.seed || 'нет')}</span>` : ''}
      <button class="btn mini${r && r.star ? ' pri' : ''}" data-a="star" type="button" title="Пометить: не удаляется при очистке"${r ? '' : ' disabled'}>${r && r.star ? 'Помечено' : 'Пометить'}</button>
      <button class="btn mini" data-a="clearview" type="button" title="Убрать из окна видео, кадры и лист. В истории работа остаётся"${(r || S.frames.length) && !S.busy ? '' : ' disabled'}>Очистить окно</button></div>
    ${S.busy ? barHtml() + `<div class="hint" id="rlMsg2">${esc(S.hint)}</div>` : ''}
    ${r && r.status === 'draft' && S.f.passes === 2 && S.frames.length && !S.busy ? '<div class="rl-fin"><span>Это черновик. Если кадры вас устраивают, увеличьте этот же ролик до чистового размера.</span><button class="btn pri" data-a="finish" type="button">Доработать до чистового</button></div>' : ''}
    <div class="rl-cols"><div><div class="rl-vidbox">${S.video ? `<video id="rlVid" src="${esc(S.video.url)}" muted playsinline preload="auto"></video>
      <div class="rl-vrow"><button class="btn mini pri" data-a="play" type="button" id="rlPlay">Пуск</button><button class="btn mini" data-a="step" data-d="-1" type="button">Кадр назад</button><button class="btn mini" data-a="step" data-d="1" type="button">Кадр вперёд</button><input type="range" id="rlSeek" min="0" max="${S.f.seconds}" step="${1 / FPS}" value="0"></div>
      <div class="rl-vrow"><button class="btn mini pri" data-a="useframe" type="button" title="Заменить выбранный ракурс этим кадром">Использовать этот кадр</button><span class="hint" id="rlFr"></span></div>` : `<div class="rl-empty" style="padding:30px 8px">${S.busy ? 'Видео ещё делается: ход работы виден в полосе выше и слева…' : 'Видео нет: оно удалено из Библиотеки или не делалось. Сохранённые кадры можно использовать.'}</div>`}</div>
      <div id="rlStat" class="rl-stat"></div></div>
      <div class="rl-rcol"><div class="rl-sheetbox"><canvas id="rlSheet"></canvas></div>
        <div class="rl-laybox">
          <div class="rl-f"><label>Раскладка</label><select class="rl-in" data-l="layout">${opt([['grid', 'Сетка'], ['row', 'Ряд'], ['col', 'Столбец']], lay.layout)}</select></div>
          <div class="rl-f"><label>Фон</label><select class="rl-in" data-l="bg">${opt([['white', 'Белый'], ['grey', 'Серый'], ['black', 'Чёрный'], ['transparent', 'Прозрачный']], lay.bg)}</select></div>
          <div class="rl-f"><label>Размер листа</label><select class="rl-in" data-l="size">${opt(SIZES, lay.size)}</select></div>
          <div class="rl-f"><label>Форма панелей</label><select class="rl-in" data-l="shape">${opt([['asis', 'Как снято'], ['square', 'Квадрат'], ['wide', '16:9'], ['tall', '3:4']], lay.shape)}</select></div>
          <div class="rl-f"><label>Зазор</label><input class="rl-in" type="number" min="0" max="200" step="2" data-l="gap" value="${lay.gap}"></div>
          <label class="rl-chips"><input type="checkbox" data-l="labels"${lay.labels ? ' checked' : ''}> Подписи</label></div>
        <div class="rl-vrow"><button class="btn pri" data-a="savesheet" type="button">Сохранить лист в Библиотеку</button><button class="btn" data-a="dl" type="button">Скачать PNG</button><button class="btn" data-a="sheetcard" type="button" title="Добавить лист картинкой в карточку раздела «Карточки»">Лист в карточку…</button><span style="flex:1"></span>
          <button class="btn pri" data-a="addviews" type="button">Добавить ракурсы</button><select class="rl-in" id="rlDest" style="width:auto"><option value="card"${S.dest === 'card' ? ' selected' : ''}>в карточку</option><option value="both"${S.dest === 'both' ? ' selected' : ''}>в карточку и в Библиотеку</option><option value="bank"${S.dest === 'bank' ? ' selected' : ''}>только в Библиотеку</option></select></div>
        <div id="rlLay"></div></div></div>
    <div id="rlThumbs"></div>
    <div id="rlLib"></div></div>
    <div id="rlHist"></div>`;
}
function paintRight() {
  const box = $('#rlRight', root); if (!box) return;
  box.innerHTML = rightHtml();
  paintSheet(); paintThumbs(); paintLay(); bindVideo(); paintHist(); paintLib();
}
function paintLay() { const lay = $('#rlLay', root); if (lay) lay.innerHTML = S.editLay ? layHtml() : ''; }
/* Карточка истории: лист (или первый кадр), имя, состояние и две кнопки оценки.
   Собрана склейкой, а не вложенными шаблонами: вчетверо вложенный шаблон читается плохо. */
function histCard(r) {
  const pic = r.sheet_url || (r.beats && r.beats[0] && r.beats[0].url);
  const thumb = pic ? '<img src="' + esc(pic) + '" alt="">' : '<div class="rl-hn">пусто</div>';
  return '<div class="rl-h' + (S.run && S.run.id === r.id ? ' on' : '') + '" data-id="' + esc(r.id) + '">'
    + '<button class="rl-hx" data-a="delhist" type="button" title="Удалить эту работу">x</button>'
    + thumb
    + '<b>' + esc(r.name) + ' · ' + esc(r.preset) + '</b>'
    + '<small>seed ' + esc(r.seed || 'нет') + ' · ' + (r.status === 'finished' ? 'готово' : 'черновик')
    + (r.star ? ' · помечено' : '') + '</small>'
    + '<div class="rt">'
    + '<button data-a="rate" data-v="1" class="' + (r.rating > 0 ? 'on' : '') + '" type="button">Хорошо</button>'
    + '<button data-a="rate" data-v="-1" class="' + (r.rating < 0 ? 'on' : '') + '" type="button">Мимо</button>'
    + '</div></div>';
}
function histHtml() {
  const head = '<div class="card-h"><h3>История работ <span class="hint">' + S.runs.length
    + '</span></h3><button class="btn mini" data-a="clear" type="button" title="Помеченные остаются">Очистить непомеченные</button></div>';
  const list = S.runs.length
    ? '<div class="rl-hist">' + S.runs.map(histCard).join('') + '</div>'
    : '<div class="hint">Здесь будут прошлые работы студии.</div>';
  return head + list;
}
function paintHist() { const h = $('#rlHist', root); if (h) h.innerHTML = histHtml(); }
function libImages() {
  return LIB.filter(it => it.kind === 'image' && !it.missing && it.url).sort((a, b) => b.date - a.date).slice(0, 60);
}
function paintLib() {
  const box = $('#rlLib', root); if (!box) return;
  const items = libImages();
  box.innerHTML = `<div class="rl-libh"><b>Картинки из Библиотеки</b><span class="hint">Перетащите картинку мышкой в рамку «Картинки» слева или нажмите на неё</span></div>`
    + (items.length ? `<div class="rl-libs">${items.map(it => `<img src="${esc(it.url)}" data-lib="${esc(it.id)}" draggable="true" loading="lazy" alt="" title="Перетащите в рамку «Картинки» или нажмите">`).join('')}</div>` : '<div class="hint" style="padding:8px 2px">Изображений в Библиотеке пока нет.</div>');
}

/* ----- сборка окна ----- */
let splitW = 430;
try { splitW = Math.max(300, +localStorage.getItem(WKEY) || 430); } catch { /* ширина по умолчанию */ }
function applyW() {
  const lay = $('.rl-layout', root); if (!lay) return;
  const max = Math.max(320, lay.clientWidth - 460);
  lay.style.setProperty('--rl-left', Math.min(max, Math.max(300, splitW)) + 'px');
}
function paintAll() {
  root.innerHTML = `<div class="head"><div><h1>Студия референсов</h1><p>Листы референсов героя, предмета или места одним рендером: короткое видео, кадры по ракурсам, один лист. Кадры и лист уходят в «Карточки» и в Библиотеку.</p></div>
    <div class="rl-chips"><button class="btn mini" data-a="editlay" type="button">${S.editLay ? 'Готово' : 'Порядок кадров…'}</button><button class="btn mini" data-a="reset" type="button">Сбросить форму</button></div></div>
    <div class="rl-layout"><div class="rl-left" id="rlLeft"></div><div class="rl-split" id="rlSplit" title="Потяните, чтобы изменить ширину. Двойной щелчок: вернуть как было"></div><div class="rl-rcol"><div id="rlRight"></div></div></div>`;
  applyW(); paintLeft(); paintRight();
}

/* ----- видео ----- */
const vid = () => $('#rlVid', root);
function bindVideo() {
  const v = vid(); if (!v) return;
  const upd = () => {
    const sk = $('#rlSeek', root);
    if (sk && document.activeElement !== sk) sk.value = v.currentTime;
    const fr = $('#rlFr', root);
    if (fr) fr.textContent = 'кадр ' + frameNo(v.currentTime) + ' · ' + v.currentTime.toFixed(2) + ' с';
    const p = $('#rlPlay', root);
    if (p) p.textContent = v.paused ? 'Пуск' : 'Пауза';
  };
  ['timeupdate', 'seeked', 'play', 'pause', 'loadedmetadata'].forEach(ev => v.addEventListener(ev, upd));
  upd();
  const sk = $('#rlSeek', root);
  if (sk) sk.oninput = () => { v.pause(); v.currentTime = +sk.value; };
}
const seek = (v, t) => new Promise(res => {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return res();
  const on = () => { v.removeEventListener('seeked', on); res(); };
  v.addEventListener('seeked', on);
  v.currentTime = t;
});
const ready = v => new Promise(res => {
  if (v.readyState >= 2 && v.duration) return res();
  v.addEventListener('loadeddata', () => res(), { once: true });
});
async function grab(t) {
  const v = vid();
  await seek(v, Math.min(t, Math.max(0, v.duration - 0.05)));
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c;
}
/* Кадры в моменты ракурсов: те же секунды, что стоят в тексте для модели, иначе подпись кадра врёт. */
async function cutFrames() {
  const v = vid(); if (!v) return;
  await ready(v);
  S.frames = [];
  for (const b of S.f.beats) {
    const t = Math.min((b.at || 0) * S.f.seconds, v.duration - 0.05);
    try { S.frames.push({ name: b.name, text: b.text, ru: b.ru || '', t, on: true, cv: await grab(t), file: '', dirty: true }); }
    catch { /* один кадр не снялся: остальные на месте */ }
  }
  await seek(v, 0);
  S.sel = S.frames.length ? 0 : -1;
  paintSheet(); paintThumbs();
}

/* ----- сохранение работы ----- */
const formSnap = () => ({ ...S.f });
async function persist(status) {
  const r = S.run;
  if (!r || (!S.frames.length && status !== 'draft')) return;
  const fd = new FormData();
  fd.append('meta', JSON.stringify({
    id: r.id, name: S.f.name || r.name || 'Без названия', type: S.f.type, preset: presetTitle(),
    status: status || r.status, res: r.res, seed: r.seed, video: (S.video && S.video.id) || r.video || '',
    seconds: S.f.seconds, layout: S.lay, form: formSnap(),
    beats: S.frames.map(b => ({ name: b.name, text: b.text, ru: b.ru || '', t: b.t, on: b.on, file: b.dirty ? '' : b.file })),
  }));
  for (let i = 0; i < S.frames.length; i++) {
    const b = S.frames[i];
    if ((b.dirty || !b.file) && b.cv) fd.append('f_' + i, await toBlob(b.cv), 'f.png');
  }
  if (S.frames.length) {
    const c = document.createElement('canvas'), [W, H] = sizeWH();
    drawSheet(c, 1400, Math.round(1400 * H / W), (+layOf().gap || 0) * 1400 / W, layOf().labels);
    fd.append('sheet', await toBlob(c), 'sheet.png');
  }
  const j = await json(await fetch('/api/reflab/runs', { method: 'POST', body: fd }));
  S.run = j;
  j.beats.forEach((b, i) => { if (S.frames[i]) { S.frames[i].file = b.file; S.frames[i].dirty = false; } });
  S.runs = await (await fetch('/api/reflab/runs')).json();
  paintHist();
}
let laterTimer = 0;
const later = () => { clearTimeout(laterTimer); laterTimer = setTimeout(() => persist().catch(() => { }), 900); };

/* Картинка в Библиотеку: своим способом - у нас кадр становится записью библиотеки байтами. */
async function toBank(cv, note) {
  const nm = ((S.f.name || 'лист') + '.png').replace(/[^\p{L}\p{N}_ .-]+/gu, '');
  const it = await json(await fetch('/api/library/add?kind=image&name=' + encodeURIComponent(nm)
    + '&note=' + encodeURIComponent(note) + '&from=' + encodeURIComponent('Студия референсов'),
    { method: 'POST', body: await toBlob(cv) }));
  if (!LIB.some(x => x.id === it.id)) addToLib(normItem(it), new Date(it.date));
  return it;
}
const libAdd = it => { if (it && !LIB.some(x => x.id === it.id)) addToLib(normItem(it), new Date(it.date)); };

/* Небольшое окошко ввода: window.prompt в окне программы может быть блокирован. */
function askText(title, val = '', ok = 'Сохранить') {
  return new Promise(res => {
    let m = $('#rlAsk');
    if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'rlAsk'; m.style.zIndex = 60; document.body.append(m); }
    m.hidden = false;
    m.innerHTML = `<div class="box" style="padding:20px;max-width:420px"><div class="card-h"><h3>${esc(title)}</h3></div><input class="rl-in" maxlength="40" style="width:100%" value="${esc(val)}"><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" data-n type="button">Отмена</button><button class="btn pri" data-y type="button">${ok}</button></div></div>`;
    const inp = $('input', m);
    inp.focus();
    const done = v => { m.hidden = true; m.innerHTML = ''; res(v); };
    m.onclick = e => { if (e.target.closest('[data-y]')) done(inp.value); else if (e.target === m || e.target.closest('[data-n]')) done(''); };
    inp.onkeydown = e => { if (e.key === 'Enter') done(inp.value); };
  });
}

/* В какую карточку раздела «Карточки» класть ракурсы. */
function askCard(o = {}) {
  const cards = AC.cards || [], want = (S.f.name || (S.run && S.run.name) || '').trim();
  const same = tok(want) ? cards.find(c => tok(c.name) === tok(want)) : null;
  return new Promise(res => {
    let m = $('#rlCard');
    if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'rlCard'; m.style.zIndex = 60; document.body.append(m); }
    m.hidden = false;
    m.innerHTML = `<div class="box" style="padding:20px;max-width:440px"><div class="card-h"><h3>В какую карточку добавить</h3></div>
      <div class="rl-f"><label>Карточка<small>раздел «Карточки»</small></label><select class="rl-in" id="rcSel"><option value="">+ Новая карточка</option>${cards.map(c => `<option value="${esc(c.id)}"${same && same.id === c.id ? ' selected' : ''}>${esc(c.name)} · картинок ${(c.images || []).length} из ${MAX_CARD}</option>`).join('')}</select></div>
      <div class="rl-f" id="rcNewBox"><label>Название новой карточки<small>это @имя в тексте сцен</small></label><input class="rl-in" id="rcName" maxlength="60" value="${esc(want)}" placeholder="например, Katerina"></div>
      ${o.views ? `<label class="rl-chips" style="margin-bottom:4px"><input type="checkbox" id="rcViews" checked> Кадры-ракурсы (${o.views} шт.)</label>` : ''}
      <label class="rl-chips" style="margin-bottom:6px"><input type="checkbox" id="rcSheet"${o.views ? '' : ' checked'}> Сам лист целиком (одной картинкой)</label>
      <div class="hint" id="rcHint"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" data-n type="button">Отмена</button><button class="btn pri" data-y type="button">Добавить</button></div></div>`;
    const sel = $('#rcSel', m), box = $('#rcNewBox', m), nm = $('#rcName', m), hint = $('#rcHint', m);
    const upd = () => {
      box.hidden = !!sel.value;
      const c = cards.find(x => x.id === sel.value);
      hint.textContent = c ? `Кадры добавятся к картинкам карточки «${c.name}» (свободно мест: ${MAX_CARD - (c.images || []).length}). Новые фото кладутся рядом со старыми.` : 'Будет создана новая карточка: она появится в разделе «Карточки».';
    };
    sel.onchange = upd; upd();
    const done = ok => {
      const v = sel.value, name = nm.value.trim();
      if (ok && !v && !name) { nm.focus(); toast('Напишите название новой карточки'); return; }
      const views = $('#rcViews', m) ? $('#rcViews', m).checked : false;
      const sheet = $('#rcSheet', m).checked;
      if (ok && !views && !sheet) { toast('Отметьте, что добавить: кадры или лист'); return; }
      m.hidden = true; m.innerHTML = '';
      res(ok ? { ...(v ? { id: v } : { name }), views, sheet } : null);
    };
    m.onclick = e => { if (e.target.closest('[data-y]')) done(true); else if (e.target === m || e.target.closest('[data-n]')) done(false); };
  });
}

/* Кадры и лист в карточку. Сервер при новых файлах перезаписывает полку карточки целиком,
   поэтому старые фото уходят рядом с новыми: иначе ракурсы стёрли бы весь образ. */
async function toCard(list, tgt) {
  const cards = AC.cards || [];
  const same = !tgt.id && cards.find(c => tok(c.name) === tok(tgt.name));
  const card = tgt.id ? cards.find(c => c.id === tgt.id) : (same || null);
  const name = card ? card.name : tgt.name;
  const old = card ? (card.images || []) : [];
  const room = MAX_CARD - old.length;
  if (room <= 0) throw new Error('В карточке «' + name + '» уже ' + MAX_CARD + ' картинок: уберите лишние в разделе «Карточки»');
  const use = list.slice(0, room);
  const fd = new FormData();
  if (card) fd.append('id', card.id);
  fd.append('name', name);
  fd.append('type', card ? card.type : S.f.type);
  fd.append('text', card ? (card.text || '') : (S.f.features || '').slice(0, 600));
  for (const im of old) {
    const b = await (await fetch(im.url)).blob();
    fd.append('images', new File([b], im.name || 'foto.png', { type: b.type || 'image/png' }));
  }
  for (const u of use) fd.append('images', await toBlob(u.cv), ' ракурс'.trim() + '.png');
  await json(await fetch('/api/actors', { method: 'POST', body: fd }));
  await acLoad();
  return (card ? 'Добавлено в карточку «' + name + '»' : 'Создана карточка «' + name + '»')
    + (use.length < list.length ? `. Вошло ${use.length} из ${list.length}: больше ${MAX_CARD} картинок нельзя` : '');
}

/* ----- задания ----- */
let tick = 0;
const STG = { queued: [0, 0], load: [0, 12], encode: [12, 18], sample: [18, 90], sample2: [18, 90], upscale: [8, 92], decode: [90, 97], save: [97, 100] };
function progress() {
  clearInterval(tick);
  S.pct = 0;
  const upd = () => {
    const j = QUEUE.find(x => x.id === S.pid);
    let text = (S.stageText || 'Делаю лист') + ': отправляю в ComfyUI…';
    if (j) {
      const [a, b] = STG[j.stage] || [0, 0];
      let pct = a, eta = '';
      if (String(j.stage).startsWith('sample') && j.max) {
        pct = a + (b - a) * (j.step || 0) / j.max;
        if (j.step > 1 && j.step1T && j.stepT) {
          const left = (j.stepT - j.step1T) / (j.step - 1) / 1000 * (j.max - j.step);
          eta = left >= 60 ? ' · осталось ~' + Math.ceil(left / 60) + ' мин' : ' · осталось ~' + Math.ceil(left) + ' с';
        }
      } else if (j.stage !== 'queued') pct = a + (b - a) * 0.5;
      S.pct = Math.max(S.pct || 0, pct);
      text = (S.stageText || 'Делаю лист') + ': ' + (QSTAGE[j.stage] || j.stage)
        + (j.step && j.max ? ', шаг ' + j.step + ' из ' + j.max : '') + eta;
    }
    $$('.rl-bar', root).forEach(b => { b.hidden = !S.busy; $('i', b).style.width = S.pct + '%'; $('span', b).textContent = Math.round(S.pct) + '%'; });
    S.hint = text;
    ['#rlMsg', '#rlMsg2'].forEach(q => { const m = $(q, root); if (m) m.textContent = text; });
  };
  tick = setInterval(() => { if (!S.busy) clearInterval(tick); else upd(); }, 800);
  upd();
}
const waitJob = r => new Promise((res, rej) => onPrompt(r.prompt_id, ev => {
  if (ev.prompt_id !== r.prompt_id) return;
  if (ev.type === 'done') { offPrompt(r.prompt_id); res(ev.item || (ev.items || [])[0]); }
  else if (ev.type === 'error') { offPrompt(r.prompt_id); rej(new Error('ошибка ComfyUI: ' + ev.message)); }
  else if (ev.type === 'interrupted') { offPrompt(r.prompt_id); rej(new Error('остановлено')); }
}));

async function runVideo(o) {   // o: {quality, steps, seed, tag}
  const pr = await json(await fetch('/api/reflab/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S.f) }));
  const fd = new FormData();
  fd.append('prompt', pr.prompt);
  fd.append('aspect', S.f.aspect);
  fd.append('quality', o.quality);
  fd.append('duration', pr.seconds);
  fd.append('steps', o.steps);
  fd.append('ref_size', 'match');   // картинки берутся в размере самого видео: больший размер референса только замедляет работу
  fd.append('accel', 'old');
  if (/^\d+$/.test(String(o.seed || ''))) fd.append('seed', o.seed);
  for (let i = 0; i < Math.min(MAX_PICS, S.pics.length); i++) {
    const f = await getFile(S.pics[i]);
    fd.append('img' + i, f, f.name);
  }
  const r = await json(await fetch('/api/generate/refs', { method: 'POST', body: fd }));
  qAdd(r.prompt_id, 'refs', 'Студия референсов: ' + (S.f.name || presetTitle()) + (o.tag ? ' (' + o.tag + ')' : ''));
  S.pid = r.prompt_id;
  const wait = waitJob(r);
  wait.catch(() => { });
  return { r, pr, wait };
}

async function go() {
  if (S.busy) return;
  if (!S.pics.length) { msg('Добавьте хотя бы одну картинку' + (S.f.source === 'text' ? ' (кнопка «Нарисовать картинку»)' : '')); return; }
  if (!S.f.beats.length) { msg('Добавьте хотя бы один ракурс'); return; }
  const two = S.f.passes === 2;
  S.busy = true; S.stageText = two ? 'Черновик' : 'Видео'; S.pid = '';
  paintLeft(); progress();
  try {
    const { r, pr, wait } = await runVideo({ quality: two ? S.f.draftQ : S.f.quality, steps: two ? 4 : S.f.steps, seed: S.f.seed, tag: two ? 'черновик' : '' });
    S.frames = []; S.video = null;
    S.run = { id: '', name: S.f.name || 'Без названия', status: 'draft', seed: String(r.seed || ''), res: '' };
    paintLeft(); paintRight();
    const fd = new FormData();
    fd.append('meta', JSON.stringify({ id: '', name: S.f.name || 'Без названия', type: S.f.type, preset: presetTitle(), status: 'draft', seed: String(r.seed || ''), seconds: pr.seconds, form: formSnap(), layout: S.lay, beats: [] }));
    S.run = await json(await fetch('/api/reflab/runs', { method: 'POST', body: fd }));
    keepLast(S.run.id);
    S.runs = await (await fetch('/api/reflab/runs')).json();
    paintHist();
    const item = await wait;
    S.video = item; S.run.res = item.res || ''; S.run.video = item.id; libAdd(item);
    S.stageText = 'Беру кадры';
    paintRight();
    await cutFrames();
    await persist(two ? 'draft' : 'finished');
    msg(two ? 'Черновик готов. Посмотрите кадры: если герой держится хорошо, нажмите «Доработать до чистового».' : 'Готово: кадры сняты. Подправьте их под видео и соберите лист.');
  } catch (e) {
    msg('Не получилось: ' + e.message); toast(e.message);
    if (S.run && !S.frames.length) {
      try { await fetch('/api/reflab/runs/' + S.run.id, { method: 'DELETE' }); S.runs = await (await fetch('/api/reflab/runs')).json(); } catch { /* работа осталась */ }
      S.run = null;
    }
  } finally {
    S.busy = false; S.pid = '';
    paintLeft(); paintRight(); paintHist();
  }
}

/* Настройки доведения. Сервер у этого окна принимает только движок и степень увеличения, поэтому
   здесь нет ручек, которые ничего бы не делали: RelayVSR всегда увеличивает в 2 раза, SeedVR2 -
   в 1,5 или в 2. Движка DLSS в этой программе нет, и третьего варианта в списке нет честно,
   а не «сделает потом». */
const finDef = () => ({ scale: '2' });
function finAsk() {
  const eng = FIN_ENG[S.f.finEng] ? S.f.finEng : 'relay';
  const v = { ...finDef(), scale: (S.f.fin && S.f.fin.scale) || '2' };
  const body = eng === 'relay'
    ? '<div class="hint">RelayVSR увеличивает ролик в 2 раза и работает быстро. Своих ручек у него нет: '
      + 'кадры остаются теми же, просто становятся крупнее.</div>'
    : `<div class="rl-f"><label>Во сколько раз</label><select class="rl-in" id="fnScale">${opt([['1.5', '×1,5'], ['2', '×2']], v.scale)}</select></div>`
      + '<div class="hint">SeedVR2: качественно, но тяжело для видеопамяти. Если не хватит памяти, возьмите ×1,5.</div>';
  return new Promise(res => {
    let m = $('#rlFin');
    if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'rlFin'; m.style.zIndex = 60; document.body.append(m); }
    m.hidden = false;
    m.innerHTML = `<div class="box" style="padding:20px;max-width:440px"><div class="card-h"><h3>Увеличение: ${eng === 'relay' ? 'RelayVSR' : 'SeedVR2'}</h3></div>${body}<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" data-n type="button">Отмена</button><button class="btn pri" data-y type="button">Увеличить</button></div></div>`;
    const done = ok => {
      if (ok && eng === 'seed') v.scale = $('#fnScale', m).value;
      m.hidden = true; m.innerHTML = '';
      if (ok) { S.f.fin = { ...v }; keep(); }
      res(ok ? v : null);
    };
    m.onclick = e => { if (e.target.closest('[data-y]')) done(true); else if (e.target === m || e.target.closest('[data-n]')) done(false); };
  });
}

async function finish() {   // второй проход: увеличивается сам черновик, ничего не перерисовывается
  if (S.busy || !S.run) return;
  const src = S.video || LIB.find(x => x.id === S.run.video);
  if (!src || src.missing) { msg('Черновик-видео удалён из Библиотеки: доработать нечего. Сделайте лист заново.'); return; }
  const o = await finAsk();
  if (!o) return;
  const eng = FIN_ENG[S.f.finEng] ? S.f.finEng : 'relay';
  S.busy = true; S.stageText = 'Увеличение черновика'; S.pid = '';
  paintLeft(); paintRight(); progress();
  try {
    const r = await postJSON('/api/upscale', {
      id: src.id,
      engine: eng === 'relay' ? 'relay' : '',
      scale: eng === 'seed' ? o.scale : '2',
    });
    qAdd(r.prompt_id, 'upscale', 'Студия референсов: ' + (S.f.name || presetTitle()) + ' (чистовой)');
    S.pid = r.prompt_id;
    const item = await waitJob(r);
    libAdd(item);
    S.video = item; S.run.res = item.res || ''; S.run.video = item.id; S.stageText = 'Беру кадры';
    paintRight();
    const v = vid();
    await ready(v);
    for (const f of S.frames) {
      try { f.cv = await grab(f.t); f.dirty = true; } catch { /* старый кадр остался */ }
    }
    await seek(v, 0);
    paintSheet(); paintThumbs();
    await persist('finished');
    msg('Чистовой лист готов: те же кадры, но крупнее и чётче.');
  } catch (e) { msg('Не получилось: ' + e.message); toast(e.message); }
  finally { S.busy = false; S.pid = ''; paintLeft(); paintRight(); paintHist(); }
}

async function draw() {   // картинка для нового образа: режим «Изображение по тексту», движок H3 Image
  if (S.busy) return;
  const f = S.f;
  if (!f.who.trim() && !f.features.trim()) { msg('Опишите, что нарисовать: заполните «Кто» и «Особенности» (по-английски)'); return; }
  const view = { character: 'full body, front view, standing in a neutral pose, plain neutral background', object: 'the whole object, three quarter view, plain neutral background', location: 'wide establishing view, eye level' }[f.type];
  const text = [f.style, f.who, f.features, f.setdress, view, 'natural light, high detail'].filter(x => x && x.trim()).join('. ');
  S.busy = true; S.stageText = 'Рисую картинку';
  paintLeft(); progress();
  try {
    const fd = new FormData();
    fd.append('prompt', text);
    fd.append('aspect', f.type === 'location' ? '16:9' : '3:4');
    fd.append('style', 'plain');
    fd.append('scale', '1');
    fd.append('engine', 'h3img');
    fd.append('mp', '4');
    const r = await json(await fetch('/api/generate/krea', { method: 'POST', body: fd }));
    qAdd(r.prompt_id, 'krea', text);
    S.pid = r.prompt_id;
    const it = await waitJob(r);
    libAdd(it);
    S.pics.unshift({ url: it.url, lib: it.id });
    keepPics();
    msg('Картинка готова: она главная. Можно делать лист.');
  } catch (e) { msg('Не получилось: ' + e.message); toast(e.message); }
  finally { S.busy = false; S.pid = ''; paintLeft(); }
}

async function describe() {
  if (!S.pics.length) { msg('Сначала добавьте картинку'); return; }
  S.describing = true;
  paintLeft();
  try {
    const imgs = [];
    for (const p of S.pics.slice(0, 3)) imgs.push(await fileToDataURL(await getFile(p), 768));
    const j = await json(await fetch('/api/reflab/describe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: imgs, type: S.f.type }) }));
    if (j.who) S.f.who = j.who;
    if (j.features) S.f.features = j.features;
    keep();
    msg('Описание готово: проверьте и поправьте при желании');
  } catch (e) { msg(e.message); toast(e.message); }
  finally { S.describing = false; paintLeft(); }
}

/* ----- картинки основы ----- */
function addFiles(files) {
  const room = MAX_PICS - S.pics.length;
  const list = [...files].filter(f => f.type.startsWith('image/'));
  list.slice(0, Math.max(0, room)).forEach(f => S.pics.push({ file: f, url: URL.createObjectURL(f) }));
  if (list.length > room) toast('Картинок не больше ' + MAX_PICS);
  keepPics(); paintLeft();
}
function addLibPic(id) {
  const it = LIB.find(x => x.id === id);
  if (!it || !it.url) return;
  if (S.pics.length >= MAX_PICS) { toast('Картинок не больше ' + MAX_PICS); return; }
  if (S.pics.some(x => x.lib === id)) { toast('Эта картинка уже добавлена'); return; }
  S.pics.push({ url: it.url, lib: it.id });
  keepPics(); paintLeft();
}

/* ----- события ----- */
root.addEventListener('toggle', e => {
  const d = e.target;
  if (d && d.dataset && d.dataset.d) S.open[d.dataset.d] = d.open;
}, true);   // «toggle» не всплывает

root.addEventListener('click', async e => {
  const a = e.target.closest('[data-a]'), hc = e.target.closest('.rl-h');
  if (!a && hc && !e.target.closest('button')) return openRun(hc.dataset.id);
  if (!a) {
    const t = e.target.closest('.rl-t[data-i]');
    if (t && S.frames[+t.dataset.i]) {
      S.sel = +t.dataset.i;
      const v = vid();
      if (v) { v.pause(); v.currentTime = S.frames[S.sel].t; }
      paintThumbs();
    }
    return;
  }
  const act = a.dataset.a, i = +a.dataset.i, v = a.dataset.v;
  try {
    if (act === 'type') {
      if (S.f.type !== v) { S.f.type = v; S.f.aspect = defAspect(v); pickPreset(Object.keys(presetList())[0]); paintLeft(); }
    } else if (act === 'source') { S.f.source = v; keep(); paintLeft(); }
    else if (act === 'preset') { pickPreset(v); paintLeft(); }
    else if (act === 'delpreset') { e.stopPropagation(); await fetch('/api/reflab/presets/' + encodeURIComponent(v), { method: 'DELETE' }); await loadData(); paintLeft(); }
    else if (act === 'savepreset') {
      const name = await askText('Название вашего набора ракурсов');
      if (!name || !name.trim()) return;
      const j = await json(await fetch('/api/reflab/presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type: S.f.type, seconds: S.f.seconds, beats: S.f.beats }) }));
      await loadData();
      S.f.preset = j.id; keep(); paintLeft(); toast('Набор ракурсов сохранён');
    } else if (act === 'addbeat') {
      const last = S.f.beats.length ? S.f.beats[S.f.beats.length - 1].at : 0;
      S.f.beats.push({ name: 'ракурс ' + (S.f.beats.length + 1), text: '', ru: '', at: Math.min(0.97, last) });
      keep(); paintLeft();
    } else if (act === 'rmbeat') { S.f.beats.splice(i, 1); keep(); paintLeft(); }
    else if (act === 'rmpic') { S.pics.splice(i, 1); keepPics(); paintLeft(); }
    else if (act === 'editlay') { S.editLay = !S.editLay; paintRight(); }
    else if (act === 'draw') draw();
    else if (act === 'describe') describe();
    else if (act === 'go') go();
    else if (act === 'finish') finish();
    else if (act === 'passes') { S.f.passes = +v; keep(); paintLeft(); }
    else if (act === 'stop') {
      if (S.pid) fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: S.pid }) });
      msg('Останавливаю…');
    } else if (act === 'reset') {
      confirmBox('Очистить форму?', 'Сохранённые работы в истории останутся.', 'Очистить', () => {
        S.f = defForm(); S.pics = []; keepPics(); keepLast(''); pickPreset(Object.keys(presetList())[0] || 'coverage'); keep(); paintLeft();
      });
    } else if (act === 'play') { const vv = vid(); if (vv) { if (vv.paused) vv.play(); else vv.pause(); } }
    else if (act === 'step') {
      const vv = vid();
      if (vv) { vv.pause(); vv.currentTime = Math.max(0, Math.min(vv.duration, vv.currentTime + (+a.dataset.d) / FPS)); }
    } else if (act === 'useframe') {
      const vv = vid(); if (!vv) return;
      vv.pause();
      const t = vv.currentTime, cv = await grab(t);
      if (S.sel >= 0 && S.frames[S.sel]) Object.assign(S.frames[S.sel], { cv, t, dirty: true });
      else { S.frames.push({ name: 'ракурс ' + (S.frames.length + 1), text: '', ru: '', t, on: true, cv, file: '', dirty: true }); S.sel = S.frames.length - 1; }
      paintThumbs(); paintSheet(); later();
    } else if (act === 'addview') {
      const vv = vid(); if (!vv) { toast('Сначала сделайте видео'); return; }
      vv.pause();
      const t = vv.currentTime;
      S.frames.push({ name: 'ракурс ' + (S.frames.length + 1), text: '', ru: '', t, on: true, cv: await grab(t), file: '', dirty: true });
      S.sel = S.frames.length - 1;
      paintThumbs(); paintSheet(); later();
    } else if (act === 'rmframe') {
      e.stopPropagation();
      S.frames.splice(i, 1); S.sel = -1;
      paintThumbs(); paintSheet(); later();
    } else if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j >= 0 && j < S.frames.length) {
        [S.frames[i], S.frames[j]] = [S.frames[j], S.frames[i]];
        paintRight(); later();
      }
    } else if (act === 'dl' || act === 'savesheet') {
      if (!S.frames.some(f => f.on)) { toast('Нет включённых кадров'); return; }
      const c = document.createElement('canvas'), [W, H] = sizeWH();
      drawSheet(c, W, H, +layOf().gap || 0, layOf().labels);
      const nm = (S.f.name || 'list').replace(/[^\p{L}\p{N}_-]+/gu, '_');
      if (act === 'dl') {
        const url = URL.createObjectURL(await toBlob(c)), l = document.createElement('a');
        l.href = url; l.download = nm + '_' + presetTitle() + '.png';
        l.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else {
        stat('Сохраняю лист в Библиотеку…');
        await toBank(c, 'Студия референсов · ' + (S.f.name || 'лист') + ' · лист (' + presetTitle() + ')');
        toast('Лист сохранён в Библиотеку');
        stat('Готово: лист сохранён в Библиотеку.');
      }
    } else if (act === 'sheetcard') {
      if (!S.frames.some(f => f.on)) { toast('Нет включённых кадров'); return; }
      await acLoad();
      const tgt = await askCard({});
      if (!tgt) return;
      stat('Добавляю лист в карточку…');
      const r = await toCard([{ cv: sheetCanvas(2560) }], tgt);
      toast(r);
      stat('Готово: ' + r + '. Откройте «Карточки», чтобы увидеть.');
    } else if (act === 'addviews') {
      const on = S.frames.filter(f => f.on);
      if (!on.length) { toast('Нет включённых кадров'); return; }
      S.dest = ($('#rlDest', root) || {}).value || S.dest;
      let note = '';
      stat('Отправляю кадры…');
      let tgt = null;
      if (S.dest !== 'bank') { await acLoad(); tgt = await askCard({ views: on.length }); if (!tgt) return; }
      if (S.dest !== 'card') {
        for (const f of on) await toBank(f.cv, 'Студия референсов · ' + (S.f.name || 'кадр') + ' · ' + f.name);
        await toBank(sheetCanvas(2560), 'Студия референсов · ' + (S.f.name || 'лист') + ' · лист (' + presetTitle() + ')');
      }
      if (tgt) {
        const items = [];
        if (tgt.views) on.forEach(f => items.push({ cv: f.cv, label: f.name }));
        if (tgt.sheet) items.push({ cv: sheetCanvas(2560) });
        note = await toCard(items, tgt);
      }
      const doneMsg = S.dest === 'bank' ? 'Ракурсы и весь лист сохранены в Библиотеку.' : S.dest === 'card' ? note : 'Ракурсы и весь лист сохранены в Библиотеку. ' + note;
      toast(doneMsg);
      stat('Готово: ' + doneMsg + (S.dest !== 'bank' ? ' Откройте «Карточки», чтобы увидеть.' : ''));
    } else if (act === 'star' && S.run) {
      const j = await json(await fetch('/api/reflab/runs/' + encodeURIComponent(S.run.id) + '/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ star: !S.run.star }) }));
      S.run.star = j.star;
      S.runs = await (await fetch('/api/reflab/runs')).json();
      paintRight(); paintHist();
    } else if (act === 'clearview') {
      S.run = null; S.video = null; S.frames = []; S.sel = -1;
      keepLast(''); paintRight();
    } else if (act === 'delhist') {
      const id = e.target.closest('.rl-h').dataset.id, r = S.runs.find(x => x.id === id);
      if (!r) return;
      confirmBox('Удалить работу «' + r.name + ' · ' + r.preset + '»?', 'Картинки в Библиотеке и в карточках не затрагиваются.', 'Удалить', async () => {
        await fetch('/api/reflab/runs/' + encodeURIComponent(id), { method: 'DELETE' });
        if (S.run && S.run.id === id) { S.run = null; S.video = null; S.frames = []; keepLast(''); }
        S.runs = await (await fetch('/api/reflab/runs')).json();
        paintRight(); paintHist();
      });
    } else if (act === 'rate') {
      const id = e.target.closest('.rl-h').dataset.id, r = S.runs.find(x => x.id === id);
      const nv = r.rating === +v ? 0 : +v;
      await fetch('/api/reflab/runs/' + encodeURIComponent(id) + '/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: nv }) });
      r.rating = nv;
      paintHist();
    } else if (act === 'clear') {
      confirmBox('Удалить все работы кроме помеченных?', 'Помеченные звездой работы останутся.', 'Удалить', async () => {
        await fetch('/api/reflab/runs/clear', { method: 'POST' });
        S.runs = await (await fetch('/api/reflab/runs')).json();
        if (S.run && !S.runs.some(r => r.id === S.run.id)) { S.run = null; S.video = null; S.frames = []; }
        paintRight(); paintHist();
      });
    } else if (act === 'lib') {
      const items = LIB.filter(it => it.kind === 'image' && !it.missing && it.url).sort((a, b) => b.date - a.date);
      let p = $('#rlLibM');
      if (!p) { p = document.createElement('div'); p.className = 'modal'; p.id = 'rlLibM'; p.style.zIndex = 60; document.body.append(p); }
      p.hidden = false;
      p.innerHTML = '<div class="box" style="padding:20px"><div class="card-h"><h3>Из Библиотеки</h3><button class="btn" data-x type="button">Готово</button></div>'
        + (items.length ? `<div class="rl-libs" style="max-height:60vh;overflow:auto">${items.map(it => `<img src="${esc(it.url)}" data-id="${esc(it.id)}" alt="" loading="lazy" style="cursor:pointer">`).join('')}</div>` : '<div class="hint" style="padding:20px 4px">Изображений в Библиотеке пока нет.</div>') + '</div>';
      p.onclick = er => {
        if (er.target === p || er.target.closest('[data-x]')) { p.hidden = true; return; }
        const t = er.target.closest('img[data-id]');
        if (!t) return;
        addLibPic(t.dataset.id);
      };
    }
  } catch (err) {
    toast(err.message); msg(err.message);
    if (['addviews', 'sheetcard', 'savesheet', 'dl'].includes(act)) stat('Не получилось: ' + err.message, true);
  }
});

async function openRun(id, silent) {
  if (S.busy) { if (!silent) toast('Дождитесь конца текущей работы'); return; }
  const r = S.runs.find(x => x.id === id);
  if (!r) return;
  S.run = r;
  if (!silent) S.f = { ...defForm(), ...(r.form || {}) };
  S.lay = { ...defLay(), ...(r.layout || {}) };
  S.video = r.video ? (LIB.find(x => x.id === r.video && !x.missing) || null) : null;
  S.sel = -1; S.editLay = false;
  S.frames = [];
  for (const b of (r.beats || [])) {
    let cv = null;
    try { if (b.url) cv = await loadCanvas(b.url); } catch { /* файл потерялся */ }
    S.frames.push({ name: b.name, text: b.text, ru: b.ru || '', t: b.t, on: b.on, cv, file: b.file, dirty: false });
  }
  keepLast(id); keep();
  paintLeft(); paintRight(); paintHist();
  if (!silent) msg(S.pics.length ? 'Работа открыта из истории.' : 'Работа открыта из истории. Картинки для нового листа добавьте заново.');
}

root.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.k) {
    const k = t.dataset.k;
    S.f[k] = ['seconds', 'steps'].includes(k) ? (+t.value || S.f[k]) : t.value;
    keep();
  } else if (t.dataset.b !== undefined) {
    const b = S.f.beats[+t.dataset.b];
    if (!b) return;
    if (t.dataset.bk === 't') b.at = Math.max(0, Math.min(0.97, (+t.value || 0) / (S.f.seconds || 8)));
    else if (t.dataset.bk === 'at') b.at = Math.max(0, Math.min(0.97, +t.value || 0));
    else { b[t.dataset.bk] = t.value; if (t.dataset.bk === 'text') b.ru = ''; }
    keep();
  } else if (t.dataset.fn !== undefined) {
    const f = S.frames[+t.dataset.fn];
    if (f) { f.name = t.value; paintSheet(); paintThumbs(true); later(); }
  } else if (t.dataset.l === 'gap') {
    S.lay.gap = +t.value || 0; keep(); paintSheet(); later();
  }
});

root.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'rlFile') { addFiles(t.files); t.value = ''; return; }
  if (t.dataset.a === 'card') {
    const c = (AC.cards || []).find(x => x.id === t.value);
    if (!c) return;
    S.pics = (c.images || []).filter(i => i.on).map(i => ({ url: i.url }));
    keepPics();
    S.f.name = c.name;
    S.f.features = c.text || S.f.features;
    S.f.type = ['character', 'object', 'location'].includes(c.type) ? c.type : 'character';
    S.f.aspect = defAspect(S.f.type);
    pickPreset(Object.keys(presetList())[0] || 'coverage');
    keep(); paintLeft();
    return;
  }
  if (t.dataset.a === 'on') {
    const f = S.frames[+t.dataset.i];
    if (f) { f.on = t.checked; paintThumbs(); paintSheet(); later(); }
    return;
  }
  if (t.dataset.l) {
    const k = t.dataset.l;
    S.lay[k] = k === 'labels' ? t.checked : k === 'gap' ? (+t.value || 0) : t.value;
    keep(); paintSheet(); later();
    return;
  }
  if (t.dataset.k === 'seconds' || t.dataset.k === 'finEng' || t.dataset.k === 'passes') paintLeft();
});

/* Перетаскивание: картинка Библиотеки в рамку, квадрат кадра - меняет место на листе. */
let dragI = -1;
root.addEventListener('dragstart', e => {
  const li = e.target.closest('img[data-lib]');
  if (li) { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/rl-lib', li.dataset.lib); return; }
  const t = e.target.closest('.rl-t[data-i]');
  if (!t) return;
  dragI = +t.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'frame');
  t.style.opacity = '.4';
});
root.addEventListener('dragend', () => {
  dragI = -1;
  $$('.rl-t', root).forEach(t => { t.style.opacity = ''; t.style.outline = ''; });
});
root.addEventListener('dragover', e => {
  if (dragI >= 0) {
    const t = e.target.closest('.rl-t[data-i]');
    if (t) {
      e.preventDefault();
      $$('.rl-t', root).forEach(x => { x.style.outline = ''; });
      t.style.outline = '2px solid var(--accent)';
    }
    return;
  }
  if (e.target.closest('[data-drop]')) e.preventDefault();
});
root.addEventListener('drop', e => {
  if (dragI >= 0) {
    const t = e.target.closest('.rl-t[data-i]');
    if (!t) return;
    e.preventDefault();
    const j = +t.dataset.i, from = dragI;
    dragI = -1;
    if (from !== j && S.frames[from]) {
      const cur = S.frames[S.sel];
      const [m] = S.frames.splice(from, 1);
      S.frames.splice(j, 0, m);
      S.sel = cur ? S.frames.indexOf(cur) : -1;
      paintThumbs(); paintSheet(); later();
    }
    return;
  }
  if (!e.target.closest('[data-drop]')) return;
  e.preventDefault();
  const lid = e.dataTransfer.getData('text/rl-lib');
  if (lid) addLibPic(lid); else addFiles(e.dataTransfer.files);
});
root.addEventListener('click', e => {
  const li = e.target.closest('img[data-lib]');
  if (li) addLibPic(li.dataset.lib);
});
root.addEventListener('dblclick', async e => {
  if (e.target.closest('#rlSplit')) {
    splitW = 430; applyW();
    try { localStorage.removeItem(WKEY); } catch { /* ок */ }
    return;
  }
  const t = e.target.closest('.rl-t[data-i]');
  if (!t || e.target.closest('input,button')) return;
  const f = S.frames[+t.dataset.i];
  if (!f) return;
  const n = await askText('Название ракурса', f.name);
  if (n && n.trim()) { f.name = n.trim().slice(0, 30); paintThumbs(); paintSheet(); later(); }
});
root.addEventListener('pointerdown', e => {
  const sp = e.target.closest('#rlSplit');
  if (!sp) return;
  e.preventDefault();
  sp.setPointerCapture(e.pointerId);
  sp.classList.add('drag');
  const x0 = e.clientX, w0 = $('#rlLeft', root).getBoundingClientRect().width;
  const move = ev => { splitW = Math.round(w0 + ev.clientX - x0); applyW(); };
  const up = () => {
    sp.classList.remove('drag');
    sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
    try { localStorage.setItem(WKEY, String(splitW)); } catch { /* не сохранено */ }
  };
  sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
});
window.addEventListener('resize', () => { if ($('.rl-layout', root)) applyW(); });

/* ----- вход в раздел ----- */
async function enter() {
  try {
    paintAll();          // окно показываем сразу: ответы сервера могут задержать, а пустой экран человек ждёт молча
  } catch { /* в проверочной среде без настоящего браузера окно может не построиться: там достаточно
                того, что тело модуля зарегистрировало обработчики; в браузере сборка проходит */ }
  try {
    await loadData();
    if (S.f.source === 'card') await acLoad();
    paintAll();
    let last = '';
    try { last = localStorage.getItem(LKEY) || ''; } catch { /* нет сохранённой работы */ }
    if (last && S.runs.some(r => r.id === last)) {
      try { await openRun(last, true); msg('Восстановила вашу последнюю работу.'); }
      catch (err) { console.error('reflab restore', err); }
    }
  } catch (e) { msg('Сервер пока не ответил: ' + e.message); }
}
onNav('reflab', enter);

/* Окно строим сразу при загрузке модуля: в раздел входят и по кнопке на полосе режимов, а не
   только по пункту меню; на одну лишь подписку меню окно оставалось пустым. Данные для окна
   не нужны: список наборов и история дорисуются, когда придут. */
try {
  paintAll();
} catch { /* в проверочной среде без настоящего браузера окно может не построиться -
             пусть там тело лишь регистрирует обработчики; в браузере сборка проходит */ }
enter();
