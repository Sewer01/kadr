import { API } from '../core/net.js';
import { $, $$, confirmBox, drawCover, esc, fmtTime, noiseCv, normItem, offCv, toast } from '../core/util.js';
import { LIB, QUEUE, byId, selected } from '../core/state.js';
import { QUALITY_ALL, frames, resFor, useSeed } from './params.js';
import { offPrompt, onPrompt, previewHandlers } from './scenario.js';
import { openUpscale, openViewer, renderLib } from '../views/library.js';
import { qAdd } from '../views/queue.js';
import { lowMemoryAsk } from '../views/setup.js';
import { ENGINE_ON } from '../views/system.js';

export function makeScene(seed = Math.random()) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 200;
  const x = c.getContext('2d'); let r = seed * 9301;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  x.fillStyle = `hsl(${340 + rnd() * 30},40%,8%)`; x.fillRect(0, 0, 320, 200);
  for (let i = 0; i < 6; i++) {
    const g = x.createRadialGradient(rnd() * 320, rnd() * 200, 0, rnd() * 320, rnd() * 200, 60 + rnd() * 140);
    const hue = [350, 10, 25, 220, 280][Math.floor(rnd() * 5)];
    g.addColorStop(0, `hsla(${hue},${60 + rnd() * 30}%,${40 + rnd() * 25}%,.9)`); g.addColorStop(1, 'transparent');
    x.fillStyle = g; x.fillRect(0, 0, 320, 200);
  }
  return c;
}
export function renderLive(ctx, W, H, src, p, t) {
  const sw = Math.max(4, Math.round(4 + p * p * 110));
  offCv.width = sw; offCv.height = Math.max(3, Math.round(sw * H / W));
  const o = offCv.getContext('2d');
  drawCover(o, src, offCv.width, offCv.height, 1.06 + Math.sin(t / 1300) * 0.02, Math.sin(t / 900) * 0.02);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(offCv, 0, 0, W, H);
  const a = (1 - p) * 0.85;
  if (a > 0.02) {
    const n = noiseCv.getContext('2d'), d = n.createImageData(160, 100);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = v; d.data[i + 1] = v * .7; d.data[i + 2] = v * .8; d.data[i + 3] = 255; }
    n.putImageData(d, 0, 0);
    ctx.globalAlpha = a; ctx.imageSmoothingEnabled = false; ctx.drawImage(noiseCv, 0, 0, W, H); ctx.globalAlpha = 1;
  }
}
export function previewPanel(el, st, opts) {
  el.innerHTML = `
    <div class="screen"><div class="frame">
      <div class="res"></div>
      <canvas class="live" hidden></canvas>
      <img class="live-img" alt="" hidden>
      <video class="live-vid" autoplay loop muted playsinline hidden style="width:100%;height:100%;object-fit:contain"></video>
      <video class="result" controls loop playsinline hidden></video>
      <button class="cw-zb rm" type="button" hidden title="Удалить этот ролик из Библиотеки: файл переместится в корзину Windows" aria-label="Удалить ролик"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button>
      <button class="cw-zb expand" type="button" title="Развернуть в большое окно" aria-label="Развернуть в большое окно"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg></button>
      <div class="wait" hidden></div>
      <div class="live-hud" hidden><span class="live-dot"></span><span class="hud-t">Предпросмотр</span><span class="hud-s"></span></div>
      <div class="bar"></div>
    </div></div>
    <div class="summary">
      <div class="sum"><small>Разрешение</small><b class="s-res"></b></div>
      <div class="sum"><small>Длина</small><b class="s-len"></b></div>
      <div class="sum"><small>Кадров</small><b class="s-fr"></b></div>
      <div class="sum"><small>${opts.extraLabel}</small><b class="s-ex"></b></div>
    </div>
    <div class="pbox" hidden>
      <div class="pbox-top"><span class="pbox-l"></span><b class="pbox-p">0%</b></div>
      <div class="pbox-bar"><i></i></div>
      <div class="pbox-badges"></div>
      <div class="pbox-chip ok"><span class="pbox-dot"></span><span class="pbox-t"></span></div>
    </div>
    <button class="go"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>Сгенерировать</button>
    <button class="stop" hidden><i></i>Остановить генерацию</button>
    <div class="cloud-line" hidden> Генерация пойдёт в облако <b>RunningHub</b> (переключить — в разделе «Настройки»)</div>
    <div class="status"></div>`;
  const frame = $('.frame', el), go = $('.go', el), stopB = $('.stop', el), status = $('.status', el);
  const live = $('.live', el), hud = $('.live-hud', el), bar = $('.bar', el);
  const liveImg = $('.live-img', el), result = $('.result', el), wait = $('.wait', el), liveVid = $('.live-vid', el);
  const expand = $('.expand', el);   // the clip finished: open it in the big viewer, as from the library
  expand.onclick = () => { if (result.dataset.dragid) openViewer(result.dataset.dragid, el._done ? normItem(el._done) : null); };
  const rmBtn = $('.rm', el);        // ...and the same clip can be thrown away right here
  rmBtn.onclick = () => {
    const id = result.dataset.dragid; if (!id) return;
    confirmBox('Удалить этот ролик?', 'Файл переместится в корзину Windows, оттуда его можно вернуть. Клипы и изображения, из которых он сделан, останутся в Библиотеке.', 'Удалить', async () => {
      try {
        const r = await fetch('/api/library/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { toast(j.error || 'Не удалось удалить'); return; }
        if ((j.failed || []).length) { toast('Файл не удалился, остался на месте'); return; }
        const at = LIB.findIndex(x => x.id === id); if (at >= 0) LIB.splice(at, 1);
        if (typeof selected !== 'undefined') selected.delete(id);
        renderLib();
      } catch (e) { toast(e.message); return; }
      resetFrame(); $('.status', el).textContent = 'Ролик удалён из Библиотеки.';
      toast('Ролик удалён в корзину');
    });
  };
  const STEP_MS = 420;
  let run = null;
  const pbox = $('.pbox', el), pboxBar = $('.pbox-bar i', el), pboxChip = $('.pbox-chip', el);

  /* the big bar + a colour chip: green = alive, yellow = quiet for a while, red = probably stuck / connection lost */
  function health(p, stepLine, badges) {
    pbox.hidden = false;
    $('.pbox-l', el).textContent = stepLine;
    $('.pbox-badges', el).innerHTML = (badges || []).map(b => `<span${b.eta ? ' class="eta"' : ''}>${esc(b.t)}</span>`).join('');
    $('.pbox-p', el).textContent = Math.round(p * 100) + '%';
    pboxBar.style.width = (p * 100) + '%';
    const now = performance.now(), idle = (now - (run.lastEv || run.t0)) / 1000;
    const sampling = run.stage && run.stage.startsWith('sample');
    const per = run.step >= 2 && run.step1T ? (run.stepT - run.step1T) / (run.step - 1) / 1000 : 0;
    const warnAt = sampling ? Math.max(90, per * 3) : run.stage === 'queued' ? 1e9 : 300;
    const badAt = sampling ? Math.max(240, per * 6) : run.stage === 'queued' ? 1e9 : 600;
    let lvl = 'ok', txt = 'Всё идёт, программа получает данные от ComfyUI';
    if (run.stopping) {
      const s = Math.round((now - run.stopping) / 1000);
      lvl = s > 15 ? 'warn' : 'ok'; txt = `Останавливаем… ${s} с` + (s > 15 ? ' · ComfyUI не отвечает на отмену, программа перезапустит движок' : '');
    } else if (!ENGINE_ON) { lvl = 'bad'; txt = 'Обрыв связи: ComfyUI не отвечает или закрылся. Дождитесь возврата или перезапустите движок'; }
    else if (run.stage === 'queued') txt = 'В очереди: ждёт, пока освободится ComfyUI';
    else if (idle > badAt) { lvl = 'bad'; txt = `Нет ответа уже ${fmtTime(idle)}. Похоже, зависло. Нажмите «Остановить генерацию» и запустите снова (можно с меньшим размером)`; }
    else if (idle > warnAt) { lvl = 'warn'; txt = `Тишина ${fmtTime(idle)}. ${sampling ? 'Шаг идёт долго, на слабой карте это бывает' : 'Возможно, грузится большая модель'}. Если станет красным, то зависло`; }
    else if (sampling && run.step) txt = `Всё идёт · последний шаг был ${fmtTime(idle)} назад`;
    pboxChip.className = 'pbox-chip ' + lvl; pbox.classList.toggle('warn', lvl === 'warn'); pbox.classList.toggle('bad', lvl === 'bad');
    $('.pbox-t', el).textContent = txt;
  }

  function resetFrame() {
    liveVid.pause(); liveVid.removeAttribute('src'); liveVid.load();   // скрытое зацикленное видео иначе продолжает декодироваться
    pbox.hidden = true;
    [live, hud, liveImg, liveVid, result, wait].forEach(x => x.hidden = true);
    result.pause(); result.removeAttribute('src'); delete result.dataset.dragid; el._done = null; rmBtn.hidden = true;
    $('.res', frame).hidden = false; frame.classList.remove('done');
  }
  // «Очистить» in the section must empty this preview too, not only the fields
  el._syncLabel = () => { if (!run) setGo(false); };   // the page may change what the button should say
  el._reset = () => {
    resetFrame();
    $$('.sum b', el).forEach(b => b.textContent = '—');
    if (typeof status !== 'undefined' && status) status.textContent = '';
    if (typeof bar !== 'undefined' && bar) bar.style.width = 0;
  };

  /* ----- real generation through the local server ----- */
  const STAGE = {
    queued: ['В очереди ComfyUI…', 0.02, 'в очереди'],
    load: ['Загружаем модели в видеопамять… (первый запуск дольше)', 0.05, 'загрузка моделей'],
    encode: ['Кодируем промпт и кадры…', 0.12, 'кодирование'],
    sample: ['Генерация кадров', 0.15, ''],
    upscale: ['Увеличиваем разрешение для второго прохода…', 0.67, 'апскейл'],
    cloud_queued: ['В очереди на RunningHub…', 0.05, 'облако: очередь'],
    cloud_run: ['Генерация в облаке RunningHub… (превью в облаке не передаётся)', 0.4, 'облако'],
    sample2: ['Проход 2 · детализация', 0.70, ''],
    decode: ['Собираем видео и звук…', 0.92, 'сборка видео'],
    save: ['Сохраняем файл…', 0.98, 'сохранение'],
  };
  const goText = () => opts.goLabel ? opts.goLabel() : 'Сгенерировать';
  const setGo = busy => { go.lastChild.textContent = busy ? 'Поставить в очередь ещё одно' : goText(); };
  async function realStart() {
    const meta = opts.meta();
    go.disabled = true; if (!run) status.textContent = 'Отправляем задание в ComfyUI…';
    let res;
    try {
      const r = await fetch(opts.real.url, { method: 'POST', body: opts.real.form() });
      const txt = await r.text();
      try { res = JSON.parse(txt); } catch { res = { error: txt }; }
      if (!r.ok) {
        if (r.status === 409 && res.low_memory) { go.disabled = false; return lowMemoryAsk(res.error, () => realStart()); }
        throw new Error(res.error || r.statusText);
      }
    } catch (e) { go.disabled = false; if (run) toast('Ошибка: ' + e.message); else status.textContent = 'Ошибка: ' + e.message; return; }
    go.disabled = false;
    if (run) {  // the previous job keeps going in the queue; this panel now follows the new one
      clearInterval(run.tick); offPrompt(run.id);
      const old = QUEUE.find(j => j.id === run.id); if (old) old.detached = true;
      run = null;
    }
    qAdd(res.prompt_id, meta.mode, meta.prompt);
    resetFrame();
    run = { real: true, id: res.prompt_id, t0: performance.now(), lastEv: performance.now(), stage: 'queued' };
    const tgt = opts.target();
    if (tgt) { liveImg.src = tgt.src; liveImg.classList.add('dim'); liveImg.hidden = false; }
    go.hidden = false; setGo(true); stopB.hidden = false; hud.hidden = false; wait.hidden = false; $('.res', frame).hidden = true;
    $('.hud-t', el).textContent = 'Предпросмотр';
    showStage();
    run.tick = setInterval(showStage, 1000);
    previewHandlers.set(el, blob => {
      if (run) run.lastEv = performance.now();
      if (!run || run.stage === 'queued' || run.anim) return;   // the animated preview (KJNodes) wins over the single frame
      URL.revokeObjectURL(liveImg.dataset.url || '');
      liveImg.dataset.url = liveImg.src = URL.createObjectURL(blob);
      liveImg.classList.remove('dim'); liveImg.hidden = false; wait.hidden = true;
    });
    onPrompt(run.id, ev => {
      if (!run || run.id !== ev.prompt_id) return;
      run.lastEv = performance.now();
      if (ev.type === 'preview_anim') {
        run.anim = true; wait.hidden = true; liveImg.classList.remove('dim');
        if (ev.mime.startsWith('video/')) { liveVid.src = `data:${ev.mime};base64,${ev.image}`; liveVid.hidden = false; liveImg.hidden = true; liveVid.play().catch(() => {}); }
        else { liveImg.src = `data:${ev.mime};base64,${ev.image}`; liveImg.hidden = false; liveVid.hidden = true; }
        return;
      }
      if (ev.type === 'stage') {
        const sampling = ev.stage.startsWith('sample');
        if (sampling && run.stage !== ev.stage) { run.sampleT0 = performance.now(); run.step1T = null; }
        run.stage = ev.stage; run.step = ev.step; run.max = ev.max;
        if (ev.scene) { if (run.scene !== ev.scene) { run.sampleT0 = performance.now(); run.step1T = null; } run.scene = ev.scene; run.nscenes = ev.scenes; }
        if (sampling && ev.step) run.stepT = performance.now();
        if (sampling && ev.step === 1) run.step1T = run.stepT;   // the first step includes loading, it is not typical
        showStage();
      } else if (ev.type === 'done') realFinish('done', ev.item);
      else if (ev.type === 'error') realFinish('error', ev.message);
      else if (ev.type === 'interrupted') realFinish('stopped');
    });
  }
  function showStage() {
    if (!run) return;
    const [txt, base, short] = STAGE[run.stage];
    const two = opts.twoPass, sampling = run.stage.startsWith('sample') && run.max;
    let p = base, line = txt, hudTxt = short;
    if (sampling) {
      const frac = (run.step || 0) / run.max;
      p = run.stage === 'sample2' ? 0.70 + 0.20 * frac : 0.15 + (two ? 0.50 : 0.75) * frac;
      const pass = two ? `проход ${run.stage === 'sample2' ? 2 : 1}/2 · ` : '';
      line = `${two && run.stage === 'sample' ? 'Проход 1 · генерация кадров' : txt} · шаг ${run.step || 0} из ${run.max}`;
      hudTxt = `${pass}шаг ${run.step || 0}/${run.max}`;
      if (run.scene) { line = `Сцена ${run.scene} из ${run.nscenes} · ` + line; hudTxt = `сцена ${run.scene}/${run.nscenes} · ${hudTxt}`;
        p = 0.15 + 0.75 * ((run.scene - 1 + frac) / run.nscenes); }
      if (run.step >= 2 && run.step1T) {
        const per = (run.stepT - run.step1T) / (run.step - 1);
        const left = (run.max - run.step) + (run.scene ? (run.nscenes - run.scene) * run.max : 0), extra = run.scene ? 10 * (run.nscenes - run.scene + 1) : 10;
        if (run.scene) {
          line += ` · эта сцена ещё ~${fmtTime((run.max - run.step) * per / 1000 + 10)}`;
          if (run.nscenes > run.scene) line += ` · весь ролик ~${fmtTime(left * per / 1000 + extra)}`;
        } else line += ` · ${two ? 'до конца прохода' : 'осталось'} ~${fmtTime(left * per / 1000 + extra)}`;
      } else if (run.step >= 1) line += ' · время считаем, нужен ещё шаг';
    }
    bar.style.width = (p * 100) + '%';
    const badges = [], single = opts.singleScene && opts.singleScene();   // one scene only: do not count the whole video
    if (run.scene) badges.push({ t: single ? `Сцена ${run.scene}` : `Сцена ${run.scene} из ${run.nscenes}` });
    if (sampling) {
      badges.push({ t: `Шаг ${run.step || 0} из ${run.max}` });
      if (run.step >= 2 && run.step1T) {
        const per = (run.stepT - run.step1T) / (run.step - 1) / 1000, thisLeft = (run.max - run.step) * per + 10;
        badges.push({ t: `Осталось ~${fmtTime(thisLeft)}`, eta: true });
        if (!single && run.scene && run.nscenes > run.scene) badges.push({ t: `Весь ролик ~${fmtTime(thisLeft + (run.nscenes - run.scene) * (run.max * per + 10))}`, eta: true });
      } else badges.push({ t: 'Считаем время…', eta: true });
    }
    badges.push({ t: `Прошло ${fmtTime((performance.now() - run.t0) / 1000)}` });
    health(p, sampling ? (two && run.stage === 'sample' ? 'Проход 1 · генерация кадров' : txt) : txt.replace(/…$/, ''), badges);
    $('.hud-s', el).textContent = hudTxt;
    wait.textContent = liveImg.hidden || liveImg.classList.contains('dim') ? txt : '';
    status.textContent = run.stopping ? 'Останавливаем…' : '';   // the big box above shows the same, no second small line
  }
  function realFinish(kind, data) {
    clearInterval(run.tick); offPrompt(run.id); previewHandlers.delete(el);
    go.hidden = false; setGo(false); stopB.hidden = true; bar.style.width = 0; pbox.hidden = true;
    const took = fmtTime((performance.now() - run.t0) / 1000);
    run = null;
    if (kind === 'done') {
      liveVid.pause(); liveVid.removeAttribute('src'); liveVid.load();   // скрытое зацикленное видео иначе продолжает декодироваться
        [liveImg, liveVid, wait].forEach(x => x.hidden = true);
      result.src = data.url; result.dataset.dragid = data.id; result.draggable = true; result.hidden = false; result.muted = true; result.play().catch(() => {}); rmBtn.hidden = false;
      el._done = data;   // in the rare case the library has not caught up, the viewer still has the item
      frame.classList.add('done'); $('.hud-t', el).textContent = 'Готово'; $('.hud-s', el).textContent = took;
      status.innerHTML = `Готово за ${took} — видео в библиотеке. Seed: <b style="font-family:var(--mono)">${esc(String(data.seed ?? '—'))}</b> `
        + (data.seed != null ? '<button class="btn" id="keepSeed" type="button" style="padding:4px 10px;font-size:12px">Зафиксировать</button>' : '');
      $('#keepSeed', el)?.addEventListener('click', () => useSeed(st, data.seed));
      status.insertAdjacentHTML('beforeend', ' <button class="btn pri" id="upBtn" type="button" style="padding:4px 12px;font-size:12px" title="Увеличить разрешение и добавить чёткости (SeedVR2)">Увеличить видео</button>');
      $('#upBtn', el)?.addEventListener('click', () => openUpscale(byId(data.id) || normItem(data)));
      // beginner flow: try another variant, or redo this very one (same seed) in a better size
      status.insertAdjacentHTML('beforeend', ' <button class="btn" id="otherBtn" type="button" style="padding:4px 12px;font-size:12px" title="Новый вариант с другим seed, настройки те же">Другой вариант</button>');
      $('#otherBtn', el).addEventListener('click', () => { st.seedFixed = false; st._upd?.(); go.onclick(); });
      const curQ = QUALITY_ALL.find(x => x.id === st.q), goodQ = QUALITY_ALL.find(x => x.id === '720p');
      if (data.seed != null && curQ && !(st.cw && st.ch) && curQ.px < goodQ.px) {
        status.insertAdjacentHTML('beforeend', ' <button class="btn" id="goodBtn" type="button" style="padding:4px 12px;font-size:12px" title="Тот же вариант (seed сохранится), размер 1280×736. Результат будет похож, но не пиксель в пиксель">В хорошем качестве</button>');
        $('#goodBtn', el).addEventListener('click', () => { st.seedFixed = true; st.seed = String(data.seed); st.q = '720p'; st._upd?.(); go.onclick(); });
      }
    } else {
      resetFrame();
      status.textContent = kind === 'error' ? 'Ошибка ComfyUI: ' + data : 'Генерация остановлена. Поправьте промпт или настройки и запустите снова';
    }
  }

  go.onclick = () => {
    const err = opts.validate(); if (err) { status.textContent = err; return; }
    if (API) {
      if (!opts.real) { status.textContent = 'Этот режим ещё не подключён к ComfyUI — пока работает «Видео»'; return; }
      return realStart();
    }
    const [w, h] = resFor(st.aspect, st.q);
    live.width = 480; live.height = Math.round(480 * h / w);
    const passes = opts.passes();
    run = { passes, total: passes.reduce((a, b) => a + b, 0), step: 0, last: performance.now(), t0: performance.now(), src: opts.target() || makeScene() };
    go.hidden = true; stopB.hidden = false; live.hidden = false; hud.hidden = false; $('.res', frame).hidden = true;
    frame.classList.remove('done'); $('.hud-t', el).textContent = 'Предпросмотр';
    run.timer = setInterval(() => { run.step++; run.last = performance.now(); if (run.step >= run.total) finish(true); }, STEP_MS);
    const draw = now => {
      if (!run) return;
      const p = Math.min(1, (run.step + Math.min(1, (now - run.last) / STEP_MS)) / run.total);
      renderLive(live.getContext('2d'), live.width, live.height, run.src, p, now);
      bar.style.width = (p * 100) + '%';
      let s = run.step, pass = 0; while (pass < run.passes.length - 1 && s >= run.passes[pass]) s -= run.passes[pass++];
      const passTxt = run.passes.length > 1 ? `проход ${pass + 1}/${run.passes.length} · ` : '';
      $('.hud-s', el).textContent = `${passTxt}шаг ${Math.min(s + 1, run.passes[pass])}/${run.passes[pass]}`;
      const el2 = (now - run.t0) / 1000;
      status.textContent = `Генерация · ${Math.round(p * 100)}%` + (p > 0.05 ? ` · осталось ~${fmtTime(el2 / p * (1 - p))}` : '');
      run.raf = requestAnimationFrame(draw);
    };
    run.raf = requestAnimationFrame(draw);
  };
  stopB.onclick = () => {
    if (!run?.real) return finish(false);
    status.textContent = 'Останавливаем…'; run.stopping = performance.now(); showStage();
    fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: run.id }) });
  };

  function finish(ok) {
    clearInterval(run.timer); cancelAnimationFrame(run.raf);
    go.hidden = false; stopB.hidden = true; bar.style.width = 0;
    if (ok) {
      renderLive(live.getContext('2d'), live.width, live.height, run.src, 1, performance.now());
      frame.classList.add('done'); $('.hud-t', el).textContent = 'Готово'; $('.hud-s', el).textContent = '';
      const [w, h] = resFor(st.aspect, st.q);
      opts.onDone({ ...opts.meta(), res: `${w}×${h}`, aspect: st.aspect, q: st.q, len: st.len(), thumb: live.toDataURL('image/jpeg', .85) });
      status.textContent = 'Готово — видео сохранено в библиотеку';
    } else {
      live.hidden = true; hud.hidden = true; $('.res', frame).hidden = false;
      status.textContent = 'Генерация остановлена. Поправьте промпт или настройки и запустите снова';
    }
    run = null;
  }

  return () => {
    if (!run && $('.res', frame).hidden) resetFrame();
    const effQ = st.effQ ? st.effQ() : st.q, [w, h] = resFor(st.aspect, effQ);
    if (!run) go.lastChild.textContent = goText();
    frame.style.aspectRatio = `${w}/${h}`;
    frame.style.width = w >= h ? '100%' : `${Math.round(100 * w / h * 0.95)}%`;
    $('.res', frame).innerHTML = `<b>${w} × ${h}</b>${st.aspect} · ${effQ !== st.q ? 'черновик' : st.q}`;
    $('.s-res', el).textContent = `${w}×${h}`;
    const L = st.len();
    $('.s-len', el).textContent = L ? `${L.toFixed(1).replace('.0', '')} с` : '—';
    $('.s-fr', el).textContent = L ? frames(L) : '—';
    $('.s-ex', el).textContent = opts.extra();
  };
}
