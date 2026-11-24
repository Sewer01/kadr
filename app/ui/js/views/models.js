import { API, postJSON } from '../core/net.js';
import { $, $$, GB, confirmBox, copyText, esc, toast } from '../core/util.js';
import { MODE_ORDER } from '../core/modes.js';
import { MD_NEED, QUEUE, setMdNeed } from '../core/state.js';
import { SET_LOCK, firstRun, goTo, onNav, setNavLocked } from '../core/tabs.js';
import { vAccCheck } from './modes.js';
import { fitTopBar, foldOnOpen } from './presets.js';
import { afterSetup, diskNote, openSetup, resetProgress, setStep, setupInfo, showRestore, showSetupPane, setSetupInfo } from './setup.js';
import { loadStatus, startEngine } from './system.js';

/* status after setup */
export let MD_ENGINE = '', MD_EXTDIR = '';   // MD_NEED (что докачать) лежит в core/state.js: его читает «Система»
export let MD_EXT = false;
export function renderModels(s) {
  if (s.models_error) {
    $('#mlist').innerHTML = `<div class="note warn"><span>Список моделей не собрался: ${esc(s.models_error)}. ComfyUI отвечает, но не отдаёт файлы — попробуйте «Обновить список» или перезапустите его кнопкой «Движок» слева внизу.</span></div>`;
    return;
  }
  if (!s.models) {   // ComfyUI has not answered yet: an empty page looks like "you have no models at all"
    $('#mlist').innerHTML = `<div class="note"><span>${s.online
      ? 'Список моделей пока не пришёл. Нажмите «Обновить список».'
      : 'ComfyUI ещё не отвечает — после запуска он загружается около полминуты. Список появится сам, страницу закрывать не нужно. <button class="btn mini" id="mlistStart" type="button" style="margin-left:6px">Запустить ComfyUI</button>'}</span></div>`;
    $('#modelsBadge').hidden = true;
    const st = $('#mlistStart'); if (st) st.onclick = () => startEngine();
    return;
  }
  MD_ENGINE = s.engine;
  const req = s.models.filter(m => m.needed);   // optional files are listed too, but they must not make the counter look broken
  const have = req.filter(m => m.have).length;
  $('#modelsBadge').textContent = `${have} / ${req.length}`; $('#modelsBadge').hidden = false;
  const miss = s.models.filter(m => !m.have).map(m => m.role).sort().join(',');
  if (window._missSig !== undefined && window._missSig !== miss && window.refreshMdl) window.refreshMdl();
  window._missSig = miss;
  /* список был сплошной простынёй: непонятно, к какому разделу какой файл, теперь группы
     по режимам - файл показан один раз под тем режимом, который раньше всех в нём участвует,
     а остальные режимы перечислены в самой строке */
  const MNAME = { video: 'Видео', lipsync: 'Клип', refs: 'Видеостудия', actor: 'Актёр', swap: 'Замена', action: 'Экшн-видео', actionsc: 'Экшн-студия', h3img: 'Изображения MiniMax H3 Image', long: 'Студия', krea: 'Изображение по тексту', kreareal: 'Изображение по тексту: реализм', qwen: 'Изменение изображения', flux: 'Изменение изображения: FLUX.2 (в коммерцию)', upscale: 'Апскейлинг видео и изображений', relayvsr: 'Апскейлинг видео · быстро (RelayVSR)' };
  const mRow = m => {
    const optional = !m.modes.length;
    const st = m.have ? '<span class="st ok">, загружено</span>' : optional ? '<span class="st opt" title="Без этого файла разделы работают; он добавляет возможность. Нажмите «Скачать», чтобы взять его.">по желанию</span>' : '<span class="st miss" title="Этот файл нужен выбранным разделам. Нажмите «Докачать недостающие» или «Скачать».">нет файла</span>';
    const modes = m.modes.map(x => MNAME[x] || x).join(', ') || 'дополнительно';

    return `<div class="m"><b>${esc((m.name || m.file || '').split('\\').pop())}<small>${esc(m.title)} · ${modes}<br>Нужен файл: <span class="mf" title="Нажмите, чтобы скопировать имя">${esc(m.file || '')}</span> · положить в папку ${esc(m.folder || '')} вашего ComfyUI (подойдёт и любая подпапка в ней)${m.marks ? ` · в названии: ${esc(m.marks)}` : ''}</small></b><span class="hint sz">${GB(m.size)}</span>${st}<div class="m-btns" style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap">${!m.have ? `<button class="btn mini pri" type="button" data-dlnow="${m.role}" title="Скачать этот файл прямо в папку моделей вашего ComfyUI">Скачать (${GB(m.size)})</button>` : ''}<button class="btn mini" type="button" data-dlmodel="${m.role}" title="Открыть страницу скачивания этого файла в браузере">Страница в интернете…</button><button class="btn mini" type="button" data-copyurl="${esc(m.url || '')}" title="Скопировать прямую ссылку, чтобы скачать менеджером загрузок или через другой компьютер">Копировать ссылку</button><button class="btn mini" type="button" data-copyname="${esc(m.file || '')}" title="Скопировать имя файла, чтобы найти его на компьютере или на сайте">Копировать имя</button><button class="btn mini" type="button" data-pickmodel="${m.role}" title="${m.have ? 'Заменить на другой файл (например, другую точность модели)' : 'Если файл у вас называется иначе — выберите его вручную'}">${m.have ? (m.picked ? 'Другой файл ' : 'Заменить…') : 'Указать файл…'}</button>${m.variants && m.variants.length > 1 ? `<button class="btn mini" type="button" data-variant="${m.role}" title="Поставить другую версию этой же модели, например полегче или новее">Другая версия…</button>` : ''}${m.lic ? `<span class="licb ${m.lic}" title="${esc(m.lic_note || '')}">${({ nc: 'нельзя в коммерцию', unknown: 'лицензия не указана', mixed: 'ролик можно, модель — нет', h3: 'MiniMax H3: условия' })[m.lic] || 'лицензия'}</span>` : ''}</div></div>`;
  };
  const ownerOf = m => !m.modes.length ? '' : m.modes.slice().sort((a, b) => {
    const ia = MODE_ORDER.indexOf(a), ib = MODE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  })[0];
  const MG = {};
  s.models.forEach(m => { const g = ownerOf(m) || '_extra'; (MG[g] = MG[g] || []).push(m); });
  $('#mlist').innerHTML = [...MODE_ORDER.filter(k => MG[k]), ...MG._extra ? ['_extra'] : []].map(k => {
    const list = MG[k], got = list.filter(m => m.have).length;
    const bad = list.filter(m => !m.have && k !== '_extra').length;
    return `<div class="mg"><b>${k === '_extra' ? 'Дополнительные файлы' : esc(MNAME[k] || k)}</b>`
      + `<small>${got} из ${list.length} · ${k === '_extra' ? 'ставятся по желанию' : bad ? bad + ' не хватает' : 'всё на месте'}</small></div>`
      + list.map(mRow).join('');
  }).join('');
  $('#mdFix').hidden = s.engine !== 'managed' || s.models.every(m => m.have || !m.modes.length);
  MD_EXT = s.engine === 'external';
  $('#mdMirror').checked = !!s.hf_mirror;
  MD_EXTDIR = (s.paths && s.paths.ext_models) || '';
  const need = s.models.filter(m => !m.have && m.modes.some(x => (s.modes || []).includes(x)));
  setMdNeed(need.map(m => m.role));
  $('#mdFixExt').hidden = s.engine !== 'external' || !need.length;
  if (need.length) $('#mdModelsCard').classList.remove('collapsed');   // a missing file has to be seen, not hidden behind a folded card
  fitTopBar();
  $('#mdFixExt').textContent = `Скачать недостающие (${need.length}, ${GB(need.reduce((a, m) => a + m.size, 0))})`;
  const MN = { video: 'Видео', lipsync: 'Клип', refs: 'Видеостудия', actor: 'Актёр', swap: 'Замена', action: 'Экшн-видео', actionsc: 'Экшн-студия', h3img: 'Изображения MiniMax H3 Image', long: 'Студия', krea: 'Изображение по тексту', kreareal: 'Изображение по тексту: реализм', qwen: 'Изменение изображения', flux: 'Изменение изображения: FLUX.2 (в коммерцию)', upscale: 'Апскейлинг видео и изображений', relayvsr: 'Апскейлинг видео · быстро (RelayVSR)' };
  $('#mdAdd').innerHTML = s.engine === 'managed' || s.engine === 'external' ? Object.entries(s.add_modes || {}).map(([m, gb]) =>
    /* «(+0 ГБ)» читается как ошибка: когда всё уже лежит на диске, кнопка ничего не качает,
         она только включает режим - так и пишем */
    `<button class="btn" data-add="${m}" title="${gb ? 'Понадобится скачать ' + String(gb).replace('.', ',') + ' ГБ моделей' : 'Все нужные файлы уже в папке моделей: скачивания не будет'}">${gb ? 'Добавить ' + MN[m] + ' (+' + String(gb).replace('.', ',') + ' ГБ)' : 'Включить ' + MN[m] + ' · модели уже есть'}</button>`).join(' ') : '';
  $$(MODE_ORDER.map(v => `.nav[data-view="${v}"]`).join(',')).forEach(n => {
    const off = s.modes && !s.modes.includes(n.dataset.view);
    n.querySelector('.badge')?.remove();
    if (off) n.insertAdjacentHTML('beforeend', '<span class="badge">не установлен</span>');
  });
  $('#mdEngine').innerHTML = s.engine === 'managed'
    ? `<span>Режим</span><b>встроенный ComfyUI ${s.comfy_version || ''}</b><span>Папка</span><b>${esc(setupInfo?.config?.install_dir || '')}</b><span>Видео</span><b>${esc(s.output_dir || '')}</b>`
    : `<span>Режим</span><b>ваш ComfyUI ${s.comfy_version || ''}</b><span>Видео</span><b>${esc(s.output_dir || 'папка output вашего ComfyUI')}</b>`;
  const P = s.paths || {};
  $('#mdEngine').insertAdjacentHTML('beforeend', (P.models ? `<span>Модели</span><b>${esc(P.models)}</b>` : '')
    + (P.assistant ? `<span>Помощник (сценарист)</span><b>${esc(P.assistant)}</b>` : '')
    + `<span>Настройки и список Библиотеки</span><b>${esc(P.data || '')}${diskNote()}</b>`);
}
$('#mdMirror').onchange = async e => {
  try { await postJSON('/api/settings/mirror', { on: e.target.checked }); toast(e.target.checked ? 'Скачивание через зеркало hf-mirror.com включено' : 'Зеркало выключено, скачиваем с Hugging Face'); loadStatus(); } catch (err) { toast(err.message); }
};
$('#mdFix').onclick = async () => {
  if (!setupInfo) setSetupInfo(await (await fetch('/api/setup/info')).json());
  const c = setupInfo.config;
  try {
    await postJSON('/api/setup/install', { install_dir: c.install_dir, models_dir: c.models_dir || '' });
    showSetupPane('progress'); setStep(2); resetProgress();
  } catch (e) { toast(e.message); }
};
$('#mdAdd').onclick = async e => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  if (b.closest('#mdAdd') && MD_EXT) {
    try { await postJSON('/api/mode/add', { mode: b.dataset.add }); toast('Режим добавлен: файлы моделей — в списке ниже'); loadStatus(); } catch (err) { toast(err.message); }
    return;
  }
  if (!setupInfo) setSetupInfo(await (await fetch('/api/setup/info')).json());
  const c = setupInfo.config;
  try {
    await postJSON('/api/setup/install', { install_dir: c.install_dir, models_dir: c.models_dir || '', add_mode: b.dataset.add });
    showSetupPane('progress'); setStep(2); resetProgress();
  } catch (err) { toast(err.message); }
};
/* cloud card */
export let CLOUD = { enabled: false };
export async function loadCloud() {
  if (!API) return CLOUD;
  CLOUD = await (await fetch('/api/cloud')).json();
  $$('.cloud-line').forEach(el => el.hidden = !CLOUD.enabled);
  document.body.classList.toggle('cloud-on', !!CLOUD.enabled);   // the RunningHub card is hidden for everyone except those who already switched it on (so they can switch it off)
  if (CLOUD.enabled) { $('#engTxt').textContent = 'облако'; $('#engDot').classList.remove('off'); }
  return CLOUD;
}
export async function mountCloud(host, wizard) {
  host.innerHTML = ''; host.append($('#cloudTpl').content.cloneNode(true));
  const c = $('.cloud-card', host), msg = $('.cl-msg', c);
  const paint = () => {
    $('.cl-state', c).className = 'verdict cl-state ' + (CLOUD.enabled ? 'ok' : CLOUD.has_key ? 'weak' : 'unsupported');
    $('.cl-state', c).textContent = CLOUD.enabled ? 'включено' : CLOUD.has_key ? 'ключ сохранён, выключено' : 'нет ключа';
    $('.cl-key', c).placeholder = CLOUD.has_key ? '•••••••• (сохранён — вставьте новый, чтобы заменить)' : 'вставьте ключ';
    $('.cl-wf', c).value = CLOUD.workflow_id || '';
    $$('.cl-host', c).forEach(b => b.classList.toggle('on', b.dataset.h === CLOUD.host));
    $$('.cl-inst', c).forEach(b => b.classList.toggle('on', b.dataset.i === CLOUD.instance));
    $('.cl-toggle', c).textContent = wizard ? 'Сохранить и начать' : CLOUD.enabled ? 'Выключить облако' : 'Включить облако';
  };
  const save = async extra => {
    const body = { workflow_id: $('.cl-wf', c).value, ...extra };
    if ($('.cl-key', c).value.trim()) body.key = $('.cl-key', c).value.trim();
    CLOUD = await postJSON('/api/cloud', body); $('.cl-key', c).value = ''; paint(); loadCloud();
  };
  await loadCloud(); paint();
  $$('.cl-host', c).forEach(b => b.onclick = () => save({ host: b.dataset.h }));
  $$('.cl-inst', c).forEach(b => b.onclick = () => save({ instance: b.dataset.i }));
  $('.cl-wf', c).onchange = () => save({});
  $('.cl-clear', c).onclick = () => save({ clear_key: true });
  $('.cl-test', c).onclick = async () => {
    msg.style.color = ''; msg.textContent = 'Проверяем…';
    try {
      await save({});
      const r = await postJSON('/api/cloud/test');
      const a = r.account || {};
      msg.style.color = 'var(--ok)';
      msg.textContent = `Ключ работает${a.remainCoins != null ? ` · баланс: ${a.remainCoins} RH` : ''}${r.models.length ? ` · в workflow найдено моделей: ${r.models.length}` : ''}`;
    } catch (e) { msg.style.color = 'var(--pink)'; msg.textContent = e.message; }
  };
  $('.cl-toggle', c).onclick = async () => {
    try {
      if (!CLOUD.has_key && !$('.cl-key', c).value.trim()) throw new Error('Вставьте API-ключ');
      if (!$('.cl-wf', c).value.trim()) throw new Error('Укажите ID workflow');
      if (wizard) { await save({ enabled: true }); await postJSON('/api/setup/cloud'); await afterSetup(); toast('Облако RunningHub включено'); }
      else { await save({ enabled: !CLOUD.enabled }); toast(CLOUD.enabled ? 'Генерация пойдёт в облако RunningHub' : 'Генерация снова на этом компьютере'); }
    } catch (e) { msg.style.color = 'var(--pink)'; msg.textContent = e.message; }
  };
}
$('#wzRestore').onclick = async () => {
  try {
    await postJSON('/api/setup/restore'); firstRun(false); setNavLocked(false); showRestore(false);
    toast('Прежние настройки на месте');
    let v = ''; try { v = localStorage.getItem('h3-last-view') || ''; } catch {}
    await loadStatus(); goTo(v && document.querySelector(`.nav[data-view="${v}"]`) ? v : 'video');
  } catch (e) { toast(e.message); }
};
(function () {   // which window the program opens in next time
  const box = $('#winMode'); if (!box) return;
  window.paintWin = v => $$('#winMode button').forEach(x => x.classList.toggle('on', x.dataset.w === (v || 'geo')));
  box.onclick = async e => {
    const b = e.target.closest('button[data-w]'); if (!b) return;
    try { await postJSON('/api/window_mode', { mode: b.dataset.w }); paintWin(b.dataset.w); toast('При следующем запуске окно откроется так'); }
    catch (err) { toast(err.message); }
  };
})();
(function () {   // the window without the video card + a way to restart and actually apply it
  const cb = $('#mdGpuUiCb'), rb = $('#mdRestart'); if (!cb) return;
  window.paintSoftUi = on => { cb.checked = !!on; };
  cb.onchange = async () => {
    try {
      const r = await postJSON('/api/window-gpu', { software: cb.checked });
      paintSoftUi(r.software);
      toast(r.software ? 'Включено. Перезапустите программу, чтобы окно рисовалось без видеокарты'
                       : 'Выключено. Перезапустите программу, чтобы окно снова рисовала видеокарта');
    } catch (err) { toast(err.message); cb.checked = !cb.checked; }
  };
  if (rb) rb.onclick = async () => {
    const api = window.pywebview && window.pywebview.api;
    if (!api || !api.restart_app) { toast('Перезапуск доступен в установленной программе: закройте её и откройте снова'); return; }
    rb.disabled = true;
    try { const r = await api.restart_app(); toast(r && r.ok ? 'Перезапускаем…' : 'Не получилось: ' + ((r && r.error) || 'неизвестная ошибка') + '. Закройте и откройте программу вручную.'); }
    catch (err) { toast(err.message); rb.disabled = false; }
  };
})();
(() => {   // «Замечать работу программы»: мигающая метка и сигнал по окончании (queue.js спрашивает notifyOn)
  const cb = $('#mdNotifyCb'); if (!cb) return;
  let on = true; try { on = localStorage.getItem('kadr-notify') !== 'off'; } catch {}
  cb.checked = on;
  document.body.classList.toggle('no-notify', !on);
  window.notifyOn = () => on;
  cb.onchange = () => {
    on = cb.checked;
    try { localStorage.setItem('kadr-notify', on ? 'on' : 'off'); } catch {}
    document.body.classList.toggle('no-notify', !on);
    toast(on ? 'Замечаем: метка пульсирует во время расчёта, в конце - сигнал' : 'Тихо: метка не пульсирует и сигнала не будет');
  };
})();
(() => {   // «Держать модели в памяти»: общий флаг (jobs.queue его читает, как и озвучка)
  const cb = $('#mdKeepCb'); if (!cb) return;
  window.paintKeep = on => { cb.checked = !!on; };
  cb.onchange = async () => {
    try {
      const r = await postJSON('/api/keep_models', { keep: cb.checked });
      paintKeep(r.keep);
      toast(r.keep ? 'Держим модели в памяти: следующая генерация стартует быстрее. Память выгружается кнопкой «Освободить память»'
                   : 'Выгружаем модели между заданиями: память освобождается сама');
    } catch (err) { toast(err.message); cb.checked = !cb.checked; }
  };
})();
setTimeout(fitTopBar, 700);   // the pills are built a moment after the page opens
(() => {   // a manual update check: the same two server calls as the banner, from the settings card
  const b = $('#mdUpd'), st = $('#mdUpdState'); if (!b) return;
  const say = html => { st.innerHTML = html; };
  b.onclick = async () => {
    b.disabled = true; say('Проверяю…');
    let u = null;
    try { u = await (await fetch('/api/update/check', { cache: 'no-store' })).json(); }
    catch (e) { say('Интернет не отвечает: ' + esc(e.message)); b.disabled = false; return; }
    if (u.error) { say(esc(u.error)); b.disabled = false; return; }
    if (!u.available) { say(u.failed ? `Проверить обновление не вышло: ${esc(u.failed)}` : `У вас последняя версия — ${esc(u.current || '')}.`); b.disabled = false; return; }
    if (!u.can_update) { say(`Вышла ${esc(u.version)}, но установить её отсюда нельзя: проверьте, что папка программы доступна для записи.`); b.disabled = false; return; }
    say(`Вышла <b>${esc(u.version)}</b> (у вас ${esc(u.current)}), ${GB(u.size || 0)}. Настройки, Библиотека и модели не меняются: скачается только установщик, он дождётся выхода программы и поставит новые файлы сам.
      <button class="btn pri mini" id="mdUpdGo" type="button" style="margin-left:6px">Скачать и установить</button>`);
    b.disabled = false;
    $('#mdUpdGo').onclick = async e => {
      if (QUEUE.some(j => j.state === 'queued' || j.state === 'running')) { toast('Идёт генерация: дождитесь конца и нажмите снова'); return; }
      e.target.disabled = true; say('Скачиваем обновление, файл проверяется по контрольной сумме. Не закрывайте программу.');
      const bar = setInterval(async () => {         // the request answers only at the end, so percents come from a second one
        try {
          const pr = await (await fetch('/api/update/progress', { cache: 'no-store' })).json();
          if (pr.total) say(`Скачиваем обновление: <b>${Math.min(99, Math.round(pr.done / pr.total * 100))}%</b> из ${GB(pr.total)}. Файл будет проверен по контрольной сумме.`);
        } catch (e) { }
      }, 700);
      try {
        await postJSON('/api/update/install', {});
        clearInterval(bar);
        say('Устанавливаем. Программа закроется сама, установщик подождёт её выхода и закончит обновление — около минуты.');
      } catch (err) { clearInterval(bar); say('Не получилось: ' + esc(err.message)); e.target.disabled = false; }
    };
  };
})();
/* ---------- updates of the engine and of the node packs (not of the program itself) ---------- */
(() => {
  const b = $('#mdEngUpd'), st = $('#mdEngState'); if (!b) return;
  const say = html => {
    st.innerHTML = html;
    const card = b.closest('.card'); if (card && html) card.classList.remove('collapsed');   // the answer must not stay folded
  };
  const roll = (core) => !core || !core.backup ? '' :
    `<button class="btn mini" id="mdEngBack" type="button" style="margin-left:6px" title="В папке данных есть копия файлов ComfyUI: вернём ${esc(core.backup_version || 'прежнюю версию')}">Откатить к ${esc(core.backup_version || 'прежней версии')}</button>`;
  async function poll() {
    let s = {};
    try { s = await (await fetch('/api/updates/state', { cache: 'no-store' })).json(); } catch { return false; }
    if (s.stage === 'downloading') say(`Скачиваем ComfyUI ${esc(s.version || '')}… ${s.pct || 0}%`);
    else if (s.stage === 'backup') say('Сохраняем резервную копию файлов ядра…');
    else if (s.stage === 'installing') say('Ставим новые файлы ядра; модели, ноды и ваши данные не трогаем…');
    else if (s.stage === 'deps') say('Догоняем пакеты Python, которые просит новое ядро минуты две…');
    else if (s.stage === 'done') { say(`Готово: ядро обновлено до ${esc(s.version || '')}, файлов ${s.files || 0}. ComfyUI сейчас перезапустится.${roll(lastCore)}`); wire(); loadStatus(); return true; }
    else if (s.stage === 'error') { say('Не вышло: ' + esc(s.error || '') + roll(lastCore)); wire(); return true; }
    else return true;
    setTimeout(poll, 2000);
    return false;
  }
  let lastCore = null;   // the last check answer: the rollback button lives as long as the backup does
  function wire() { const rb = $('#mdEngBack'); if (rb) rb.onclick = async () => {
    rb.disabled = true; say('Откатываем ядро к прежней версии…');
    try { await postJSON('/api/updates/core/rollback', {}); say('Прежняя версия на месте, ComfyUI перезапускается.'); loadStatus(); }
    catch (e) { say('Не удалось вернуть: ' + esc(e.message)); rb.disabled = false; }
  }; }
  b.onclick = async () => {
    b.disabled = true; say('Спрашиваю GitHub…'); toast('Проверяю версию ComfyUI…');
    let c = null;
    try { c = await (await fetch('/api/updates/check', { cache: 'no-store' })).json(); }
    catch (e) { say('Интернет не отвечает: ' + esc(e.message)); b.disabled = false; return; }
    b.disabled = false;
    const core = c.core || {}; lastCore = core;
    if (!core.installed) { say('Не видно, какая версия ядра установлена: ComfyUI не запущен.' + roll(core)); wire(); toast('Не видно версии ComfyUI: он сейчас не запущен'); return; }
    /* The program answers for one core version: the one it is built and checked with. A newer release
       of ComfyUI is not offered as an update, it is mentioned, and the button for it asks first: a
       fresh core can disagree with the node packs this program pins, and then sections stop working. */
    const risky = `<button class="btn mini" id="mdEngRisky" type="button" style="margin-left:6px" title="Обновить до версии, с которой нодами программы не проверялись">Всё равно обновить до ${esc(core.latest)}</button>`;
    const ahead = core.ahead ? ` В репозитории вышел ComfyUI ${esc(core.latest)} — программа его не предлагает.` : '';
    if (!core.newer && !core.ahead) {
      if (core.unknown) {   // silence from GitHub is not news of its own
        say(`ComfyUI у вас ${esc(core.installed)} — это версия, с которой программа собрана и проверена (${esc(core.pinned || core.installed)}). Проверить по GitHub не удалось: он не ответил, так что о новых версиях ничего не знаю.${roll(core)}`);
        wire(); toast('GitHub не ответил: свежую версию проверить не удалось'); return;
      }
      say(`ComfyUI у вас ${esc(core.installed)} — это версия, с которой программа собрана и проверена (${esc(core.pinned || core.installed)}); новее такой нет, обновлять нечего.${roll(core)}`);
      wire(); toast(`ComfyUI ${esc(core.installed)} — обновлений нет`); return;
    }
    if (!core.newer) {   // nothing we answer for, but upstream moved: say so, offer it behind a warning
      say(`ComfyUI у вас ${esc(core.installed)} — это версия, с которой программа собрана и проверена; она работает с закрепленными нодами.${ahead} Если нужна именно свежая — обновим, но с оговоркой: с нодами программы она не проверялась.
      ${risky}${roll(core)}`);
      wire(); return;
    }
    toast(`Есть проверенная версия ComfyUI ${esc(core.pinned)} — можно обновить`);
    say(`Программа проверена с ComfyUI <b>${esc(core.pinned)}</b>, у вас ${esc(core.installed)}. Обновим только код ядра (несколько десятков мегабайт): модели, ноды и папка вывода не меняются, а перезаписываемые файлы уйдут в резерв, из которого можно вернуть.${ahead}
      <button class="btn pri mini" id="mdEngGo" type="button" style="margin-left:6px">Обновить до ${esc(core.pinned)}</button>${core.ahead ? risky : ''}${roll(core)}`);
    const bat = $('#mdEngBat');
  if (bat) bat.onclick = async e => {
    if ((window.QUEUE || []).some(j => j.state === 'queued' || j.state === 'running')) { toast('Идёт генерация: дождитесь конца'); return; }
    confirmBox('Обновить встроенный ComfyUI?',
      'Запустим штатный update_comfyui.bat самой сборки: он обновляет ядро и ноды, но не трогает скачанные модели. ComfyUI на минуту закроется и поднимется сам. Продолжать?',
      async () => {
        bat.disabled = true; say('Обновляем ComfyUI штатным скриптом… это несколько минут');
        try {
          const r = await postJSON('/api/comfy/update', {});
          say((r.ok ? 'Готово: ' + (r.before || '?') + ' -> ' + (r.after || '?') : 'Скрипт завершился с кодом ' + r.code + ' · ядро перезапущено') + ' · подробности в журнале программы');
          loadStatus();
        } catch (err) { say('Не вышло: ' + esc(err.message)); }
        bat.disabled = false;
      }, { ok: 'Обновить', cancel: 'Отмена' });
  };
  $('#mdEngGo').onclick = async e => {
      if ((window.QUEUE || []).some(j => j.state === 'queued' || j.state === 'running')) { toast('Идёт генерация: дождитесь конца'); return; }
      e.target.disabled = true;
      try { await postJSON('/api/updates/core', { version: core.pinned }); poll(); }
      catch (err) { say('Не получилось начать: ' + esc(err.message)); }
    };
    const rk = $('#mdEngRisky');
    if (rk) rk.onclick = () => {
      if ((window.QUEUE || []).some(j => j.state === 'queued' || j.state === 'running')) { toast('Идёт генерация: дождитесь конца'); return; }
      confirmBox('Обновить ядро до непроверенной версии?',
        `Программа собрана и проверена с ComfyUI ${core.pinned || 'вашей версии'}. Версия ${core.latest} вышла позже и с нодами программы не проверялась: свежее ядро может разойтись с закрепленными нодами, и тогда разделы перестанут запускаться. Обновление трогает только код ядра, копии перезаписанных файлов остаются, их можно вернуть кнопкой «Откатить». Обновлять?`,
        async () => {
          rk.disabled = true;
          try { await postJSON('/api/updates/core', { version: core.latest, ack: 1 }); poll(); }
          catch (err) { say('Не получилось начать: ' + esc(err.message)); rk.disabled = false; }
        }, { ok: 'Обновить', cancel: 'Отмена' });
    };
    wire();
  };
})();
(() => {   // node packs: the program pins a commit on purpose, so this only reports and offers a swap
  const b = $('#mdNodesUpd'), box = $('#nodesUpd'); if (!b || !box) return;
  b.onclick = async () => {
    b.disabled = true; box.hidden = false; box.innerHTML = '<div class="note"><span>Сравниваем закреплённые версии нод с их репозиториями…</span></div>';
    let c = null;
    try { c = await (await fetch('/api/updates/check', { cache: 'no-store' })).json(); }
    catch (e) { box.innerHTML = `<div class="note warn"><span>Интернет не отвечает: ${esc(e.message)}</span></div>`; b.disabled = false; return; }
    b.disabled = false;
    const packs = c.packs || [];
    box.innerHTML = `<b style="font-size:13px">Ноды: версия, которую ждёт программа</b><div class="hint" style="margin:2px 0 8px">Каждая нода закреплена за коммитом, с которым программа собрана и проверена. Кнопка «Обновить ноду» ставит именно его, а не самый свежий коммит репозитория: свежий нод может зарегистрировать те же маршруты, что уже есть в ядре, и тогда ComfyUI вообще не запустится. Если после обновления раздел перестанет считываться, жмите «Вернуть прежнюю».</div>` +
      packs.map(p => `<div class="m"><b>${esc(p.name)}<small>${p.installed ? 'установлена' : 'не установлена'}${p.applied ? ' · вы обновили её до ' + esc(p.applied) : p.backup ? ' · обновлялась вручную, программа ждёт версию ' + esc(p.pinned) : ' · программа ждёт версию ' + esc(p.pinned)}${p.backup ? ' · прежняя копия цела' : ''}</small></b><span class="hint sz">${p.newer ? ('программа ждёт коммит ' + esc(p.pinned) + (p.ahead ? ', в репозитории уже ' + esc(p.latest) + ' от ' + esc(p.date || '') + ' - его программа не предлагает' : '')) : (p.ahead ? 'в репозитории есть новее: ' + esc(p.latest) + ' от ' + esc(p.date || '') + ' - программа его не предлагает' : 'стоит та версия, которую программа просила')}</span><span class="st ${p.newer ? 'miss' : 'ok'}">${p.newer ? 'есть что ставить' : 'актуальна'}</span><div class="m-btns" style="grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap">${p.newer && p.installed ? `<button class="btn mini" data-np="${esc(p.name)}" type="button">Обновить ноду</button>` : ''}${p.backup ? `<button class="btn mini" data-nb="${esc(p.name)}" type="button">Вернуть прежнюю</button>` : ''}</div></div>`).join('');
    box.onclick = async e => {
      const u = e.target.closest('[data-np]'), r = e.target.closest('[data-nb]');
      if (u) {
        if ((window.QUEUE || []).some(j => j.state === 'queued' || j.state === 'running')) { toast('Идёт генерация: дождитесь конца'); return; }
        u.disabled = true; u.textContent = 'Обновляем…';
        try {
          const j = await postJSON('/api/updates/pack', { name: u.dataset.np });
          toast(j.already ? `Нода уже на коммите ${j.commit}: его программа считает проверенным` : `Нода ${u.dataset.np} на коммите ${j.commit}`);
          b.onclick();
        }
        catch (err) { toast(err.message); u.disabled = false; u.textContent = 'Обновить ноду'; }
      } else if (r) {
        r.disabled = true;
        try { await postJSON('/api/updates/pack/rollback', { name: r.dataset.nb }); toast('Прежняя нода на месте'); b.onclick(); }
        catch (err) { toast(err.message); r.disabled = false; }
      }
    };
  };
})();
$('#mdRecheck').onclick = async () => { const b = $('#mdRecheck'); b.disabled = true;
  try { await loadStatus(); toast('Список перечитан'); } finally { b.disabled = false; } };
