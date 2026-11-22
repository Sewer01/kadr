import { API, postJSON } from '../core/net.js';
import { $, $$, confirmBox, esc, fmtDate, fmtTime, toast } from '../core/util.js';
import { IMG_PANELS, LIB, QUEUE, byId, registerViews } from '../core/state.js';
import { goTo } from '../core/tabs.js';
import { SZ_ROW, szWire } from '../ui/params.js';
import { offPrompt, onPrompt, previewHandlers, scenarioWindow } from '../ui/scenario.js';
import { wireDrop } from '../ui/slots.js';
import { agKreaMode, agPromptButton, agQwenMode, hGripAfter } from './agent.js';
import { dimTxt, openUpscale, saveItems, useMenu, zoomOpen } from './library.js';
import { doReset } from './models.js';
import { PR, presetsHave, presetsPaint } from './presets.js';
import { qAdd } from './queue.js';
import { extKind, lowMemoryAsk } from './setup.js';

/* Кнопка «Всё к сценаристу» уносит из окна всё: если «Сценарий» и «Промт» различаются,
   уходят оба, с подписями - так Сценарист видит и наши слова, и готовый текст. */
const windowText = win => {
  const s = String(win.sc ? win.sc.value : '').trim(), p = String(win.value() || '').trim();
  return s && p && s !== p ? 'Сценарий:\n' + s + '\n\nПромт:\n' + p : (p || s);
};

/* «Ручку» размера сетки вешает views/agent.js (window.gridResize), а он исполняется
   позже нас: у окна картинок ручки ещё нет, поэтому пробуем сейчас и повторяем на
   следующем шаге цикла событий, когда раздел сценариста уже объявился. */
const gridHandle = root => {
  const g = $('.grid', root);
  if (!g) return;
  if (window.gridResize) window.gridResize(g);
  else setTimeout(() => { if (window.gridResize) window.gridResize(g); }, 0);
};

/* rent a powerful computer: a short explanation for beginners + the way to connect */
export function connectRent() {
  goTo('models');
  setTimeout(() => { const r = $('#mdReset'); if (r && !$('#mdStatus').hidden) doReset(); setTimeout(() => { $('.opt[data-opt="external"]')?.click(); extKind('rent'); }, 250); }, 250);
}
export function openRent() {
  let m = $('#rentMenu'); if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'rentMenu'; document.body.append(m); }
  m.hidden = false;
  m.innerHTML = `<div class="box" style="padding:22px;max-width:580px;max-height:calc(var(--vh,1vh)*90);overflow:auto"><div class="card-h"><h3>Аренда сервера</h3><button class="btn" data-x type="button">Закрыть</button></div>
    <div class="note"><span>Вы арендуете в интернете сервер с мощной видеокартой и платите за время, пока он включён. Эта программа остаётся у вас и управляет им. <b>Функция новая и проверяется</b>: если что-то не получится, напишите разработчику.</span></div>
    <ol class="rent-steps">
      <li><b>Выберите сервис.</b> Например, Immers.Cloud (российский, оплата в рублях, посекундная). Для H3 нужна видеокарта с 48 ГБ памяти и больше (A100 80 ГБ, H100 и т. п.) и образ с ComfyUI.</li>
      <li><b>Создайте отдельный диск</b> на 150–200 ГБ и подключите к машине. Тогда модели останутся, когда вы удалите машину, а в следующий раз скачивать их заново не придётся. Хранение диска оплачивается отдельно.</li>
      <li><b>Откройте порт 8000</b> в настройках самой машины и скопируйте ссылку «StableDiffusion» из панели сервиса (в ней ваш ключ).</li>
      <li><b>Положите на сервер модели и ноды</b> нужных разделов. Программа их туда сама не скачивает. После подключения она покажет, чего не хватает.</li>
      <li><b>Подключитесь:</b> нажмите кнопку ниже, выберите «У меня уже есть ComfyUI или арендованный сервер» и вставьте ссылку целиком.</li>
    </ol>
    <div class="note" style="margin-top:12px"><span><b>Про деньги.</b> Пока машина включена, оплата идёт даже без работы. Закончили: удалите машину (диск с моделями можно оставить). Ключ и ссылку никому не показывайте.</span></div>
    <div class="rent-row"><button class="btn" data-site type="button">Открыть сайт Immers.Cloud</button><button class="btn pri" data-connect type="button">Подключить арендованный сервер</button></div>
    <div class="hint" id="rentRef" style="margin-top:10px;font-size:12.5px;line-height:1.5" hidden>Кнопка «Открыть сайт» ведёт по <b>реферальной ссылке автора программы</b>. Если зарегистрироваться по ней, Immers.Cloud начислит вам <b>бонус 20% от суммы первого пополнения баланса</b>. Автор программы за это получает 10% от ваших платежей в Immers.Cloud. Цены для вас от этого не растут.</div></div>`;
  fetch('/api/rent/info').then(r => r.json()).then(j => { const el = $('#rentRef'); if (el) el.hidden = !j.ref; }).catch(() => {});
  m.onclick = e => { if (e.target === m || e.target.closest('[data-x]')) { m.hidden = true; return; } if (e.target.closest('[data-site]')) { fetch('/api/rent/open', { method: 'POST' }); return; } if (e.target.closest('[data-connect]')) { m.hidden = true; connectRent(); } };
}
$('#mdRentCard').addEventListener('click', e => { const b = e.target.closest('[data-rent]'); if (!b) return;
  if (b.dataset.rent === 'how') { openRent(); return; }
  confirmBox('Подключить арендованный сервер?', 'Программа покажет экран установки: нужно будет вписать адрес вашего сервера. Скачанные файлы и папки не тронуты, а кнопка «Вернуться к прежним настройкам» вернёт всё как было.', 'Показать экран установки', () => connectRent()); });
$('#view-presets').innerHTML = `<div class="pr-steps" id="prSteps"><span class="st"><i>1</i>Тип</span><u></u><span class="st"><i>2</i>Вариант</span><u></u><span class="st"><i>3</i>Создать</span></div>
  <div class="pr-first"><div class="n">1</div><div><b>Сначала откройте «Настройки»</b><span>Там выбирается, как работает программа: «Я новичок» (всё скачается само) или «У меня уже есть ComfyUI и модели». Без этого генерация не начнётся.</span></div><button class="btn primary" id="prGoSet" type="button">Открыть Настройки</button></div>
  <div class="pr-head"><h1 id="prTitle"></h1><p id="prSub"></p></div>
  <div class="pr-types" id="prTypes">
    <button class="pr-type" type="button" data-t="image"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="m21 16-5-5L6 20"/></svg></span><b>Изображение</b><p>Создать по описанию, изменить готовое, карта героя, раскадровка</p></button>
    <button class="pr-type" type="button" data-t="video"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/><path d="m8.5 10.5 3 1.5-3 1.5z" fill="currentColor"/></svg></span><b>Видео</b><p>Оживить изображение, озвучить, сменить героя, снять сцены</p></button>
    <button class="pr-type" type="button" data-go="upfile"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg></span><b>Апскейлинг</b><p>Сделать видео или фото чётче и увеличить разрешение</p></button>
    <button class="pr-rent" type="button" id="prRent"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg></span><span><b>Нет мощной видеокарты? Арендуйте сервер</b><small>Платите только за время работы, ничего не нужно покупать. Подробно и по шагам</small></span><i>Как это работает -> </i></button>
  </div>
  <div id="prList" hidden>
    <div class="pr-bar"><button class="pr-back" id="prBack" type="button"> Назад</button></div>
    <div class="pr-tools"><input id="prSearch" type="search" placeholder="Поиск по вариантам…" autocomplete="off">
      <div class="pr-view" id="prView"><button data-v="grid" title="Сеткой"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg></button><button data-v="list" title="Списком"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button></div></div>
    <div class="pr-chips" id="prChips"><button data-f="all">Все <i></i></button><button data-f="have">Готово к работе <i></i></button><button data-f="miss">Нужно скачать <i></i></button><button data-f="fav">Избранное <i></i></button></div>
    <div class="pr-grid"></div></div>`;
