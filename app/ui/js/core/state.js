import { $, $$, esc, fmtDate, normItem, toast } from './util.js';
import { goTo } from './tabs.js';
import { ASPECTS, QUALITY_ALL } from '../ui/params.js';
/* Разделы отсюда НЕ импортируются. Импорт раздела означал бы, что хаб исполняется
   ПОСЛЕ раздела, и любое общее значение, прочитанное разделом у себя в теле, падало
   бы с «Cannot access before initialization» - на этом страница и вставала без
   вкладок. Разделы сами приносят сюда свои значения через registerViews. */

export const LIB = [];
// a frame or a piece of sound arrives from a button, not from a run: the list is a shared array, so it
// can be refilled in place, and the side tray is told to repaint - otherwise it shows yesterday's shelf
window.h3ReloadLibrary = async () => {
  try {
    const items = await (await fetch('/api/library')).json();
    LIB.length = 0;
    items.forEach(it => LIB.push(typeof normItem === 'function' ? normItem(it) : it));
    // refilling the array is not enough: the list on the screen is drawn by renderLib, and the tray is a
    // different thing - a keepsake that only reaches the array is a file the person cannot see
    try { window.renderLib?.(); } catch (e) { }
    try { window.trayFill?.(); } catch (e) { }
  } catch (e) { }
};
export const IMG_PANELS = [];  // refresh functions of the picture result windows
/* ---------- общая очередь заданий ---------- */
export const QUEUE = [];
export const byId = id => LIB.find(x => x.id === id);

/* ---------- разделы сообщают о себе ----------
   Здесь хаб собирает то, что разделы принесли сами: L, RM, V, IMG и функции
   обновления разделов. Так у хаба нет импортов из views/ и ui/, он исполняется
   первым, и чтение общего состояния любым разделом безопасно. */
export const views = {};                     // имена разделов: приходят из views/ при их исполнении
export function registerViews(part) { Object.assign(views, part); }

/* ---------- значения, через которые смотрят несколько разделов ----------
   Раньше каждое из них лежало в своём разделе, и разделы читали их друг у друга:
   граф модулей замыкался, а страница падала на первом же имени, которое не успели
   экспортировать. Здесь живут только значения (ни одного имени из views/ и ui/),
   поэтому через них цикл пройти нельзя. Присваивание внутри модуля-владельца видно
   всем, кто импортирует (живая привязка ESM); где значение меняют целиком - рядом
   сеттер, потому что импортируемую переменную присвоить нельзя. */
export const earlyEvents = new Map();      // события, пришедшие раньше, чем раздел подписался на них
export let abuf, peaks = [], audioName;    // звук «Клипа»: буфер, пики для волны, имя файла
export function setClipAudio(buf, pk, name) { abuf = buf; peaks = pk; audioName = name; }
export let UP_JOB = null;                  // задание апскейла, чей прогресс показывают на странице
export function setUpJob(v) { UP_JOB = v; }
export let MD_NEED = [];                   // какие модели ещё нужно докачать
export function setMdNeed(v) { MD_NEED = v; }
export const selected = new Set();         // карточки, отмеченные для пакетных действий
export let libFilter = 'all', selecting = false;   // Библиотека: включённый фильтр и режим пакетного выбора
export function setLibFilter(v) { libFilter = v; }
export function setSelecting(v) { selecting = v; }
export let openId = null, openItem = null; // открытый просмотр: клипа может и не быть в Библиотеке
export function setOpenId(v) { openId = v; }
export function setOpenItem(v) { openItem = v; }
export let setupProfile = null, setupModes = ['video'];   // что ставят при первом запуске
export function setSetupProfile(v) { setupProfile = v; }
export function setSetupModes(v) { setupModes = v; }

