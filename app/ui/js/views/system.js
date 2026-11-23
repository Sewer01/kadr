import { API, postJSON } from '../core/net.js';
import { $, confirmBox, esc, g1, meter, shortCpu, toast } from '../core/util.js';
import { MD_NEED, QUEUE } from '../core/state.js';
import { goTo, groupOf, NAV_GROUP_TITLES, partOfGroup } from '../core/tabs.js';
import { CLOUD, mdStart, renderModels } from './models.js';
import { qAdd } from './queue.js';
import { resetProgress, setStep, setupInfo, showSetupPane, setSetupInfo } from './setup.js';

export let ENGINE_ON = true;
export let WAIT_CORE = 0;
/* ComfyUI boots for tens of seconds; until the list is there the page keeps asking by itself */
export function waitCore() {
  if (WAIT_CORE) return;
  let n = 0, tried = false;
  WAIT_CORE = setInterval(async () => {
    if (++n > 45 || !document.querySelector('#view-models.active')) { clearInterval(WAIT_CORE); WAIT_CORE = 0; return; }
    await loadStatus();
    if (ENGINE_ON) { clearInterval(WAIT_CORE); WAIT_CORE = 0; toast('ComfyUI отвечает — список моделей обновлён'); return; }
    if (!tried && n === 12) { tried = true; toast('ComfyUI всё молчит — пробую запустить его заново'); startEngine(true); }
    if (n === 45) coreLogHint();
  }, 4000);
}
export async function startEngine(quiet) {
  try {
    const r = await postJSON('/api/engine/start', {});
    if (!quiet) toast(r.note || 'ComfyUI уже работает');
    if (r.starting) waitCore();
  } catch (e) { toast(e.message); }
}
/* the two logs the program keeps: they say why ComfyUI stays silent, the screen cannot */
export async function showCoreLog() {
  let j = {};
  try { j = await (await fetch('/api/core-log', { cache: 'no-store' })).json(); }
  catch (e) { toast('Не удалось прочитать журнал: ' + e.message); return; }
  let m = $('#coreLogModal');
  if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'coreLogModal'; document.body.append(m); }
  m.hidden = false;
  m.innerHTML = `<div class="box" style="padding:20px;max-width:960px;max-height:calc(var(--vh,1vh)*88);overflow:auto">
    <div class="card-h"><h3>Почему ComfyUI молчит</h3><button class="btn mini" data-x type="button">Закрыть</button></div>
    <div class="hint" style="margin-bottom:8px">Файлы журнале лежат в ${esc(j.data || 'папке данных')} — их можно скопировать целиком.</div>
    <b style="font-size:13.5px">ComfyUI, последние строки</b>
    <pre style="white-space:pre-wrap;font-size:12px;line-height:1.45;margin:6px 0 16px;max-height:38vh;overflow:auto">${esc(j.comfy || 'пусто')}</pre>
    <b style="font-size:13.5px">Программа</b>
    <pre style="white-space:pre-wrap;font-size:12px;line-height:1.45;margin:6px 0 0;max-height:24vh;overflow:auto">${esc(j.app || 'пусто')}</pre></div>`;
  m.onclick = e => { if (e.target === m || e.target.closest('[data-x]')) m.hidden = true; };
}
export function coreLogHint() {
  const box = $('#mlist');
  if (!box || !document.querySelector('#view-models.active')) return;
  box.innerHTML = `<div class="note warn"><span>ComfyUI не ответил за три минуты. Обычно причина видна в его журнале: видеокарта или драйвер, свободное место, повреждённый файл модели.
    <button class="btn mini" id="coreLogBtn2" type="button" title="Журнал программы: что запускалось, что скачивалось, какие ошибки. Нужен, когда что-то пошло не так">Показать журнал</button></span></div>`;
  const b = $('#coreLogBtn2'); if (b) b.onclick = showCoreLog;
}
export function paintProbe(s) {
  const el = $('#engProbe'); if (!el) return;
  const p = s.probe || {}, url = p.url || s.comfy || '—';
  window.PROBE_OK = !!p.ok;
  el.innerHTML = (p.ok
    ? `ComfyUI отвечает: <b>${esc(url)}</b> · проверено в ${esc(p.at || '—')}`
    : `ComfyUI не отвечает: <b>${esc(url)}</b> · ${esc(p.err || 'нет ответа')} · попыток подряд: ${p.fails || 1}`)
    + ` <button class="btn mini" id="coreLogBtn" type="button">Показать журнал</button>`;
  const b = $('#coreLogBtn'); if (b) b.onclick = showCoreLog;
}
$('#engRow').onclick = () => startEngine();
export function setEngine(on) {
  ENGINE_ON = on;
  const cloudOn = typeof CLOUD !== 'undefined' && CLOUD.enabled;
  $('#engDot').classList.toggle('off', !on && !cloudOn);
  $('#engTxt').textContent = cloudOn ? 'облако' : on ? 'подключён' : 'не запущен';
}
/* the main menu on the left can be hidden (to give the page the whole window) and shown again */
(function () {
  const app = $('.app'), btn = $('#sbToggle');
  const paint = () => { const off = app.classList.contains('nosb'); document.body.classList.toggle('nosb-on', off); btn.textContent = off ? '☰ Меню' : '‹ Меню'; btn.title = off ? 'Показать главное меню' : 'Скрыть главное меню'; };
  btn.onclick = () => { app.classList.toggle('nosb'); try { localStorage.setItem('h3-sb-hidden', app.classList.contains('nosb') ? '1' : ''); } catch {} paint(); };
  try { if (localStorage.getItem('h3-sb-hidden')) app.classList.add('nosb'); } catch {}
  paint();
})();
/* pinned top bar with every video and image section */
(function () {
  const bar = document.createElement('div'); bar.id = 'modeBar'; document.body.appendChild(bar);
  // the names people read all day; the side menu keeps its own, longer ones for now
  const SHORT = { video: 'Видео', lipsync: 'Клип', refs: 'Видеостудия', actor: 'Актёр', swap: 'Замена', voicelab: 'Озвучка',
    reflab: 'Референсы', imgedit: 'Редактирование',
    long: 'Студия', actionsc: 'Экшн-студия', action: 'Экшн-видео',
    krea: 'Изображение по тексту', qwen: 'Изображения', upfile: 'Апскейлинг' };
  // what a button really opens, said in one line: the bar is short by design, the tooltip is not
  const TIP = { video: 'Видео из картинки', lipsync: 'Музыкальный клип', voicelab: 'Голос по описанию, клон по образцу, диалог', refs: 'Видео по референсам',
    reflab: 'Листы референсов персонажа, предмета и места из одного ролика',
    imgedit: 'Выбор варианта правки готового изображения: по описанию, лист персонажа, раскадровка',
    actor: 'Актёрская игра', swap: 'Замена персонажа', long: 'Фильм по сценам',
    actionsc: 'Динамичное видео по сценам', action: 'Динамичное видео',
    krea: 'Изображение по тексту', qwen: 'Изображения', upfile: 'Апскейлинг' };
  // the order a person works in: the picture, then the references, then the studios, then the clip
  // and the actor; pictures and the retouching stay in their own groups, the separators as they were
  const GROUPS = [['video', 'refs', 'long', 'action', 'actionsc', 'clipsc', 'lipsync', 'actor', 'swap'],
                  ['reflab'], ['krea', 'imgedit', 'qwen'], ['voicelab'], ['upfile']];
  function paint() {
    const cur = ($('.view.active')?.id || '').replace('view-', '');
    let html = '';
    GROUPS.forEach(g => {
      const part = g.map(v => {
        const n = $(`.nav[data-view="${v}"]`); if (!n || n.hidden) return '';
        const gp = groupOf(v); if (gp && gp.nav !== v) return '';   // режим группы: своей кнопки на полосе у него нет
        // светится кнопка группы, когда открыт любой режим из неё; подсказка говорит, что там не один режим
        const on = gp ? gp.parts.includes(cur) : v === cur;
        const extra = gp ? ' · режимы: ' + gp.parts.map(k => NAV_GROUP_TITLES[k] || SHORT[k] || k).join(', ') : '';
        return `<button type="button" class="mb${on ? ' on' : ''}" data-go="${v}" title="${((TIP[v] || SHORT[v] || '') + extra).replace(/["<>&]/g, '')}">${n.querySelector('svg')?.outerHTML || ''}<i>${SHORT[v]}</i></button>`;
      }).join('');
      if (part) html += (html ? '<i class="mb-sep"></i>' : '') + part;
    });
    if (bar.innerHTML !== html) bar.innerHTML = html;
    const on = bar.querySelector('.on'); if (on && on.offsetLeft + on.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = on.offsetLeft - 20;
  }
  // кнопка группы открывает тот её режим, на котором человек останавливался
  bar.addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) goTo(partOfGroup(b.dataset.go)); });
  new MutationObserver(paint).observe($('.main'), { attributes: true, attributeFilter: ['class'], subtree: true });
  new MutationObserver(paint).observe($('aside') || document.body, { attributes: true, attributeFilter: ['hidden', 'class'], subtree: true });
  paint();
})();
/* the load box is a thing a person looks at once in a while, not a wall of numbers standing
   in the way: it folds under its own heading, keeps a two-figure summary when folded, and
   remembers the choice between runs */
