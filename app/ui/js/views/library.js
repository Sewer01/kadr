import { API, postJSON } from '../core/net.js';
import { $, $$, ICON, copyPictureToClipboard, copyText, esc, fileName, fmtDate, fmtTime, paintRange, toast } from '../core/util.js';
import { MODE_NAME } from '../core/modes.js';
import { IMG_PANELS, LIB, byId, libFilter, openId, openItem, selecting, selected, setLibFilter, setOpenId, setOpenItem, setSelecting, setUpJob } from '../core/state.js';
import { TABS, goTo, onNav } from '../core/tabs.js';
import { frames } from '../ui/params.js';
import { setDropFile } from '../ui/slots.js';
import { insertAtCursor, scenarioDraftOf, scenarioResolvers } from '../ui/scenario.js';
import { agAttachFile, agGo } from './agent.js';
import { continueLong } from './modes.js';
import { qAdd } from './queue.js';
import { resetProgress, setStep, setupInfo, showSetupPane, setSetupInfo } from './setup.js';
import { libToFile } from './workflows.js';

/* Фильтр списка и режим пакетного выбора переехали в core/state.js: читает их
   renderLib, а этот раздел исполняется позже тех, кто зовёт renderLib. */
export function addToLib(item, date = new Date()) {
  LIB.push({ id: Math.random().toString(36).slice(2), date, fav: false, ...item });
  LIB.sort((a, b) => b.date - a.date);
  renderLib();
  window.trayFill?.();
}
// знак режима на миниатюре: «С» - запись сделана кнопкой «Субтитры…», «48» или «60» - кнопкой
// «Плавность…», «С 60» - если поля есть оба. У обычной записи знака нет, и карточка не меняется
export function libTag(it) {
  const s = it.subtitled && typeof it.subtitled === 'object' ? it.subtitled : null;
  const f = it.smoothed && typeof it.smoothed === 'object' ? +it.smoothed.fps : 0;
  const fps = (f === 48 || f === 60) ? String(f) : '';
  if (!s && !fps) return '';
  const mark = [s ? 'С' : '', fps].filter(Boolean).join(' ');
  const title = s && fps ? `Субтитры и плавность ${fps} кадров в секунду` : s ? 'Субтитры' : `Плавность ${fps} кадров в секунду`;
  return `<span class="li-tag" title="${title}">${mark}</span>`;
}
window.renderLib = renderLib;   // a keepsake saved from any bench must be able to ask for a redraw
export function renderLib() {
  $('#libBadge').textContent = LIB.length;
  const items = LIB.filter(it => libFilter === 'all' || (libFilter === 'fav' ? it.fav : libFilter === 'images' ? it.kind === 'image' : libFilter === 'videos' ? it.kind !== 'image' : it.mode === libFilter));
  const lib = $('#lib');
  lib.classList.toggle('selecting', selecting);
  lib.innerHTML = items.length ? items.map(it => `
    <div class="li${selected.has(it.id) ? ' sel' : ''}" data-id="${it.id}">
      <div class="li-th" data-act="open">
        ${it.missing ? '<div class="li-gone">файл не найден<small>видео удалили с диска</small></div>'
          : it.kind === 'image' ? `<img src="${it.url}" alt="" loading="lazy">` : it.url ? `<video src="${it.url}#t=0.5" preload="metadata" muted loop playsinline></video>` : `<img src="${it.thumb}" alt="">`}
        ${it.kind === 'image' ? '' : `<div class="li-play"><i>${ICON.play}</i></div>`}
        ${it.fav ? `<span class="li-fav">${ICON.star}</span>` : ''}
        ${libTag(it)}
        <span class="li-check">${selected.has(it.id) ? '' : ''}</span>
        <div class="li-act">
          <button data-act="use" title="Использовать в workflow">${ICON.use}</button>
          <button data-act="save" title="Сохранить на компьютер">${ICON.save}</button>
          <button data-act="fav" title="Избранное">${ICON.star}</button>
          <button data-act="del" title="Удалить">${ICON.del}</button>
        </div>
        <span class="li-mode">${MODE_NAME[it.mode]}</span>
        ${it.len ? `<span class="li-len">${it.len.toFixed(1).replace('.0', '')} с</span>` : ''}
      </div>
      <div class="li-b"><p>${esc(it.prompt) || '<span style="color:var(--dim)">без промпта</span>'}</p><small>${[it.res, it.aspect, fmtDate(it.date)].filter(Boolean).join(' · ')}</small></div>
    </div>`).join('')
    : `<div class="empty" style="grid-column:1/-1">${LIB.length ? 'В этом разделе пока пусто' : 'Здесь появятся ваши видео после первой генерации'}</div>`;
  $('#selCount').hidden = $('#bulkSave').hidden = $('#bulkDel').hidden = $('#selAll').hidden = !selecting;
  $('#selCount').textContent = `выбрано: ${selected.size}`;
  $('#selAll').textContent = items.length && items.every(it => selected.has(it.id)) ? 'Снять выбор' : `Выбрать все (${items.length})`;
  $('#selAll').disabled = !items.length;
  $('#selAll')._shown = items;   // what the filter shows now: choosing all means these, not everything
  $('#bulkSave').disabled = $('#bulkDel').disabled = !selected.size;
  $('#selToggle').textContent = selecting ? 'Готово' : 'Выбрать';
  $('#selToggle').classList.toggle('on', selecting);
  IMG_PANELS.forEach(f => f());  // thumbnails under the pictures of the picture sections
}
export let SAVE_BUSY = false;
export async function saveItems(items) {   // one save at a time: a second click would ask the same files twice
  if (SAVE_BUSY) { toast('Прежнее сохранение ещё идёт - подождите немного'); return; }
  SAVE_BUSY = true;
  try { await saveItemsNow(items); } finally { SAVE_BUSY = false; }
}
export async function saveItemsNow(items) {
  const have = items.filter(it => !it.missing);
  if (have.length < items.length) toast(`Пропущено видео, которых нет на диске: ${items.length - have.length}`);
  items = have; if (!items.length) return;
  if (API) {
    const native = window.pywebview?.api;
    if (native?.save_video) {
      // the app window: the usual Windows "Save as" dialog; the program copies the file itself
      try {
        if (items.length === 1) {
          const r = await native.save_video(items[0].id, fileName(items[0]));
          if (r.ok) toast('Сохранено: ' + r.path);
          else if (!r.cancelled) toast('Не удалось сохранить: ' + (r.error || 'ошибка'));
        } else {
          const r = await native.save_videos(items.map(it => ({ id: it.id, filename: fileName(it) })));
          if (r.ok) toast(`Сохранено видео: ${r.count} в папку ${r.folder}` + (r.failed ? ` (не удалось: ${r.failed})` : ''));
          else if (!r.cancelled) toast('Не удалось сохранить');
        }
      } catch (e) { toast('Не удалось сохранить: ' + e.message); }
      return;
    }
    // a normal browser: the browser's own download
    items.forEach((it, i) => setTimeout(() => {
      const a = document.createElement('a'); a.href = it.url + '?download=1'; a.download = ''; a.click();
    }, i * 400));
    toast(items.length === 1 ? 'Скачивание началось — файл будет в папке «Загрузки»' : `Скачивается ${items.length} видео — они будут в папке «Загрузки»`);
    return;
  }
  // in the real app: native "Save as…" / folder picker, then copy the mp4 from the output folder
  toast(items.length === 1 ? `Сохранение ${fileName(items[0])} — здесь откроется окно выбора папки` : `Сохранение ${items.length} видео — здесь откроется окно выбора папки`);
}
export function askDelete(ids) {
  // в списке лежат не только видео: слово должно соответствовать тому, что человек открыл
  const one = ids.length === 1 ? (LIB.find(x => x.id === ids[0]) || {}) : {};
  const what = one.kind === 'image' ? 'картинку' : one.kind === 'audio' ? 'звук' : 'видео';
  $('#cfTitle').textContent = ids.length === 1 ? `Удалить ${what}?` : `Удалить файлов: ${ids.length}?`;
  $('#cfText').textContent = ids.length === 1
    ? 'Файл переместится в корзину Windows — его можно будет восстановить.'
    : 'Файлы переместятся в корзину Windows — их можно будет восстановить.';
  $('#confirm').hidden = false;
  $('#cfOk').onclick = async () => {
    if ($('#cfOk')._busy) return;   // one click is enough: while it works, the second does nothing
    $('#cfOk')._busy = true;
    const was = $('#cfOk').textContent; $('#cfOk').textContent = 'Убираем…';
    try {
    if (API) {
      try {   // one request for the whole choice: the files go to the Recycle Bin in one hidden call
        const r = await fetch('/api/library/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...ids] }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) toast(j.error || 'Не удалось удалить');
        else if ((j.failed || []).length) toast(`Не удалось удалить файлов: ${j.failed.length} — остались на месте`);
        ids = j.gone || [];
      } catch (e) { toast(e.message); ids = []; }
    }
    ids.forEach(id => { const i = LIB.findIndex(x => x.id === id); if (i >= 0) LIB.splice(i, 1); selected.delete(id); });
    $('#confirm').hidden = true;
    if (ids.includes(openId)) closeViewer();
    renderLib(); toast(ids.length === 1 ? 'Видео удалено' : `Удалено: ${ids.length}`);
    } finally { $('#cfOk')._busy = false; $('#cfOk').textContent = was; }
  };
}
export function setFav(it, fav) {
  it.fav = fav;
  if (API) fetch(`/api/library/${it.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fav }) });
}
export function closeViewer() {
  // the window was closed by a function that had been dropped in an earlier clean-up: the cross,
  // Escape and every button that leaves for another section threw an error instead of closing it
  const m = $('#viewer'); if (!m) return;
  m.hidden = true;
  const v = $('video', m); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }   // taking the address away is not enough: it keeps playing
  const im = $('img', m); if (im) im.removeAttribute('src');
  const cmp = $('#vwCmp'); if (cmp) { clearInterval(CMP_TIMER); cmp.innerHTML = ''; }
  setOpenId(null);
}
export function openViewer(id, fallback) {
  const it = byId(id) || fallback; if (!it) return; setOpenId(it.id || id); setOpenItem(it);
  const vid = $('#viewer video'), img = $('#viewer img');
  const pic = it.kind === 'image';
  vwMedia(it);
  $('#vwCopy').hidden = !it.prompt;
  $('#vwDel').hidden = !byId(openId);   // a clip the Library does not know cannot be deleted from it
  $('#vwPic').hidden = !(it.url || it.thumb);
  img.style.cursor = pic && it.url ? 'zoom-in' : '';
  img.onload = () => { if (pic && !it.res && img.naturalWidth) $('#vwKv').insertAdjacentHTML('afterbegin', `<span>Разрешение</span><b>${dimTxt(img.naturalWidth, img.naturalHeight)}</b>`); };
  vid.onloadedmetadata = () => { if (!pic && !it.res && vid.videoWidth) $('#vwKv').insertAdjacentHTML('afterbegin', `<span>Разрешение</span><b>${dimTxt(vid.videoWidth, vid.videoHeight)}</b>`); };
  if (pic) { vid.removeAttribute('src'); img.src = it.url; } else if (it.url) { vid.src = it.url; vid.play().catch(() => {}); } else img.src = it.thumb;
  $('#vwTitle').textContent = `${MODE_NAME[it.mode]} · ${it.sub}`;
  $('#vwKv').innerHTML = [...(it.res ? [['Разрешение', /^\d+×\d+$/.test(it.res) ? dimTxt(...it.res.split('×')) : it.res]] : []), ...(it.aspect ? [['Формат', it.aspect]] : []), ...(it.q ? [['Качество', it.q]] : []), ...(it.len ? [['Длина', `${it.len.toFixed(1)} с · ${frames(it.len)} кадров`]] : []), ['Создано', fmtDate(it.date)], ...(it.seed != null ? [['Seed', String(it.seed)]] : []), ['Файл', fileName(it)]]
    .map(([k, v]) => k === 'Файл' && v
      ? `<span>${k}</span><b class="vw-file" data-file="${esc(v)}" title="${it.missing ? 'Файл не найден на диске - имя осталось из списка' : 'Нажмите, чтобы скопировать имя файла целиком'}">${esc(v)}</b>`
      : `<span>${k}</span><b>${v}</b>`).join('');
  $('#vwKv').onclick = e => {
    const b = e.target.closest('.vw-file'); if (!b) return;
    copyText(b.dataset.file, 'Имя файла скопировано');
  };
  $('#vwPrompt').textContent = it.prompt || 'без промпта';
  $('#vwFav').textContent = it.fav ? ' В избранном' : 'В избранное';
  $('#vwZoom').hidden = !(it.kind === 'image' && it.url);   // при открытом сравнении она не нужна
  $('#vwSeed').hidden = it.seed == null;
  $('#vwContinue').hidden = pic || !it.url || !!it.missing;
  $('#vwUp').hidden = it.mode === 'upscale' || it.mode === 'custom' || !it.url || !!it.missing;
  $('#vwUp').textContent = pic ? 'Увеличить изображение…' : 'Увеличить видео…';
  // слова кладутся поверх видео: для картинки кнопки нет, как нет её у пропавшего с диска файла
  $('#vwSub').hidden = pic || !it.url || !!it.missing;
  $('#vwFps').hidden = pic || !it.url || !!it.missing;   // частить картинку нечем
  const canCmp = it.mode === 'upscale' && (it.src || it.src_file) && !!it.url && !it.missing;
  $('#vwCmpBtn').hidden = !canCmp; cmpSet(canCmp, it);
  $('#viewer').hidden = false;
}
export function vwMedia(it) {   // which of the viewer's players is shown
  const pic = it.kind === 'image';
  $('#viewer video').hidden = !it.url || pic; $('#viewer img').hidden = $('#viewer .li-play').hidden = !!it.url && !pic;
  $('#vwZoom').hidden = !pic || !it.url;
}
/* before / after: a handle moves left-right over the same picture or video */
export let CMP_TIMER = 0;
export function cmpSet(on, it) {
  const box = $('#vwCmp'); clearInterval(CMP_TIMER); box.innerHTML = '';
  $('#vwCmpBtn').textContent = on ? 'Только результат' : 'До и после';
  if (!on) { box.hidden = true; vwMedia(it); return; }
  box.hidden = false; $('#viewer video').pause(); $('#viewer video').hidden = true; $('#viewer img').hidden = true; $('#viewer .li-play').hidden = true; $('#vwZoom').hidden = true;
  CMP_TIMER = cmpMount(box, it, false);
}
/* the slider itself; `full`: in the big window over the whole screen */
export function cmpMount(box, it, full) {
  const pic = it.kind === 'image', tag = pic ? 'img' : 'video', at = pic ? '' : ' muted loop autoplay playsinline';
  const mk = (cls, src) => pic ? `<img class="${cls}" src="${src}" alt="">` : `<video class="${cls}" src="${src}"${at}></video>`;
  box.innerHTML = `<div class="cmp-in">${mk('cmp-b', '/api/srcfile/' + it.id)}${mk('cmp-a', it.url)}<div class="cmp-h"><i>⇄</i></div><span class="cmp-l l">До</span><span class="cmp-l r">После</span><button class="cmp-fs" type="button" title="${full ? 'Закрыть (Esc)' : 'Открыть на весь экран'}">${full ? '✕' : '⛶'}</button></div><div class="cmp-hint">${full ? 'Esc или ✕: закрыть. ' : ''}Потяните ползунок влево и вправо: слева до увеличения, справа после</div>`;
  const wrap = $('.cmp-in', box), a = $('.cmp-a', box), b = $('.cmp-b', box);
  const fit = () => { const w = a.naturalWidth || a.videoWidth, h = a.naturalHeight || a.videoHeight; if (w) wrap.style.aspectRatio = `${w} / ${h}`; };
  a.onload = a.onloadedmetadata = fit;
  const move = x => { const r = wrap.getBoundingClientRect(), f = Math.min(1, Math.max(0, (x - r.left) / r.width)); a.style.clipPath = `inset(0 0 0 ${f * 100}%)`; $('.cmp-h', wrap).style.left = f * 100 + '%'; };
  wrap.onpointerdown = e => { wrap.setPointerCapture(e.pointerId); move(e.clientX); wrap.onpointermove = ev => move(ev.clientX); };
  wrap.onpointerup = () => { wrap.onpointermove = null; };
  const fs = $('.cmp-fs', box); fs.onpointerdown = e => e.stopPropagation(); fs.onclick = () => full ? cmpCloseFull() : cmpOpenFull(it);
  return pic ? 0 : setInterval(() => { if (a.readyState > 1 && b.readyState > 1 && Math.abs(a.currentTime - b.currentTime) > .12) b.currentTime = a.currentTime; if (a.paused && !b.paused) b.pause(); else if (!a.paused && b.paused) b.play().catch(() => {}); }, 300);
}
export let CMP_TIMER2 = 0;
export function cmpOpenFull(it) {
  clearInterval(CMP_TIMER); $$('#vwCmp video').forEach(v => v.pause());
  let ov = $('#cmpFull'); if (!ov) { ov = document.createElement('div'); ov.id = 'cmpFull'; document.body.append(ov); }
  clearInterval(CMP_TIMER2); CMP_TIMER2 = cmpMount(ov, it, true);
}
export function cmpCloseFull(back = true) {
  clearInterval(CMP_TIMER2); $('#cmpFull')?.remove();
  const it = byId(openId); if (back && it && !$('#vwCmp').hidden) cmpSet(true, it);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#cmpFull')) { e.stopImmediatePropagation(); e.preventDefault(); cmpCloseFull(); } }, true);
$('#vwPic').onclick = () => copyPictureToClipboard(openItem);
$('#vwCmpBtn').onclick = () => { const it = byId(openId); if (it) cmpSet($('#vwCmp').hidden, it); };
export const dimTxt = (w, h) => `${w}×${h} · ${(w * h / 1e6).toFixed(1).replace('.', ',')} МП`;

$('#lib').addEventListener('click', e => {
  const card = e.target.closest('.li'); if (!card) return;
  const id = card.dataset.id, it = byId(id);
  if (selecting) { selected.has(id) ? selected.delete(id) : selected.add(id); renderLib(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'del') askDelete([id]);
  else if (it.missing) toast('Файла этого видео нет на диске (его удалили). Нажмите корзину, чтобы убрать запись.');
  else if (act === 'use') useMenu(it);
  else if (act === 'save') saveItems([it]);
  else if (act === 'fav') { setFav(it, !it.fav); renderLib(); toast(it.fav ? 'Добавлено в избранное' : 'Убрано из избранного'); }
  else openViewer(id);
});
$('#libFilter').onclick = e => {
  const c = e.target.closest('.chip'); if (!c) return;
  setLibFilter(c.dataset.f); $$('#libFilter .chip').forEach(x => x.classList.toggle('on', x === c)); renderLib();
};
$('#selAll').onclick = () => {
  const shown = $('#selAll')._shown || [];
  const all = shown.length && shown.every(it => selected.has(it.id));
  shown.forEach(it => all ? selected.delete(it.id) : selected.add(it.id));
  renderLib();
};
$('#selToggle').onclick = () => { setSelecting(!selecting); selected.clear(); renderLib(); };
$('#bulkSave').onclick = () => saveItems([...selected].map(byId));
$('#bulkDel').onclick = () => askDelete([...selected]);
$$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-close]')) m.id === 'viewer' ? closeViewer() : (m.hidden = true); }));
addEventListener('keydown', e => { if (e.key === 'Escape') { $('#confirm').hidden = true; closeViewer(); } });
/* full screen has no panels at all, so the page itself must give a way out (Esc, F11) */
export let FS = false;
export const fsSay = on => toast(on ? 'Полный экран: Esc или F11 - вернуть окно с панелями' : 'Окно с панелями');
export async function fsCheck() { try { FS = !!(await window.pywebview.api.window_state()).fullscreen; } catch { FS = false; } return FS; }
export async function fsToggle(on) {
  const to = (on === undefined) ? !FS : !!on;
  try { const r = await window.pywebview.api.set_fullscreen(to); FS = !!r.fullscreen; fsSay(FS); }
  catch { toast('Не удалось переключить экран'); }
}
addEventListener('keydown', e => {
  if (e.key === 'F11') { e.preventDefault(); fsToggle(); return; }
  // Esc leaves full screen only when nothing on the page is waiting for it
  if (e.key === 'Escape' && FS && !$('#cmpFull') && ![...document.querySelectorAll('.modal')].some(m => !m.hidden)) {
    e.preventDefault(); fsToggle(false);
  }
}, true);
setTimeout(fsCheck, 800);
document.addEventListener('visibilitychange', () => { if (!document.hidden) fsCheck(); });
$('#vwSave').onclick = () => saveItems([(byId(openId) || openItem)]);
$('#vwDel').onclick = () => { if (openId) askDelete([openId]); };   // the window that shows the result is where you decide to drop it
$('#vwCopy').onclick = () => {
  const t = ((byId(openId) || openItem) || {}).prompt || '';
  if (!t) { toast('У этого файла нет промпта'); return; }
  copyText(t, 'Промпт скопирован');
};
$('#vwZoom').onclick = () => { const it = (byId(openId) || openItem); if (it && it.url) zoomOpen(it.url); };
$('#vwImg').onclick = () => { const it = (byId(openId) || openItem); if (it && it.kind === 'image' && it.url) zoomOpen(it.url); };
/* ---------- субтитры поверх готового клипа ---------- */
// маленькое меню у курсора: тем же способом, что и остальные контекстные меню (div.ctxm,
// закрытие по клику вне и по Escape); записи - тройки [текст, подсказка, что сделать]
export function subMenu(x, y, items) {
  document.querySelectorAll('.ctxm').forEach(z => z.remove());   // старое меню не должно остаться под новым
  const menu = document.createElement('div'); menu.className = 'ctxm';
  const close = () => {
    menu.remove();
    removeEventListener('mousedown', off, true); removeEventListener('keydown', onKey);
    removeEventListener('resize', close); removeEventListener('scroll', close, true);
  };
  const off = ev => { if (!menu.contains(ev.target)) close(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  items.forEach(([label, hint, go]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = hint;
    b.onclick = () => { close(); go(); };
    menu.append(b);
  });
  document.body.append(menu);
  window.placeAtCursor(menu, x, y);
  window.watchMenu(menu);
  addEventListener('mousedown', off, true); addEventListener('keydown', onKey);
  addEventListener('resize', close); addEventListener('scroll', close, true);
}
$('#vwSub').onclick = e => {
  const it = byId(openId) || openItem; if (!it) return;
  subMenu(e.clientX, e.clientY, [['Понизу, обычные', 'bottom'], ['Понизу, крупные', 'big'], ['По центру', 'center']]
    .map(([label, place]) => [label, 'Слова лягут поверх видео: ' + label.toLowerCase(),
                              () => subAskLang(it, place, e.clientX, e.clientY)]));
};
// второе меню: оставлять распознанное как сказано или просить перевод. Перевод делает локальная
// модель сценариста, поэтому нужны её модель на диске и чтобы генерация видео в это время не шла
export function subAskLang(it, place, x, y) {
  subMenu(x, y, [
    ['Оставить как сказано', 'Слова лягут поверх видео такие, какие распознались: ничего не переводится',
      () => subMake(it, place, false)],
    ['Перевести на русский', 'Перевод делает локальная модель сценариста: нужна её модель на диске и чтобы генерация видео не шла. Метки времени останутся те же',
      () => subMake(it, place, true)],
  ]);
}
// речь из клипа распознаётся на процессоре: десятки секунд на короткий ролик, поэтому запас большой;
// перевод моделью сценариста добавляет к ожиданию ещё минуты
export async function subMake(it, place, translate) {
  const b = $('#vwSub'); if (!b || b.disabled) return;
  const was = b.textContent;
  b.disabled = true; b.textContent = translate ? 'Распознаю и перевожу…' : 'Распознаю…';
  toast(translate ? 'Распознаю речь из клипа и перевожу на русский - нужно подождать'
                  : 'Распознаю речь из клипа - нужно подождать');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), translate ? 1500000 : 600000);   // 25 минут или 10: ждёт даже длинный ролик
  try {
    const r = await fetch('/api/subtitles', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: it.id, place, lang: 'auto', translate: !!translate }), signal: ctl.signal });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { error: txt }; }
    if (!r.ok) throw new Error(j.error || r.statusText);
    if (!j.ok) { toast(j.error || 'Субтитры не вышли'); return; }
    await window.h3ReloadLibrary();   // список Библиотеки обновляется общим способом
    toast(`Субтитры готовы: реплик ${j.lines}. Ролик лёг в Библиотеку отдельно, исходник как был`
      + (j.translated ? ', текст переведён на русский' : ', текст оставлен как сказано' + (j.why ? ' (' + j.why + ')' : '')));
    if (byId(j.id)) openViewer(j.id);
  } catch (err) {
    toast('Субтитры не вышли: ' + String((err && err.message) || err).slice(0, 180));
  } finally {
    clearTimeout(timer);
    const now = $('#vwSub'); if (now) { now.disabled = false; now.textContent = was; }
  }
}
/* ---------- плавность готового клипа: дорисовка промежуточных кадров ---------- */
$('#vwFps').onclick = e => {
  const it = byId(openId) || openItem; if (!it) return;
  document.querySelectorAll('.ctxm').forEach(x => x.remove());   // старое меню не должно остаться под новым
  const menu = document.createElement('div'); menu.className = 'ctxm';
  const close = () => {
    menu.remove();
    removeEventListener('mousedown', off, true); removeEventListener('keydown', onKey);
    removeEventListener('resize', close); removeEventListener('scroll', close, true);
  };
  const off = ev => { if (!menu.contains(ev.target)) close(); };
  const onKey = ev => { if (ev.key === 'Escape') close(); };
  [[48, '48 кадров в секунду'], [60, '60 кадров в секунду']].forEach(([f, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.title = 'Движение станет плавнее на экране с такой частотой; исходник останется как был';
    b.onclick = () => { close(); fpsMake(it, f); };
    menu.append(b);
  });
  document.body.append(menu);
  window.placeAtCursor(menu, e.clientX, e.clientY);
  window.watchMenu(menu);
  addEventListener('mousedown', off, true); addEventListener('keydown', onKey);
  addEventListener('resize', close); addEventListener('scroll', close, true);
};
// дорисовка идёт на процессоре и занимает примерно втрое больше, чем длится сам ролик
export async function fpsMake(it, fps) {
  const b = $('#vwFps'); if (!b || b.disabled) return;
  const was = b.textContent;
  b.disabled = true; b.textContent = 'Дорисовываю…';
  toast('Дорисовываю ' + fps + ' кадров в секунду - это минуты, можно подождать');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500000);   // 25 минут: ждёт даже длинный ролик в высоком разрешении
  try {
    const r = await fetch('/api/smooth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: it.id, fps }), signal: ctl.signal });
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { error: txt }; }
    if (!r.ok) throw new Error(j.error || r.statusText);
    await window.h3ReloadLibrary();   // список Библиотеки обновляется общим способом
    toast('Плавность готова (' + (j.how || 'новый файл') + '). Ролик лёг в Библиотеку отдельно, исходник как был');
    if (byId(j.id)) openViewer(j.id);
  } catch (err) {
    toast('Плавность не вышла: ' + String((err && err.message) || err).slice(0, 180));
  } finally {
    clearTimeout(timer);
    const now = $('#vwFps'); if (now) { now.disabled = false; now.textContent = was; }
  }
}
export async function openUpscale(it, file, into) {   // `file`: the person's own file; `into`: draw into a card on the page
  if (!it) return;
  const st = await (await fetch('/api/status')).json();
  const have = (st.modes || []).includes('upscale') && !(st.models || []).some(m => m.role.startsWith('seedvr') && !m.have);
  const relayNodes = st.relay_ok !== false;   // the ComfyUI build itself must know the RelayVSR nodes
  const haveRelay = relayNodes && (st.modes || []).includes('relayvsr') && !(st.models || []).some(m => m.role.startsWith('relayvsr') && !m.have);
  const inline = !!into;          // on the page the person sees the file AND the settings at once, and can say no
  let m = null;
  if (!inline) {                  // the empty overlay must not exist when the controls live on the page
    m = $('#upMenu');
    if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'upMenu'; document.body.append(m); }
    m.hidden = false;
  }
  const host = into || m;
  const [w, h] = (it.res || '').split('×').map(Number), secs = it.len || 5;
  const est = sc => (w && h ? (w * sc) * (h * sc) / 1048576 : 1.4) * (it.kind === 'image' ? 1 : Math.round(secs * 24)) * 3.24;  // seconds, measured on an RTX 4060 Ti 16 GB
  const opt = (k, name) => { const out = w ? `${Math.round(w * k / 2) * 2}×${Math.round(h * k / 2) * 2}` : '';
    return `<button class="btn up-s" data-k="${k}" type="button">${name}${out ? ` · ${out}` : ''}<small style="display:block;opacity:.7">примерно ${fmtTime(est(k))} на видеокарте уровня RTX 4060 Ti, у слабой — дольше</small></button>`; };
  const BOX_HEAD = `<div class="box" style="padding:20px;max-width:460px"><div class="card-h"><h3>${it.kind === 'image' ? 'Увеличить изображение' : 'Увеличить видео'}</h3><button class="btn" data-x type="button">Закрыть</button></div>`;
  const HEAD = `<div class="hint" style="margin-bottom:10px">${it.kind === 'image' ? 'Изображение' : 'Видео'} ${esc(it.res || '')}${it.len ? ' · ' + Math.round(it.len) + ' с' : ''}. Готовый файл появится в Библиотеке отдельно, исходный не изменится.</div>`;
  const body = (inline ? HEAD : '')
    + (it.kind === 'image'
      ? `<div class="note"><span>Изображение станет крупнее и чётче (с деталями). Это занимает от десятков секунд до нескольких минут. Задание пойдёт в очередь, а готовое изображение появится в Библиотеке отдельным файлом, исходная останется.</span></div>`
      : `<div class="note"><span>Видео станет крупнее и чётче, звук останется прежним. Это долго: от нескольких минут до часа на видео. Задание пойдёт в очередь, вы можете заниматься другим, а готовое видео появится в Библиотеке отдельным файлом. Если ждать не хочется — просто закройте это окно.</span></div>`)
    + (it.kind === 'image' ? '' : (() => {   // two ways for a video: fast (RelayVSR) and careful (SeedVR2)
      const relayT = (w && h ? (w * 2) * (h * 2) / 1048576 / 4 : 0.9) * Math.round(secs * 24) * 0.7;   // seconds; an estimate for an RTX 4060 Ti (the author's 5090 is ~3.5x faster)
      const tooBig = w && h && w * h * secs > 10 * 1376 * 768;
      const why = 'Быстрый способ берёт всё видео целиком в память видеокарты, поэтому он рассчитан на клип примерно до 10 секунд при 1376×768.';
      return `<div style="margin-top:14px;padding:12px;border:1.5px solid var(--line-2);border-radius:12px"><div style="font-weight:800;font-size:15px;margin-bottom:4px" title="${why}"> Быстро — RelayVSR, в 2 раза${w ? ` · ${w * 2}×${h * 2}` : ''}</div>`
        + `<div class="hint" style="margin-bottom:8px">Примерно ${fmtTime(relayT)} на RTX 4060 Ti (оценка). Видео не длиннее ~10 с при 1376×768: оно целиком грузится в память.${tooBig ? ' <b style="color:var(--pink)">Вашего видео это не касается - оно больше, поэтому кнопка ниже выключена. Увеличивайте вариантом «Качественнее».</b>' : ''}</div>`
        + (haveRelay ? `<label style="display:block;font-size:13px;margin-bottom:8px"><b>Детали: <span id="upDetailV">70</span>%</b> <span class="hint">меньше — мягче, без пересвета лиц; больше — чётче</span><input type="range" id="upDetail" min="0" max="100" step="5" value="70" style="width:100%"></label><button class="btn pri up-s" data-e="relay" data-k="2" type="button"${tooBig ? ' disabled title="' + why + ' Ваше видео длиннее или больше - быстрый способ для него недоступен."' : ' title="Быстрый способ: всё видео целиком в память карты, качество мягче, чем у «Качественнее», но в разы быстрее"'}>Увеличить быстро</button>`
          : `<div class="hint" style="margin-bottom:8px">${relayNodes
              ? `Нужна модель RelayVSR (около 5,3 ГБ).${st.engine === 'managed' ? '' : ' В своём ComfyUI положите relayvsr_x2_lightx2v_int8_convrot в diffusion_models и relayvsr_flash_vae_x2_fp32 в vae.'}`
              : 'Нужен более новый ComfyUI: в вашей версии узлов RelayVSR ещё нет. Обновите ComfyUI (раздел «Модели») — или увеличивайте вариантом «Качественнее», он работает сейчас.'}</div>`
            + (st.engine === 'managed' ? '<button class="btn pri" data-dl="relayvsr" type="button">Скачать модель</button>' : '')) + '</div>'
        + `<div style="font-weight:800;font-size:15px;margin:14px 0 4px"> Качественнее — SeedVR2 (долго)</div>`;
    })())
    + (have && it.kind === 'image' ? (() => { const k2 = w ? Math.max(1, 2048 / Math.max(w, h)) : 1.5; const tw = w ? Math.round(w * k2 / 2) * 2 : 0, th = w ? Math.round(h * k2 / 2) * 2 : 0;
        return `<div style="display:grid;gap:10px;margin-top:14px"><button class="btn pri up-s" data-k="2k" data-m="soft2k" type="button">До 2К, мягко${tw ? ` · ${tw}×${th}` : ''}<small style="display:block;opacity:.8">добавляет чёткость, но без «цифровой» резкости; быстро</small></button></div>`; })() : '')
    + (have ? `<label style="display:block;font-size:13px;margin-top:10px"><b>Чёткость: <span id="upSharpV">100</span>%</b> <span class="hint">меньше — мягче, ближе к обычному увеличению; 100 — как есть</span><input type="range" id="upSharp" min="0" max="100" step="5" value="100" style="width:100%"></label><div style="display:grid;gap:10px;margin-top:14px">${opt(1.5, (it.kind === 'image' ? 'Чётче (SeedVR2): ' : '') + 'Увеличить в 1,5 раза')}${opt(2, (it.kind === 'image' ? 'Чётче (SeedVR2): ' : '') + 'Увеличить в 2 раза')}</div>`
      : (`<div class="hint" style="margin:14px 0">Для этого нужна модель SeedVR2 (около 4 ГБ). ${st.engine === 'managed' ? 'Нажмите, чтобы скачать, и вернитесь сюда.' : 'Если файлов seedvr2_3b_int8_convrot и seedvr2_ema_vae_fp16 нет в вашем ComfyUI, положите их в его папки моделей.'}</div>`
        + (st.engine === 'managed' ? '<button class="btn pri" data-dl type="button">Скачать модель</button>' : '')));
  host.innerHTML = inline ? body : BOX_HEAD + body + '</div>';
  // чужая оценка дана для другой видеокарты; если у нас есть свои замеры такой же работы, зовём на помощь их
  if (API) {
    fetch('/api/forecast?mode=upscale&sec=' + Math.round(secs || 0)).then(r => r.json()).then(jc => {
      if (!jc || jc.samples < 2 || jc.secs < 20) return;
      if (!host.isConnected) return;
      const line = document.createElement('div');
      line.className = 'hint';
      line.style.cssText = 'margin-top:10px';
      line.textContent = 'По вашим прошлым запускам такой работы: примерно ' + fmtTime(jc.secs) + ' (замеров: ' + jc.samples + ').';
      host.append(line);
    }).catch(() => { });
  }
  // the blue part of a slider is painted by hand; a control created later was left unpainted,
  // which is why the handle stood at 70% while the colour stopped at a third
  [...host.querySelectorAll('input[type=range]')].forEach(paintRange);
  host.oninput = e => { if (e.target.id === 'upDetail') $('#upDetailV', host).textContent = e.target.value; if (e.target.id === 'upSharp') $('#upSharpV', host).textContent = e.target.value; };
  host.onclick = async e => {
    if (!inline && (e.target === m || e.target.closest('[data-x]'))) { m.hidden = true; return; }
    if (e.target.closest('[data-dl]')) {
      if (!inline) m.hidden = true; closeViewer();
      if (!setupInfo) setSetupInfo(await (await fetch('/api/setup/info')).json());
      const c = setupInfo.config;
      try { await postJSON('/api/setup/install', { install_dir: c.install_dir, models_dir: c.models_dir || '', add_mode: e.target.closest('[data-dl]').dataset.dl || 'upscale' }); goTo('models'); showSetupPane('progress'); setStep(2); resetProgress(); } catch (err) { toast(err.message); }
      return;
    }
    const b = e.target.closest('.up-s'); if (!b) return;
    const detail = ($('#upDetail', host) ? +$('#upDetail', host).value : 70) / 100, sharp = ($('#upSharp', host) ? +$('#upSharp', host).value : 100) / 100;
    try {
      let r;
      if (file) {
        const fd = new FormData(); fd.append('scale', b.dataset.k); fd.append('method', b.dataset.m || ''); fd.append('engine', b.dataset.e || '');
        fd.append('detail', detail); fd.append('sharp', sharp);
        fd.append('res', it.res || ''); fd.append('len', it.len || 0); fd.append('file', file);
        const resp = await fetch('/api/upscale_file', { method: 'POST', body: fd }); const txt = await resp.text();
        let j; try { j = JSON.parse(txt); } catch { j = { error: txt }; }
        if (!resp.ok) throw new Error(j.error || txt || resp.statusText);
        r = j;
      } else r = await postJSON('/api/upscale', { id: it.id, scale: b.dataset.k, method: b.dataset.m || '', engine: b.dataset.e || '', detail, sharp });
      qAdd(r.prompt_id, 'upscale', it.prompt || 'Увеличение');
      if (!inline) {
        m.hidden = true; closeViewer();
        toast(`Задание в очереди: готовая ${it.kind === 'image' ? 'изображение' : 'видео'} появится в Библиотеке`);
        goTo('queue');
      } else {
        // on the retouching page the person stays where he is: the progress has to be visible here.
        // the queue keeps the job anyway, and clearing the page remains his own decision
        setUpJob(r.prompt_id);
        host.querySelectorAll('.up-s, input[type=range]').forEach(b => { b.disabled = true; });
        host.insertAdjacentHTML('beforeend',
          '<div class="hint up-run" style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<b>Идёт увеличение</b><span class="up-run-t">Задание в очереди…</span>' +
          '<button class="btn mini" type="button" data-a="job" title="Открыть очередь: там это же задание и общий ход всех работ">В очередь</button></div>');
        const jb = host.querySelector('[data-a="job"]'); if (jb) jb.onclick = () => goTo('queue');
      }
    } catch (err) { toast(err.message); }
  };
}
/* ---------- picture viewer with zoom (magnifier) ---------- */
export const ZV = { s: 1, fit: 1 };
export function zvApply(s, cx, cy) {
  const st = $('#zvStage'), im = $('#zvImg'); if (!im.naturalWidth) return;
  s = Math.min(10, Math.max(ZV.fit * .4, s));
  const rx = (st.scrollLeft + cx) / (im.clientWidth || 1), ry = (st.scrollTop + cy) / (im.clientHeight || 1);
  ZV.s = s; im.style.width = im.naturalWidth * s + 'px'; im.style.height = im.naturalHeight * s + 'px';
  st.scrollLeft = rx * im.clientWidth - cx; st.scrollTop = ry * im.clientHeight - cy;
  $('#zvPct').textContent = Math.round(s * 100) + '%';
}
export function zoomFit() { const st = $('#zvStage'), im = $('#zvImg'); ZV.fit = Math.min(st.clientWidth / im.naturalWidth, st.clientHeight / im.naturalHeight); zvApply(ZV.fit, 0, 0); st.scrollLeft = st.scrollTop = 0; }
export function zoomOpen(url) {
  const im = $('#zvImg'); $('#zoomv').hidden = false; im.style.width = im.style.height = '';
  im.onload = zoomFit; im.src = url; if (im.complete && im.naturalWidth) zoomFit();
}
export function zoomClose() { $('#zoomv').hidden = true; $('#zvImg').removeAttribute('src'); }
(() => {
  const st = $('#zvStage'), mid = () => [st.clientWidth / 2, st.clientHeight / 2];
  $('#zvClose').onclick = zoomClose; $('#zvFit').onclick = zoomFit;
  $('#zv100').onclick = () => zvApply(1, ...mid()); $('#zvIn').onclick = () => zvApply(ZV.s * 1.25, ...mid()); $('#zvOut').onclick = () => zvApply(ZV.s / 1.25, ...mid());
  st.addEventListener('wheel', e => { e.preventDefault(); const r = st.getBoundingClientRect(); zvApply(ZV.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  st.addEventListener('dblclick', e => { const r = st.getBoundingClientRect(); Math.abs(ZV.s - 1) < .01 ? zoomFit() : zvApply(1, e.clientX - r.left, e.clientY - r.top); });
  let drag = null;
  st.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, l: st.scrollLeft, t: st.scrollTop }; st.classList.add('drag'); st.setPointerCapture(e.pointerId); });
  st.addEventListener('pointermove', e => { if (drag) { st.scrollLeft = drag.l - (e.clientX - drag.x); st.scrollTop = drag.t - (e.clientY - drag.y); } });
  st.addEventListener('pointerup', () => { drag = null; st.classList.remove('drag'); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#zoomv').hidden) zoomClose(); });
})();

/* ---------- Library -> workflow: "Use in…" button and the side tray to drag from ---------- */
export const USE_TARGETS = [['video', 'Видео'], ['lipsync', 'Клип'], ['refs', 'Видеостудия'], ['actor', 'Актёр'], ['action', 'Экшн-видео'], ['actionsc', 'Экшн фильм'], ['long', 'Киностудия'], ['qwen', 'Изображения'], ['agent', 'Сценарист (в чат)']];
export function freeSlot(view) {
  const root = $('#view-' + view); if (!root) return null;
  // кадры начала и конца человек выбирает сам: само туда ничего не подставляем
  const s = $$('label.drop:not(.disabled):not(.filled), label.ref:not(.filled):not(.frame)', root)[0];
  const f = s || (view === 'qwen' ? $('label.drop', root) : null);  // the editor has one slot: it is replaced
  return f && $('input[type=file]', f);
}
export async function useInWorkflow(it, view) {
  if (view === 'agent') {  // not a slot: the picture goes into the chat
    try { await agAttachFile(await libToFile(it)); agGo(); toast('Изображение добавлена в чат сценариста'); return true; }
    catch { toast('Не удалось взять файл'); return false; }
  }
  const input = freeSlot(view);
  if (!input) { toast('В этом разделе нет свободного места для изображения'); return false; }
  try { const f = await libToFile(it); goTo(view); await setDropFile(input, f); toast('Изображение отправлена в «' + USE_TARGETS.find(t => t[0] === view)[1] + '»'); return true; }
  catch { toast('Не удалось взять файл'); return false; }
}
export function useMenu(it) {
  let m = $('#useMenu');
  if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'useMenu'; document.body.append(m); }
  m.hidden = false;
  m.innerHTML = '<div class="box" style="padding:20px;max-width:360px"><div class="card-h"><h3>Куда отправить?</h3><button class="btn" data-x type="button">Закрыть</button></div><div style="display:grid;gap:8px">'
    + (it.kind !== 'image' && it.url && !it.missing ? '<button class="btn pri" data-v="__continue" type="button">Видеостудия: продолжить это видео</button>' : '')
    + USE_TARGETS.filter(t => !$(`.nav[data-view="${t[0]}"]`)?.disabled).map(t => `<button class="btn" data-v="${t[0]}" type="button">${t[1]}${t[0] === 'long' && it.kind !== 'image' ? ': кадр как референс' : ''}</button>`).join('') + '</div>'
    + (it.kind === 'image' ? '' : '<div class="hint" style="margin-top:10px">Из видео берётся последний кадр. «Продолжить это видео» берёт последние секунды клипа, и новая сцена продолжает их.</div>') + '</div>';
  m.onclick = async e => {
    if (e.target === m || e.target.closest('[data-x]')) { m.hidden = true; return; }
    const b = e.target.closest('[data-v]'); if (!b) return;
    m.hidden = true;
    if (b.dataset.v === '__continue') { if (openId) closeViewer(); await continueLong(it); return; }
    await useInWorkflow(it, b.dataset.v);
  };
}
// the tray: the latest library pictures, drag one onto any picture slot
(() => {
  const tray = document.createElement('div'); tray.id = 'libTray';
  tray.innerHTML = '<button class="lt-tab" type="button" title="Последние изображения из Библиотеки — перетащите на нужное место">Библиотека</button><div class="lt-body" hidden></div>';
  document.body.append(tray);
  const st = document.createElement('style');
  st.textContent = '#libTray{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:30;display:flex;align-items:center}#libTray[hidden]{display:none}'
    + '.lt-tab{writing-mode:vertical-rl;padding:12px 6px;border-radius:10px 0 0 10px;background:var(--card,#222);border:1px solid var(--line-2);border-right:0;color:var(--text);font-size:12px;font-weight:700;cursor:pointer}'
    + '.lt-body{width:170px;max-height:calc(var(--vh,1vh)*74);overflow:auto;padding:8px;display:grid;gap:6px;background:var(--bg-2);border:1px solid var(--line-2);border-radius:12px 0 0 12px}'
    + '.lt-body img,.lt-body video{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer;display:block}'
    + '.lt-cap{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;'
    + 'margin:6px 0 2px;display:flex;justify-content:space-between;align-items:center}'
    + '.lt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}'
    + '.lt-grid img,.lt-grid video{border-radius:6px}'
    + '.lt-aud{background:var(--card,#222);border:1px solid var(--line-2);border-radius:8px;padding:7px 8px;'
    + 'font-size:11px;display:flex;gap:6px;align-items:center;cursor:grab;min-height:34px}'
    + '.lt-aud span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
  document.head.append(st);
  const body = $('.lt-body', tray);
  const fill = () => {
    // three groups, each with its own room: audio used to be invisible here altogether, and twelve of
    // anything ran out after two generations
    const live = LIB.filter(it => !it.missing && it.url).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const CAP = 60;
    const groups = [['Фото', 'image'], ['Видео', 'video'], ['Аудио', 'audio']];
    const label = it => esc((it.title || it.prompt || it.source || 'без названия').replace(/\s+/g, ' ').trim()).slice(0, 26);
    const parts = groups.map(([title, kind]) => {
      const items = live.filter(it => (it.kind || 'video') === kind).slice(0, CAP);
      if (!items.length) return '';
      const tiles = items.map(it => kind === 'image'
        ? `<img src="${it.url}" draggable="true" data-id="${it.id}" alt="" title="${label(it)}">`
        : kind === 'video'
          ? `<video src="${it.url}#t=0.5" preload="metadata" muted draggable="true" data-id="${it.id}" title="${label(it)}"></video>`
          : `<div class="lt-aud" draggable="true" data-id="${it.id}" title="${label(it)}">♪ <span>${label(it)}</span></div>`).join('');
      const all = live.filter(it => (it.kind || 'video') === kind).length;
      return `<div class="lt-cap"><span>${title}</span><span>${items.length}${all > items.length ? ' из ' + all : ''}</span></div><div class="lt-grid">${tiles}</div>`;
    }).join('');
    const items = [];
    body.innerHTML = parts || '<div class="hint" style="font-size:11px">В Библиотеке пока ничего нет</div>';
  };
  $('.lt-tab', tray).onclick = () => { body.hidden = !body.hidden; if (!body.hidden) fill(); };
  window.trayFill = () => { if (!body.hidden) fill(); };  // new results appear in the open tray at once
  body.addEventListener('click', e => {
    const t = e.target.closest('[data-id]'); if (!t) return;
    const it = byId(t.dataset.id);
    if ($('#view-agent.active') && it && it.kind === 'image') { useInWorkflow(it, 'agent'); return; }   // in the agent a click puts the picture into the chat
    openViewer(t.dataset.id);
  });  // a click opens the picture, a drag takes it into a slot
  body.addEventListener('dragstart', e => {
    const t = e.target.closest('[data-id]'); if (!t) return;
    e.dataTransfer.setData('text/h3lib', t.dataset.id);
    // what a person reads on the tile is the name the file should keep when he drops it:
    // the tile carries that very text in its own hint, so no lookup is needed here
    const nm = (t.getAttribute('title') || '').trim();
    if (nm) { try { e.dataTransfer.setData('text/h3name', nm); } catch {} }
    e.dataTransfer.effectAllowed = 'copy';
  });
  const sync = () => { tray.hidden = !!$('#view-library.active, #view-models.active, #view-queue.active'); };   // the agent has the tray too: a picture dropped on the chat is attached to it
  new MutationObserver(sync).observe($('main, body'), { subtree: true, attributes: true, attributeFilter: ['class'] }); sync();
  // pictures of the result windows (the big one and the thumbnails of earlier ones) can be dragged into the picture slots too
  document.addEventListener('dragstart', e => {
    const t = e.target.closest && e.target.closest('[data-dragid], .cw-th[data-id]'); if (!t || e.target.closest('.lt-body')) return;
    e.dataTransfer.setData('text/h3lib', t.dataset.dragid || t.dataset.id); e.dataTransfer.effectAllowed = 'copy';
  });
  // the zones that take a library file: the picture slots, the audio field, the retouching loader and
  // the reference-video card (a card of buttons, so it declares its own input below)
  const DZONES = 'label.drop, label.ref, label.audio-empty, #upDrop, .h3vdrop';
  document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/h3lib') && e.target.closest(DZONES + ', #view-agent')) e.preventDefault(); }, true);
  document.addEventListener('drop', async e => {
    const id = e.dataTransfer.getData('text/h3lib'); if (!id) return;
    let dragName = ''; try { dragName = e.dataTransfer.getData('text/h3name') || ''; } catch {}
    const lb = e.target.closest(DZONES);
    if (!lb && e.target.closest('#view-agent')) {   // dropped on the agent's chat: the picture goes into the message
      e.preventDefault(); e.stopPropagation(); const it0 = byId(id); if (it0) await useInWorkflow(it0, 'agent'); return;
    }
    if (!lb) return;
    e.preventDefault(); e.stopPropagation(); lb.classList.remove('over');
    const it = byId(id), input = lb.__h3input || $('input[type=file]', lb); if (!it || !input) return;
    if (it.kind === 'image' && /audio/i.test(input.accept || '')) { toast('В это поле кладут звук, а не картинку'); return; }
    if (it.kind === 'audio' && /video/i.test(input.accept || '') && !/audio/i.test(input.accept || '')) { toast('Сюда кладут видео, а не звук'); return; }
    try { await setDropFile(input, await libToFile(it, /video/i.test(input.accept || ''), dragName)); toast(it.kind === 'audio' ? 'Звук взят из Библиотеки' : it.kind === 'video' ? 'Видео взято из Библиотеки' : 'Изображение взята из Библиотеки'); } catch { toast('Не удалось взять файл'); }
  }, true);
})();

/* Лист референсов: кадры движения камеры из короткого ролика. Кадры становятся обычными
   памятками библиотеки - их видят все режимы, отдельной проводки не нужно. Фраза кадра
   лежит в памятке, её можно поставить в поле «Сценарий» любого режима. */
const RS = { presets: [], file: null, frames: [] };

function rsFill() {
  const sel = $('#rsPreset');
  if (!sel || sel.options.length || !RS.presets.length) return;
  const groups = {};
  RS.presets.forEach(p => { (groups[p.kindName] = groups[p.kindName] || []).push(p); });
  sel.innerHTML = Object.keys(groups).sort().map(kind => `<optgroup label="${esc(kind)}">` + groups[kind].map(p =>
    `<option value="${esc(p.id)}" title="${esc(p.hint)}">${esc(p.title)} - ${esc(p.beats.map(b => b.name).join(' · '))}</option>`).join('') + '</optgroup>').join('');
}

async function rsLoad() {
  if (!RS.presets.length) {
    try { RS.presets = (await (await fetch('/api/refsheet/presets')).json()).presets || []; }
    catch (e) { RS.presets = []; }
  }
  rsFill();
}

/* Режимы для вставки берутся из реестра окон «Сценарий», а не из списка, который пришлось бы
   подерживать руками: что умеет принимать текст, то и предлагается. */
const rsModes = () => TABS.filter(t => !t.hidden && scenarioResolvers.has(t.key)).map(t => ({ key: t.key, title: t.caption }));

function rsPaint(frames) {
  RS.frames = frames || [];
  const box = $('#rsOut');
  if (!box) return;
  if (!RS.frames.length) { box.hidden = true; box.innerHTML = ''; return; }
  const modes = rsModes();
  box.innerHTML = RS.frames.map(f => `<div class="rs-frame" data-id="${esc(f.id)}">
    <span><b>${esc(f.name)}</b> <span class="hint">на ${Number(f.at).toFixed(1)} с · ${esc(f.text)}</span></span>
    <select data-mode>${modes.map(m => `<option value="${esc(m.key)}">${esc(m.title)}</option>`).join('')}</select>
    <button class="btn mini" type="button" data-put>Фраза в поле</button>
  </div>`).join('');
  box.hidden = false;
}

$('#rsVideo').onchange = e => {
  RS.file = e.target.files[0] || null;
  $('#rsNote').textContent = RS.file ? 'видео: ' + RS.file.name : 'видео не выбрано';
};

$('#rsMake').onclick = async () => {
  if (!RS.file) { toast('Сначала выбери короткое видео'); return; }
  const preset = $('#rsPreset').value;
  if (!preset) { toast('Список движений камеры ещё не пришёл'); return; }
  $('#rsNote').textContent = 'Берём кадры: по одному на каждый момент движения...';
  try {
    const url = '/api/refsheet?preset=' + encodeURIComponent(preset) + '&name=' + encodeURIComponent(RS.file.name);
    const r = await fetch(url, { method: 'POST', body: RS.file });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Программа не смогла взять кадры');
    rsPaint(j.frames);
    try { await window.h3ReloadLibrary(); } catch (e) { }
    renderLib();
    $('#rsNote').textContent = 'кадров ' + j.frames.length + (j.skipped.length ? ' · не вышло: ' + j.skipped.join(', ') : '')
      + ' · ролик ' + j.seconds + ' с';
    toast('Лист «' + j.preset + '» лёг в библиотеку');
  } catch (e) { $('#rsNote').textContent = 'не вышло'; toast(e.message); }
};

$('#rsOut').onclick = e => {
  const row = e.target.closest('.rs-frame'); if (!row || !e.target.closest('[data-put]')) return;
  const f = RS.frames.find(x => x.id === row.dataset.id); if (!f) return;
  const mode = ($('select[data-mode]', row) || {}).value;
  const field = scenarioDraftOf(mode);
  if (!field) { toast('В этом режиме нет окна сценария'); return; }
  insertAtCursor(field, f.text);
  toast('Фраза кадра встала в поле');
};

onNav('library', rsLoad);