/* ---------- запоминаем последние настройки и файлы, чтобы они были на месте после перезапуска ---------- */
export const MEM = { KEY: 'h3-mem', skip: new Set(['first', 'last', 'refs', 'dur0', 'start', 'end', 'faithful']), ready: false, sig: {}, audio: null, last: null };
export const memIdb = new Promise(res => {
  try {
    const r = indexedDB.open('h3mem', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  } catch { res(null); }
});
export async function memFile(op, key, value) {
  const db = await memIdb; if (!db) return null;
  return new Promise(res => {
    try {
      const tx = db.transaction('files', op === 'get' ? 'readonly' : 'readwrite'), st = tx.objectStore('files');
      const rq = op === 'get' ? st.get(key) : op === 'put' ? st.put(value, key) : st.delete(key);
      tx.oncomplete = () => res(rq.result); tx.onerror = tx.onabort = () => res(null);
    } catch { res(null); }
  });
}
export const memStates = () => ({ video: [views.V, $('#vPrompt'), views.vUpd], lipsync: [views.L, $('#lPrompt'), views.lUpd],
  // the two picture windows were the only ones the program forgot: their text and photos vanished
  // on the next start, while every studio remembered everything
  ...(views.IMG && views.IMG.qwen ? { qwen: [views.IMG.qwen.S, views.IMG.qwen.ta(), views.IMG.qwen.upd] } : {}),
  ...(views.IMG && views.IMG.krea ? { krea: [views.IMG.krea.S, views.IMG.krea.ta(), views.IMG.krea.upd] } : {}),
  ...Object.fromEntries(Object.entries(views.RM || {}).map(([m, r]) => [m, [r.S, r.prompt(), r.upd]])) });
export function memSlots() {
  const out = [['video/first', $('#dFirst')], ['video/last', $('#dLast')]];
  ['#qwDrop', '#qwDrop2', '#qwDrop3', '#qwDrop4', '#qwDrop5'].forEach((s, i) => { const el = $(s); if (el) out.push([`qwen/img${i}`, el]); });
  $$('.ref', views.refsEl).forEach((r, i) => out.push([`lipsync/ref${i}`, r]));
  Object.entries(views.RM || {}).forEach(([m, r]) => {
    $$('.ref', r.root).forEach((x, i) => out.push([`${m}/img${i}`, x]));
    $$('.rm-vids .slot', r.root).forEach((x, i) => out.push([`${m}/vid${i}`, x]));
    $$('.rm-auds .slot', r.root).forEach((x, i) => out.push([`${m}/aud${i}`, x]));
  });
  return out;
}
export function memSave() {
  if (!MEM.ready) return;
  try {
    const data = {};
    Object.entries(memStates()).forEach(([k, [st, prompt]]) => {
      const o = {}; Object.keys(st).forEach(p => { if (!MEM.skip.has(p) && typeof st[p] !== 'function') o[p] = st[p]; });
      data[k] = { s: JSON.parse(JSON.stringify(o)), prompt: prompt ? prompt.value : undefined };
    });
    data.lipsync.s.start = views.L.start; data.lipsync.s.end = views.L.end;
    // the heartbeat runs while nothing changes at all: rewriting the same text every few seconds is
    // pure wear, so the store is touched only when the content really moved
    const json = JSON.stringify(data);
    if (json !== MEM.last) { MEM.last = json; localStorage.setItem(MEM.KEY, json); }
  } catch {}
  const slots = memSlots();
  slots.forEach(([key, el]) => {
    const f = el._file, sig = f ? `${f.name}|${f.size}|${f.lastModified}` : '';
    if (MEM.sig[key] === sig) return;
    MEM.sig[key] = sig;
    if (f) memFile('put', key, f); else memFile('delete', key);
  });
  const a = MEM.audio, asig = a ? `${a.name}|${a.size}|${a.lastModified}` : '';
  if (MEM.sig['lipsync/audio'] !== asig) { MEM.sig['lipsync/audio'] = asig; if (a) memFile('put', 'lipsync/audio', a); else memFile('delete', 'lipsync/audio'); }
}
export async function memRestore() {
  let data = null; try { data = JSON.parse(localStorage.getItem(MEM.KEY) || 'null'); } catch {}
  const apply = () => {
    if (!data) return;
    Object.entries(memStates()).forEach(([k, [st, prompt, upd]]) => {
      const d = data[k]; if (!d) return;
      Object.entries(d.s || {}).forEach(([p, v]) => { if (!MEM.skip.has(p) && typeof st[p] !== 'function') st[p] = v; });
      if ('q' in st && !QUALITY_ALL.some(x => x.id === st.q)) st.q = '720p';   // a broken remembered size must not get through
      if ('aspect' in st && !ASPECTS.some(x => x.id === st.aspect)) st.aspect = '16:9';
      if (prompt && typeof d.prompt === 'string') { prompt.value = d.prompt; prompt.dispatchEvent(new Event('input')); }
      st._paintLoras?.(); upd();
    });
  };
  apply();
  for (const [key, el] of memSlots()) {
    const f = await memFile('get', key); if (!(f instanceof File)) continue;
    const input = $('input', el); if (!input) continue;
    const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event('change'));
    MEM.sig[key] = `${f.name}|${f.size}|${f.lastModified}`;
  }
  const au = await memFile('get', 'lipsync/audio');
  if (au instanceof File) {
    await views.loadAudio(au); MEM.audio = au; MEM.sig['lipsync/audio'] = `${au.name}|${au.size}|${au.lastModified}`;
    const ls = data?.lipsync?.s;
    if (ls && ls.end > ls.start && ls.end <= views.L.dur0 + 0.01) { views.L.start = ls.start; views.L.end = ls.end; views.syncSel(); views.lUpd(); }
  }
  setTimeout(() => { apply(); MEM.ready = true; }, 800);  // adding a picture re-fits the format: put the saved choice back after that
}
setInterval(memSave, 5000);   // a net against a crash; cheap now that nothing is rewritten in idle
addEventListener('beforeunload', memSave);
/* The picture windows are built further down this same script, and a photo is restored by putting
   it into a real file input: running before them meant the nodes simply were not there. */
