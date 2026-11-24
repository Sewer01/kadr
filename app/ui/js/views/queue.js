import { $, esc, fmtTime, normItem, toast } from '../core/util.js';
import { MODE_NAME } from '../core/modes.js';
import { LIB, QUEUE, UP_JOB, earlyEvents } from '../core/state.js';
import { goTo } from '../core/tabs.js';
import { addToLib, openViewer } from './library.js';
import { RM, upFinished, upProgress } from './modes.js';
import { ENGINE_ON, gpuNote } from './system.js';
import { setActx } from '../ui/audio.js';

export const QSTAGE = { queued: 'ждёт своей очереди', load: 'загрузка моделей', encode: 'кодирование', sample: 'генерация', sample2: 'проход 2', upscale: 'апскейл',
  decode: 'сборка видео', save: 'сохранение', cloud_queued: 'в очереди RunningHub', cloud_run: 'считается в облаке' };
export function qAdd(id, mode, prompt) {
  const j = { id, mode, prompt: prompt || '', state: 'queued', stage: 'queued', t0: null, detached: false, lastEv: performance.now() };
  QUEUE.push(j);
  (earlyEvents.get(id) || []).forEach(qHandle);
  qRender();
}
export function qHandle(m) {
  const j = QUEUE.find(x => x.id === m.prompt_id); if (!j) return;
  j.lastEv = performance.now();
  if (m.type === 'stage') {
    if (m.eta) j.eta = m.eta;   // сколько эта работа обычно занимает на этой машине
    const samp = String(m.stage).startsWith('sample');
    if (samp && (j.stage !== m.stage || (m.scene && j.scene !== m.scene))) j.step1T = null;
    if (samp && m.step) { j.stepT = performance.now(); if (m.step === 1) j.step1T = j.stepT; }
    j.scene = m.scene; j.nscenes = m.scenes;
    j.state = 'running'; j.stage = m.stage; j.step = m.step; j.max = m.max; j.t0 = j.t0 || performance.now();
  } else if (m.type === 'done') {
    j.state = 'done'; j.took = j.t0 ? (performance.now() - j.t0) / 1000 : 0; j.itemId = (m.item || (m.items || [])[0] || {}).id;
    (m.items || [m.item]).forEach(it => { if (!LIB.some(x => x.id === it.id)) addToLib(normItem(it), new Date(it.date)); /* ready clip belongs to the section that made it: Экшн-видеостудия тоже ходит в эту рассылку,
     раньше здесь была прописана только Видеостудия, и клип Экшн-студии не доходил до ленты сцен */
    if (it.long && typeof RM !== 'undefined') { const rm = RM[it.mode] || RM.long; if (rm && rm.root && rm.root._partDone) rm.root._partDone(normItem(it) || it); } });
    if (j.mode === 'upscale' && j.itemId && $('#view-queue').classList.contains('active') && $('#viewer').hidden) setTimeout(() => openViewer(j.itemId), 400);  // show before/after at once
    /* The card's line used to be closed only when the job had failed: a good retouch left
       «Идёт увеличение 98%» standing there forever, and the finished file was never shown. */
    if (j.mode === 'upscale') upFinished(j);
    if (j.detached) toast(`Готово: ${MODE_NAME[j.mode] || 'видео'} — оно в Библиотеке`);
  } else if (m.type === 'error') {
    j.state = 'error'; j.raw = m.message; j.msg = errSay(m.message);
    if (UP_JOB === j.id) upFinished(j);
    if (j.detached) toast('Задание не получилось: ' + j.msg);
    // сцена из цепочки упала: молча останавливать «сделать все сцены» нельзя - человек видит только
    // что первая сцена вышла, а дальше тишина (именно так и было, когда причина пряталась в ComfyUI)
    ['long', 'actionsc'].forEach(k => { const st = (typeof RM !== 'undefined' && RM[k]) ? RM[k].root : null; if (st && st._chainFail && st._chainPart != null) st._chainFail(m.message); }); }
  else if (m.type === 'interrupted') j.state = 'stopped';
  if (UP_JOB && j.id === UP_JOB) upProgress(j);
  qRender();
}
// what a raw engine error means in plain words - a person cannot guess it from a module name
export function errSay(msg) {
  const s = String(msg || '');
  if (/window_attention/i.test(s) || (/has no attribute/i.test(s) && /comfy_kitchen|attention/i.test(s))) {
    return 'Быстрому увеличению нужен более новый ComfyUI: в вашей версии не хватает узла window_attention. ' +
      'Откройте «Настройки» и обновите ComfyUI - или увеличивайте вариантом «Качественнее», он работает и так.';
  }
  if (/out of memory/i.test(s)) return 'Не хватило памяти видеокарты: возьмите видео короче или уменьшите степень увеличения.';
  if (/Could not find a node|not a valid node|node type/i.test(s)) return 'В ComfyUI не хватает нужного узла: обновите ComfyUI в разделе «Настройки».';
  return s;
}
export const QBASE = { queued: .02, load: .05, encode: .12, sample: .15, upscale: .67, sample2: .7, decode: .92, save: .98, cloud_queued: .05, cloud_run: .4 };
/* what the user should see about a job: how far it is, and whether it is alive (green), quiet (yellow) or probably stuck (red) */
export function jobView(j) {
  const now = performance.now();
  if (j.state === 'queued') {
    const n = QUEUE.filter(x => x.state === 'queued' || x.state === 'running').indexOf(j);
    return { p: 0, lvl: 'ok', label: 'В очереди', txt: n > 0 ? `Ждёт своей очереди: впереди ${n} ${n === 1 ? 'задание' : 'задания(й)'}` : 'Ждёт, пока освободится ComfyUI' };
  }
  const samp = String(j.stage).startsWith('sample') && j.max;
  let p = QBASE[j.stage] ?? .3, label = QSTAGE[j.stage] || 'идёт';
  if (samp) {
    const f = (j.step || 0) / j.max;
    p = j.stage === 'sample2' ? .7 + .2 * f : .15 + .75 * f;
    if (j.scene) p = .15 + .75 * ((j.scene - 1 + f) / j.nscenes);
    label = (j.scene ? `сцена ${j.scene}/${j.nscenes} · ` : '') + `шаг ${j.step || 0} из ${j.max}`;
  }
  const idle = (now - (j.lastEv || now)) / 1000;
  const per = j.step >= 2 && j.step1T ? (j.stepT - j.step1T) / (j.step - 1) / 1000 : 0;
  const warnAt = samp ? Math.max(90, per * 3) : 300, badAt = samp ? Math.max(240, per * 6) : 600;
  let lvl = 'ok', txt = 'Всё идёт, программа получает данные от ComfyUI';
  if (String(j.stage).startsWith('cloud')) txt = 'Считается в облаке';
  else if (!ENGINE_ON) { lvl = 'bad'; txt = 'Обрыв связи: ComfyUI не отвечает или закрылся'; }
  else if (idle > badAt) { lvl = 'bad'; txt = `Нет ответа уже ${fmtTime(idle)}. Похоже, зависло: нажмите «Остановить» и запустите снова`; }
  else if (idle > warnAt) { lvl = 'warn'; txt = `Тишина ${fmtTime(idle)}. ${samp ? 'Шаг идёт долго, на слабой карте так бывает' : 'Возможно, грузится большая модель'}. Если станет красным, то зависло`; }
  else if (samp && j.step) txt = `Всё идёт · последний шаг был ${fmtTime(idle)} назад`;
  return { p, lvl, label, txt };
}
export function dockRender() {
  const act = QUEUE.filter(j => j.state === 'queued' || j.state === 'running');
  const j = act.find(x => x.state === 'running') || act[0], d = $('#dock');
  const hide = !j || $('#view-queue').classList.contains('active') || !!document.querySelector('.view.active .pbox:not([hidden])') || !$('#viewer').hidden;
  d.hidden = hide; if (hide) return;
  const v = jobView(j);
  $('#dockL').textContent = `${MODE_NAME[j.mode] || 'Задание'} · ${v.label}` + (act.length > 1 ? ` · всего ${act.length}` : '');
  $('#dockP').textContent = j.state === 'queued' ? '' : Math.round(v.p * 100) + '%';
  $('#dockBar').style.width = (v.p * 100) + '%';
  $('#dockChip').className = 'pbox-chip ' + v.lvl; d.className = 'dock ' + v.lvl; $('#dockTxt').textContent = v.txt;
}
$('#dock').onclick = () => goTo('queue');
export function qRender() {
  dockRender();
  const act = QUEUE.filter(j => j.state === 'queued' || j.state === 'running');
  const badge = $('#qBadge'); badge.hidden = !act.length; badge.textContent = act.length;
  const box = $('#qList'); if (!box) return;
  const fin = QUEUE.filter(j => !act.includes(j)).slice(-30).reverse();
  $('#qClear').hidden = !fin.length;
  const row = (j, n) => {
    const run = j.state === 'running', samp = run && String(j.stage).startsWith('sample') && j.max;
    let st = run ? (QSTAGE[j.stage] || 'идёт') : j.state === 'queued' ? 'ждёт своей очереди' : j.state === 'done' ? `готово за ${fmtTime(j.took)} · результат в Библиотеке`
      : j.state === 'stopped' ? 'остановлено' : 'ошибка: ' + (j.msg || '');
    if (samp) st += ` · шаг ${j.step || 0} из ${j.max}`;
    if (run && j.t0) st += ` · прошло ${fmtTime((performance.now() - j.t0) / 1000)}`;
    // срок берём из прошлых прогонов того же режима на этом же компьютере, а не из инструкции
    if (j.eta >= 20) {
      const went = j.t0 ? (performance.now() - j.t0) / 1000 : 0;
      st += run ? (went < j.eta ? ` · по прошлым запускам ~${fmtTime(j.eta)}, осталось ~${fmtTime(j.eta - went)}`
                                : ` · по прошлым запускам ~${fmtTime(j.eta)}, сейчас дольше обычного`)
                : ` · по прошлым запускам ~${fmtTime(j.eta)}`;
    }
    if (run) st += gpuNote(j);   // почему идёт медленнее, если видеокарта занята не нашей работой
    const cls = j.state === 'done' ? ' ok' : j.state === 'error' ? ' err' : run ? ' run' : '';
    if (j.stopping && act.includes(j)) st = 'останавливаем… ComfyUI заканчивает текущий шаг, это может занять несколько секунд';
    const btn = act.includes(j) ? (j.stopping ? `<button class="btn" disabled>Останавливаем…</button>` : `<button class="btn" data-q="stop" data-id="${j.id}">${run ? 'Остановить' : 'Убрать'}</button>`)
      : j.state === 'done' ? '<button class="btn" data-q="lib">В Библиотеку</button>' : '';
    const live = act.includes(j), v = live ? jobView(j) : null;
    const big = live ? `<div class="q-big ${v.lvl}"><i style="width:${Math.round(v.p * 100)}%"></i></div><div class="pbox-chip ${v.lvl}"><span class="pbox-dot"></span><span>${run ? Math.round(v.p * 100) + '% · ' : ''}${esc(v.txt)}</span></div>` : '';
    const cmpB = j.state === 'done' && j.mode === 'upscale' && j.itemId ? `<button class="btn pri" data-q="cmp" data-id="${j.itemId}">До и после</button>` : '';
    return `<div class="q-row${cls}"><div class="q-n">${n || (j.state === 'done' ? '' : '·')}</div><div><div class="q-t">${esc(MODE_NAME[j.mode] || 'Видео')}: ${esc(j.prompt.slice(0, 120) || 'без промпта')}</div>`
      + `<div class="q-s">${esc(st)}</div>${big}</div>${cmpB || btn}</div>`;
  };
  box.innerHTML = QUEUE.length ? act.map((j, i) => row(j, i + 1)).join('') + fin.map(j => row(j, 0)).join('')
    : '<div class="q-empty">Очередь пуста. Нажмите «Сгенерировать» в любом разделе — задание появится здесь.</div>';
}
$('#qList').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.q === 'lib') return goTo('library');
  if (b.dataset.q === 'cmp') return openViewer(b.dataset.id);
  b.disabled = true;
  const sj = QUEUE.find(j => j.id === b.dataset.id); if (sj) { sj.stopping = true; qRender(); }   // the list is redrawn every second: remember that a stop was asked, so the button doesn't come back
  fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: b.dataset.id }) });
});
$('#qClear').onclick = () => { for (let i = QUEUE.length - 1; i >= 0; i--) if (!['queued', 'running'].includes(QUEUE[i].state)) QUEUE.splice(i, 1); qRender(); };
/* Метка программы отвечает за расчёт: пульсирует, пока в очереди что-то есть,
   и в конце одна вспышка плюс короткий сигнал - человек уходит в другое окно и
   возвращается по звуку. Всё это гасится переключателем в «Настройках». */
let NOTIFY_BUSY = false;
function notifyDone() {
  const mark = document.querySelector('.brand-mark');
  if (mark) { mark.classList.remove('work-done'); void mark.offsetWidth; mark.classList.add('work-done'); }
  try {
    const ac = setActx();
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime + 0.02;
    [[660, 0], [880, 0.16]].forEach(([f, d]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.16, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.17);
      o.connect(g); g.connect(ac.destination); o.start(t + d); o.stop(t + d + 0.2);
    });
  } catch (e) { }
}
setInterval(() => {
  /* Метка пульсирует и за работу сценариста тоже: его «думаю…» человек должен
     видеть из любого окна, а не только читая чат. */
  const busy = QUEUE.some(j => j.state === 'running' || j.state === 'queued') || !!window._agNote;
  if (busy !== NOTIFY_BUSY) {
    NOTIFY_BUSY = busy;
    const mark = document.querySelector('.brand-mark');
    if (mark) mark.classList.toggle('work', busy);
    if (!busy && window.notifyOn && window.notifyOn()) notifyDone();
  }
  if (QUEUE.some(j => j.state === 'running' || j.state === 'queued')) qRender(); else dockRender();
}, 1000);
qRender();
