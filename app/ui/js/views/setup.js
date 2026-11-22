import { postJSON } from '../core/net.js';
import { $, $$, GB, confirmBox, esc, toast } from '../core/util.js';
import { MODE_ORDER } from '../core/modes.js';
import { setSetupModes, setSetupProfile, setupModes, setupProfile } from '../core/state.js';
import { goTo, setNavLocked } from '../core/tabs.js';
import { mountCloud } from './models.js';
import { loadStatus } from './system.js';

// start with one mode: a full set is ~100 GB, most people need one task to begin with
export let setupInfo = null, setupOpt = 'new';   // setupProfile и setupModes лежат в core/state.js: их читает «Сценарист»
export function setSetupInfo(v) { setupInfo = v; }   // пишут и чужие модули
export const SETUP_STEPS = [['comfy', 'ComfyUI'], ['nodes', 'Ноды'], ['start', 'Запуск ComfyUI'], ['models', 'Модели']];

export function setStep(n) {
  $$('#setupSteps .step').forEach(s => {
    const k = +s.dataset.s; s.classList.toggle('done', k < n); s.classList.toggle('cur', k === n);
    $('i', s).textContent = k < n ? '✓' : k;
  });
}
export function showSetupPane(which) {
  $('#wzChoose').hidden = which !== 'choose';
  $('#wzProgress').hidden = which !== 'progress';
  $('#mdStatus').hidden = which !== 'status';
  $('#setupTitle').textContent = which === 'status' ? 'Настройки' : 'Установка';
  $('#setupSteps').hidden = which === 'status';
}