export let SQ_ASKED = false;
export async function askSavedQueue() {
  if (SQ_ASKED) return; SQ_ASKED = true;
  try {
    const r = await (await fetch('/api/queue/saved')).json();
    if (!r.count) return;
    const cancel = () => fetch('/api/queue/discard', { method: 'POST' });
    const btn = $('#confirm [data-close]'); btn.addEventListener('click', cancel, { once: true });
    confirmBox('Продолжить очередь?', `В прошлый раз осталось ${r.count} незавершённых заданий (программу закрыли или пропало питание). Продолжить их? Задание, которое шло, начнётся заново. Если нажать «Отмена», они будут забыты.`, 'Продолжить', async () => {
      btn.removeEventListener('click', cancel);
      const j = await postJSON('/api/queue/resume');
      (j.jobs || []).forEach(x => qAdd(x.prompt_id, x.mode, x.prompt));
      toast('Задания вернулись в очередь'); goTo('queue');
    });
  } catch {}
}
export let OFFER_SHOWN = false;
export function offerNewModes(s) {
  const o = (s.offer_modes || [])[0];
  if (OFFER_SHOWN || !o) return;
  OFFER_SHOWN = true;
  const show = () => {
    if (!$('#confirm').hidden) return setTimeout(show, 3000);  // another question is open: wait
    const name = { flux: 'Изменение изображения: FLUX klein (можно в коммерцию)', long: '«Студия» (клипы и ролики по сценам)' }[o.mode] || o.mode;
    const btn = $('#confirm [data-close]');
    const later = () => fetch('/api/mode/offered', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: o.mode }) });
    btn.addEventListener('click', later, { once: true });
    confirmBox('Новый режим', (o.gb ? `В обновлении появился режим «${name}». Чтобы он заработал, нужно скачать модели (около ${String(o.gb).replace('.', ',')} ГБ). Добавить сейчас? Скачивание можно закрыть и продолжить позже, оно докачается с того же места.` : `В обновлении появился режим «${name}». Все нужные модели уже лежат в папке моделей - скачивать ничего не придётся, режим заработает сразу. Включить его?`), 'Добавить', async () => {
      btn.removeEventListener('click', later); await later();
      try {
        if (s.engine === 'external') {
          await postJSON('/api/mode/add', { mode: o.mode }); await loadStatus(); goTo('models');
          if (MD_NEED.length) mdStart(MD_NEED);
        } else {
          if (!setupInfo) setSetupInfo(await (await fetch('/api/setup/info')).json());
          const c = setupInfo.config;
          await postJSON('/api/setup/install', { install_dir: c.install_dir, models_dir: c.models_dir || '', add_mode: o.mode });
          showSetupPane('progress'); setStep(2); resetProgress();
        }
      } catch (err) { toast(err.message); }
    });
  };
  setTimeout(show, 2000);
}
export async function loadStatus() {
  let s;
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 25000);   // a core that does not answer must not hang the page
  try {
    s = await (await fetch('/api/status', { signal: ctrl.signal })).json();
  } catch (e) {
    /* the answer never came: say who is silent, and never erase the cards that are already shown */
    const box = $('#mlist');
    if (box && document.querySelector('#view-models.active') && !box.querySelector('.m')) {
      box.innerHTML = `<div class="note warn"><span>${window.PROBE_OK
        ? 'ComfyUI отвечает, но список моделей не собрался вовремя — он сейчас занят. Страница переспрашивает сама; можно нажать «Обновить список».'
        : 'ComfyUI не отвечает: он либо ещё загружается (это около полминуты), либо не запущен. Страница переспрашивает каждые четыре секунды.'}
        <button class="btn mini" id="coreLogBtn3" type="button">Показать журнал</button></span></div>`;
      const cl = $('#coreLogBtn3'); if (cl) cl.onclick = showCoreLog;
      waitCore();
    }
    return;
  }
  try {
    /* the answer is in hand, so everything that fails below is OUR mistake — reporting it as
       "ComfyUI is busy" is exactly how an empty list was blamed on the core for two days */
    $('#setCustomBox').hidden = s.engine !== 'external';
    setEngine(s.online);
    paintProbe(s);
    if (window.paintWin) paintWin(s.window_mode);
    if (window.paintSoftUi) paintSoftUi(!!s.software_ui);
    renderModels(s);            // also when the core is silent: the card has to say why it is empty
    if (!s.online) { waitCore(); return; }
    askSavedQueue();
    offerNewModes(s);
  } catch (e) {
    console.error('Не удалось показать список моделей:', e);
    const box = $('#mlist');
    if (box && !box.querySelector('.m')) {
      box.innerHTML = `<div class="note warn"><span>Программа не смогла показать список моделей: ${esc((e && e.message) || e)}.
        <button class="btn mini" id="coreLogBtn4" type="button">Показать журнал</button></span></div>`;
      const b = $('#coreLogBtn4'); if (b) b.onclick = showCoreLog;
    } else { toast('Список моделей не обновился: ' + ((e && e.message) || e)); }
  }
}

