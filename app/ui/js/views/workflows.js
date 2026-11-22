import { API, postJSON } from '../core/net.js';
import { $, $$, drawCover, esc, fmtDate, fmtTime, normItem, toast } from '../core/util.js';
import { LIB, peaks } from '../core/state.js';
import { firstRun, goTo, setNavLocked, onNav } from '../core/tabs.js';
import { drawWave } from '../ui/audio.js';
import { resFor } from '../ui/params.js';
import { makeScene } from '../ui/preview.js';
import { offPrompt, onPrompt, previewHandlers } from '../ui/scenario.js';
import { setDropFile } from '../ui/slots.js';
import { addToLib, renderLib, saveItems, zoomOpen } from './library.js';
import { QSTAGE, qAdd } from './queue.js';

/* ---------- свои workflow ---------- */
export const CW = { id: null, rep: null, vals: {}, files: {}, run: null, shown: null };
export async function cwList(select) {
  let items = [];
  try { items = await (await fetch('/api/wf/list')).json(); } catch {}
  const sel = $('#cwSel');
  sel.innerHTML = items.length ? items.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('') : '<option value="">нет сохранённых</option>';
  let last = ''; try { last = localStorage.getItem('h3-cw-last') || ''; } catch {}
  if (!select && items.some(x => x.id === last)) select = last;
  if (select && items.some(x => x.id === select)) sel.value = select;
  $('#cwDel').hidden = !items.length;
  if (items.length) cwOpen(sel.value); else { CW.id = null; $('#cwBody').innerHTML = ''; $('#cwHowto').hidden = false; }
}
export async function cwOpen(id) {
  CW.id = id; CW.shown = null; try { localStorage.setItem('h3-cw-last', id); } catch {} CW.vals = {}; CW.files = {}; $('#cwHowto').hidden = true;
  $('#cwBody').innerHTML = '<div class="hint">Разбираем workflow…</div>';
  try {
    const r = await fetch('/api/wf/' + id);
    if (!r.ok) throw new Error(await r.text());
    CW.rep = await r.json();
  } catch (e) { $('#cwBody').innerHTML = `<div class="note warn"><span>${esc(e.message || 'ComfyUI не отвечает. Запустите его и откройте раздел снова')}</span></div>`; return; }
  CW.rep.widgets.forEach(w => { CW.vals[w.key] = w.missing ? w.suggest : w.value; });
  try {  // what was set last time in this workflow
    const saved = JSON.parse(localStorage.getItem('h3-cw-' + id) || '{}');
    CW.rep.widgets.forEach(w => { if (w.key in saved && w.role !== 'media' && !(w.missing && !saved[w.key])) CW.vals[w.key] = saved[w.key]; });
  } catch {}
  cwRender();
}
export const CW_MODEL = w => w.kind === 'combo' && w.role === 'other' && /(_name$|^ckpt|checkpoint|^model$|lora|^unet|^vae|^clip)/i.test(w.name);
export const cwGroupBy = list => { const m = new Map(); list.forEach(w => { if (!m.has(w.node)) m.set(w.node, []); m.get(w.node).push(w); }); return [...m.values()]; };
export function cwField(w) {
  const k = esc(w.key), v = CW.vals[w.key];
  if (w.kind === 'combo') return `<select data-k="${k}">${w.missing && !v ? '<option value="">— выберите файл —</option>' : ''}${(w.options || []).map(o => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  if (w.kind === 'bool') return `<label class="cw-chk"><input type="checkbox" data-k="${k}"${v ? ' checked' : ''}> включено</label>`;
  if (w.kind === 'int' || w.kind === 'float') return `<input type="number" data-k="${k}" value="${esc(String(v))}"${w.min != null ? ` min="${w.min}"` : ''}${w.max != null ? ` max="${w.max}"` : ''} step="${w.kind === 'int' ? 1 : (w.step || 'any')}">`;
  if (w.multiline || String(v).length > 60) return `<textarea data-k="${k}" rows="4">${esc(String(v))}</textarea>`;
  return `<input type="text" data-k="${k}" value="${esc(String(v))}">`;
}
// a node's fields as one small window: title on top, fields in a tidy grid
export const cwBox = (title, ws) => `<div class="cw-box"><div class="cw-bt">${esc(title)}</div><div class="cw-bg">${ws.map(w =>
  `<label class="cw-f${w.kind === 'combo' || w.multiline ? ' wide' : ''}"><span>${esc(w.name)}</span>${cwField(w)}</label>`).join('')}</div></div>`;
export function cwRender() {
  try { cwRenderInner(); }
  catch (e) { $('#cwBody').innerHTML = `<div class="note warn"><span>Не удалось показать форму этого workflow: ${esc(e.message || e)}. пришлите файл comfyui.log из папки данных (Настройки) вместе с файлом workflow.</span></div>`; }
}
export function cwRenderInner() {
  const r = CW.rep, W = r.widgets;
  const missing = W.filter(w => w.missing), prompts = W.filter(w => w.role === 'prompt' || w.role === 'negative'), media = W.filter(w => w.role === 'media');
  const seeds = W.filter(w => w.role === 'seed'), sizes = W.filter(w => w.role === 'size');
  const aspects = W.filter(w => w.role === 'aspect'), toggles = W.filter(w => w.role === 'toggle'), params = W.filter(w => w.role === 'param');
  const tiles = W.filter(w => ['length', 'steps', 'cfg'].includes(w.role));
  const models = W.filter(w => CW_MODEL(w) && !w.missing);
  const other = W.filter(w => w.role === 'other' && !w.missing && !CW_MODEL(w));
  let status = '';
  if (r.missing_nodes.length) status += `<div class="note warn"><span><b>В вашем ComfyUI нет нод:</b> ${[...new Set(r.missing_nodes.map(m => esc(m.cls)))].join(', ')}. Установите их (например, через ComfyUI Manager), перезапустите ComfyUI и откройте раздел снова. Пока их нет, запустить нельзя.</span></div>`
    + `<div class="cw-bg3">${[...new Set(r.missing_nodes.map(m => m.cls))].map(c => `<div class="cw-f"><span>Нода <b style="color:var(--pink)">${esc(c)}</b></span><button class="btn mini" type="button" data-websearch="${esc('ComfyUI custom node ' + c + ' github')}">Найти в интернете</button></div>`).join('')}</div>`;
  if (missing.length) status += `<div class="note warn"><span><b>Не найдены файлы.</b> Выберите замену из того, что есть в вашем ComfyUI.</span></div><div class="cw-bg3">${missing.map(w =>
    `<label class="cw-f"><span>${esc(w.title)} · не найден: <b style="color:var(--pink)">${esc(w.value)}</b> <button class="btn mini" type="button" data-websearch="${esc('"' + String(w.value).split(/[\/]/).pop() + '" huggingface download')}">Найти в интернете</button></span>${cwField(w)}</label>`).join('')}</div>`;
  r.notes.forEach(n => status += `<div class="note"><span>${esc(n)}</span></div>`);
  let html = '';
  if (status) html += `<div class="card cw-status"><div class="card-h"><h3>Что нашлось в «${esc(r.name)}»</h3></div>${status}</div>`;
  else html += `<div class="cw-ok">, «${esc(r.name)}»: все ноды и файлы на месте</div>`;

  let main = '';
  if (prompts.length) main += `<div class="cw-prompts">${prompts.map(w => `<div class="cw-pp ${w.role === 'negative' ? 'neg' : 'pos'}"><div class="cw-pb">${w.role === 'negative' ? '✕ Негативный промпт' : '✓ Основной промпт'} <small>${esc(w.title)}</small></div>${cwField(w)}</div>`).join('')}</div>`;
  if (media.length) main += `<div class="cw-media">${media.map(w => `<label class="cw-file"><input type="file" data-f="${esc(w.key)}" accept="${w.mkind}/*" hidden>
      <div class="cw-fp"><i>${{ image: '🖼', audio: '🎵', video: '🎬' }[w.mkind]}</i></div>
      <b>${{ image: 'Изображение', audio: 'Аудио', video: 'Видео' }[w.mkind]}</b><small class="cw-fn">${esc(w.title)} · ${w.has_default ? 'можно не менять' : 'нужно выбрать'}</small>${w.mkind === 'audio' ? '' : `<button class="btn mini cw-lib" data-lib="${esc(w.key)}" type="button">Из Библиотеки</button>`}</label>`).join('')}</div>`;
  let tl = '';
  tl += aspects.map(w => `<div class="cw-t cw-asp"><span>Формат · ${esc(w.title)}</span>${cwField(w)}</div>`).join('');
  const bySizeNode = cwGroupBy(sizes);
  bySizeNode.forEach(ws => { tl += `<div class="cw-t"><span>Размер · ${esc(ws[0].title)}</span><div class="cw-pair">${ws.map(w => `<label>${esc(w.name)}${cwField(w)}</label>`).join('<b>×</b>')}</div></div>`; });
  tl += tiles.map(w => `<div class="cw-t"><span>${{ length: 'Длина', steps: 'Шаги', cfg: 'CFG' }[w.role]} · ${esc(w.title)}</span>${cwField(w)}</div>`).join('');
  tl += seeds.map(w => `<div class="cw-t"><span>Seed · ${esc(w.title)}</span>${cwField(w)}<label class="cw-chk"><input type="checkbox" data-rnd="${esc(w.key)}" checked> каждый раз новый</label></div>`).join('');
  tl += params.map(w => `<div class="cw-t"><span>${esc(w.title)}</span>${cwField(w)}</div>`).join('');
  if (tl) main += `<div class="cw-tiles">${tl}</div>`;
  if (toggles.length) main += `<div class="cw-toggles">${toggles.map(w => `<label class="cw-sw"><input type="checkbox" data-k="${esc(w.key)}"${CW.vals[w.key] ? ' checked' : ''}><b>${esc(w.title)}</b></label>`).join('')}</div>`;
  html += `<div class="card"><div class="card-h"><h3>Основное <small style="color:var(--muted);font-weight:500">· промпт, размер, шаги, seed</small></h3></div><div style="display:grid;gap:10px">${main || '<div class="hint">Основных полей не нашлось. Всё остальное внизу.</div>'}</div></div>`;

  const det = (title, n, body) => `<details class="card cw-det"><summary>${title} <small>${n}</small></summary><div class="cw-boxes">${body}</div></details>`;
  if (models.length) html += det('Модели и файлы', `${models.length} · обычно менять не нужно`, cwGroupBy(models).map(ws => cwBox(ws[0].title, ws)).join(''));
  if (other.length) html += det('Дополнительные настройки', `${other.length} · обычно менять не нужно`, cwGroupBy(other).map(ws => cwBox(ws[0].title, ws)).join(''));

  const result = `<div class="card cw-res"><div class="card-h"><h3>Результат</h3></div>
    <div class="cw-frame" id="cwFrame"><button class="cw-zb" id="cwZoomBtn" type="button" title="Увеличить" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/></svg></button><div class="cw-wait" id="cwWait">Здесь появится результат</div>
      <img id="cwLive" alt="" hidden><video id="cwVideo" controls loop playsinline hidden></video><img id="cwImage" alt="" hidden>
      <div class="cw-bar"><i id="cwBar"></i></div></div>
    <div class="cw-acts" id="cwActs" hidden><button class="btn" data-a="save" type="button">Сохранить</button><button class="btn" data-a="lib" type="button">В Библиотеке</button><button class="btn" data-a="restore" type="button" title="Вернуть в форму настройки этой генерации">Вернуть настройки</button></div>
    <div class="cw-time" id="cwTime"></div><div class="status" id="cwStatus"></div>
    <button class="go" id="cwGo"${r.missing_nodes.length ? ' disabled' : ''}>Сгенерировать</button>
    <button class="stop" id="cwStop" hidden><i></i>Остановить</button>
    <div class="cw-hh" id="cwHH" hidden>История</div><div class="cw-hist" id="cwHist"></div></div>`;
  $('#cwBody').innerHTML = `<div class="cw-cols"><div class="cw-left">${html}</div><div class="cw-rs" id="cwRs" title="Потяните, чтобы изменить ширину окна. Двойной клик: вернуть"></div><div class="cw-right">${result}</div></div>`;
  cwTick();
  if (!CW.run) cwShowLast();
  cwHist();
}
$('#cwBody').addEventListener('input', e => {
  const k = e.target.dataset?.k; if (!k) return;
  const w = CW.rep.widgets.find(x => x.key === k); if (!w) return;
  CW.vals[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  try { localStorage.setItem('h3-cw-' + CW.id, JSON.stringify(CW.vals)); } catch {}
});
// width / height are rounded to a multiple of 32 (what the video and picture models accept)
$('#cwBody').addEventListener('change', e => {
  const inp = e.target, k = inp.dataset?.k; if (!k || !inp.closest('.cw-pair')) return;
  const v = parseInt(inp.value, 10); if (!(v > 0)) return;
  const r = Math.max(64, Math.round(v / 32) * 32);
  if (r !== v) { inp.value = r; CW.vals[k] = String(r); try { localStorage.setItem('h3-cw-' + CW.id, JSON.stringify(CW.vals)); } catch {} toast(`Размер округлён: ${v} -> ${r} (кратно 32)`); }
});
$('#cwBody').addEventListener('change', e => {
  const k = e.target.dataset?.f; if (!k) return;
  cwSetFile(k, e.target.files[0] || null);
});
/* ---------- own workflows: files, library picker, width of the result window ---------- */
export function cwSetFile(key, f) {
  CW.files[key] = f;
  const inp = $(`[data-f="${key}"]`, $('#cwBody')), tile = inp && inp.closest('.cw-file'); if (!tile) return;
  $('.cw-fn', tile).textContent = f ? f.name : 'Выберите файл';
  $('.cw-fp', tile).innerHTML = f && f.type.startsWith('image/') ? `<img src="${URL.createObjectURL(f)}" alt="">` : '<i>✓</i>';
  tile.classList.toggle('on', !!f);
}
export function cwPick(key) {
  const w = CW.rep.widgets.find(x => x.key === key); if (!w) return;
  const items = LIB.filter(it => !it.missing && it.url && (w.mkind === 'image' ? it.kind === 'image' : it.kind !== 'image')).sort((a, b) => b.date - a.date);
  let m = $('#cwPick');
  if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'cwPick'; document.body.append(m); }
  m.hidden = false;
  m.innerHTML = `<div class="box" style="padding:20px"><div class="card-h"><h3>Из Библиотеки · ${w.mkind === 'image' ? 'изображения' : 'видео'}</h3><button class="btn" data-x type="button">Закрыть</button></div>`
    + (items.length ? `<div class="cw-pickgrid">${items.map(it => `<button class="cw-th" data-id="${it.id}" type="button" title="${esc((it.label ? it.label + ' · ' : '') + (it.prompt || '').slice(0, 80))}">${w.mkind === 'image' ? `<img src="${it.url}" alt="" loading="lazy">` : `<video src="${it.url}#t=0.5" preload="metadata" muted></video>`}${it.label ? `<span class="cw-lb">${esc(it.label)}</span>` : ''}</button>`).join('')}</div>`
      : '<div class="hint" style="padding:20px 4px">В Библиотеке пока нет подходящих файлов.</div>') + '</div>';
  m.onclick = async e => {
    if (e.target === m || e.target.closest('[data-x]')) { m.hidden = true; return; }
    const th = e.target.closest('.cw-th'); if (!th) return;
    const it = LIB.find(x => x.id === th.dataset.id); if (!it) return;
    try {
      const blob = await (await fetch(it.url)).blob();
      cwSetFile(key, new File([blob], `${it.id}.${it.ext || (w.mkind === 'image' ? 'png' : 'mp4')}`, { type: blob.type }));
      m.hidden = true; toast('Файл взят из Библиотеки');
    } catch { toast('Не удалось взять файл'); }
  };
}
/* ---------- picture slots: choose "from the library" or "from the computer" ---------- */
document.addEventListener('click', e => {
  const lb = e.target.closest('label.drop, label.ref'); if (!lb || e.target.closest('.x, select, input')) return;
  const input = $('input[type=file]', lb); if (!input) return;
  e.preventDefault(); e.stopPropagation();
  let m = $('#picSrc');
  if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'picSrc'; document.body.append(m); }
  m.hidden = false;
  const showSrc = () => {
    m.innerHTML = '<div class="box" style="padding:20px;max-width:360px"><div class="card-h"><h3>Откуда взять изображение?</h3><button class="btn" data-x type="button">Закрыть</button></div>'
      + '<div style="display:grid;gap:10px"><button class="btn pri" data-s="lib" type="button">Из Библиотеки</button><button class="btn" data-s="pc" type="button">С компьютера</button></div></div>';
  };
  const showLib = () => {
    const items = LIB.filter(it => !it.missing && it.url).sort((a, b) => b.date - a.date);
    m.innerHTML = '<div class="box" style="padding:20px"><div class="card-h"><h3>Из Библиотеки</h3><button class="btn" data-x type="button">Закрыть</button></div>'
      + (items.length ? `<div class="cw-pickgrid">${items.map(it => `<button class="cw-th" data-id="${it.id}" type="button" title="${esc((it.label ? it.label + ' · ' : '') + (it.prompt || '').slice(0, 80))}">${it.kind === 'image' ? `<img src="${it.url}" alt="" loading="lazy">` : `<video src="${it.url}#t=0.5" preload="metadata" muted></video><span class="cw-lb">последний кадр видео</span>`}</button>`).join('')}</div>`
        : '<div class="hint" style="padding:20px 4px">В Библиотеке пока ничего нет.</div>') + '</div>';
  };
  showSrc();
  m.onclick = async ev => {
    if (ev.target === m || ev.target.closest('[data-x]')) { m.hidden = true; return; }
    const s = ev.target.closest('[data-s]');
    if (s) { if (s.dataset.s === 'pc') { m.hidden = true; input.click(); } else showLib(); return; }
    const th = ev.target.closest('.cw-th'); if (!th) return;
    const it = LIB.find(x => x.id === th.dataset.id); if (!it) return;
    try {
      await setDropFile(input, await libToFile(it));
      m.hidden = true; toast('Изображение взята из Библиотеки');
    } catch { toast('Не удалось взять файл'); }
  };
}, true);
export async function libToFile(it, forVideo, keepName) {
  let blob;
  // a file taken out of the library is named as the panel shows it, not by its internal number
  const nice = String(keepName || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const named = (base, ext) => {
    const clean = nice && !new RegExp('\\.' + ext + '$', 'i').test(nice) ? nice + '.' + ext : (nice || base);
    return clean;
  };
  // a sound is taken as it is: there is no frame to pull out of it
  if (it.kind === 'image' || it.kind === 'audio') blob = await (await fetch(it.url)).blob();
  else if (forVideo) {
    // a video dropped on a video field IS the video: taking its last frame here used to hand the
    // person a picture where he expected moving reference
    blob = await (await fetch(it.url)).blob();
    return new File([blob], named(it.id + '.mp4', 'mp4'), { type: blob.type || 'video/mp4' });
  } else {  // a video dropped on a picture field: its last frame, handy for continuing a scene
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = it.url;
    await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = no; });
    v.currentTime = Math.max(0, v.duration - 0.05);
    await new Promise((ok, no) => { v.onseeked = ok; v.onerror = no; });
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
    blob = await new Promise(ok => c.toBlob(ok, 'image/png'));
  }
  const ext = it.kind === 'audio' ? (it.ext || 'mp3') : (it.kind === 'image' ? (it.ext || 'png') : 'png');
  return new File([blob], named(it.id + '.' + ext, ext), { type: blob.type || (it.kind === 'image' ? 'image/png' : 'application/octet-stream') });
}

export const cwMine = () => LIB.filter(x => x.mode === 'custom' && (x.wf ? x.wf === CW.id : x.sub === CW.rep.name)).sort((a, b) => b.date - a.date);
export function cwFit(w, h) {  // the window takes the shape of the picture, never taller than 68% of the screen
  const f = $('#cwFrame'); if (!f || !w || !h) return;
  f.style.aspectRatio = `${w} / ${h}`; f.style.width = `min(100%, calc(var(--vh,1vh)*${(68 * w / h).toFixed(1)}))`; f.style.minHeight = '0'; f.style.margin = '0 auto';
}
export function cwShow(it) {
  const f = $('#cwFrame'); if (!f || !it) return;
  CW.shown = it.id;
  const pic = it.kind === 'image', v = $('#cwVideo'), im = $('#cwImage');
  $('#cwWait').hidden = true; $('#cwLive').hidden = true; v.hidden = pic; im.hidden = !pic;
  if (pic) { v.removeAttribute('src'); im.onload = () => cwFit(im.naturalWidth, im.naturalHeight); im.src = it.url; }
  else { v.onloadedmetadata = () => cwFit(v.videoWidth, v.videoHeight); v.src = it.url; v.muted = true; v.play().catch(() => {}); }
  $('#cwActs').hidden = false; $('#cwActs [data-a="restore"]').hidden = !it.cw_values;
  if (!CW.run) { $('#cwBar').style.width = '0'; $('#cwTime').innerHTML = `<b>${pic ? 'Изображение' : 'Видео'}${it.label ? ' · ' + esc(it.label) : ''}</b> · ${fmtDate(it.date)}`; $('#cwStatus').textContent = [it.res, it.sub].filter(Boolean).join(' · '); }
  $('#cwZoomBtn').hidden = !pic;
  $$('#cwHist .cw-th').forEach(t => t.classList.toggle('on', t.dataset.id === it.id));
}
export function cwShowLast() { const mine = cwMine(); const it = mine.find(x => x.id === CW.shown) || mine[0]; if (it && !it.missing) cwShow(it); }
export function cwHist() {
  const box = $('#cwHist'); if (!box) return;
  const mine = cwMine().slice(0, 16);
  $('#cwHH').hidden = !mine.length;
  box.innerHTML = mine.map(it => `<button draggable="true" class="cw-th${it.id === CW.shown ? ' on' : ''}" data-id="${it.id}" type="button" title="${esc((it.label ? it.label + ' · ' : '') + fmtDate(it.date))}">${it.missing ? '<i>—</i>'
    : it.kind === 'image' ? `<img src="${it.url}" alt="" loading="lazy">` : `<video src="${it.url}#t=0.5" preload="metadata" muted></video>`}${it.label ? `<span class="cw-lb">${esc(it.label)}</span>` : ''}</button>`).join('');
}
export function cwTick() {
  const r = CW.run, bar = $('#cwBar'); if (!r || !bar) return;
  const el = (performance.now() - r.t0) / 1000, sampling = r.stage.startsWith('sample') && r.max;
  const base = { queued: .02, load: .05, encode: .12, sample: .15, upscale: .7, sample2: .75, decode: .92, save: .98 }[r.stage] ?? .1;
  let p = base, line = QSTAGE[r.stage] || 'идёт', eta = '';
  if (sampling) {
    const frac = (r.step || 0) / r.max, two = r.stage === 'sample2';
    p = (two ? .75 : .15) + (two ? .15 : .55) * frac; line += ` · шаг ${r.step || 0} из ${r.max}`;
    if (r.step) eta = ` · до конца этапа ~${fmtTime((r.max - r.step) * ((r.stepT - r.sampleT0) / r.step) / 1000)}`;
  }
  bar.style.width = (p * 100) + '%';
  $('#cwTime').innerHTML = r.stage === 'queued' ? `<b>В очереди</b> · ждём своей очереди · ${fmtTime(el)}` : `<b>Идёт</b> · прошло ${fmtTime(el)}${eta}`;
  $('#cwStatus').textContent = line;
}
export function cwFinish(kind, ev) {
  const r = CW.run; if (!r) return;
  clearInterval(r.tick); offPrompt(r.id); previewHandlers.delete('cw'); CW.run = null;
  const took = fmtTime((performance.now() - r.t0) / 1000);
  if (!$('#cwLive')) return;
  $('#cwLive').hidden = true; $('#cwStop').hidden = true; $('#cwGo').disabled = !!CW.rep.missing_nodes.length;
  if (kind === 'done') {
    const it = LIB.find(x => x.id === ev.item.id) || normItem(ev.item);
    cwShow(it); cwHist(); $('#cwBar').style.width = '100%';
    $('#cwTime').innerHTML = `<b style="color:var(--ok)">Готово</b> · за ${took}`; $('#cwStatus').textContent = `${it.kind === 'image' ? 'Изображение сохранена' : 'Видео сохранено'} в Библиотеку`;
  } else {
    $('#cwBar').style.width = '0'; $('#cwWait').hidden = false; $('#cwWait').textContent = 'Здесь появится результат';
    $('#cwTime').innerHTML = kind === 'error' ? '<b style="color:var(--pink)">Ошибка</b>' : '<b>Остановлено</b>';
    $('#cwStatus').textContent = kind === 'error' ? 'Ошибка ComfyUI: ' + ev.message : 'Генерация остановлена';
  }
}
$('#cwBody').addEventListener('click', async e => {
  const lb = e.target.closest('[data-lib]'); if (lb) { e.preventDefault(); cwPick(lb.dataset.lib); return; }
  if (e.target.closest('#cwZoomBtn') || e.target.closest('#cwImage')) { zoomOpen($('#cwImage').src); return; }
  const th = e.target.closest('.cw-th'); if (th) { const it = LIB.find(x => x.id === th.dataset.id); if (it) cwShow(it); return; }
  const act = e.target.closest('#cwActs [data-a]');
  if (act) {
    const it = LIB.find(x => x.id === CW.shown); if (!it) return;
    if (act.dataset.a === 'save') saveItems([it]);
    else if (act.dataset.a === 'lib') goTo('library');
    else if (act.dataset.a === 'restore' && it.cw_values) {
      Object.entries(it.cw_values).forEach(([k, v]) => { if (k in CW.vals) CW.vals[k] = v; });
      try { localStorage.setItem('h3-cw-' + CW.id, JSON.stringify(CW.vals)); } catch {}
      cwRender(); toast('Настройки возвращены');
    }
    return;
  }
  if (e.target.closest('#cwStop')) {
    if (CW.run) { $('#cwStatus').textContent = 'Останавливаем…'; fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: CW.run.id }) }); }
    return;
  }
  if (!e.target.closest('#cwGo')) return;
  const status = $('#cwStatus'), W = CW.rep.widgets;
  const bad = W.find(w => w.missing && !CW.vals[w.key]); if (bad) { status.textContent = `Выберите файл: ${bad.title}`; return; }
  const noFile = W.find(w => w.role === 'media' && !w.has_default && !CW.files[w.key]); if (noFile) { status.textContent = `Загрузите файл: ${noFile.title}`; return; }
  $$('[data-rnd]', $('#cwBody')).forEach(c => {
    if (!c.checked) return;
    const v = Math.floor(Math.random() * 2 ** 50); CW.vals[c.dataset.rnd] = v;
    const inp = $(`[data-k="${c.dataset.rnd}"]`, $('#cwBody')); if (inp) inp.value = v;
  });
  const fd = new FormData(); fd.append('wf', CW.id); fd.append('values', JSON.stringify(CW.vals));
  Object.entries(CW.files).forEach(([k, f]) => f && fd.append('f:' + k, f));
  $('#cwGo').disabled = true; status.textContent = 'Отправляем задание в ComfyUI…';
  try {
    const r = await fetch('/api/generate/custom', { method: 'POST', body: fd }), txt = await r.text();
    let res; try { res = JSON.parse(txt); } catch { res = { error: txt }; }
    if (!r.ok) throw new Error(res.error || txt || r.statusText);
    const prompt = (W.find(w => w.role === 'prompt') || {}).key;
    qAdd(res.prompt_id, 'custom', prompt ? String(CW.vals[prompt]) : CW.rep.name);
    if (CW.run) { clearInterval(CW.run.tick); offPrompt(CW.run.id); }  // the older job goes on in the queue
    CW.run = { id: res.prompt_id, t0: performance.now(), stage: 'queued' };
    $('#cwVideo').hidden = true; $('#cwImage').hidden = true; $('#cwLive').hidden = true; $('#cwWait').hidden = false; $('#cwWait').textContent = 'Задание в очереди…';
    $('#cwStop').hidden = false; $('#cwGo').disabled = false;
    CW.run.tick = setInterval(cwTick, 1000); cwTick();
    previewHandlers.set('cw', blob => {
      const run = CW.run, im = $('#cwLive'); if (!run || run.stage === 'queued' || !im) return;
      URL.revokeObjectURL(im.dataset.url || ''); im.dataset.url = im.src = URL.createObjectURL(blob); im.hidden = false; $('#cwWait').hidden = true;
    });
    onPrompt(res.prompt_id, ev => {
      const run = CW.run; if (!run || run.id !== ev.prompt_id) return;
      if (ev.type === 'stage') {
        const sampling = ev.stage.startsWith('sample');
        if (sampling && run.stage !== ev.stage) run.sampleT0 = performance.now();
        run.stage = ev.stage; run.step = ev.step; run.max = ev.max;
        if (sampling && ev.step) run.stepT = performance.now();
        if ($('#cwWait')) $('#cwWait').textContent = QSTAGE[ev.stage] || 'Идёт генерация…';
        cwTick();
      } else if (ev.type === 'done') cwFinish('done', ev);
      else if (ev.type === 'error') cwFinish('error', ev);
      else if (ev.type === 'interrupted') cwFinish('stopped', ev);
    });
  } catch (err) { status.textContent = 'Ошибка: ' + err.message; $('#cwGo').disabled = !!CW.rep.missing_nodes.length; }
});
$('#cwSel').onchange = e => e.target.value && cwOpen(e.target.value);
$('#cwDel').onclick = async () => {
  if (!CW.id || !confirm('Удалить этот workflow из списка? Файлы на диске не трогаем.')) return;
  await fetch('/api/wf/' + CW.id, { method: 'DELETE' }); cwList();
};
$('#cwFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const graph = JSON.parse(await f.text());
    const r = await fetch('/api/wf/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.replace(/\.json$/i, ''), graph }) });
    if (!r.ok) throw new Error(await r.text());
    cwList((await r.json()).id);
  } catch (err) { toast(err instanceof SyntaxError ? 'Это не файл workflow (.json)' : err.message); }
};
onNav('custom', () => cwList(CW.id));

/* the user's own LoRAs */
export const CL = { files: [], items: [] };
export async function loadCL() {
  try {
    const r = await (await fetch('/api/loras/custom')).json();
    if (!r.files) return;
    CL.files = r.files; CL.items = r.items; $('#clCard').hidden = false; renderCL();
  } catch {}
}
export function renderCL() {
  $('#clList').innerHTML = CL.items.length ? CL.items.map((x, i) => `<div class="m" data-i="${i}">
      <b><select class="cl-f">${CL.files.map(f => `<option${f === x.file ? ' selected' : ''}>${esc(f)}</option>`).join('')}${CL.files.includes(x.file) ? '' : `<option selected>${esc(x.file)}</option>`}</select></b>
      <span class="hint">сила <input class="cl-s" type="number" step="0.05" min="-4" max="4" value="${x.strength}" style="width:70px"></span>
      <button class="chip cl-on${x.on ? ' on' : ''}" type="button">${x.on ? 'включена' : 'выключена'}</button>
      <button class="btn mini cl-x" type="button">Убрать</button></div>`).join('')
    : '<div class="hint">Пока нет своих LoRA.</div>';
}
export const saveCL = () => postJSON('/api/loras/custom', { items: CL.items }).catch(e => toast(e.message));
$('#clAdd').onclick = () => {
  if (!CL.files.length) { toast('ComfyUI не видит файлов в папке loras'); return; }
  CL.items.push({ file: CL.files[0], strength: 0.8, on: true }); renderCL(); saveCL();
};
$('#clRe').onclick = loadCL;
$('#clList').addEventListener('change', e => {
  const row = e.target.closest('.m'); if (!row) return; const x = CL.items[+row.dataset.i];
  if (e.target.matches('.cl-f')) x.file = e.target.value; else if (e.target.matches('.cl-s')) x.strength = +e.target.value || 0;
  saveCL();
});
$('#clList').addEventListener('click', e => {
  const row = e.target.closest('.m'); if (!row) return; const i = +row.dataset.i;
  if (e.target.closest('.cl-on')) CL.items[i].on = !CL.items[i].on; else if (e.target.closest('.cl-x')) CL.items.splice(i, 1); else return;
  renderCL(); saveCL();
});
onNav('models', loadCL);
$('#setCustom').onclick = () => $('#navCustom').click();
$('#cwBack').onclick = () => $('.nav[data-view="models"]').click();
$('#navCustom').addEventListener('click', () => { $$('.nav').forEach(x => x.classList.toggle('active', x.dataset.view === 'models')); });
if (API) {
  fetch('/api/status').then(r => r.json()).then(s => {
    firstRun(!s.configured || !localStorage.getItem('h3-seen-settings'));
    if (!s.configured) { setNavLocked(true); goTo('models'); return; }
    setTimeout(() => {   // back to the page where the user was last time
      let v = ''; try { v = localStorage.getItem('h3-last-view') || ''; } catch {}
      const n = v && $(`.nav[data-view="${v}"]`);
      if (n && !n.hidden && !n.disabled && v !== 'models') goTo(v); else if (!v) goTo('presets');   // a first start opens the start page
    }, 700);
  });
  fetch('/api/library').then(r => r.json()).then(items => { items.forEach(it => LIB.push(normItem(it))); renderLib(); });
} else
// demo items so the library isn't empty in the mockup
[
  ['video', 'Футболист бежит на камеру в замедленной съёмке, пасмурный день, мягкий свет', '16:9', '720p', 5, 'Изображение -> видео', 2],
  ['lipsync', '<Picture 1> поёт у окна, за стеклом дождь, тёплый свет лампы', '9:16', '1080p', 9.4, '2 реф. · аудио 9.4 с', 1],
  ['video', 'Бард играет на рояле в полутёмном зале, камера медленно облетает его', '16:9', 'HD+', 8, 'Текст -> видео', 1],
  ['lipsync', '<Picture 1> читает рэп на крыше ночного города, неон', '9:16', '720p', 11.2, '3 реф. · аудио 11.2 с', 0],
  ['video', 'Кошка прыгает на подоконник и смотрит на снег', '1:1', '720p', 4, 'Кадр -> кадр', 0],
].forEach(([mode, prompt, aspect, q, len, sub, daysAgo], i) => {
  const [w, h] = resFor(aspect, q), d = new Date(Date.now() - daysAgo * 864e5 - i * 37e5);
  const c = document.createElement('canvas'); c.width = 320; c.height = 200; drawCover(c.getContext('2d'), makeScene(i / 7 + .05), 320, 200);
  addToLib({ mode, prompt, aspect, q, len, sub, res: `${w}×${h}`, thumb: c.toDataURL('image/jpeg', .85) }, d);
});
// theme switcher
(() => {
  const KEY = 'h3-theme', root = document.documentElement, box = document.getElementById('themes');
  const apply = t => {
    if (t) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    box.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === (t || '')));
    if (typeof drawWave === 'function' && peaks && peaks.length) { try { drawWave(); } catch {} }
  };
  let cur = ''; try { cur = localStorage.getItem(KEY) || ''; } catch {}
  apply(cur);
  box.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    apply(b.dataset.t); try { localStorage.setItem(KEY, b.dataset.t); } catch {}
  });
})();