export function showRestore(on) { const row = $('#wzRestoreRow'); if (row) row.hidden = !on; }
export async function openSetup() {
  showSetupPane('choose'); setStep(1);
  const qs = new URLSearchParams({ modes: setupModes.join(',') });
  if ($('#instDir').value) qs.set('install_dir', $('#instDir').value);
  if (setupProfile) qs.set('profile', setupProfile);
  setupInfo = await (await fetch('/api/setup/info?' + qs)).json();
  showRestore(!!setupInfo.can_restore);   // the button has to be visible on every step of the wizard
  setSetupProfile(setupInfo.profile);
  if (setupInfo.installing) { showSetupPane('progress'); setStep(2); replaySetup(setupInfo); return; }
  const hw = setupInfo.hardware, c = setupInfo.config;
  // before setup ComfyUI may not exist yet, so the sidebar shows the detected card instead
  $('#hwGrid').innerHTML = [
    ['Видеокарта', hw.nvidia ? hw.gpu : 'нет видеокарты NVIDIA (работает только с NVIDIA)'], ['Видеопамять', hw.vram_gb ? hw.vram_gb + ' ГБ' : '—'],
    ['Оперативная память', hw.ram_gb + ' ГБ'], ['Свободно на диске', hw.disk_free_gb != null ? hw.disk_free_gb + ' ГБ' : '—'],
  ].map(([k, v]) => `<div><small>${k}</small><b>${esc(String(v))}</b></div>`).join('');
  const V = { ok: ['ok', 'Подходит'], weak: ['weak', 'Будет работать медленно'], unsupported: ['unsupported', 'Не подходит'] }[setupInfo.verdict];
  $('#hwVerdict').className = 'verdict ' + V[0]; $('#hwVerdict').textContent = V[1];
  $('#hwNotes').innerHTML = setupInfo.notes.map(n => `<li>${esc(n)}</li>`).join('')
    + (hw.nvidia && hw.driver && hw.driver < 580 ? '<li style="list-style:none;margin-left:-18px"><button class="btn pri" id="drvBtn" type="button">Скачать свежий драйвер NVIDIA</button></li>' : '');
  const drvBtn = $('#drvBtn'); if (drvBtn) drvBtn.onclick = () => fetch('/api/open-driver-page', { method: 'POST' });
  if (!$('#instDir').value) $('#instDir').value = setupInfo.install_dir;

  if (c.comfy_url) $('#comfyUrl').value = c.comfy_url;
  extKind(!c.comfy_url || /\/\/(127\.|localhost)/.test(c.comfy_url) ? 'local' : 'rent');   // a saved rented server opens in the «rented» form
  const free = hw.disk_free_gb;
  $('#diskHint').textContent = `Понадобится до ~${setupInfo.need_gb} ГБ (если моделей ещё нет)` + (free != null ? `, свободно ${free} ГБ` : '')
    + (free != null && free < setupInfo.need_gb ? ' — места может не хватить, выберите другой диск' : '');
  $('#planList').innerHTML = setupInfo.plan.map(m =>
    `<div class="m"><b>${esc(m.file)}<small>${esc(m.title)}</small></b><span></span><span class="st">${GB(m.size)}</span></div>`).join('');
  const key = 'selected';
  const P = setupInfo.profiles;
  $$('#modePick .mcard').forEach(c => {
    c.classList.toggle('on', setupModes.includes(c.dataset.m));
    $('#modeAll').textContent = $$('#modePick .mcard').every(x => setupModes.includes(x.dataset.m)) ? 'Снять все (оставить только «Видео»)' : 'Выбрать все';
    $('small', c).textContent = `~${P[setupProfile].sizes[c.dataset.m]} ГБ, если ставить только его`
      + (c.dataset.m === 'relayvsr' && setupInfo.relay_ok === false ? ' · сам режим заработает, когда ComfyUI обновится' : '');
  });
  const shared = setupModes.includes('lipsync') && setupModes.includes('refs')
    ? ' «Клип» и «Видеостудия» используют одну и ту же основную модель — вместе они почти не добавляют места.' : '';
  $('#modeTotal').innerHTML = `<span>Скачается всего: <b>~${P[setupProfile].sizes.selected} ГБ</b> (из них ~19 ГБ — общая часть для любого режима: текстовый энкодер и VAE).${shared}</span>`;
  $('#profilePick').innerHTML = Object.entries(P).map(([k, p]) =>
    `<button data-p="${k}" class="${k === setupProfile ? 'on' : ''}">${p.title}${k === setupInfo.recommended ? ' ★' : ''}<small>~${p.sizes[key]} ГБ</small></button>`).join('');
  $('#profileAbout').textContent = P[setupProfile].about + (setupProfile === setupInfo.recommended ? ' · ★ рекомендуем для вашего компьютера' : '');
  pickOpt(setupOpt);
}
$('#modePick').onclick = e => {
  const c = e.target.closest('.mcard'); if (!c) return;
  const m = c.dataset.m;
  const next = setupModes.includes(m) ? setupModes.filter(x => x !== m) : [...setupModes, m];
  if (!next.length) { toast('Нужен хотя бы один режим'); return; }
  setSetupModes(next.sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b))); openSetup();
};
$('#modeAll').onclick = () => {
  const all = $$('#modePick .mcard').map(c => c.dataset.m);
  setSetupModes(all.every(m => setupModes.includes(m)) ? ['video'] : all.sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b)));
  openSetup();
};
$('#profilePick').onclick = e => {
  const b = e.target.closest('button[data-p]'); if (!b) return;
  setSetupProfile(b.dataset.p); openSetup();
};
export function pickOpt(opt) {
  setupOpt = opt;
  if (opt === 'cloud') { $('.opt[data-opt="cloud"]').hidden = false; $('#optCloudShow').hidden = true; }
  $('#wzForm').hidden = opt === 'cloud'; $('#wzCloud').hidden = opt !== 'cloud';
  if (opt === 'cloud') mountCloud($('#wzCloud'), true);
  $$('#wzChoose .opt').forEach(o => o.classList.toggle('on', o.dataset.opt === opt));
  $$('#wzForm .fld').forEach(f => f.hidden = !f.dataset.for.split(' ').includes(opt));
  $('#wzStart').textContent = opt === 'external' ? 'Подключиться' : 'Установить';
  // with your own ComfyUI nothing is downloaded: the choice only says which sections are in use
  $('#modePick').classList.toggle('ext', opt === 'external'); $('#modeTotal').hidden = opt === 'external';
  $('#modeHint').textContent = opt === 'external' ? '— отметьте разделы, которыми будете пользоваться; остальные приложение проверять не будет' : '— отметьте только нужное, остальное можно докачать потом в разделе «Настройки»';
  $('#wzErr').textContent = '';
}
$$('#wzChoose .opt').forEach(o => o.onclick = () => pickOpt(o.dataset.opt));
/* own ComfyUI: on this computer (nothing to fill) or a rented server (two fields: address and key) */
export let extK = 'local';
export function extKind(k) {
  extK = k; const rent = k === 'rent', url = $('#comfyUrl');
  $$('#extKind button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  if (rent && url.value.trim() === 'http://127.0.0.1:8188') url.value = '';
  if (!rent && !url.value.trim()) url.value = 'http://127.0.0.1:8188';
  url.placeholder = rent ? 'Ссылка «StableDiffusion» из панели сервиса или http://IP-адрес:8000' : '';
  $('#extUrlL').textContent = rent ? 'Шаг 1. Адрес сервера или ссылка «StableDiffusion»' : 'Адрес вашего ComfyUI на этом компьютере';
  $('#extUrlH').textContent = rent ? 'Проще всего вставить ссылку «StableDiffusion» из панели сервиса целиком: в ней уже есть и адрес, и ключ. Или впишите http://IP-адрес:8000 (порт 8000 у Immers.Cloud).' : 'ComfyUI должен быть запущен. Обычно адрес уже верный: http://127.0.0.1:8188';
  $('#extKeyBox').hidden = !rent;
  $('#extUrlL').parentElement.classList.toggle('ext-hl', rent);
}
$('#extKind').onclick = e => { const b = e.target.closest('button'); if (b) extKind(b.dataset.k); };
$('#instDir').onchange = () => openSetup();
$$('[data-pick]').forEach(b => b.onclick = async () => {
  if (!window.pywebview?.api?.pick_folder) { $('#' + b.dataset.pick).focus(); toast('Впишите путь к папке вручную'); return; }
  const p = await window.pywebview.api.pick_folder($('#' + b.dataset.pick).value);
  if (p) { $('#' + b.dataset.pick).value = p; if (b.dataset.pick === 'instDir') openSetup(); }
});

export function lowMemoryAsk(text, retry) {
  confirmBox('Видеопамяти может не хватить', (text || '') + ' Можно рискнуть: если память кончится, работа остановится и скажет об этом прямо.',
    'Всё равно начать', async () => { try { await postJSON('/api/gate/off', {}); } catch (e) { } retry(); });
}

/* Клип, который человек приносит продолживать, может нести память о себе: режим, сид и промпт
   вписаны внутрь файла. Нашли - показываем под кнопкой выбора и даём забрать промпт. */
/* install progress */
export const prog = { cur: null, done: new Set(), t: 0, b: 0, speed: 0 };
export function resetProgress() {
  Object.assign(prog, { cur: null, done: new Set(), t: 0, b: 0, speed: 0 });
  ['#pRetry', '#pDone'].forEach(s => $(s).hidden = true); $('#pCancel').hidden = false;
  $('#pErr').textContent = ''; $('#pLabel').textContent = 'Готовимся…'; $('#pBar').style.width = 0;
  $('#pBytes').textContent = $('#pSpeed').textContent = '';
  renderPSteps();
}
export function renderPSteps() {
  $('#pSteps').innerHTML = SETUP_STEPS.map(([id, name], i) => {
    const cls = prog.done.has(id) ? 'done' : prog.cur === id ? 'cur' : '';
    return `<div class="ps ${cls}"><i>${prog.done.has(id) ? '✓' : i + 1}</i>${name}</div>`;
  }).join('');
}
export function onSetupEvent(ev) {
  if ($('#wzProgress').hidden && ev.step !== 'finish') { showSetupPane('progress'); setStep(2); }
  if (ev.step === 'finish') {
    $('#pCancel').hidden = true;
    if (ev.state === 'done') {
      SETUP_STEPS.forEach(([id]) => prog.done.add(id)); prog.cur = null; renderPSteps();
      $('#pLabel').textContent = 'Всё установлено!'; $('#pBar').style.width = '100%';
      $('#pBytes').textContent = $('#pSpeed').textContent = '';
      $('#pDone').hidden = false; setStep(3);
    } else {
      $('#pErr').textContent = ev.label; $('#pRetry').hidden = false;
    }
    return;
  }
  if (ev.state === 'done') prog.done.add(ev.step);
  else prog.cur = ev.step;
  renderPSteps();
  if (ev.label) $('#pLabel').textContent = ev.label;
  const done = ev.overall_done ?? ev.done, total = ev.overall_total ?? ev.total;
  if (ev.step === 'nodes' || (total === 100 && !done)) {
    $('#pBytes').textContent = $('#pSpeed').textContent = '';
    if (total) $('#pBar').style.width = Math.min(100, done / total * 100) + '%';
  } else if (done != null && total) {
    $('#pBar').style.width = Math.min(100, done / total * 100) + '%';
    const unit = total > 1000;
    $('#pBytes').textContent = unit ? `${GB(done)} из ${GB(total)}` + (ev.count ? ` · файл ${ev.index} из ${ev.count}` : '') : `${done}%`;
    const now = performance.now();
    if (unit && prog.t && now - prog.t > 900) {
      const sp = (done - prog.b) / ((now - prog.t) / 1000);
      prog.speed = prog.speed ? prog.speed * 0.7 + sp * 0.3 : sp;
      const left = (total - done) / Math.max(prog.speed, 1);
      $('#pSpeed').textContent = prog.speed > 0 ? `${(prog.speed / 1e6).toFixed(1)} МБ/с · осталось ~${left > 3600 ? Math.floor(left / 3600) + ' ч ' : ''}${Math.round(left % 3600 / 60)} мин` : '';
      prog.t = now; prog.b = done;
    } else if (!prog.t || done < prog.b) { prog.t = now; prog.b = done; }
  } else if (ev.state === 'done') $('#pBar').style.width = '100%';
}
export function replaySetup(info) { resetProgress(); (info.log || []).forEach(onSetupEvent); if (info.last) onSetupEvent(info.last); }
$('#pCancel').onclick = () => { postJSON('/api/setup/cancel'); $('#pLabel').textContent = 'Останавливаем…'; };
$('#pRetry').onclick = async () => {
  try {
    await postJSON('/api/setup/install', { install_dir: $('#instDir').value.trim(), profile: setupProfile, modes: setupModes });
    resetProgress();
  } catch (e) { $('#pErr').textContent = e.message; }
};
$('#pDone').onclick = afterSetup;
export async function afterSetup() {
  setNavLocked(false); await loadStatus(); goTo('video');
}

export function diskNote() {   // сколько осталось на диске с настройками, а не вечная страшилка "мало места"
  const n = window.DISK_FREE;
  if (typeof n !== 'number' || !isFinite(n)) return '';
  return n < 30 ? ` · свободно ${n} ГБ, место на исходе` : ` · свободно ${n} ГБ`;
}