$('#prTypes').onclick = e => { if (e.target.closest('.pr-rent')) { openRent(); return; } const b = e.target.closest('.pr-type'); if (b && b.dataset.go) { goTo(b.dataset.go); return; } if (b) { PR.tab = b.dataset.t; PR.q = ''; PR.f = 'all'; $('#prSearch').value = ''; presetsPaint(); presetsHave().then(presetsPaint); } };
$('#prGoSet').onclick = () => $('.nav[data-view="models"]').click();
$('#prBack').onclick = () => { PR.tab = ''; presetsPaint(); };
$('#prSearch').oninput = e => { PR.q = e.target.value; presetsPaint(); };
$('#prChips').onclick = e => { const b = e.target.closest('button'); if (b) { PR.f = b.dataset.f; presetsPaint(); } };
$('#prView').onclick = e => { const b = e.target.closest('button'); if (b) { PR.view = b.dataset.v; presetsPaint(); } };
$('#view-presets .pr-grid').onclick = e => {
  const f = e.target.closest('[data-fav]');
  if (f) { const id = f.dataset.fav; PR.favs = PR.favs.includes(id) ? PR.favs.filter(x => x !== id) : [...PR.favs, id]; try { localStorage.setItem('h3-pfav', JSON.stringify(PR.favs)); } catch {} presetsPaint(); return; }
  const c = e.target.closest('.pr-card'); if (c) goTo(c.dataset.p);
};
// разметка «Пресетов» только что встала: красим её сейчас - presets.js исполнялся
// раньше нас и свою первую покраску сделать не мог
presetsPaint();
/* ---------- PICTURES: "Изображение по тексту" (Krea 2) and "Правка изображения" (Qwen Image 2.1) ---------- */
export const IMG_ASPECTS = [['16:9', 'Горизонт', 16, 9], ['9:16', 'Вертикаль', 9, 16], ['1:1', 'Квадрат', 1, 1], ['4:3', '4:3', 4, 3], ['3:4', '3:4', 3, 4], ['3:2', '3:2', 3, 2], ['2:3', '2:3', 2, 3], ['21:9', 'Кино 21:9', 21, 9]];
/* размер MiniMax H3 Image: формат + площадь в мегапикселях, стороны кратны 32 (та же формула, что на сервере) */
export const h3Size = (aspect, mp) => { const [aw, ah] = String(aspect || '16:9').split(':').map(Number); const r = v => Math.max(32, Math.round(v / 32) * 32); if (!(aw > 0) || !(ah > 0)) return [2048, 1152]; const px = mp * 1e6; return [r(Math.sqrt(px * aw / ah)), r(Math.sqrt(px * ah / aw))]; };
export const IMG_SIZES = { '16:9': [1376, 768], '9:16': [768, 1376], '1:1': [1024, 1024], '4:3': [1184, 896], '3:4': [896, 1184], '3:2': [1248, 832], '2:3': [832, 1248], '21:9': [1568, 672] };
export const IMG_STAGE = {
  queued: ['В очереди ComfyUI…', 0.02], load: ['Загружаем модели в видеопамять… (первый запуск дольше)', 0.08], encode: ['Читаем промпт и изображение…', 0.2],
  sample: ['Рисуем', 0.25], upscale: ['Увеличиваем изображение…', 0.5], sample2: ['Второй проход: добавляем детали', 0.5], decode: ['Собираем изображение…', 0.92], save: ['Сохраняем…', 0.98],
};
export const IMG = {};

// one result window for both sections: sends the job, follows the progress, shows the picture
export function imgPanel(el, o) {
  el.innerHTML = `
    <div class="card ip">
      <div class="ip-frame"><img class="ip-live" hidden alt=""><img class="ip-res" hidden alt="" title="Нажмите, чтобы увеличить"><div class="ip-empty">Здесь появится изображение</div>
        <button class="cw-zb ip-zb" type="button" title="Увеличить на весь экран" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/></svg></button></div>
      <div class="bar"><i class="ip-bar" style="width:0"></i></div>
      <div class="status ip-status"></div>
      <div class="hint ip-dim" style="text-align:center;min-height:16px"></div>
      <div class="ip-acts" hidden>
        <button class="btn" data-a="save" type="button">Сохранить</button>
        <button class="btn" data-a="use" type="button">Использовать в…</button>
        <button class="btn pri" data-a="up" type="button" title="Увеличить изображение и добавить чёткости (SeedVR2)">Увеличить изображение</button>
        <button class="btn" data-a="lib" type="button">В Библиотеке</button>
      </div>
      <div class="cw-hh ip-hh" hidden>Прошлые изображения — нажмите, чтобы открыть</div>
      <div class="cw-hist ip-hist"></div>
      <button class="go ip-go" type="button"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg><span>Сгенерировать</span></button>
      <button class="stop ip-stop" type="button" hidden><i></i>Остановить генерацию</button>
    </div>`;
  const $q = s => $(s, el);
  const live = $q('.ip-live'), res = $q('.ip-res'), empty = $q('.ip-empty'), bar = $q('.ip-bar'), status = $q('.ip-status');
  const go = $q('.ip-go'), stopB = $q('.ip-stop'), acts = $q('.ip-acts'), frame = $q('.ip-frame');
  let run = null, last = null;
  const zb = $q('.ip-zb'), hist = $q('.ip-hist'), hh = $q('.ip-hh');
  const dim = $q('.ip-dim');
  res.onload = () => { if (res.naturalWidth) { frame.style.aspectRatio = `${res.naturalWidth} / ${res.naturalHeight}`; dim.textContent = 'Размер: ' + dimTxt(res.naturalWidth, res.naturalHeight); } };
  const refresh = () => {  // thumbnails of this section's earlier pictures
    const mine = LIB.filter(x => x.mode === o.mode && x.kind === 'image' && !x.missing && x.url).sort((a, b) => b.date - a.date).slice(0, 12);
    hh.hidden = !mine.length;
    hist.innerHTML = mine.map(it => `<button draggable="true" class="cw-th${last && last.id === it.id ? ' on' : ''}" data-id="${it.id}" type="button" title="${esc(fmtDate(it.date) + ((it.prompt || '') ? ' · ' + it.prompt.slice(0, 70) : ''))}"><img src="${it.url}" alt="" loading="lazy"></button>`).join('');
  };
  IMG_PANELS.push(refresh);
  const showItem = it => {
    last = it; live.hidden = true; empty.hidden = true; res.dataset.dragid = it.id; res.src = it.url; res.hidden = false; acts.hidden = false; zb.hidden = false;
    status.innerHTML = `${esc(fmtDate(it.date))} · Seed: <b style="font-family:var(--mono)">${esc(String(it.seed ?? '—'))}</b>`; refresh();
  };
  hist.onclick = e => { const b = e.target.closest('.cw-th'); const it = b && LIB.find(x => x.id === b.dataset.id); if (it && !run) showItem(it); };
  res.onclick = zb.onclick = () => { if (res.src) zoomOpen(res.src); };
  const show = () => {
    if (!run) return;
    const [txt, base] = IMG_STAGE[run.stage] || IMG_STAGE.queued;
    let p = base, line = txt;
    const two = o.two && o.two();
    if ((run.stage === 'sample' || run.stage === 'sample2') && run.max) {
      const f = (run.step || 0) / run.max;
      p = run.stage === 'sample2' ? 0.5 + 0.4 * f : 0.25 + (two ? 0.25 : 0.65) * f; line = `${txt} · шаг ${run.step || 0} из ${run.max}`;
      if (run.step) line += ` · осталось ~${fmtTime((run.max - run.step) * (run.stepT - run.sampleT0) / run.step / 1000 + 3)}`;
    }
    bar.style.width = (p * 100) + '%';
    status.textContent = `${line} · прошло ${fmtTime((performance.now() - run.t0) / 1000)}`;
  };
  const end = () => { clearInterval(run.tick); offPrompt(run.id); previewHandlers.delete(el); run = null; go.hidden = false; stopB.hidden = true; bar.style.width = 0; };
  go.onclick = async () => {
    // «Изображение по тексту» starts its queue from this very button: the start of a generation lives
    // in one place, and a second button hidden in the prompt card only made people miss it
    if (o.intercept && o.intercept()) return;
    const err = o.validate(); if (err) { status.textContent = err; return; }
    go.disabled = true; if (!run) status.textContent = 'Отправляем задание в ComfyUI…';
    let r;
    try {
      const resp = await fetch(o.url, { method: 'POST', body: o.form() });
      const txt = await resp.text();
      try { r = JSON.parse(txt); } catch { r = { error: txt }; }
      if (!resp.ok) {
        if (resp.status === 409 && r.low_memory) { go.disabled = false; return lowMemoryAsk(r.error, () => go.click()); }
        throw new Error(r.error || resp.statusText);
      }
    } catch (e) { go.disabled = false; status.textContent = 'Ошибка: ' + e.message; return; }
    go.disabled = false;
    if (run) { clearInterval(run.tick); offPrompt(run.id); const old = QUEUE.find(j => j.id === run.id); if (old) old.detached = true; run = null; }
    qAdd(r.prompt_id, o.mode, o.promptText());
    { const jj = QUEUE.find(x => x.id === r.prompt_id); if (jj && r.eta) jj.eta = r.eta; }
    live.hidden = true; res.hidden = true; empty.hidden = true; acts.hidden = true; zb.hidden = true; dim.textContent = '';
    run = { id: r.prompt_id, t0: performance.now(), stage: 'queued' };
    stopB.hidden = false;
    run.tick = setInterval(show, 1000); show();
    previewHandlers.set(el, blob => {
      if (!run || run.stage === 'queued') return;
      URL.revokeObjectURL(live.dataset.url || ''); live.dataset.url = live.src = URL.createObjectURL(blob); live.hidden = false;
    });
    onPrompt(run.id, ev => {
      if (!run || run.id !== ev.prompt_id) return;
      if (ev.type === 'stage') {
        if (ev.stage.startsWith('sample') && run.stage !== ev.stage) run.sampleT0 = performance.now();
        run.stage = ev.stage; run.step = ev.step; run.max = ev.max; if (ev.step) run.stepT = performance.now();
        show();
      } else if (ev.type === 'done') {
        const took = fmtTime((performance.now() - run.t0) / 1000); end();
        last = ev.item; live.hidden = true; res.dataset.dragid = ev.item.id; res.src = ev.item.url; res.hidden = false; acts.hidden = false; zb.hidden = false; refresh();
        status.innerHTML = `Готово за ${took} — изображение в Библиотеке. Seed: <b style="font-family:var(--mono)">${esc(String(ev.item.seed ?? '—'))}</b>`;
      } else if (ev.type === 'error') {
        end(); empty.hidden = !!last; res.hidden = !last; zb.hidden = !last; status.textContent = 'Ошибка ComfyUI: ' + ev.message;
      } else if (ev.type === 'interrupted') {
        end(); empty.hidden = !!last; res.hidden = !last; zb.hidden = !last; status.textContent = 'Генерация остановлена.';
      }
    });
  };
  stopB.onclick = () => { if (!run) return; status.textContent = 'Останавливаем…'; fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: run.id }) }); };
  acts.onclick = e => {
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a || !last) return;
    const it = byId(last.id) || last;
    if (a === 'save') saveItems([it]); else if (a === 'use') useMenu(it); else if (a === 'up') openUpscale(it); else goTo('library');
  };
  frame.style.aspectRatio = '16 / 9'; refresh();
  return { frame, ratio: (w, h) => { if (!run && !last) frame.style.aspectRatio = `${w} / ${h}`; } };
}