export async function doReset() {   // the menu item "настройки экрана" needs the action itself, not a click on the armed button
  await postJSON('/api/setup/reset'); setNavLocked(true); openSetup();
}
$('#mdReset').onclick = async () => {
  const b = $('#mdReset');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.textContent = 'Точно сбросить? Нажмите ещё раз'; toast('Сброс остановит ComfyUI и откроет стартовый экран');
    setTimeout(() => { if (b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = 'Сброс настроек'; } }, 6000);
    return;
  }
  b.dataset.armed = ''; b.textContent = 'Сброс настроек'; b.disabled = true;
  try { await doReset(); } catch (e) { toast(e.message); b.disabled = false; }
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-websearch]'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  postJSON('/api/search-web', { q: b.dataset.websearch }).then(() => toast('Открываю поиск в браузере'), err => toast(err.message));
});
// own ComfyUI: download missing files straight into the user's models folder
export async function mdAskFolder() {
  const msg = 'Укажите папку models вашего ComfyUI: в ней лежат папки diffusion_models, loras, vae… Например G:\\ModelHub\\Models';
  if (window.pywebview?.api?.pick_folder) { toast('Выберите папку models вашего ComfyUI'); return (await window.pywebview.api.pick_folder('')) || ''; }
  return (prompt(msg) || '').trim();
}
export async function mdStart(roles) {
  let folder = MD_EXTDIR;
  // only someone running their own ComfyUI has to say where models live; our own copy is known
  if (!folder && typeof MD_EXT !== 'undefined' && MD_EXT) { folder = await mdAskFolder(); if (!folder) return; }
  try {
    const r = await postJSON('/api/models/download', { roles, folder });
    if (typeof MD_EXT !== 'undefined' && MD_EXT) MD_EXTDIR = r.folder || folder;
    $('#mdDl').hidden = false; $('#mdDlL').textContent = 'Начинаем…'; $('#mdDlB').style.width = '0';
    toast(`Скачиваем ${r.count} файл(ов) в ${r.folder || folder}`);
  } catch (err) {
    if (/Папка не найдена|не похоже/.test(err.message)) MD_EXTDIR = '';
    toast(err.message);
  }
}
$('#mdFixExt').onclick = () => mdStart(MD_NEED);
$('#mdDlStop').onclick = () => postJSON('/api/models/download/cancel');
export function onMdl(m) {
  const card = $('#mdDl'); card.hidden = false;
  const vp = $('#vAccProg'); if (vp) vp.textContent = m.state === 'done' ? 'Готово' : m.state === 'error' ? (m.label || '') : (m.total && m.done != null ? `${Math.round(m.done / m.total * 100)}%` : '');
  if (m.state === 'done') setTimeout(() => vAccCheck(), 500);
  if (m.state === 'done' || m.state === 'error') {
    $('#mdDlL').textContent = m.label || ''; $('#mdDlN').textContent = '';
    if (m.state === 'done') { $('#mdDlB').style.width = '100%'; loadStatus(); setTimeout(() => { card.hidden = true; }, 6000); }
    return;
  }
  if (m.label) $('#mdDlL').textContent = m.label + (m.count > 1 ? ` · файл ${m.index} из ${m.count}` : '');
  if (m.total && m.done != null) {
    $('#mdDlB').style.width = Math.min(100, m.done / m.total * 100) + '%';
    $('#mdDlN').textContent = `${GB(m.done)} из ${GB(m.total)}`;
  }
}
$('#mdOwnGo').onclick = () => confirmBox('Перейти к настройке своего ComfyUI?',
  'Откроется экран настройки: программа перестанет считать текущую конфигурацию готовой. Скачанные файлы не тронуты, кнопка «Вернуться к прежним настройкам» вернёт всё как было.',
  'Показать экран настройки', () => doReset());