if (document.readyState === 'complete') memRestore(); else addEventListener('load', memRestore);

/* ---------- закладки: сохранить состояние раздела и вернуться к нему позже ---------- */
export const BM = { KEY: 'h3-bookmarks', MODES: ['video', 'lipsync', 'refs', 'actor', 'action', 'long'], MAX: 15 };
export const bmLoad = () => { try { const a = JSON.parse(localStorage.getItem(BM.KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
export const bmStore = list => { try { localStorage.setItem(BM.KEY, JSON.stringify(list)); } catch { toast('Не удалось сохранить закладку: нет места в браузере'); } };
export function bmRender() {
  const all = bmLoad();
  BM.MODES.forEach(m => {
    const bar = $(`#view-${m} .st-bar`); if (!bar) return;
    const mine = all.filter(b => b.mode === m).sort((x, y) => (y.auto ? 1 : 0) - (x.auto ? 1 : 0) || new Date(y.date) - new Date(x.date));
    $('.st-n', bar).textContent = mine.length;
    $('.st-pop', bar).innerHTML = mine.length ? mine.map(b =>
      `<div class="st-i${b.auto ? ' auto' : ''}" data-id="${esc(b.id)}" title="${esc(b.title || '')}"><span class="t">${b.auto ? '↶ ' : ''}${esc(b.name)}</span><small>${fmtDate(new Date(b.date))}</small><i class="x" data-del title="Удалить этап">✕</i></div>`).join('')
      : '<div class="st-empty">Пока нет этапов. Нажмите «Сохранить этап», когда результат вас устраивает: потом к нему можно вернуться.<br><br>Этап запоминает проект целиком: тексты, настройки, референсы и готовые сцены. Не удаляйте клипы из Библиотеки, пока работаете над проектом.</div>';
  });
}
export async function bmSave(mode, opt = {}) {
  if (mode === 'long') return bmSaveLong(opt);
  const st = memStates()[mode]; if (!st) return;
  const [state, prompt] = st, o = {};
  Object.keys(state).forEach(p => { if (!MEM.skip.has(p) && typeof state[p] !== 'function') o[p] = state[p]; });
  const id = Math.random().toString(36).slice(2, 10), files = [];
  for (const [key, el] of memSlots()) {
    if (!key.startsWith(mode + '/') || !el._file) continue;
    await memFile('put', `bm/${id}/${key}`, el._file); files.push(key);
  }
  if (mode === 'lipsync' && MEM.audio) { await memFile('put', `bm/${id}/lipsync/audio`, MEM.audio); files.push('lipsync/audio'); }
  const text = prompt ? prompt.value.trim() : '';
  const name = opt.auto ? 'Было до открытия этапа' : stageName(text);
  let list = bmLoad();
  if (opt.auto) list.filter(b => b.mode === mode && b.auto).forEach(old => { (old.files || []).forEach(k => memFile('delete', `bm/${old.id}/${k}`)); list = list.filter(x => x !== old); });
  const mine = list.filter(b => b.mode === mode && !b.auto);
  if (!opt.auto && mine.length >= BM.MAX) { const old = mine[0]; list = list.filter(b => b !== old); (old.files || []).forEach(k => memFile('delete', `bm/${old.id}/${k}`)); }
  list.push({ id, mode, name, auto: !!opt.auto, title: text.slice(0, 200), date: new Date().toISOString(), s: JSON.parse(JSON.stringify(o)), prompt: text, files });
  bmStore(list); bmRender(); if (!opt.auto) toast('Этап сохранён: «' + name + '». Он лежит в списке «Этапы» вверху раздела');
}
export const stageDrop = b => { if (b && b.mode === 'long' && b.run) fetch('/api/long/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: b.run, id: b.id, action: 'delete' }) }).catch(() => {}); };
export const stageName = text => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' · ' + ((text || '').replace(/\s+/g, ' ').slice(0, 26) || 'без текста') + ((text || '').length > 26 ? '…' : '');
export async function bmSaveLong(opt = {}) {
  const root = $('#view-long'), proj = root && root._snap && root._snap(); if (!proj || !(proj.scenes || []).length) { if (!opt.auto) toast('В проекте пока нет сцен'); return; }
  let list = bmLoad();
  const drop = b => { stageDrop(b); list = list.filter(x => x !== b); };
  if (opt.auto) list.filter(b => b.mode === 'long' && b.auto).forEach(drop);
  const mine = list.filter(b => b.mode === 'long' && !b.auto); if (!opt.auto && mine.length >= BM.MAX) drop(mine[0]);
  const first = (proj.scenes.find(x => x.prompt && x.prompt.trim()) || {}).prompt || '';
  const done = proj.scenes.filter(x => x.done || x.draftDone).length;
  const name = opt.auto ? 'Было до открытия этапа' : stageName(first) + ` · сцен ${proj.scenes.length}, готово ${done}`;
  const sid = Math.random().toString(36).slice(2, 10);
  try { await fetch('/api/long/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: proj.run, id: sid, action: 'save' }) }); } catch {}   // the continuation points and pictures are copied on the disk
  list.push({ id: sid, mode: 'long', run: proj.run, name, auto: !!opt.auto, title: first.slice(0, 200), date: new Date().toISOString(), s: proj, prompt: first, files: [] });
  bmStore(list); bmRender(); if (!opt.auto) toast('Этап сохранён: «' + name + '»');
}
export async function bmOpen(id) {
  const b = bmLoad().find(x => x.id === id); if (!b) return;
  goTo(b.mode);
  if (!b.auto) await bmSave(b.mode, { auto: true });   // what is on the screen now is kept too: the opening can be undone with «↶ Было до открытия этапа»
  if (b.mode === 'long') { const r = await $('#view-long')._openStage(b.s, b.id); toast(!r.ok ? 'Не удалось открыть этап' : r.files ? 'Этап открыт: «' + b.name + '»' : 'Этап открыт: «' + b.name + '». Это старое сохранение: тексты и настройки вернулись, а готовые сцены, возможно, придётся сделать заново'); return; }
  const apply = () => {
    const st = memStates()[b.mode]; if (!st) return;
    const [state, prompt, upd] = st;
    Object.entries(b.s || {}).forEach(([p, v]) => { if (!MEM.skip.has(p) && typeof state[p] !== 'function') state[p] = v; });
    if (prompt) { prompt.value = b.prompt || ''; prompt.dispatchEvent(new Event('input')); }
    state._paintLoras?.(); upd();
  };
  apply();
  for (const [key, el] of memSlots()) {
    if (!key.startsWith(b.mode + '/')) continue;
    if (!(b.files || []).includes(key)) { if (el._file) $('.x', el)?.click(); continue; }
    const f = await memFile('get', `bm/${b.id}/${key}`); if (!(f instanceof File)) continue;
    const input = $('input', el); if (!input) continue;
    const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; input.dispatchEvent(new Event('change'));
  }
  if (b.mode === 'lipsync' && (b.files || []).includes('lipsync/audio')) {
    const au = await memFile('get', `bm/${b.id}/lipsync/audio`);
    if (au instanceof File) { await views.loadAudio(au); MEM.audio = au; }
  }
  setTimeout(apply, 800);  // adding a picture re-fits the format: put the saved choice back after that
  toast('Этап открыт: «' + b.name + '»');
}
export function bmDelete(id) {
  const list = bmLoad(), b = list.find(x => x.id === id); if (!b) return;
  (b.files || []).forEach(k => memFile('delete', `bm/${id}/${k}`));
  stageDrop(b);
  bmStore(list.filter(x => x.id !== id)); bmRender();
}
BM.MODES.forEach(m => {
  const view = $('#view-' + m); if (!view) return;
  const bar = document.createElement('div'); bar.className = 'st-bar';
  bar.innerHTML = '<button type="button" class="btn st-save" title="Запомнить всё, что сейчас в этом разделе: изображения, текст, настройки (в Видеостудии весь проект). Потом к этому месту можно вернуться">＋ Сохранить этап</button>'
    + '<button type="button" class="btn st-list" title="Этап запоминает проект целиком: тексты, настройки, референсы и готовые сцены. Открывайте любой этап и возвращайтесь к нему. Не удаляйте клипы из Библиотеки, пока работаете над проектом.">Этапы <b class="st-n">0</b> ▾</button><div class="st-pop" hidden></div>';
  const head = $('.head', view);   // the stage buttons belong with the page title, not with the tabs line
  if (head) head.appendChild(bar); else view.prepend(bar);
  (window.__stBars || (window.__stBars = {}))[m] = bar;
  $('.st-save', bar).onclick = () => bmSave(m);
  $('.st-list', bar).onclick = e => { e.stopPropagation(); $$('.st-pop').forEach(x => { if (x !== $('.st-pop', bar)) x.hidden = true; }); $('.st-pop', bar).hidden = !$('.st-pop', bar).hidden; };
  $('.st-pop', bar).onclick = e => {
    e.stopPropagation();
    const it = e.target.closest('.st-i'); if (!it) return;
    if (e.target.closest('[data-del]')) { bmDelete(it.dataset.id); return; }
    $('.st-pop', bar).hidden = true; bmOpen(it.dataset.id);
  };
});
document.addEventListener('click', () => $$('.st-pop').forEach(x => { x.hidden = true; }));
bmRender();

$('#optCloudShow').onclick = () => { $('.opt[data-opt="cloud"]').hidden = false; $('#optCloudShow').hidden = true; };