export function imgSeedBox(S) {
  return `<div class="row" style="margin-top:16px"><div class="row-l">Seed — «номер варианта»</div>
      <div class="seg" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-sf="0">Случайный<small>каждый раз новое изображение</small></button><button data-sf="1">Фиксированный<small>тот же вариант снова</small></button></div>
      <div class="path on" data-seedrow hidden><input data-seedin inputmode="numeric" spellcheck="false" placeholder="число, например 123456789"></div>
    </div>`;
}
export function imgSeedWire(root, S) {
  const paint = () => { $$('[data-sf]', root).forEach(b => b.classList.toggle('on', (b.dataset.sf === '1') === !!S.seedFixed)); $('[data-seedrow]', root).hidden = !S.seedFixed; };
  root.addEventListener('click', e => { const b = e.target.closest('[data-sf]'); if (b) { S.seedFixed = b.dataset.sf === '1'; paint(); } });
  $('[data-seedin]', root).oninput = e => { S.seed = e.target.value.replace(/\D/g, ''); e.target.value = S.seed; };
  paint();
}
export const imgSeedForm = (S, fd) => { if (S.seedFixed && S.seed) fd.append('seed', S.seed); };

/* --- Krea 2: by text --- */
(() => {
  const root = $('#view-krea'), S = { aspect: '16:9', style: 'plain', scale: '2k', engine: 'krea', mp: '4' };
  root.innerHTML = `
    <div class="head"><div><h1>Изображение по тексту</h1><p>Опишите изображение словами — модель Krea 2 нарисует его. Загрузить своё изображение здесь нельзя: для этого страница «Правка»</p></div>
      <div class="mode-pill"><i></i><span>Krea 2 · 1 МП</span></div></div>
    <div class="grid"><div class="col">
      <div class="card" data-scenarobox="krea"></div>
      <div class="card"><div class="card-h"><h3><span class="n">2</span>Параметры</h3></div>
        <div class="row"><div class="row-l">Модель</div>
          <div class="seg kr-eng" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><button data-e="krea">Krea 2<small>лучшее качество, можно в коммерцию</small></button><button data-e="h3img">MiniMax H3 Image<small>очень высоко: до 16 МП</small></button><button data-e="flux">FLUX klein<small>лёгкая модель; лицензию см. в списке моделей</small></button><button data-e="qwen">Qwen 2.1<small>текст на изображении, не для коммерции</small></button></div>
          <div class="row kr-h3mp" hidden style="margin-top:10px"><div class="row-l">Размер результата</div>
            <div class="seg" style="grid-template-columns:repeat(3,1fr)"><button data-mp="4">4 МП<small>быстро</small></button><button data-mp="8">8 МП<small>средне</small></button><button data-mp="16">16 МП<small>максимум деталей, долго</small></button></div>
            <div class="hint" style="margin-top:6px">Модель рассчитана на 4 МП и больше: чем крупнее, тем чище детали. На 16 ГБ памяти 16 МП считается заметно дольше.</div></div>
          <div class="hint kr-enghint" hidden></div>
          <div class="hint" style="margin-top:6px">Лицензии: <b>Krea 2</b> и <b>FLUX klein</b> можно использовать в коммерции (Krea 2 — если годовой доход компании меньше 1 млн $). <b>MiniMax H3 Image</b> — открытая лицензия, крупные изображения и правка по референсам. <b>Qwen 2.1</b> только для творчества, не для коммерции.</div></div>
        <div class="row kr-neg" hidden><div class="row-l">Негативный промпт <span class="hint">что не должно быть на изображении</span></div>
          <textarea class="kr-negtxt" rows="2" placeholder="Пусто — быстрее и легче для видеокарты. Если нужно, впишите, например: blurry, low quality, extra fingers, text, watermark"></textarea><div class="hint" style="margin-top:4px">Негативный промпт замедляет Qwen примерно вдвое и требует больше видеопамяти. Заполняйте, только если без него не получается.</div></div>
        <div class="row kr-stylerow"><div class="row-l">Стиль</div>
          <div class="seg" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-st="plain">Обычный<small>быстро, любые изображения</small></button><button data-st="real">Реализм<small>люди и фото как с камеры, 2 прохода</small></button></div>
          <div class="hint kr-realhint" hidden></div></div>
        <div class="row kr-scale" hidden><div class="row-l">Размер результата</div>
          <div class="seg" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-sc="2k">Около 2K<small>быстрее</small></button><button data-sc="4k">4K<small>дольше и нужно больше видеопамяти</small></button></div></div>
        <div class="row"><div class="row-l">Формат</div><div class="chips kr-asp"></div></div>
        ${SZ_ROW}
        ${imgSeedBox()}</div>
    </div><div class="preview kr-prev"></div></div>`;
  /* Окно «Сценарий» этого режима даёт общий модуль: поле, ряд кнопок и подпись - одна сборка
     на все разделы. Переключатель «Один промпт / Список промптов» и блок списка остаются
     разметкой раздела: они встают до поля и сразу под кнопками, селекторы (.kr-bm, .kr-batch,
     .kr-same, .kr-bl) не меняются. */
  const krWin = scenarioWindow($('[data-scenarobox="krea"]', root), {
    kind: 'krea', register: 'krea', num: 1, cls: 'kr-prompt',
    counter: { cls: 'counter kr-count', text: '0 символов' },
    head: '<div class="seg kr-bm" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-bottom:8px">'
      + '<button type="button" data-b="0" class="on">Один промпт</button>'
      + '<button type="button" data-b="1">Список промптов<small>серия картинок</small></button></div>',
    placeholder: 'Опишите картинку: кто или что в кадре, где, какой свет, какой стиль (фото, иллюстрация, постер)…',
    mid: `<div class="kr-batch" hidden style="margin-top:10px">
      <div class="hint" style="margin-bottom:6px">Вставьте промпты одним куском: каждый отделите <b>пустой строкой</b> (или пронумеруйте: «1.», «Кадр 2:»). Приложение само разделит текст и поставит каждое изображение в очередь. Модель, формат и размер общие для всех.</div>
      <div style="display:flex;justify-content:space-between;align-items:center"><b class="kr-bcount"></b></div>
      <div class="kr-bl" style="max-height:220px;overflow:auto;margin:6px 0"></div>
      <div class="note warn kr-bwarn" hidden><span></span></div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0;cursor:pointer" title="Если нужна серия похожих кадров, включите. Для разных изображений оставьте выключенным: у каждой будет свой случайный seed."><input type="checkbox" class="kr-same" style="margin-top:3px"><span>Одинаковый seed для всей серии <span class="hint">(для серии кадров; для разных изображений не нужно). Если ниже задан фиксированный seed, возьмётся он.</span></span></label>
      <div class="status kr-bstatus" style="margin-top:6px"></div>
    </div>`,
    footNote: 'Лучше писать подробно, одним абзацем. Помощник в разделе «Сценарист» умеет писать такие промпты',
    generate: { mode: () => agKreaMode(), text: () => ($('.kr-prompt', root) || {}).value },
  });
  /* В модель уходит «Промт»; если человек написал только «Сценарий», берём его - иначе
     кнопка генерации ушла бы с пустым текстом, как это было, когда поле было одно. */
  const krText = () => String(krWin.value() || '').trim()
    || String(krWin.sc ? krWin.sc.value : '').trim();
  gridHandle(root);
  $('.kr-asp', root).innerHTML = IMG_ASPECTS.map(([id, name, w, h]) => { const k = 18 / Math.max(w, h);
    return `<button class="chip" data-a="${id}"><i class="ar" style="width:${w * k}px;height:${h * k}px"></i>${name}${name !== id ? ` <small>${id}</small>` : ''}</button>`; }).join('');
      + (true ? `<button class="token tok-aud" type="button" data-audio="1" title="&lt;Audio 1&gt; - ссылка на ваше аудио: модель возьмёт его как фоновый звук сцены">&lt;Audio 1&gt;</button>` : '');
  const krForm = text => { const fd = new FormData(); fd.append('prompt', text);
    fd.append('aspect', S.aspect); fd.append('style', S.engine === 'krea' ? S.style : 'plain'); fd.append('scale', S.scale); fd.append('engine', S.engine); if (S.engine === 'h3img') fd.append('mp', S.mp); if (S.cw && S.ch) { fd.append('width', S.cw); fd.append('height', S.ch); } if (S.engine === 'qwen') fd.append('negative', $('.kr-negtxt', root).value.trim()); imgSeedForm(S, fd); return fd; };
  const P = imgPanel($('.kr-prev', root), {
    // the list of prompts starts from the same button the single prompt uses
    intercept: () => (window._krBatch ? window._krBatch() : false),
    mode: 'krea', url: '/api/generate/krea', promptText: () => krText(),
    validate: () => krText() ? '' : 'Напишите сценарий или готовый промпт',
    form: () => { const fd = new FormData(); fd.append('prompt', krText()); fd.append('aspect', S.aspect); fd.append('style', S.engine === 'krea' ? S.style : 'plain'); fd.append('scale', S.scale); fd.append('engine', S.engine); if (S.engine === 'h3img') fd.append('mp', S.mp); if (S.cw && S.ch) { fd.append('width', S.cw); fd.append('height', S.ch); } if (S.engine === 'qwen') fd.append('negative', $('.kr-negtxt', root).value.trim()); imgSeedForm(S, fd); return fd; },
    two: () => S.engine === 'krea' && S.style === 'real',
  });
  const upd = () => {
    $$('.kr-asp .chip', root).forEach(c => c.classList.toggle('on', c.dataset.a === S.aspect));
    const h3 = S.engine === 'h3img';
    const [w, h] = S.cw && S.ch ? [S.cw, S.ch] : h3 ? h3Size(S.aspect, +S.mp) : IMG_SIZES[S.aspect], k = !h3 && S.style === 'real' ? (S.scale === '4k' ? 2.5 : 1.5) : 1;
    ''  /* the size stands in the buttons; repeating it under «Формат» was a duplicate */; P.ratio(w, h);
    $$('[data-st]', root).forEach(b => b.classList.toggle('on', b.dataset.st === S.style));
    $$('[data-sc]', root).forEach(b => b.classList.toggle('on', b.dataset.sc === S.scale));
    $('.kr-scale', root).hidden = !(S.engine === 'krea' && S.style === 'real');
    $$('.kr-h3mp [data-mp]', root).forEach(b => b.classList.toggle('on', b.dataset.mp === S.mp));
    $('.kr-h3mp', root).hidden = !h3;
    $$('.kr-eng button', root).forEach(b => b.classList.toggle('on', b.dataset.e === S.engine));
    $('.kr-stylerow', root).hidden = S.engine !== 'krea'; $('.kr-neg', root).hidden = S.engine !== 'qwen';
    $('.mode-pill span', root).textContent = { krea: 'Krea 2 · 1 МП', flux: 'FLUX klein · 1 МП', qwen: 'Qwen Image 2.1 · 1 МП', h3img: `MiniMax H3 Image · ${S.mp} МП` }[S.engine];
  };
  async function krEngCheck() {
    const hint = $('.kr-enghint', root); hint.hidden = true;
    if (S.engine === 'krea') return;
    const role = S.engine === 'flux' ? 'flux' : S.engine === 'h3img' ? 'h3img' : 'qwen';
    try {
      const st = await (await fetch('/api/status')).json();
      const miss = (st.models || []).filter(m => m.role.startsWith(role) && !m.have);
      if (!(st.modes || []).includes(role) || miss.length) {
        hint.hidden = false;
        hint.textContent = st.engine === 'managed'
          ? `Для этой модели нужны ещё файлы. Откройте «Настройки» и нажмите «Добавить ${role === 'flux' ? 'Изменение изображения: FLUX.2' : role === 'h3img' ? 'Изображения MiniMax H3 Image' : 'Изменение изображения'}».`
          : role === 'flux'
            ? 'Положите в папки моделей вашего ComfyUI: flux-2-klein-4b-fp8.safetensors (diffusion_models), qwen_3_4b.safetensors (text_encoders) и flux2-vae.safetensors (vae). Потом обновите раздел «Настройки».'
            : 'Для Qwen 2.1 нужны её модели (страница «Правка»). Проверьте «Настройки».';
      }
    } catch {}
  }
  root.addEventListener('click', async e => {
    const en = e.target.closest('.kr-eng button'); if (en) { S.engine = en.dataset.e; upd(); krEngCheck(); return; }
    const mp = e.target.closest('[data-mp]'); if (mp) { S.mp = mp.dataset.mp; upd(); return; }
    const sc = e.target.closest('[data-sc]'); if (sc) { S.scale = sc.dataset.sc; upd(); return; }
    const b = e.target.closest('[data-st]'); if (!b) return;
    S.style = b.dataset.st; upd();
    const hint = $('.kr-realhint', root); hint.hidden = true;
    if (S.style !== 'real') return;
    try {
      const st = await (await fetch('/api/status')).json();
      const miss = (st.models || []).filter(m => m.role.startsWith('kreareal') && !m.have);
      if (!(st.modes || []).includes('kreareal') || miss.length) {
        hint.hidden = false;
        hint.textContent = st.engine === 'managed'
          ? 'Для реализма нужны ещё две модели (около 15 ГБ). Откройте «Настройки» и нажмите «Добавить Изображение: реализм».'
          : 'Для реализма положите в папки моделей вашего ComfyUI: redcraftKREA2RedMix_krea2Edition.safetensors (diffusion_models) и realism_engine_krea2_v2.safetensors (loras). Потом обновите раздел «Настройки».';
      }
    } catch {}
  });
  $('.kr-asp', root).onclick = e => { const c = e.target.closest('.chip'); if (c) { S.aspect = c.dataset.a; S.cw = S.ch = 0; $('.sz-w', root).value = $('.sz-h', root).value = ''; $('.sz-reset', root).hidden = true; upd(); } };
  szWire(root, S, () => upd(), () => IMG_SIZES[S.aspect]);
  const krCount = e => $('.kr-count', root).textContent = e.target.value.length + ' символов';
  $('.kr-prompt', root).oninput = krCount;
  if (krWin.sc) krWin.sc.oninput = krCount;   // счётчик считает и то, что пишут в сценарии
  /* --- list of prompts: a series of pictures, one queue job per prompt --- */
  const K = { batch: false, items: [], removed: new Set() };
  const splitList = text => {
    const t = text.replace(/\r/g, '').trim(); if (!t) return [];
    let parts = t.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) { const m = t.split(/\n(?=\s*(?:кадр|frame|scene|сцена)?\s*\d+\s*[:.)\-–]\s)/i).map(x => x.trim()).filter(Boolean); if (m.length > 1) parts = m; }
    return parts.map(x => x.replace(/^\s*(?:кадр|frame|scene|сцена)?\s*\d+\s*[:.)\-–]\s*/i, '').replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  };
  const BATCH_MAX = 50;
  const kbRender = () => {
    const all = splitList(krText());
    K.items = all.filter(x => !K.removed.has(x));
    const over = K.items.length > BATCH_MAX;
    $('.kr-bl', root).innerHTML = K.items.map((x, i) => `<div class="kr-bi" style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--line)"><b style="min-width:26px">${i + 1}</b><span style="flex:1;font-size:12.5px">${esc(x.length > 120 ? x.slice(0, 120) + '…' : x)}</span><button class="btn" type="button" data-rm="${i}" title="Убрать из списка" style="padding:1px 8px">✕</button></div>`).join('')
      || '<div class="hint">Вставьте текст выше: промпты, разделённые пустой строкой.</div>';
    const n = K.items.length;
    $('.kr-bcount', root).textContent = n ? `Промптов: ${n}` : '';
    const w = $('.kr-bwarn', root); w.hidden = !over; w.textContent = over ? `Не больше ${BATCH_MAX} промптов за раз: уберите лишние или разбейте на части.` : '';
    const go = $('.ip-go', root); if (!go) return; go.disabled = !n || over; go.querySelector('span').textContent = n ? `Сгенерировать ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'изображение' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'изображения' : 'изображений'}` : 'Сгенерировать';
  };
  const kbMode = on => {
    K.batch = on; root.classList.toggle('kr-batching', on);
    // one button for both modes: leaving the list puts the ordinary caption back
    { const g = $('.ip-go', root); if (g && !on) { g.querySelector('span').textContent = 'Сгенерировать'; g.disabled = false; } }
    $$('.kr-bm button', root).forEach(b => b.classList.toggle('on', (b.dataset.b === '1') === on));
    $('.kr-batch', root).hidden = !on;
    $('.kr-prompt', root).placeholder = on ? 'Вставьте сюда список промптов. Каждый промпт отделите пустой строкой: из каждого получится отдельное изображение.' : 'Опишите изображение: кто или что в кадре, где, какой свет, какой стиль (фото, иллюстрация, постер)…';
    if (on) kbRender();
  };
  $('.kr-bm', root).onclick = e => { const b = e.target.closest('button'); if (b) kbMode(b.dataset.b === '1'); };
  const krBatchStart = () => { if (!K.batch) return false; krBatchGo(); return true; };
  window._krBatch = krBatchStart;   // the preview panel asks the queue through this
  $('.kr-bl', root).onclick = e => { const b = e.target.closest('[data-rm]'); if (!b) return; K.removed.add(K.items[+b.dataset.rm]); kbRender(); };
  $('.kr-prompt', root).addEventListener('input', () => { if (K.batch) { K.removed.clear(); kbRender(); } });
  const krBatchGo = async () => {
    const st = $('.kr-bstatus', root), n = K.items.length; if (!n || n > BATCH_MAX) return false;
    const same = $('.kr-same', root).checked, fixed = S.seedFixed && S.seed;
    const seed = same ? (fixed ? S.seed : String(Math.floor(Math.random() * 1e12))) : null;
    const go = $('.ip-go', root); go.disabled = true; let ok = 0;
    for (let i = 0; i < n; i++) {
      st.textContent = `Отправляем в очередь: ${i + 1} из ${n}…`;
      try {
        const fd = krForm(K.items[i]);
        if (seed) fd.set('seed', seed); else fd.delete('seed');   // every picture its own random seed unless it is a series
        fd.append('batch_label', `${i + 1} из ${n}`);
        const r = await fetch('/api/generate/krea', { method: 'POST', body: fd }); const txt = await r.text(); let res; try { res = JSON.parse(txt); } catch { res = { error: txt }; }
        if (!r.ok) throw new Error(res.error || r.statusText);
        qAdd(res.prompt_id, 'krea', K.items[i]); ok++;
      } catch (err) { st.textContent = `Ошибка на промпте ${i + 1}: ${err.message}. В очередь поставлено: ${ok}.`; go.disabled = false; return; }
    }
    const pl = k => k % 10 === 1 && k % 100 !== 11 ? 'изображение' : (k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 10 || k % 100 >= 20)) ? 'изображения' : 'изображений';
    st.innerHTML = `В очереди ${ok} ${pl(ok)}. Они появятся в Библиотеке по мере готовности; следить за ходом можно в разделе «Очередь».`; go.disabled = false;
  };
  const fillList = text => { kbMode(true); $('.kr-prompt', root).value = text; $('.kr-prompt', root).oninput({ target: $('.kr-prompt', root) }); K.removed.clear(); kbRender(); };
  imgSeedWire(root, S); upd();
  // the text written here can be handed to the Agent without retyping it; the target follows the engine
  agPromptButton($('.card-h', $('.kr-prompt', root).closest('.card')), 'текст окна', () => windowText(krWin),
    () => ({ kreareal: 'krea', flux: 'fluxt', h3img: 'h3t', qwen: 'qwent' }[S.engine] || 'krea'));
  IMG.krea = { fillList, fill: it => { if (it.engine) S.engine = it.engine; else if (/^(Картинка|Изображение) \(FLUX/.test(it.sub || '')) S.engine = 'flux'; else if (/^(Картинка|Изображение) \(Qwen/.test(it.sub || '')) S.engine = 'qwen'; else S.engine = 'krea'; $('.kr-prompt', root).value = it.prompt || ''; $('.kr-prompt', root).oninput({ target: $('.kr-prompt', root) }); if (IMG_SIZES[it.aspect]) S.aspect = it.aspect; upd(); } };
  IMG.krea.S = S; IMG.krea.upd = upd; IMG.krea.ta = () => $('.kr-prompt', root);
})();