// custom nodes the sections need, for people who use their own ComfyUI
export async function loadNodes() {
  const card = $('#mdNodesCard'), st = await (await fetch('/api/status')).json().catch(() => ({}));
  card.hidden = st.engine !== 'external';
  $('#mdOwnCard').hidden = st.engine !== 'managed';
  if (card.hidden) return;
  let r; try { r = await (await fetch('/api/nodes')).json(); } catch { return; }
  const list = r.nodes || [];
  $('#mdNodes').innerHTML = list.map(n => `<div class="m"><b>${esc(n.pack)}<small>${esc(n.why)}${n.optional ? ' · необязательно' : ''}</small></b>
    <span class="hint" style="font-family:var(--mono);font-size:11px;word-break:break-all">${n.have ? '' : esc(n.url)}</span>
    ${n.have ? '<span class="st ok">, есть</span>' : n.optional ? '<span class="st opt">нет</span>' : '<span class="st miss">нет</span>'}
    ${n.have ? '' : `<button class="btn mini" type="button" data-copyurl="${esc(n.url)}">Скопировать ссылку</button>`}</div>`).join('')
    || '<span class="hint">Для выбранных разделов особые ноды не нужны.</span>';
  $('#mdNodesNote').hidden = list.every(n => n.have);
  if (!list.every(n => n.have || n.optional)) card.classList.remove('collapsed');   // a missing node must be seen
}
$('#mdNodesRe').onclick = loadNodes;
$('#mdNodes').addEventListener('click', e => {
  const b = e.target.closest('[data-copyurl]'); if (!b) return;
  copyText(b.dataset.copyurl, 'Ссылка скопирована');
});
onNav('models', async () => {
  try { localStorage.setItem('h3-seen-settings', '1'); } catch {}
  firstRun(SET_LOCK);
  if (!API) return;
  const s = await (await fetch('/api/status')).json();
  if (!s.configured) { showRestore(!!s.can_restore); openSetup(); }
  else { showSetupPane('status'); foldOnOpen(); setSetupInfo(setupInfo || await (await fetch('/api/setup/info')).json()); renderModels(s); mountCloud($('#mdCloud'), false).then(() => { $('#mdCloudBox').open = !!CLOUD.enabled; }); loadNodes(); }
});