export async function pollSystem() {
  if (!API || document.hidden) return;
  try {
    const s = await (await fetch('/api/system')).json();
    const gpu = s.gpu;
    if (gpu) {
      $('#gpuName').textContent = gpu.name;
      meter('#gpuLoad', '#gpuBar', gpu.util, gpu.util != null ? `${Math.round(gpu.util)} %` : '—');
      meter('#vramTxt', '#vramBar', gpu.vram_used_gb / gpu.vram_total_gb * 100, `${g1(gpu.vram_used_gb)} / ${g1(gpu.vram_total_gb)} ГБ`);
      $('#tempRow').hidden = gpu.temp == null; if (gpu.temp != null) $('#gpuTemp').textContent = `${Math.round(gpu.temp)} °C`;
    // the same block of numbers, but read by a person, not by a machine: what the card is, how hard it
    // works, how much of it is full, what it eats, how hot it is - and the same for the processor
    const pw = gpu.power, pl = gpu.power_limit;
    if (pw != null) {
      $('#gpuPower').textContent = pl ? `${Math.round(pw)} / ${Math.round(pl)} Вт` : `${Math.round(pw)} Вт`;
      const pb = $('#powerBar'); if (pb) pb.style.width = Math.min(100, (pw / (pl || 100)) * 100) + '%';
    }
    const cpu = (typeof s.cpu === 'object' && s.cpu) ? s.cpu : { util: s.cpu };
    const cn = $('#cpuName');
    if (cn) cn.textContent = cpu.name ? shortCpu(cpu.name) : 'не сообщается';
    meter('#cpuTxt', '#cpuBar', cpu.util, cpu.util != null ? `${Math.round(cpu.util)} %` : '—');

      $('#powerRow').hidden = gpu.power == null;
      if (gpu.power != null) $('#gpuPower').textContent = `${Math.round(gpu.power)}` + (gpu.power_limit ? ` / ${Math.round(gpu.power_limit)}` : '') + ' Вт';
    } else $('#gpuName').textContent = 'не найдена';
    const _cpu = (typeof s.cpu === 'object' && s.cpu) ? s.cpu.util : s.cpu;
      meter('#cpuTxt', '#cpuBar', _cpu, _cpu != null ? `${Math.round(_cpu)} %` : '—');
    meter('#ramTxt', '#ramBar', s.ram.used_gb / s.ram.total_gb * 100, `${g1(s.ram.used_gb)} / ${g1(s.ram.total_gb)} ГБ`);
    if (s.disk) {
      $('#diskName').textContent = s.disk.drive;
      // the disk is drawn like every other line: how much is taken, not how much is left in words
      const dtot = s.disk.total_gb || 1, dused = Math.max(0, dtot - (s.disk.free_gb || 0));
      // the words carry the number, the bar carries the share: each of them says one thing
      meter('#diskTxt', '#diskBar', dused / dtot * 100, `свободно ${s.disk.free_gb} ГБ`);
    window.DISK_FREE = +s.disk.free_gb; window.DISK_DRIVE = s.disk.drive; }
  } catch { /* the server is restarting; try again on the next tick */ }
}
setInterval(pollSystem, 2000);
export let GPU_LIVE = null, GPU_AT = 0;
export async function gpuPoll() {
  if (typeof QUEUE === 'undefined' || !QUEUE.some(j => j.state === 'running')) { GPU_LIVE = null; return; }
  const now = performance.now();
  if (now - GPU_AT < 6000) return;
  GPU_AT = now;
  try { GPU_LIVE = await (await fetch('/api/gpu')).json(); } catch (e) { GPU_LIVE = null; }
}
setInterval(() => { try { gpuPoll(); } catch (e) { } }, 6000);
export function gpuNote(j) {
  const g = GPU_LIVE;
  if (!g || g.util == null || !j || !/^sample/.test(String(j.stage || ''))) return '';
  if (g.util <= 25) return ' · карта загружена на ' + Math.round(g.util) + '%: её, похоже, держит другая программа';
  if (g.power_limit && g.power >= g.power_limit * 0.93) return ' · карта упёрлась в лимит питания (' + Math.round(g.power) + ' Вт)';
  if (g.temp >= 83) return ' · карта нагрета до ' + Math.round(g.temp) + '°: скорость ограничена';
  return '';
}

/* Программа помнит, при скольком свободном месте видеопамяти этот режим уже прерывался. Если
   сейчас меньше, пуск останавливается и спрашивает: возможно, память держит браузер или игра.
   Согласие рискнуть действует три минуты - на эту попытку, а не навсегда. */
/* Буфер обмена браузер доверяет только активному окну: стоит человеку кликнуть мимо, и
   navigator.clipboard отказывает. Тогда текст кладём в скрытое поле и копируем по-старому -
   этот способ работает, пока клик настоящий. */