/* --- Qwen Image 2.1: edit a picture, character sheet --- */
(() => {
  const root = $('#view-qwen'), S = { kind: 'edit', size: '1', h3s: '4', aspect: '', headless: true, bg: 'grey', panels: 4, engine: 'qwen', frames: true, line: 'white' };
  root.innerHTML = `
    <div class="head"><div><h1>Изменение изображения</h1><p>Загрузите изображение и напишите, что изменить: поменять место, одежду, свет, поставить персонажа в новую сцену. Или соберите лист персонажа</p></div>
      <div class="mode-pill"><i></i><span>Qwen Image 2.1</span></div></div>
    <div class="grid"><div class="col">
      <div class="row qw-top"><div class="seg qw-kind"><button data-k="edit" type="button" title="Изменить ваше изображение по описанию">Править изображение</button><button data-k="sheet" type="button" title="Собрать лист персонажа: 4 или 6 видов с разных сторон">Лист персонажа</button><button data-k="story" type="button" title="История по кадрам из изображений героя и места">Раскадровка</button></div><button class="btn mini qw-clear" type="button" title="Убрать всё в этом разделе: картинки, текст правки и особые приметы">Очистить всё</button></div>
      <div class="card"><div class="card-h"><h3><span class="n">1</span>Картинка</h3></div>
        <div class="qw-slots">
          <label class="drop" id="qwDrop"><input type="file" accept="image/*"><i class="cnt">1/3</i><div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="m21 15-5-5L5 21"/></svg><b>Ваша картинка</b><span>перетащите или нажмите</span></div><span class="tag" hidden>Исходная</span><button class="x" type="button">✕</button></label>
          <label class="drop qw-s2" id="qwDrop2" title="Ещё одна картинка (референс, по желанию)"><input type="file" accept="image/*"><i class="cnt">2/3</i><div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div><span class="tag" hidden>2</span><button class="x" type="button">✕</button></label>
          <label class="drop qw-s3" id="qwDrop3" title="Ещё одна картинка (референс, по желанию)"><input type="file" accept="image/*"><i class="cnt">3/3</i><div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div><span class="tag" hidden>3</span><button class="x" type="button">✕</button></label>
          <label class="drop qw-s4 qw-h3only" id="qwDrop4" hidden title="4-я картинка: только MiniMax H3 Image (до 5 референсов)"><input type="file" accept="image/*"><i class="cnt">4/5</i><div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div><span class="tag" hidden>4</span><button class="x" type="button">✕</button></label>
          <label class="drop qw-s5 qw-h3only" id="qwDrop5" hidden title="5-я картинка: только MiniMax H3 Image (до 5 референсов)"><input type="file" accept="image/*"><i class="cnt">5/5</i><div class="ph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div><span class="tag" hidden>5</span><button class="x" type="button">✕</button></label>
        </div>
        <div class="hint qw-morehint" style="margin-top:8px"></div></div>
      <div class="card" data-scenarobox="qwen"></div>
      <div class="card"><div class="card-h"><h3><span class="n">3</span>Параметры</h3></div>
          <div class="row qw-storyopts" hidden style="margin-bottom:12px"><div class="row-l">Как рисовать</div>
            <div class="seg qw-fr" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-fr="1">По кадрам<small>каждый кадр отдельно, лист склеит программа</small></button><button data-fr="0">Одним листом<small>одно изображение сразу</small></button></div>
            <div class="row qw-lnrow" style="margin-top:10px"><div class="row-l">Линия между кадрами</div>
              <div class="seg qw-ln" style="grid-template-columns:repeat(3,1fr)"><button data-ln="white">Тонкая белая</button><button data-ln="black">Тонкая чёрная</button><button data-ln="none">Без линии</button></div></div>
            <div class="hint" style="margin-top:6px">Кадры пишите по одному в строке: «1: ...», «2: ...» (2, 3, 4, 6, 8 или 9 кадров). Каждый кадр сохраняется отдельно в Библиотеку в полном размере. FLUX.2 рисует кадр за секунды, Qwen 2.1 заметно дольше (минуты на кадр).</div></div>
          <div class="row qw-parameng" style="margin-bottom:12px"><div class="row-l">Модель</div><div class="seg qw-eng" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"><button data-e="qwen">Qwen 2.1<small>для творчества, не для коммерции</small></button><button data-e="h3img">MiniMax H3 Image<small>до 5 референсов, крупно</small></button><button data-e="flux">FLUX klein<small>лёгкая модель; лицензию см. в списке моделей</small></button></div>
            <div class="hint qw-fluxhint" hidden></div></div>
          <div class="row qw-editonly" style="margin-top:12px"><div class="row-l">Формат кадра <span class="hint">по умолчанию как у вашего изображения</span></div><div class="chips qw-asp"></div></div>
          <div class="qw-szwrap" style="margin-top:12px">${SZ_ROW}</div>
          <div class="row qw-editonly qw-szrow" style="margin-top:12px"><div class="row-l">Размер результата</div><div class="seg qw-size" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-s="1">Обычный<small>~1 МП, быстро</small></button><button data-s="2">Крупный<small>~2 МП, дольше</small></button></div></div>
          <div class="row qw-h3sz" hidden style="margin-top:12px"><div class="row-l">Размер результата</div>
            <div class="seg" style="grid-template-columns:repeat(3,1fr)"><button data-h3s="4">4 МП<small>быстро</small></button><button data-h3s="8">8 МП<small>средне</small></button><button data-h3s="16">16 МП<small>дольше всего</small></button></div>
            <div class="hint" style="margin-top:6px">MiniMax H3 Image: лист персонажа и раскадровка выходят крупными сами (8 МП), а для правки размер выбираете вы.</div></div>
        <div class="qw-sheet" style="margin-top:14px" hidden>
          <div class="note"><span>Нужен персонаж на изображении (лучше в полный рост, но портрет тоже подойдёт). Потом лист можно взять как референс в других разделах.</span></div>
          <div class="row"><div class="row-l">Сколько видов</div><div class="seg qw-pn" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-p="4">4 панели<small>полный рост спереди и сзади, два портрета</small></button><button data-p="6">6 панелей<small>полный рост спереди, в 3/4, сбоку, сзади + 2 портрета</small></button></div></div>
          <div class="row"><div class="row-l">Первая панель</div><div class="seg qw-head" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)"><button data-h="1">Без головы<small>видна вся одежда</small></button><button data-h="0">С головой<small>для животных — так</small></button></div></div>
          <div class="row"><div class="row-l">Фон</div><div class="seg qw-bg" style="grid-template-columns:repeat(3,1fr)"><button data-b="grey">Серый</button><button data-b="white">Белый</button><button data-b="black">Чёрный</button></div></div>
          <div class="row"><div class="row-l">Особые приметы <span class="hint">необязательно</span></div><div class="path on"><input class="qw-marks" spellcheck="false" placeholder="например: жёлтые очки, шрам на брови"></div></div></div>
        ${imgSeedBox()}
        <div class="hint" style="margin-top:10px">Модель Qwen Image 2.1 — только для некоммерческого использования (лицензия Qwen Research).</div></div>
    </div><div class="preview qw-prev"></div></div>`;
  /* Окно «Сценарий» правки картинки - тот же общий модуль: ряд плашек над полем, обёртка
     .qw-edit сохранена (на неё смотрит лист персонажа, который прячет поле целиком), классы
     поля и плашек прежние, так что код раскадровки и меток их находит как находил. */
  const qwWin = scenarioWindow($('[data-scenarobox="qwen"]', root), {
    kind: 'qwen', register: 'qwen', num: 2, hint: 'можно написать в разделе «Сценарист»',
    wrap: 'qw-edit', cls: 'qw-prompt', chips: 'above', chipsCls: 'qw-tokens',
    placeholder: 'Что изменить и что оставить. Например: Этот человек сидит в кафе у окна и пьёт кофе. Лицо, причёска и одежда как на изображении.',
    generate: { mode: () => agQwenMode(), text: () => ($('.qw-prompt', root) || {}).value },
  });
  const qwText = () => String(qwWin.value() || '').trim()
    || String(qwWin.sc ? qwWin.sc.value : '').trim();
  gridHandle(root);
  const drop = $('#qwDrop');
  wireDrop(drop, () => {});
  const drop2 = $('#qwDrop2'), drop3 = $('#qwDrop3'), drop4 = $('#qwDrop4'), drop5 = $('#qwDrop5');
  $('.qw-clear', root).onclick = () => {
    const pics = [drop, drop2, drop3, drop4, drop5].filter(d => d.classList.contains('filled')), ta = $('.qw-prompt', root), mk = $('.qw-marks', root);
    if (!pics.length && !ta.value.trim() && !(mk && mk.value.trim())) { toast('Здесь и так пусто'); return; }
    confirmBox('Очистить «Изменение изображения»?',
      `Уберём${pics.length ? ' картинки (' + pics.length + ' шт.),' : ''} текст правки${mk && mk.value.trim() ? ' и особые приметы' : ''}. Картинки в Библиотеке останутся.`, 'Очистить всё', () => {
        pics.forEach(d => $('.x', d)?.click());
        ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (mk) mk.value = '';
        toast('Раздел очищен');
      });
  };
  szWire($('.qw-szwrap', root), S, () => upd(), () => IMG_SIZES[S.aspect] || [1376, 768]);
  wireDrop(drop2, () => {}); wireDrop(drop3, () => {}); wireDrop(drop4, () => {}); wireDrop(drop5, () => {});
  hGripAfter($('.qw-slots', root), 'h3.qwh', { h: '--qwh', min: 110, max: 460 });
  /* The slots paint their own picture but never call the window's repaint, so the row of tags under
     the prompt stayed asleep: a photo arrived, the chip went on saying «no photo here». */
  $('.qw-slots', root).addEventListener('change', () => setTimeout(upd, 0), true);
  $('.qw-slots', root).addEventListener('click', () => setTimeout(upd, 0), true);
  const P = imgPanel($('.qw-prev', root), {
    mode: 'qwen', url: '/api/generate/qwen',
    promptText: () => S.kind === 'sheet' ? 'Лист персонажа' : qwText(),
    validate: () => !drop._file && !(S.kind === 'story' && S.frames) ? 'Загрузите изображение' : S.kind === 'edit' && !qwText() ? 'Напишите, что изменить на изображении' : S.kind === 'story' && !$('.qw-prompt', root).value.trim() ? 'Опишите историю по кадрам' : '',
    form: () => {
      const fd = new FormData(); if (drop._file) fd.append('image', drop._file); fd.append('kind', S.kind);
      if (S.kind === 'story') { fd.append('frames', S.frames ? '1' : '0'); fd.append('line', S.line); }
      fd.append('engine', S.kind === 'sheet' ? (S.engine === 'h3img' ? 'h3img' : 'qwen') : S.engine);
      if (S.kind !== 'sheet' && S.cw && S.ch) { fd.append('width', S.cw); fd.append('height', S.ch); }
      if (S.kind !== 'sheet') { if (drop2._file) fd.append('image2', drop2._file); if (drop3._file) fd.append('image3', drop3._file);
        if (S.engine === 'h3img') { if (drop4._file) fd.append('image4', drop4._file); if (drop5._file) fd.append('image5', drop5._file); } }
      if (S.kind === 'sheet') { fd.append('panels', S.panels); fd.append('headless', S.headless ? '1' : '0'); fd.append('background', S.bg); fd.append('marks', $('.qw-marks', root).value.trim()); }
      else { fd.append('prompt', qwText()); fd.append('size', S.engine === 'h3img' ? S.h3s : S.size); fd.append('aspect', S.aspect); }
      imgSeedForm(S, fd); return fd;
    },
  });
  $('.qw-asp', root).innerHTML = `<button class="chip" data-qa="">Как у изображения</button>` + IMG_ASPECTS.map(([id, name, w, h]) => { const k = 18 / Math.max(w, h);
    return `<button class="chip" data-qa="${id}"><i class="ar" style="width:${w * k}px;height:${h * k}px"></i>${name}${name !== id ? ` <small>${id}</small>` : ''}</button>`; }).join('');
  const upd = () => {
    $$('.qw-asp .chip', root).forEach(c => c.classList.toggle('on', c.dataset.qa === S.aspect));
    $$('.qw-kind button', root).forEach(b => b.classList.toggle('on', b.dataset.k === S.kind));
    $('.qw-edit', root).hidden = S.kind === 'sheet'; $('.qw-sheet', root).hidden = S.kind !== 'sheet';
    // the prompt card is meaningless for a character sheet, so it steps out of the way entirely
    { const pc = $('.qw-edit', root).closest('.card'); if (pc) pc.hidden = S.kind === 'sheet'; }
    { const er = $('.qw-parameng', root); if (er) er.hidden = S.kind === 'sheet'; }   // the sheet picks its own model
    const h3 = S.engine === 'h3img';
    if (S.kind === 'sheet' && S.engine === 'flux') S.engine = 'qwen';   // лист персонажа умеют Qwen и H3 Image
    $$('.qw-s2, .qw-s3', root).forEach(x => x.hidden = S.kind === 'sheet');
    /* 4-я и 5-я картинки есть только у MiniMax H3 Image: остальные движки берут не больше трёх */
    $$('.qw-h3only', root).forEach(x => x.hidden = S.kind === 'sheet' || !h3);
    $$('.qw-h3sz', root).forEach(x => x.hidden = S.kind === 'sheet' || !h3);
    $$('.qw-size', root).forEach(x => { const r = x.closest('.row'); if (r) r.hidden = h3 || S.kind === 'sheet'; });
    /* Индикатор в шапке обязан показывать то, чем раздел реально рисует: раньше тут навсегда
       осталось «Qwen Image 2.1», и переключение движка или режима на него не влияло. */
    const QW_KIND = { edit: 'правка', sheet: 'лист персонажа', story: 'раскадровка' };
    $('.mode-pill span', root).textContent = ({ qwen: 'Qwen Image 2.1', flux: 'FLUX.2 klein', h3img: 'MiniMax H3 Image · ' + (S.h3s || 1) + ' МП' })[S.engine] + ' · ' + (QW_KIND[S.kind] || 'правка');
    $$('.qw-eng [data-e="flux"]', root).forEach(x => x.hidden = S.kind === 'sheet');
    $$('.qw-h3sz [data-h3s]', root).forEach(b => b.classList.toggle('on', b.dataset.h3s === S.h3s)); $('.qw-slots', root).classList.toggle('one', S.kind === 'sheet'); $('.qw-morehint', root).hidden = S.kind === 'sheet';
    $('.qw-morehint', root).innerHTML = S.kind === 'story'
      ? (h3
        ? 'Раскадровка на MiniMax H3 Image: до 5 изображений - герой, лист персонажа, локация, стиль. В тексте они называются <b>&lt;Picture 1&gt;</b>, <b>&lt;Picture 2&gt;</b>… Каждый кадр называется по номеру.'
        : 'Раскадровка: 1-е изображение — герой (или лист персонажа), 2-я — локация, 3-я — по желанию. В тексте они называются <b>&lt;image1&gt;</b>, <b>&lt;image2&gt;</b>, <b>&lt;image3&gt;</b> (для FLUX.2: «image 1», «image 2»).')
      : (h3
        ? 'MiniMax H3 Image: до 5 изображений. <b>&lt;Picture 1&gt;</b> — то, что меняем (или главный образец), остальные — стиль, герой, предмет, место. Каждое называйте в тексте по номеру.'
        : 'Референсы (по желанию): 1-е изображение — то, что меняем, 2-я и 3-я — например, герой, предмет или одежда. В тексте они называются <b>&lt;image2&gt;</b>, <b>&lt;image3&gt;</b> (для FLUX.2: «image 2», «image 3»).');
    /* The same chips as in the studios: the person should not remember how each model names a
       picture. H3 Image takes <Picture N>, Qwen <imageN>, FLUX.2 «image N», and a storyboard says
       it with a space, exactly as the hint of the card puts it. */
    {
      const tagOf = i => S.engine === 'h3img' ? '<Picture ' + i + '>'
        : (S.kind === 'story' || S.engine === 'flux') ? 'image ' + i : '<image' + i + '>';
      const tk = $('.qw-tokens', root);
      if (tk) {
        const lit = t => t.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        tk.innerHTML = ['#qwDrop', '#qwDrop2', '#qwDrop3', '#qwDrop4', '#qwDrop5']
          .map(s => $(s, root)).filter(d => d && !d.hidden)
          .map((d, i) => `<button class="token" type="button"${d._file ? '' : ' disabled'} title="${d._file ? 'Вставить в текст: ' + lit(tagOf(i + 1)) : 'В это место ещё не загружено фото'}">${lit(tagOf(i + 1))}</button>`)
          .join('') + (S.kind === 'story' ? '<span class="hint">кадры считываются по порядку, без тега</span>' : '');
      }
    }
    /* Бирка «1/3» была написана прямо в разметке и никогда не переписывалась: в режиме листа место
       одно, а она обещала три. */
    {
      const cap = S.kind === 'sheet' ? 1 : (h3 ? 5 : 3);
      ['#qwDrop', '#qwDrop2', '#qwDrop3', '#qwDrop4', '#qwDrop5'].forEach((s, i) => {
        const c = $('.cnt', $(s, root)); if (!c) return;
        c.textContent = (i + 1) + '/' + cap;
        c.hidden = cap === 1;
      });
    }
    $('.qw-storyopts', root).hidden = S.kind !== 'story';
    $('.qw-lnrow', root).hidden = !S.frames;
    $$('.qw-fr button', root).forEach(b => b.classList.toggle('on', (b.dataset.fr === '1') === S.frames));
    $$('.qw-ln button', root).forEach(b => b.classList.toggle('on', b.dataset.ln === S.line));
    $$('.qw-editonly', root).forEach(r => r.hidden = S.kind === 'story' || (S.engine === 'flux' && r.contains($('.qw-asp', root))) || (h3 && r.classList.contains('qw-szrow')));   // у H3 Image свой размер в МП
    $('.qw-prompt', root).placeholder = S.kind === 'story' && S.frames ? '1: первый кадр по-английски...\n2: второй кадр...\n(героя и место называйте image 1, image 2). Или попросите сценариста (Раскадровка, потом «По кадрам»).' : S.kind === 'story' ? 'Расскажите историю по кадрам: первый кадр — …, второй кадр — …. Героя и место называйте <image1>, <image2>. Или попросите сценариста (Раскадровка) написать промпт.' : 'Что изменить и что оставить. Например: Этот человек сидит в кафе у окна и пьёт кофе. Лицо, причёска и одежда как на изображении.';
    $$('.qw-size button', root).forEach(b => b.classList.toggle('on', b.dataset.s === S.size));
    $$('.qw-head button', root).forEach(b => b.classList.toggle('on', (b.dataset.h === '1') === S.headless));
    $$('.qw-bg button', root).forEach(b => b.classList.toggle('on', b.dataset.b === S.bg));
    $$('.qw-eng button', root).forEach(b => b.classList.toggle('on', b.dataset.e === S.engine));
    $$('.qw-pn button', root).forEach(b => b.classList.toggle('on', +b.dataset.p === S.panels));
    if (S.kind === 'sheet' && h3) S.panels === 6 ? P.ratio(4352, 1984) : P.ratio(3840, 2176);
    else if (S.kind === 'sheet') S.panels === 6 ? P.ratio(2112, 960) : P.ratio(1920, 1088);
    else if (S.kind === 'story') P.ratio(1920, 1088);
    if (S.kind !== 'sheet' && S.cw && S.ch) P.ratio(S.cw, S.ch);
  };
  root.addEventListener('click', e => {
    const fr = e.target.closest('.qw-fr button'), ln = e.target.closest('.qw-ln button');
    if (fr) { S.frames = fr.dataset.fr === '1'; upd(); return; }
    if (ln) { S.line = ln.dataset.ln; upd(); return; }
    const qa = e.target.closest('.qw-asp .chip'); if (qa) { S.aspect = qa.dataset.qa; upd(); return; }
    const k = e.target.closest('.qw-kind button'), h3s = e.target.closest('[data-h3s]'), s = e.target.closest('.qw-size button'), h = e.target.closest('.qw-head button'), b = e.target.closest('.qw-bg button'), pn = e.target.closest('.qw-pn button'), en = e.target.closest('.qw-eng button');
    if (en) { S.engine = en.dataset.e; upd(); qwFluxCheck(); return; }
    if (h3s) { S.h3s = h3s.dataset.h3s; upd(); return; }
    if (pn) S.panels = +pn.dataset.p; else if (k) S.kind = k.dataset.k; else if (s) S.size = s.dataset.s; else if (h) S.headless = h.dataset.h === '1'; else if (b) S.bg = b.dataset.b; else return;
    upd();
  });
  async function qwFluxCheck() {
    const hint = $('.qw-fluxhint', root); hint.hidden = true;
    if (S.engine !== 'flux') return;
    try {
      const st = await (await fetch('/api/status')).json();
      const miss = (st.models || []).filter(m => m.role.startsWith('flux') && !m.have);
      if (!(st.modes || []).includes('flux') || miss.length) {
        hint.hidden = false;
        hint.textContent = st.engine === 'managed'
          ? 'Для этой модели нужны ещё три файла (около 12 ГБ). Откройте «Настройки» и нажмите «Добавить Изменение изображения: FLUX.2».'
          : 'Положите в папки моделей вашего ComfyUI: flux-2-klein-4b-fp8.safetensors (diffusion_models), qwen_3_4b.safetensors (text_encoders) и flux2-vae.safetensors (vae). Потом обновите раздел «Настройки».';
      }
    } catch {}
  }
  imgSeedWire(root, S); upd();
  $('.qw-tokens', root).onclick = e => {
    const t = e.target.closest('.token'); if (!t) return;
    if (t.disabled) { toast('В это место ещё не загружено фото'); return; }
    const ta = $('.qw-prompt', root), p = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    // a tag glued to the previous word reads badly and is harder to fix later
    const txt = (p > 0 && !/[\s>]/.test(ta.value[p - 1]) ? ' ' : '') + t.textContent + ' ';
    ta.value = ta.value.slice(0, p) + txt + ta.value.slice(ta.selectionEnd || p);
    ta.focus(); ta.selectionStart = ta.selectionEnd = p + txt.length;
    ta.dispatchEvent(new Event('input'));
  };
  agPromptButton($('.card-h', $('.qw-prompt', root).closest('.card')), 'текст правки', () => windowText(qwWin),
    () => ({ h3img: 'h3e' }[S.engine] || 'qwen'));
  IMG.qwen = { fill: it => { if (it.engine) S.engine = it.engine; if (it.frames !== undefined) S.frames = !!it.frames; if (String(it.sub || '').startsWith('Раскадровка по кадрам')) S.frames = true; else if (String(it.sub || '').startsWith('Раскадровка')) S.frames = false; if (it.kind === 'story' || String(it.sub || '').startsWith('Раскадровка')) { S.kind = 'story'; $('.qw-prompt', root).value = it.prompt || ''; } else if (it.sub === 'Лист персонажа') S.kind = 'sheet'; else { S.kind = 'edit'; $('.qw-prompt', root).value = it.prompt || ''; } upd(); } };
  IMG.qwen.S = S; IMG.qwen.upd = upd; IMG.qwen.ta = () => $('.qw-prompt', root);
})();


fetch('/api/version').then(r => r.json()).then(v => { $('#appVer').textContent = 'Версия ' + v.version + (v.built ? ' · сборка ' + v.built : ''); }).catch(() => {});
/* Cleaning a written prompt is the same chore in every mode, and in the studios it already has a
   button. Here it comes to the rest of them: the button is put into the strip under the field, asks
   before erasing, and clears exactly the field it stands under. */
export function attachClearButtons(root) {
  const scope = root && root.querySelectorAll ? root : document;
  /* One rule for every field: the tags and the note keep their own line, all the buttons of the
     field stand in one row, and the clearing button is always the last one, at the right edge.
     The row is the one the field's buttons already use; where there are none, a row is made. */
  const list = Array.prototype.slice.call(scope.querySelectorAll ? scope.querySelectorAll('textarea') : (scope.tagName === 'TEXTAREA' ? [scope] : []));
  list.forEach(ta => {
    // ряд аудио в лотке сценариста: у каждой строки есть свой крестик, кнопка очистки только мешает
    if (ta.dataset.noClear === '1' || ta.id === 'agAudioText' || ta.closest('#agAudioBox') || ta.closest('.atrim') || ta.closest('.sp-menu') || ta.closest('.lm-scenes') || ta.closest('.sc') || ta.closest('.ag-comp') || ta.id === 'agIn') return;
    const card = ta.closest('.card') || ta.parentElement;
    if (!card || card.querySelector('.ta-clear')) return;
    // ряд кнопок того же поля: тот, что дало окно «Сценарий», а не попавшийся рядом
    const rows = Array.prototype.slice.call(card.querySelectorAll('.field-btns'));
    let row = rows.filter(r => r.querySelector('.gen-b')).pop() || rows.pop()
      || Array.prototype.slice.call(card.querySelectorAll('.ta-foot')).filter(f => !f.querySelector('.rm-tokens, .tokens, .sc-tokens')).pop();
    if (!row) { row = document.createElement('div'); row.className = 'field-btns'; ta.insertAdjacentElement('afterend', row); }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn mini ta-clear'; b.textContent = 'Очистить текст';
    b.title = 'Стереть текст в этом поле; файлы на своих местах останутся';
    b.style.cssText = 'padding:3px 10px;font-size:12px';
    b.onclick = () => {
      if (!ta.value.trim()) { toast('Здесь и так пусто'); return; }
      confirmBox('Стереть текст промпта?', 'Поле очистится. Картинки, видео и звук останутся там, где вы их положили.', 'Стереть текст', () => {
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        toast('Текст стёрт');
      });
    };
    row.append(b);
  });
}
/* «Вставить пример» сидела на строке с тегами и читалась как ещё один тег. У кнопок поля есть
   свой ряд - переставляем её туда, третьей, перед очисткой. */
export function placeExampleButtons() {
  $$('.sw-example').forEach(el => {
    const card = el.closest('.card'); if (!card) return;
    const rows = Array.prototype.slice.call(card.querySelectorAll('.field-btns'));
    const row = rows.filter(r => r.querySelector('.gen-b')).pop() || rows.pop();
    if (!row || el.parentElement === row) return;
    const clr = row.querySelector('.ta-clear');
    if (clr) row.insertBefore(el, clr); else row.append(el);
  });
}
/* Обе раскладки полей вызывает один вход: порядок, в котором поля успели построиться, бывает
   разный, и второй таймер был костылём. */
export function fieldRows(root) { attachClearButtons(root); placeExampleButtons(); }

setTimeout(() => {
  fieldRows(document);
  if (typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(nd => {
      if (nd.nodeType !== 1) return;
      if (nd.querySelectorAll || nd.classList) fieldRows(nd);
    })));
    mo.observe(document.body, { childList: true, subtree: true });
  }
}, 1700);

/* A prompt is prose, and one typo can cost a whole generation: turn the browser's own spelling
   check on explicitly for the fields where a person writes, and keep it on for the ones that are
   built later. Fields carrying a path or code stay quiet. */
(function () {
  const quiet = el => /dir|path|json|api|код/i.test((el.id || '') + ' ' + (el.className || '') + ' ' + (el.placeholder || ''));
  const on = el => { if (el.tagName === 'TEXTAREA' && !quiet(el)) el.setAttribute('spellcheck', 'true'); };
  setTimeout(() => {
    document.querySelectorAll('textarea').forEach(on);
    if (typeof MutationObserver !== 'undefined') new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(nd => {
      if (nd.nodeType !== 1) return; on(nd); nd.querySelectorAll && nd.querySelectorAll('textarea').forEach(on);
    }))).observe(document.body, { childList: true, subtree: true });
  }, 1500);
})();

/* ---------- updates: a new release on GitHub -> a bar with "Обновить" ---------- */
(() => {
  if (!API) return;
  const bar = document.createElement('div'); bar.className = 'upd'; bar.hidden = true; document.body.append(bar);
  setTimeout(async () => {
    let u; try { u = await (await fetch('/api/update/check')).json(); } catch { return; }
    if (!u.available || !u.can_update) return;
    const paint = (html) => { bar.innerHTML = html; bar.hidden = false; };
    const ask = () => paint(`<span>Вышла версия <b>${esc(u.version)}</b> (у вас ${esc(u.current)}). Настройки, Библиотека и модели останутся.</span><button class="btn pri" data-a="go" type="button">Обновить</button><button class="btn" data-a="later" type="button">Позже</button>`);
    ask();
    bar.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'later') { bar.hidden = true; return; }
      if (QUEUE.some(j => j.state === 'queued' || j.state === 'running')) { toast('Идёт генерация. Дождитесь её конца и нажмите «Обновить» снова'); return; }
      paint('<span>Скачиваем обновление… Не закрывайте программу.</span>');
      try {
        await postJSON('/api/update/install', {});
        paint('<span>Устанавливаем. Программа закроется и сама откроется заново — это займёт около минуты.</span>');
      } catch (err) { paint(`<span>Не получилось обновить: ${esc(err.message)}</span><button class="btn" data-a="go" type="button">Ещё раз</button><button class="btn" data-a="later" type="button">Закрыть</button>`); }
    };
  }, 4000);
})();
document.addEventListener('pointerdown', e => {
  const h = e.target.closest('#cwRs'); if (!h) return;
  const cols = h.parentElement, box = $('#cwBody'); h.classList.add('drag'); h.setPointerCapture(e.pointerId);
  const move = ev => { const r = cols.getBoundingClientRect(); const k = (cols.clientWidth || r.width) / (r.width || 1); const w = Math.round(Math.min(r.width * .7 * k, Math.max(300, (r.right - ev.clientX - 5) * k))); box.style.setProperty('--cw-rw', w + 'px'); try { localStorage.setItem('h3-cw-rw', w); } catch {} };
  const up = () => { h.classList.remove('drag'); h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); };
  h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
});
document.addEventListener('dblclick', e => { if (e.target.closest('#cwRs')) { $('#cwBody').style.removeProperty('--cw-rw'); try { localStorage.removeItem('h3-cw-rw'); } catch {} } });
try { const rw = +localStorage.getItem('h3-cw-rw'); if (rw >= 300) $('#cwBody').style.setProperty('--cw-rw', rw + 'px'); } catch {}
/* Общий хаб не импортирует разделы: окно картинок сообщает о себе сам (core/state.js) */
registerViews({ IMG });
