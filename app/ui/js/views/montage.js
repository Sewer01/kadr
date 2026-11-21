import { postJSON } from '../core/net.js';
import { $, $$, confirmBox, esc, fmtDate, normItem, paintRange, toast } from '../core/util.js';
import { MODE_NAME } from '../core/modes.js';
import { IMG_PANELS, LIB, byId, selected } from '../core/state.js';
import { offPrompt, onPrompt } from '../ui/scenario.js';
import { openUpscale, renderLib, saveItems } from './library.js';
import { frameOut, soundOut } from './modes.js';
import { qAdd } from './queue.js';

/* ---------- MONTAGE: join library clips in a chosen order (ComfyUI does the work, no ffmpeg) ---------- */
(function mountMontage() {
  // по-русски про число клипов: «1 клип», «2 клипа», «12 клипов»
  const clipsW = N => `${N}` + (N % 10 === 1 && N % 100 !== 11 ? ' клип' : (N % 10 >= 2 && N % 10 <= 4 && (N % 100 < 10 || N % 100 >= 20)) ? ' клипа' : ' клипов');
  const root = $('#view-montage'), MT = { ids: [], cuts: [], ins: [], drag: null, busy: false, up: {}, n: 0, px: 26, hpx: 96, res: false };
  try { MT.px = +localStorage.getItem('h3-mt-px') || 26; } catch {}
  try { MT.hpx = +localStorage.getItem('h3-mt-h') || 96; } catch {}
  root.style.setProperty('--mt-h', MT.hpx + 'px');   // one height for every block, whatever its length
  // a block is as wide as its length; the floor is one second (below that the buttons step aside)
  const wOf = d => Math.max(Math.round(MT.px), Math.round(d * MT.px));   // block width: the clip length at the chosen scale (short clips keep room for buttons)
   // cuts[i]: seconds the clip is trimmed to (null: whole clip)
  const get = id => id.startsWith('up:') ? MT.up[id.slice(3)] : byId(id);   // a clip of the Library or a file from the computer
  root.innerHTML = `
    <div class="head"><div><h1>Монтаж</h1><p>Обрежьте клип и сохраните его, либо склейте несколько в один ролик: добавьте по порядку, поменяйте местами, метками отрежьте нужное и нажмите «Сохранить»</p></div></div>
    <div class="grid"><div class="col">
      <div class="card"><div class="card-h"><h3><span class="n">1</span>Клипы из Библиотеки</h3><span class="hint">нажмите на клип, чтобы добавить</span><button type="button" class="btn mini mt-pc" title="Добавить видео со своего компьютера">+ С компьютера</button><input type="file" class="mt-file" accept="video/*" multiple hidden></div><div class="mt-lib"></div><div class="hint mt-hid" style="margin-top:8px"></div></div>
      <div class="card"><div class="card-h"><h3><span class="n">2</span>Порядок клипов</h3><span class="counter mt-total"></span><span class="mt-zoom"><button type="button" class="btn mini" data-z="-1" title="Мельче">−</button><button type="button" class="btn mini" data-z="0" title="Уместить всю ленту по ширине">По ширине</button><button type="button" class="btn mini" data-z="1" title="Крупнее">+</button></span>
        </div>
        <div class="mt-strip"></div>
        <div class="mt-vh" title="Потяните вверх или вниз: все блоки станут выше или ниже. Двойной щелчок: как было"><i></i></div>
        <div class="mt-scale"><span>1 секунда</span><input type="range" class="mt-px" min="8" max="90" step="1" title="Крупнее масштаб - точнее резать по времени"><span class="mt-px-x">26 px</span><span class="hint">этот ползунок и кнопки «−» «+» меняют только ширину ленты</span>
              <span class="mt-mk" title="где стоит метка реза: секунды внутри клипа и номер кадра">маркер —</span>
      <span class="mt-acts"><button type="button" class="btn mini mt-shot" title="Сохранить кадр на метке в Библиотеку">📷 Сделать кадр</button>
      <button type="button" class="btn mini mt-snd" title="Сохранить звук этого клипа в Библиотеку">🎧 Сделать звук</button>
       <button type="button" class="btn mini mt-fade" title="Режим затухания: ножницы в ленте становятся лесенками. Поставьте метку в клипе и нажмите лесенку - звук начнёт стихать от метки в эту сторону">Затухание аудио</button></span>
<button type="button" class="btn mini mt-clear" title="Убрать из ленты все клипы (сами видео останутся в Библиотеке)">Очистить ленту</button></div>
        <div class="mt-trim" hidden></div>
        <div class="hint mt-hint" style="margin-top:8px">Нажмите на клип в ленте - он сразу заиграет справа с этого места. Ширина блока равна длине клипа. Порядок меняется перетаскиванием или стрелками ◀ ▶ (они именно переставляют, а не играют), крестик убирает клип из монтажа. Край блока тянется внутрь: левый отрезает начало, правый - конец; на клипе появится отметка вида 2.5–8 с. Двойной щелчок по клипу возвращает его целиком. Кнопка «Затухание аудио» меняет ножницы у метки на две лесенки: метка ставится туда, где звук начинает стихать, <b>левая лесенка гасит звук к началу клипа, правая - к его концу</b>. Стороны включаются <b>независимо</b>: можно держать обе сразу - тогда на блоке появятся и ↙, и ↘. Включённая лесенка горит, повторное нажатие выключает только её, вторая остаётся работать. Спуск уходит и в собранный звук («Сделать звук»), и в сохранённый ролик; клипы, из которых он собран, не меняются. Метка реза (треугольник сверху) стоит там, куда её поставили, и не убегает во время показа; голубая линия - это бегунок воспроизведения. Клик по клипу слева от метки играет от начала оставленного куска до метки, клик справа - от метки до конца куска. Ножницы: левая убирает всё до метки, правая - всё после неё. Потяните правый край блока, чтобы сделать клип короче (или вернуть длину). Клипы разного размера приводятся к размеру первого.</div></div>
    </div><div class="preview">
      <div class="screen"><div class="frame" style="aspect-ratio:16/9;width:100%"><div class="res mt-empty"><b>Монтаж пуст</b>добавьте клип из Библиотеки (или несколько, если хотите склеить) - они появятся в ленте, и здесь сразу покажется кадр, на который указывает метка реза. Кнопка «▶» играет всю ленту по порядку, после склейки тут же встанет готовый ролик.</div><video class="result mt-pv" playsinline hidden></video><video class="result mt-res" controls loop playsinline hidden></video></div></div>
      <div class="mt-bar" hidden><button type="button" class="btn mt-restart" title="Смотреть с начала ленты">⏮</button><button type="button" class="btn mt-play" title="Играть / пауза (пробел)">▶</button><input type="range" class="mt-seek" min="0" max="0" value="0" title="Перемотка"><span class="mt-time">0:00 / 0:00</span></div>
      <div class="mt-tabs" hidden><button type="button" class="btn mini on" data-pv="seq">Предпросмотр</button><button type="button" class="btn mini" data-pv="res">Готовый ролик</button><button type="button" class="btn mini mt-del" hidden title="Убрать готовый ролик из Библиотеки: файл переместится в корзину Windows">Удалить ролик</button></div>
      <button class="go mt-go"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>Сохранить</button>
      <div class="mt-upbox"><select class="mt-upeng" title="Чем увеличивать каждый клип перед сохранением"><option value="relay">Увеличение: быстро - RelayVSR, в 2 раза</option><option value="seed">Увеличение: качественно - SeedVR2, в 2 раза (долго)</option></select><button type="button" class="btn mt-upgo" title="Каждый клип увеличивается отдельно (быстро, память не переполняется), потом увеличенные склеиваются. Исходные клипы остаются.">Увеличить каждый клип и сохранить</button></div>
      <div class="mt-sets">
        <label class="mt-s-detail"><span><b>Детали: <i class="mt-dv">70</i>%</b> меньше — мягче, без пересвета лиц; больше — чётче</span><input type="range" class="mt-detail" min="0" max="100" step="5" value="70"></label>
        <label class="mt-s-sharp" hidden><span><b>Чёткость: <i class="mt-sv">100</i>%</b> меньше — мягче; 100 — как есть</span><input type="range" class="mt-sharp" min="0" max="100" step="5" value="100"></label>
        <label><span><b>Зерно плёнки: <i class="mt-gv">0</i>%</b> 0 — выключено. Накладывается на каждый клип отдельно, потом всё сохраняется одним роликом</span><input type="range" class="mt-grain" min="0" max="100" step="5" value="0"></label>
      </div>
      <div class="mt-pipe" hidden></div>
      <div class="status mt-status"></div>
    </div></div>`;
  /* The picture is the signal itself: the baseline is at the bottom, a taller step is a louder step.
     So the stairs must go DOWN toward the side where the sound is dying: the left button fades toward
     the beginning of the clip, the right one toward its end. These are the same two drawings the audio
     editor uses - one language everywhere. */
  const FD_L = '<svg viewBox="0 0 20 14" style="width:18px;height:13px;vertical-align:-2px"><path d="M1 13V11h4V8h4V5h4V2h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  const FD_R = '<svg viewBox="0 0 20 14" style="width:18px;height:13px;vertical-align:-2px"><path d="M19 13V11h-4V8h-4V5h-4V2H1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  const FD = FD_R;
  /* A clip can die at both ends at once: the left stair and the right stair are two independent
     switches, each remembering the marker of the moment it was turned on. Pressing one must never
     put the other out - that is what the two arrows on the block are for. Old saved states carried
     one side, and they still work: the reader moves that single side into the new shape. */
  const fadeOf = i => {
    const f = (MT.fades || [])[i] || {};
    if (f.dir) { const o = { l: null, r: null }; o[f.dir] = (f.at == null ? null : f.at); return o; }
    return { l: (f.l == null ? null : f.l), r: (f.r == null ? null : f.r) };
  };
  const fadeHas = i => { const f = fadeOf(i); return !!(f.l != null || f.r != null); };
  MT.fadeMode = false; MT.fades = MT.fades || [];
  { const fb = $('.mt-fade', root); if (fb) fb.innerHTML = FD + ' Затухание аудио'; }   // once: the caption never changes later
  const hidden = () => { try { return JSON.parse(localStorage.getItem('h3-mt-hide') || '[]'); } catch { return []; } };
  const hideSet = a => { try { localStorage.setItem('h3-mt-hide', JSON.stringify(a)); } catch {} };
  const fullOf = i => get(MT.ids[i]).len || 5;
  // what is kept of a clip: from inOf(i) to endOf(i) seconds of the original; cuts[i] went on
  // meaning "where it ends", so the old saved states keep working
  const endOf = i => MT.cuts[i] != null ? Math.min(MT.cuts[i], fullOf(i)) : fullOf(i);
  const inOf = i => Math.min(Math.max(0, MT.ins[i] || 0), Math.max(0, endOf(i) - 0.3));
  const durOf = i => Math.max(0.3, endOf(i) - inOf(i));
  const trimTxt = i => (inOf(i) > 0.05
    ? inOf(i).toFixed(1).replace('.0', '') + '\u2009–\u2009' + endOf(i).toFixed(1).replace('.0', '')   // a piece cut from the middle: show its edges
    : durOf(i).toFixed(1).replace('.0', ''))                                                          // whole, or cut only at the end
    + ' с' + (MT.cuts[i] != null || inOf(i) > 0.05 ? ' ✂' : '')
    + (() => { const f = fadeOf(i), p = []; if (f.l != null) p.push('↙' + (+f.l).toFixed(1).replace('.0', '')); if (f.r != null) p.push('↘' + (+f.r).toFixed(1).replace('.0', '')); return p.length ? ' ' + p.join(' ') : ''; })();   // both ends, if both are on
  const lenTxt = it => it.len ? it.len.toFixed(1).replace('.0', '') + ' с' : '';
  function render() {
    const keep = MT.ids.map(id => !!get(id) && !get(id).missing); MT.cuts = MT.cuts.filter((_, i) => keep[i]); MT.ins = MT.ins.filter((_, i) => keep[i]); MT.fades = (MT.fades || []).filter((_, i) => keep[i]); MT.ids = MT.ids.filter((_, i) => keep[i]);
    const hid = hidden(), all = LIB.filter(it => it.kind !== 'image' && !it.missing && it.url), vids = all.filter(it => !hid.includes(it.id)), nh = all.length - vids.length;
    $('.mt-hid', root).innerHTML = nh ? `Убрано из списка: ${nh} · <button type="button" class="a-change" data-showall>Вернуть все</button>` : '';
    $('.mt-lib', root).innerHTML = vids.length ? vids.map(it => `<button type="button" class="mt-card" data-id="${it.id}" title="${esc(it.prompt || '')}"><video src="${it.url}#t=0.5" preload="metadata" muted playsinline></video><span class="mt-plus">+</span><span class="mt-x" data-hide="${it.id}" role="button" title="Убрать из этого списка (в Библиотеке клип останется)">✕</span><span class="mt-len">${lenTxt(it)}</span><small>${esc(it.prompt || MODE_NAME[it.mode] || '')}</small></button>`).join('')
      : '<div class="hint">В Библиотеке пока нет видео. Сначала сгенерируйте клипы.</div>';
    $('.mt-strip', root).innerHTML = MT.ids.length ? MT.ids.map((id, i) => { const it = get(id), d = durOf(i); return `<div class="mt-item${wOf(d) < 92 ? ' narrow' : ''}" draggable="true" data-i="${i}" style="width:${wOf(d)}px" data-w="${wOf(d)}"><canvas class="mt-cv" aria-hidden="true"></canvas><span class="mt-n">${i + 1}</span>${window.mtPipeDone && window.mtPipeDone(id) ? '<span class="mt-ok" title="Клип обработан">✓</span>' : ''}<span class="mt-len">${trimTxt(i)}</span><div class="mt-b"><button type="button" data-mv="-1" ${i === 0 ? "disabled" : ""} title="Порядок склейки: переставить левее">◀</button><button type="button" data-rm title="Убрать из монтажа (в Библиотеке клип останется)">✕</button><button type="button" data-mv="1" ${i === MT.ids.length - 1 ? "disabled" : ""} title="Порядок склейки: переставить правее">▶</button></div><i class="mt-rhl" title="Потяните, чтобы отрезать начало клипа"></i><i class="mt-rh" title="Потяните, чтобы отрезать конец клипа (длиннее оригинала нельзя). Двойной щелчок по клипу - вернуть целое"></i></div>`; }).join('')
      : '<div class="hint">Пока пусто: нажмите на клипы сверху.</div>';

    const total = MT.ids.reduce((a, id, i) => a + durOf(i), 0);
    $('.mt-total', root).textContent = MT.ids.length ? `${clipsW(MT.ids.length)} · ≈ ${Math.round(total)} с` : '';
    if (MT.ids.length) $('.mt-strip', root).insertAdjacentHTML('beforeend',
      `<i class="mt-fr" data-fr="-1" title="На один кадр левее (${frameStep().toFixed(3)} с)">◀</i>`
      + '<i class="mt-ph" title="Потяните за этот треугольник: метка встанет туда, где нужен рез. Слева показывается кадр, на который она указывает"></i><i class="mt-line"></i>'
      + `<i class="mt-fr" data-fr="1" title="На один кадр правее (${frameStep().toFixed(3)} с)">▶</i>`
      + '<i class="mt-run"></i>'
      + '<i class="mt-cut" data-cut="in">' + (MT.fadeMode ? FD_L : '✂') + '</i>'
      + '<i class="mt-cut out" data-cut="out">' + (MT.fadeMode ? FD_R : '✂') + '</i>');
    if (MT.fadeMode) $$('.mt-cut', root).forEach(b => {
      b.classList.add('fd');
      const side = b.dataset.cut === 'in' ? 'l' : 'r', on2 = fadeOf(mkAt().i)[side] != null;
      b.title = (side === 'l' ? 'Спуск к НАЧАЛУ клипа' : 'Спуск к КОНЦУ клипа') + ' - ' + (on2 ? 'включён, нажми ещё раз, чтобы выключить только его' : 'выключен') +
        '. Метка - где спуск начинается. Левый и правый переключаютя независимо, можно держать оба.';
      // the stair of a side that is on stays lit - that is what tells an armed switch from a plain
      // scissors - and goes out when the same stair is pressed again
      b.classList.toggle('on', fadeOf(mkAt().i)[b.dataset.cut === 'in' ? 'l' : 'r'] != null);
    });
    syncPlayer(); paintTrim();
    queueThumbs();                      // the frames arrive one by one, the interface stays responsive
    if (window.mtSaveState) { window.mtSaveState(); window.mtPipePaint(); }
  }

  /* preview player: the clips in the chosen order play one after another; the slider, a click on a clip and the playhead seek in the whole montage */
  const P = { g: 0, i: 0, playing: false, raf: 0, drag: false, picked: false, mode: 'seq', loading: false, tok: 0, lim: null, mkI: 0, mkFrac: {}, miss: null, was: 0, stall: 0, rescue: 0, swapAt: 0, rev: 0 };
  // The marker always stands on the clip that is in focus (P.i) and remembers its own place for each
  // clip by its name: switching clips cannot leave an invisible marker somewhere and use it later.
  const mkAt = () => {
    if (P.mkI >= MT.ids.length) P.mkI = 0;
    const id = MT.ids[P.mkI]; if (!id) return { i: 0, off: 0 };
    let f = P.mkFrac[id];
    if (typeof f !== 'number') f = 0;                          // a clip nobody marked: the marker stands at its BEGINNING -
                                                           // the middle only made it jump under the hand
    P.mkFrac[id] = Math.min(1, Math.max(0, f));               // a share, so it stays in place as lengths arrive
    return { i: P.mkI, off: Math.max(0, Math.min(durOf(P.mkI) - 0.05, P.mkFrac[id] * durOf(P.mkI))) };
  };
  // one frame of this clip: the frame rate comes with the generated video, otherwise 24 as the
  // generator makes them
  const frameStep = () => { const it = get(MT.ids[mkAt().i]); const f = (it && (it.fps || (it.meta && it.meta.fps))) || 24; return 1 / Math.max(1, f); };
  // the strip used to show one stretched picture per clip, so the cut point was a guess: now each block
  // carries a real filmstrip of its kept piece, the same way the video bench does
  const cvQ = []; let cvBusy = false;
  const queueThumbs = () => {
    cvQ.length = 0;
    $$('.mt-item', $('.mt-strip', root)).forEach(el => cvQ.push(el));
    if (!cvBusy) runThumbs();
  };
  async function runThumbs() {
    cvBusy = true;
    while (cvQ.length) {
      const el = cvQ.shift();
      const i = +el.dataset.i, it = get(MT.ids[i]);
      if (it && el.isConnected) { try { await fillThumb(el, it, i); } catch (e) { } }
    }
    cvBusy = false;
  }
  async function fillThumb(el, it, i) {
    const cv = $('.mt-cv', el); if (!cv) return;
    const d = durOf(i), W = Math.max(40, Math.round(wOf(d)));
    const n = Math.max(2, Math.min(10, Math.round(W / 62)));
    const base = inOf(i) || 0;
    const key = [it.id, n, W, base.toFixed(2), d.toFixed(2)].join('|');
    if (cv._key === key) return;
    cv._key = key;
    cv.width = W; cv.height = Math.max(40, MT.hpx || el.clientHeight || 96);   // the height of the ruler, not of the content
    const g = cv.getContext('2d'), fw = cv.width / n;
    g.fillStyle = '#14161b'; g.fillRect(0, 0, cv.width, cv.height);
    if (d <= 0.05) { cv._key = ''; return; }
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = it.url;
    const ready = await new Promise(res => {
      let done = false;
      const fin = ok => { if (done) return; done = true; clearTimeout(to); res(ok); };
      const to = setTimeout(() => fin(false), 7000);
      v.onloadedmetadata = () => fin(true); v.onerror = () => fin(false);
    });
    if (!ready || !v.videoWidth) { cv._key = ''; try { v.removeAttribute('src'); v.load(); } catch (e) { } return; }
    for (let k = 0; k < n; k++) {
      const tm = base + Math.min(Math.max(0.02, (v.duration || d) - 0.05), (k + 0.5) / n * d);
      await new Promise(res => {
        let done = false;
        const fin = () => { if (done) return; done = true; clearTimeout(to); v.onseeked = null; res(); };
        const to = setTimeout(fin, 800);
        v.onseeked = fin;
        try { v.currentTime = tm; } catch (e) { fin(); }
      });
      try { g.drawImage(v, k * fw, 0, fw + 0.8, cv.height); } catch (e) { }
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(k * fw, cv.height - 12, fw, 12);
      g.fillStyle = '#fff'; g.font = '9px sans-serif';
      g.fillText(((k + 0.5) / n * d).toFixed(1), k * fw + 2, cv.height - 3);
    }
    try { v.removeAttribute('src'); v.load(); } catch (e) { }
  }

  function nudge(dir) {                 // step the marker by one frame and show that frame in the window
    const mk = mkAt(), i = mk.i, d = durOf(i); if (!MT.ids.length || d <= 0.05) return;
    const f = Math.min(1, Math.max(0, (mk.off + dir * frameStep()) / d));
    P.mkFrac[MT.ids[i]] = f; P.picked = true; P.mkI = i; P.i = i;
    const off = f * d; P.g = startOf(i) + off; loadAt(i, off, false); updateUI(); paintTrim();
  }
  const xOf = (i, off) => {
    const strip = $('.mt-strip', root), el = $$('.mt-item', strip)[i]; if (!el) return 0;
    return el.offsetLeft + Math.min(1, Math.max(0, off / (durOf(i) || 1))) * el.offsetWidth;
  };
  const pv = $('.mt-pv', root), bar = $('.mt-bar', root), seek = $('.mt-seek', root), playBtn = $('.mt-play', root), timeEl = $('.mt-time', root);
  const blank = () => { pv.removeAttribute('src'); delete pv.dataset.id; try { pv.load(); } catch { } };   // without load() the old frame stays on screen
  const mmss = s => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const totalLen = () => MT.ids.reduce((a, _, i) => a + durOf(i), 0);
  const startOf = i => { let a = 0; for (let j = 0; j < i; j++) a += durOf(j); return a; };
  function locate(g) { let a = 0; const n = MT.ids.length; for (let i = 0; i < n; i++) { const d = durOf(i); if (g < a + d - 1e-6 || i === n - 1) return { i, off: Math.min(d, Math.max(0, g - a)) }; a += d; } return { i: 0, off: 0 }; }
  /* Starting a clip is not a one-shot affair: right after the source changes at a seam the element
     often has no first frame yet, play() rejects once for no visible reason, and the old silent
     catch left the ribbon frozen - the button showed «pause», nothing moved, and pressing it only
     paused something that had already stopped. So the start is tried several times. */
  function playNow(left) {
    if (!P.playing) return;
    const tries = left == null ? 3 : left;
    try {
      const pr = pv.play();
      if (pr && pr.catch) pr.catch(() => { if (P.playing && tries > 1) setTimeout(() => playNow(tries - 1), 160); });
    } catch (e) { }
  }
  function loadAt(i, off, play) {
    const id = MT.ids[i], it = get(id);
    if (!it) {           // a clip that left the Library: never keep somebody else's video on screen
      blank(); setPlaying(false);
      if (P.miss !== id) { P.miss = id; toast('Этого клипа больше нет в Библиотеке - окно очищено'); }
      return;
    }
    P.miss = null;
    const tok = ++P.tok, go = () => { if (tok !== P.tok) return; P.loading = false; try { pv.currentTime = inOf(i) + off; } catch {} if (play) playNow(); };
    if (pv.dataset.id !== id) {
      P.loading = true; P.swapAt = Date.now(); pv.dataset.id = id; pv.src = it.url;
      pv.addEventListener('loadedmetadata', () => { P.loading = false; go(); }, { once: true });
      pv.addEventListener('error', () => { P.loading = false; }, { once: true });
      setTimeout(() => { if (tok === P.tok) P.loading = false; }, 4000);   // a frame that never announces itself must not freeze the player
      pv.load();
    } else go();
  }
  function seekTo(g, play) {
    if (!MT.ids.length) return;
    g = Math.min(Math.max(0, g), totalLen()); const L = locate(g); P.g = g; P.i = L.i; loadAt(L.i, L.off, play); updateUI();
  }
  function updateUI() {
    const tot = totalLen(); if (!P.drag) { seek.value = Math.round(P.g * 10); paintRange(seek); }   // the fill follows playback, not only the hand
    timeEl.textContent = mmss(P.g) + ' / ' + mmss(tot);
    const strip = $('.mt-strip', root), ph = $('.mt-ph', strip), ln = $('.mt-line', strip), run = $('.mt-run', strip), items = $$('.mt-item', strip); if (!ph || !items.length) return;
    items.forEach((x, k) => x.classList.toggle('cur', k === P.i));
    if (P.i >= items.length) { P.i = Math.max(0, items.length - 1); P.g = Math.min(P.g, totalLen()); }
    const mk = mkAt();
    // the stairs stand at the marker and must tell the truth about the clip the marker is on NOW:
    // a step to the next clip does not redraw the strip, and the colour of the previous clip stayed
    if (MT.fadeMode) {
      const st2 = fadeOf(mk.i);
      $$('.mt-cut', root).forEach(b => b.classList.toggle('on', st2[b.dataset.cut === 'in' ? 'l' : 'r'] != null));
    }
    const mkEl = $('.mt-mk', root);
    if (mkEl) mkEl.textContent = 'маркер ' + (Math.round(mk.off * 100) / 100 + '').replace('.', ',') +
      ' с · кадр ' + Math.round(mk.off / frameStep()) + ' · клип ' + (mk.i + 1);
    const mx = xOf(mk.i, mk.off);   // the line is drawn where it truly is
    if (ln) ln.style.left = mx + 'px';
    // the grip, the arrows and the scissors are a hand's business: at the very beginning of the first
    // block they used to hang over the edge of the ribbon, where nothing can catch them. The line stays
    // exact, the handles slide to stay under the cursor. The bounds are the VISIBLE part of the ribbon:
    // it scrolls, and the handles live in the ribbon's own coordinates
    const L0 = strip.scrollLeft, R0 = strip.scrollLeft + (strip.clientWidth || 1);
    ph.style.left = Math.max(L0 + 12, Math.min(R0 - 12, mx)) + 'px';
    $$('.mt-fr', strip).forEach(b => {
      const want = mx + (+b.dataset.fr === 1 ? 14 : -36);
      b.style.left = Math.max(L0, Math.min(R0 - 22, want)) + 'px';
    });
    // the scissors stand on both sides of the marker: one click and the piece is cut there
    $$('.mt-cut', strip).forEach(b => {
      const out = b.dataset.cut === 'out';
      let want = mx + (out ? 10 : -36);
      // At the very beginning of a block there is no room to the left of the marker. The old answer
      // moved the left button to the right side with the same offset as the right one, so both stood
      // in one place and became a smudge - that is what looked like "the scissors got stuck at the
      // start". Now the second one steps aside instead of landing on top of its brother.
      if (!out && mx - 36 < L0 + 2) want = mx + 44;               // no room left of the marker - stand to its right, past the other one
      if (out && mx + 36 > R0 - 2) want = mx - 44;
      // the ribbon scrolls: clamping to its width left the buttons behind at the far edge while the
      // marker had moved on - they stay inside what a person can actually see
      b.style.left = Math.max(L0, Math.min(R0 - 28, want)) + 'px';
    });
    const gx = xOf(P.i, P.g - startOf(P.i));     // the running playhead: this one may move
    if (run) run.style.left = gx + 'px';
    if (P.playing && (gx < strip.scrollLeft + 20 || gx > strip.scrollLeft + strip.clientWidth - 20)) strip.scrollLeft = Math.max(0, gx - 60);
  }
  async function mtShot() {
    if (!MT.ids.length) { toast('Лента пуста'); return; }
    const mk = mkAt(), it = get(MT.ids[mk.i]);
    setPlaying(false); loadAt(mk.i, mk.off, false);
    await new Promise(res => {                     // the window must truly stand on the marked frame
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(to); pv.onseeked = null; res(); };
      const to = setTimeout(fin, 1600);
      pv.onseeked = fin;
    });
    await new Promise(r => requestAnimationFrame(() => r()));
    if (!pv.videoWidth) { toast('Кадр взять не удалось: окно ещё не показало видео'); return; }
    const c = document.createElement('canvas'); c.width = pv.videoWidth; c.height = pv.videoHeight;
    try { c.getContext('2d').drawImage(pv, 0, 0, c.width, c.height); } catch (e) { toast('Браузер не отдаёт картинку'); return; }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    if (!blob || !blob.size) { toast('Кадр не получился'); return; }
    const stem = String((it && (it.title || it.source)) || 'клип').replace(/\.[a-z0-9]+$/i, '').slice(0, 30);
    const f = new File([blob], stem + ' · клип ' + (mk.i + 1) + ' · кадр ' + Math.round(mk.off / frameStep()) + '.png',
      { type: 'image/png' });
    f.__from = stem + '.mp4'; f.__at = (Math.round(mk.off * 100) / 100 + '').replace('.', ',') + ' с';
    frameOut(f, null, toast);                      // the montage has no picture slots: the library is the place
  }

  async function mtSound() {
    if (!MT.ids.length) { toast('Лента пуста'); return; }
    // the sound of the WHOLE strip as it stands now: every clip, its own cut, in the montage order -
    // that is the work the person made, and a sound of one clip would be something else
    const parts = MT.ids.map((id, i) => {
        const fd = fadeOf(i), p = { id, start: inOf(i) || 0, end: (inOf(i) || 0) + durOf(i) };
        const rel = x => +Math.max(0, Math.min(p.end - p.start, x - p.start)).toFixed(3);
        // a clip may die at both ends, so both are sent; the old single-side words stay for safety
        if (fd.r != null) { p.fade = 'r'; p.fade_at = rel(fd.r); }
        if (fd.l != null) { p.fade_in = rel(fd.l); }
        return p;
      });
    const total = parts.reduce((a, p) => a + (p.end - p.start), 0);
    if (total < 0.3) { toast('В ленте почти ничего не осталось: сначала отрежьте меньше'); return; }
    toast('Собираю звук монтажа из ' + parts.length + ' клип(ов)…');
    let r;
    try {
      r = await fetch('/api/montage/sound', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts })
      });
    } catch (err) { toast('Сервер не отвечает'); return; }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error || ''; } catch (e2) { }
      toast(msg || 'Звук монтажа требует версию 1.5.3 или новее - в вашей этого адреса ещё нет');
      return;
    }
    soundOut(await r.blob(), 'монтаж · ' + parts.length + ' клип(а) · ' + (Math.round(total * 10) / 10) + ' с.mp3',
      'лента монтажа', '0-' + (Math.round(total * 10) / 10) + ' с', toast);
  }

  function setPlaying(on) {
    P.playing = on; playBtn.textContent = on ? '⏸' : '▶'; clearInterval(P.raf);
    P.stall = 0; P.rescue = 0; P.rev = 0; P.was = pv.currentTime;   // a new start begins with a clean watchdog
    if (!on) { try { pv.volume = 1; } catch (e) { } }   // nobody should hear a leftover half-volume clip later
    if (on) { P.raf = setInterval(tick, 40); return; }
    try { pv.pause(); } catch { }
    const rv = $('.mt-res', root); try { if (rv && !rv.paused) rv.pause(); } catch { }   // nothing keeps running behind the preview
  }
  // the button tells the truth about the element, whoever started or stopped it
  pv.addEventListener('play', () => { if (!P.playing) { P.playing = true; playBtn.textContent = '⏸'; clearInterval(P.raf); P.raf = setInterval(tick, 40); } });
  /* A pause is not always the person's doing: swapping the source at a seam pauses the element by
     itself, and treating that as «stopped» used to kill the ribbon exactly between the second clip
     and the third, after which no button could revive it. A pause that comes while the ribbon still
     believes it plays is answered with another start, not with a stop. */
  pv.addEventListener('pause', () => {
    if (!P.playing) return;
    if (P.loading || Date.now() - P.swapAt < 1500) return;   // the ribbon itself is changing clips
    if (pv.ended) { atEnd(pv.currentTime); return; }
    P.rev++;
    if (P.rev > 4) { setPlaying(false); toast('Клип встал и не отвечает: посмотрите его кнопкой ▶ в ленте или замените другим'); return; }
    try { pv.currentTime = Math.max(inOf(P.i), inOf(P.i) + Math.max(0, P.g - startOf(P.i))); } catch (e) { }
    playNow();
  });
  pv.addEventListener('ended', () => { if (P.playing) atEnd(pv.currentTime); });
  const pieceEnd = i => inOf(i) + durOf(i);   // where the kept piece stops, on the clock of the file
  function atEnd(t) {                          // called by the timer and by the video itself
    if (!P.playing || P.i >= MT.ids.length) return;
    if (P.lim) { setPlaying(false); P.lim = null; updateUI(); return; }   // a look at one side stops on its own clip, it does not roll on
    if (P.i < MT.ids.length - 1) { P.i++; P.g = startOf(P.i); P.rev = 0; P.stall = 0; P.rescue = 0; loadAt(P.i, 0, true); }
    else { setPlaying(false); P.g = totalLen(); updateUI(); }
  }
  /* The fade is heard while the strip plays, not only in the file the montage later assembles:
     the same descent, the same side. The marker is where it begins, the end of the kept piece is
     where the sound is gone; toward the beginning the piece starts silent and fills up to the marker. */
  function fadeVolume(i, t) {
    const fd = fadeOf(i);
    if (fd.l == null && fd.r == null) return null;
    const from = inOf(i), len = Math.max(0.05, durOf(i));
    const p = Math.min(1, Math.max(0, (t - from) / len));
    let v = 1;
    if (fd.r != null) {
      const at = Math.min(1, Math.max(0, (fd.r - from) / len));
      v = Math.min(v, Math.max(0, 1 - (p <= at ? 0 : (p - at) / Math.max(0.02, 1 - at))));
    }
    if (fd.l != null) {
      const at = Math.min(1, Math.max(0, (fd.l - from) / len));
      v = Math.min(v, Math.max(0, at <= 0.02 ? 1 : p / at));
    }
    return v;
  }
  function tick() {
    if (!P.playing) return;
    // the descent follows the ribbon's own clock: it moves whether or not the frame decoder is ready,
    // so the person hears the fade exactly where the marker stands
    {
      const from = inOf(P.i), t = from + Math.max(0, P.g - startOf(P.i));
      const want = fadeVolume(P.i, t);
      if (want !== null) { if (Math.abs(pv.volume - want) > 0.008) pv.volume = Math.min(1, Math.max(0, want)); }
      else if (pv.volume !== 1) pv.volume = 1;
    }
    /* The seam guard. The clock of the ribbon cannot be used here: at a transition the element
       starts a new clip from zero, which looks exactly like a freeze. What is unmistakable is the
       element standing on pause while the ribbon still says «playing». */
    if (!pv.paused) { P.stall = 0; P.rescue = 0; }
    else if (P.playing && !P.loading && !pv.seeking) {
      const now = Date.now();
      if (!P.stall) P.stall = now;
      else if (now - P.stall > 900) {
        P.stall = now; P.rescue++;
        const itCur = get(MT.ids[P.i]);
        if (P.rescue === 1) {
          // the same thing a person does by hand: put the clip back at its place and start again
          try { pv.currentTime = inOf(P.i) + Math.max(0, P.g - startOf(P.i)); } catch (e) { }
          P.rev = 0; playNow();
        } else if (P.rescue === 2 && itCur) {
          P.swapAt = Date.now(); pv.src = itCur.url; try { pv.load(); } catch (e) { }
          setTimeout(() => {
            if (!P.playing) return;
            try { pv.currentTime = inOf(P.i) + Math.max(0, P.g - startOf(P.i)); } catch (e) { }
            P.rev = 0; playNow();
          }, 450);
        } else if (P.i < MT.ids.length - 1) {
          toast('Клип ' + (P.i + 1) + ' встал - перешёл к следующему');
          P.rescue = 0; P.rev = 0; atEnd(pieceEnd(P.i));
        } else {
          setPlaying(false); toast('Клип встал и не отвечает: посмотрите его кнопкой ▶ в ленте или замените другим');
        }
      }
    }
    if (P.lim && P.g >= P.lim[1] - 0.03) { setPlaying(false); P.g = P.lim[1]; P.lim = null; updateUI(); return; }   // a preview of one side stops at the marker
    if (pv.readyState >= 2) {
      const d = durOf(P.i), t = pv.currentTime, from = inOf(P.i);   // the video counts from the whole file, we keep a piece of it
      if (pv.dataset.id === MT.ids[P.i] && t > pieceEnd(P.i) + 0.25) { pv.currentTime = from; return; }   // never let it run past the cut
      if (!pv.seeking && (t >= pieceEnd(P.i) - 0.04 || pv.ended)) {
        atEnd(t); return;   // atEnd itself moves to the next clip or stops: moving twice here skipped one
      }
      P.g = startOf(P.i) + Math.max(0, t - from);
      updateUI();
    }
  }
  function togglePlay() {
    if (!MT.ids.length) return;
    P.picked = true;   // pressing play is a choice too: show what is playing
    if (P.mode !== 'seq') { showMode('seq'); }
    if (P.playing) { setPlaying(false); P.lim = null; return; }
    P.lim = null;   // the button plays the whole ribbon, not the last side you looked at
    seekTo(P.g >= totalLen() - 0.05 ? 0 : P.g, true); setPlaying(true);
  }
  function showMode(m) {
    P.mode = m; const n = MT.ids.length, seq = m === 'seq' && n > 0 && P.picked, res = m === 'res' && MT.res;
    if (!seq) setPlaying(false);
    // the transport row stays when there is a ribbon to play, even before anything is chosen
    pv.hidden = !seq; bar.hidden = !(n > 0 && m === 'seq'); $('.mt-res', root).hidden = !res; $('.mt-empty', root).hidden = seq || res;
    const tabs = $('.mt-tabs', root); tabs.hidden = !MT.res; $$('[data-pv]', tabs).forEach(b => b.classList.toggle('on', b.dataset.pv === m)); resTabPaint();
    if (m === 'seq' && !$('.mt-res', root).paused) $('.mt-res', root).pause();
  }
  function syncPlayer() {
    const n = MT.ids.length, tot = totalLen(); seek.max = Math.round(tot * 10); paintRange(seek);
    // an empty ribbon is an empty window: the last joined video is only shown when it is asked for
    if (!n) { P.picked = false; setPlaying(false); blank(); P.g = 0; P.i = 0; P.mode = 'seq'; }
    else {
      setPlaying(false);
      if (!P.picked) { P.picked = true; P.g = startOf(P.i) + mkAt().off; }   // open on the frame the marker points at
      seekTo(Math.min(P.g, tot), false);
    }
    showMode(P.mode); updateUI();
  }
  pv.addEventListener('timeupdate', () => { if (P.playing && pv.currentTime >= pieceEnd(P.i) - 0.04) atEnd(); });
  // The interface can be zoomed (the "Размер интерфейса" setting): a screen pixel is then not a
  // layout pixel, so every point of the mouse has to be turned into the ribbon's own pixels first.
  const ribbonX = clientX => {
    const strip = $('.mt-strip', root), box = strip.getBoundingClientRect();
    const k = strip.offsetWidth ? box.width / strip.offsetWidth : 1;   // how much this ribbon is zoomed
    return (clientX - box.left) / k + strip.scrollLeft;
  };
  const timeAtX = clientX => {              // which second of the montage is under this point of the screen
    const strip = $('.mt-strip', root), items = $$('.mt-item', strip);
    const x = ribbonX(clientX);
    let a = 0;
    for (let i = 0; i < items.length; i++) {
      const w = items[i].offsetWidth || 1;
      if (x <= a + w || i === items.length - 1) return { i, g: startOf(i) + Math.min(1, Math.max(0, (x - a) / w)) * durOf(i) };
      a += w + 8;                            // the gap between the blocks
    }
    return { i: 0, g: 0 };
  };
  root.addEventListener('pointerdown', e => {
    const cut = e.target.closest('.mt-cut');
    if (cut && MT.fadeMode) {                // the same two buttons, another meaning: the marker is where the sound starts dying
      e.preventDefault(); e.stopPropagation();
      if (!MT.ids.length) { toast('Лента пуста'); return; }
      const mk = mkAt(), i = mk.i, dir = cut.dataset.cut === 'in' ? 'l' : 'r';
      MT.fades = MT.fades || [];
      const at = +Math.max(inOf(i), Math.min(endOf(i), inOf(i) + mk.off)).toFixed(2);
      // two independent switches: the left stair and the right one, each remembering where the
      // marker stood when it was turned on; pressing one must never put the other out
      const cur = fadeOf(i);
      cur[dir] = (cur[dir] != null) ? null : at;
      MT.fades[i] = (cur.l == null && cur.r == null) ? null : cur;
      const other = cur[dir === 'r' ? 'l' : 'r'];
      toast((cur[dir] != null
        ? (dir === 'r' ? 'Весь звук клипа стихает от метки до его конца' : 'Весь звук клипа стихает от метки до его начала')
        : (dir === 'r' ? 'Спуск к концу клипа выключен' : 'Спуск к началу клипа выключен'))
        + (other != null ? ' · вторая сторона осталась включена' : ''));
      render();
      // the stair of a side that is on stays lit: it is a switch, not a momentary answer
      $$('.mt-cut', root).forEach(b => b.classList.toggle('on', fadeOf(i)[b.dataset.cut === 'in' ? 'l' : 'r'] != null));
      return;
    }
    if (cut) {                               // one click of the scissors cuts the clip at the marker
      e.preventDefault(); e.stopPropagation();
      const mk = mkAt(), i = mk.i, at = mk.off;      // the cut happens where the marker stands
      const left = cut.dataset.cut === 'in';
      if ((left ? durOf(i) - at : at) < 0.3) { toast('После такой обрезки не останется и трети секунды'); return; }
      P.picked = true;
      const id = MT.ids[i];
      if (left) { MT.ins[i] = +Math.min(999, inOf(i) + at).toFixed(2); P.mkFrac[id] = 0; }   // the cut point became the new beginning
      else { MT.cuts[i] = (inOf(i) + at) >= fullOf(i) - 0.05 ? null : +(inOf(i) + at).toFixed(2); P.mkFrac[id] = 1; }   // and stays at the new end
      setPlaying(false); render();
      return;
    }
    const head = e.target.closest('.mt-ph');
    if (!head) return;                     // a press anywhere else is nobody's business here
    e.preventDefault(); e.stopPropagation();
    const was = P.playing; setPlaying(false);
    // The marker follows the mouse one for one: the distance the pointer travelled is the distance
    // along this block, measured in its own pixels. No trip through the ribbon's seconds, so it can
    // neither run ahead of the pointer nor stick at one side.
    const strip = $('.mt-strip', root);
    const mk = mkAt();
    const ruler = ev => ribbonX(ev.clientX);   // one ruler for the pointer and the blocks, in the ribbon's own pixels
    const pxGrab = ruler(e) - xOf(mk.i, mk.off);   // how far from the marker the pointer took it, in pixels
    head.classList.add('drag');
    try { head.setPointerCapture(e.pointerId); } catch { }
    const mv = ev => {
      const bx = ruler(ev) - pxGrab, items = $$('.mt-item', strip);
      let k = items.length - 1;
      for (let j = 0; j < items.length; j++) { const L = items[j].offsetLeft, W = items[j].offsetWidth || 1; if (bx <= L + W) { k = j; break; } }
      if (k < 0) k = 0;
      const L = items[k].offsetLeft, W = items[k].offsetWidth || 1;
      const f = Math.min(1, Math.max(0, (bx - L) / W));
      P.mkI = k; P.i = k; P.mkFrac[MT.ids[k]] = f; P.picked = true;
      const off = f * durOf(k);
      P.g = startOf(k) + off; loadAt(k, off, false); updateUI();   // the frame the marker points at shows on the left
    };
    const up = ev => {
      head.classList.remove('drag');
      try { head.releasePointerCapture(ev.pointerId); } catch { }
      head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up);
      if (was) setPlaying(true);
    };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
    mv(e);
  });
  const focusClip = i => {        // the window follows what the person has just touched
    if (i < 0 || i >= MT.ids.length) return;
    P.picked = true; P.lim = null; P.i = i; P.mkI = i;
    if (P.mode !== 'seq') P.mode = 'seq';
    showMode('seq'); P.g = startOf(i); seekTo(P.g, false);
  };
  window.mtFocusClip = focusClip;
  const restartBtn = $('.mt-restart', root);
  restartBtn.onclick = () => {          // watch the ribbon again from its very first frame
    if (!MT.ids.length) return;
    P.picked = true; P.lim = null;
    if (P.mode !== 'seq') showMode('seq');
    seekTo(0, true); setPlaying(true);
  };
  playBtn.onclick = togglePlay;
  pv.onclick = () => togglePlay();          // a click on the picture pauses and resumes, like any player
  seek.oninput = () => { P.drag = true; P.picked = true; if (P.mode !== 'seq') showMode('seq'); seekTo(seek.value / 10, P.playing); };
  seek.onchange = () => { P.drag = false; };
  addEventListener('keydown', e => {
    if (e.code !== 'Space' || root.offsetParent === null || e.target.closest('input,textarea,select,button,[contenteditable]')) return;
    e.preventDefault(); togglePlay();
  });
  function fitPx() {
    const W = $('.mt-strip', root).clientWidth - 8, n = MT.ids.length; if (!n) return 26;
    for (let px = 90; px > 8; px--) { const w = MT.ids.reduce((a, _, i) => a + Math.max(Math.round(px), Math.round(durOf(i) * px)), 0) + 8 * (n - 1); if (w <= W) return px; }
    return 8;
  }
  const setPx = v => {
    MT.px = Math.min(90, Math.max(8, Math.round(v)));
    try { localStorage.setItem('h3-mt-px', MT.px); } catch {}
    $$('.mt-px', root).forEach(r => { r.value = MT.px; });
    $$('.mt-px-x', root).forEach(x => { x.textContent = MT.px + ' px'; });
    render();
  };
  const trimI = () => (typeof P !== 'undefined' && MT.ids.length && P.mkI < MT.ids.length) ? P.mkI : 0;   // the fields show the clip the marker stands on - the one the scissors will cut
  const paintTrim = () => {
    const box = $('.mt-trim', root); if (!box) return;
    if (!MT.ids.length) { box.hidden = true; box.innerHTML = ''; return; }
    const i = trimI(), full = fullOf(i);
    box.hidden = false;
    box.innerHTML = `<span class="tt-what">Обрезка клипа ${i + 1} из ${MT.ids.length}</span>`
      + `<label>с <input type="number" class="mt-tin" min="0" max="${Math.max(0, full - 0.3).toFixed(2)}" step="0.1" value="${inOf(i).toFixed(1)}"> с</label>`
      + `<label>до <input type="number" class="mt-tout" min="0.3" max="${full.toFixed(2)}" step="0.1" value="${endOf(i).toFixed(1)}"> с</label>`
      + `<span class="hint">в монтаже останется ${durOf(i).toFixed(1)} с из ${full.toFixed(1)} с</span>`
      + `<button type="button" class="btn mini mt-treset">Вернуть целый</button>`;
  };
  root.addEventListener('change', e => {
    const box = e.target.closest('.mt-trim'); if (!box) return;
    const i = trimI(), full = fullOf(i);
    if (e.target.matches('.mt-tin')) { MT.ins[i] = Math.min(Math.max(0, +e.target.value || 0), Math.max(0, endOf(i) - 0.3)); render(); }
    else if (e.target.matches('.mt-tout')) {
      const v = Math.min(full, Math.max(inOf(i) + 0.3, +e.target.value || 0));
      MT.cuts[i] = v >= full - 0.05 ? null : v; render();
    }
  });
  window.montageLoad = ids => { MT.ids = ids.slice(); MT.cuts = ids.map(() => null); MT.ins = ids.map(() => 0); render(); const st = $('.mt-status', root); st.textContent = 'Сцены из Видеостудии уже стоят по порядку. Нажмите «Склеить»: готовый ролик появится справа и в Библиотеке.'; };
  $('.mt-pc', root).onclick = () => $('.mt-file', root).click();
  $('.mt-file', root).onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const meta = await new Promise(res => { const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.onloadedmetadata = () => res({ len: v.duration || 0, res: v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '' }); v.onerror = () => res(null); v.src = url; });
      if (!meta) { toast('Не удалось открыть файл «' + f.name + '». Нужно видео (mp4, mov, webm).'); URL.revokeObjectURL(url); continue; }
      const k = 'k' + (++MT.n); MT.up[k] = { id: 'up:' + k, file: f, url, len: meta.len, res: meta.res, prompt: f.name };
      MT.ids.push('up:' + k); MT.cuts.push(null); MT.ins.push(0);
    }
    render();
  };
  const move = (i, j) => {
    if (j < 0 || j >= MT.ids.length) return;
    const id = MT.ids[i];
    const [x] = MT.ids.splice(i, 1), [c] = MT.cuts.splice(i, 1), [bi] = MT.ins.splice(i, 1);
    MT.ids.splice(j, 0, x); MT.cuts.splice(j, 0, c); MT.ins.splice(j, 0, bi);
    // the focus follows the clip it was on, and the playhead goes to that clip's marker: positions in
    // the old order must not point at another clip after a swap
    P.i = Math.max(0, MT.ids.indexOf(id)); P.lim = null; P.g = startOf(P.i) + mkAt().off;
    render();
  };
  root.addEventListener('click', e => {
    const fr = e.target.closest('.mt-fr'); if (fr) { nudge(+fr.dataset.fr); return; }
    if (e.target.closest('[data-showall]')) { hideSet([]); render(); return; }
    const zb = e.target.closest('[data-z]'); if (zb) { const k = +zb.dataset.z; setPx(k > 0 ? MT.px * 1.25 : k < 0 ? MT.px * 0.8 : fitPx()); return; }
    const tb = e.target.closest('[data-pv]'); if (tb) { showMode(tb.dataset.pv); return; }
    const x = e.target.closest('[data-hide]'); if (x) { e.stopPropagation(); const id = x.dataset.hide; hideSet([...hidden(), id]); const k2 = MT.ids.map(v => v !== id); MT.cuts = MT.cuts.filter((_, i) => k2[i]); MT.ins = MT.ins.filter((_, i) => k2[i]); MT.ids = MT.ids.filter((_, i) => k2[i]); render(); return; }
    const c = e.target.closest('.mt-card'); if (c) { MT.ids.push(c.dataset.id); MT.cuts.push(null); MT.ins.push(0); render(); focusClip(MT.ids.length - 1); return; }
    const it = e.target.closest('.mt-item'); if (!it) return; const i = +it.dataset.i;
    if (e.target.closest('[data-rm]')) { MT.ids.splice(i, 1); MT.cuts.splice(i, 1); MT.ins.splice(i, 1); render(); return; }
    const mv = e.target.closest('[data-mv]'); if (mv) { move(i, i + +mv.dataset.mv); return; }
    if (e.target.closest('.mt-rh') || P.mode !== 'seq') { if (P.mode !== 'seq') showMode('seq'); else return; }
    const r = it.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * durOf(i);   // where in this clip they clicked
    P.picked = true;   // the clip you touched is the one the window shows
    P.i = i; P.mkI = i;   // and its own marker: each clip keeps the place you put it on
    const m = mkAt();
    if (i === m.i && Math.abs(at - m.off) > 0.02) {
      // left of the marker: show the kept beginning up to the marker; right of it: from the marker to the kept end
      const mk = Math.max(0, Math.min(durOf(i), m.off));
      P.lim = at < mk ? [startOf(P.i), startOf(P.i) + mk] : [startOf(P.i) + mk, startOf(P.i) + durOf(i)];
      seekTo(P.lim[0], true); setPlaying(true); updateUI(); return;
    }
    seekTo(startOf(i) + at, true);   // another clip: watch it from that place
  });
  root.addEventListener('pointerdown', e => {
    const h = e.target.closest('.mt-rh, .mt-rhl'); if (!h) return;
    e.preventDefault(); e.stopPropagation();
        const el = h.closest('.mt-item'), i = +el.dataset.i, x0 = e.clientX, d0 = durOf(i), full = fullOf(i);
    const left = h.classList.contains('mt-rhl');   // the same arithmetic, mirrored: the left handle moves the start
    el.draggable = false; try { h.setPointerCapture(e.pointerId); } catch {}
    const move2 = ev => {
      // both edges mean the same thing when dragged to the right: more seconds cut off
      const px = Math.round(((ev.clientX - x0) / MT.px) * 10) / 10;
      if (left) { MT.ins[i] = Math.min(Math.max(0, Math.round(((MT.ins[i] || 0) + px) * 10) / 10), Math.max(0, endOf(i) - 0.3)); }
      else { MT.cuts[i] = Math.min(full, Math.max(inOf(i) + 0.3, Math.round((d0 + (ev.clientX - x0) / MT.px) * 10) / 10 + inOf(i))); }
      el.style.width = wOf(durOf(i)) + 'px'; el.classList.toggle('narrow', wOf(durOf(i)) < 92); el.classList.toggle('narrow', wOf(durOf(i)) < 92);
      $('.mt-len', el).textContent = trimTxt(i);
    };
    const up = () => {
      h.removeEventListener('pointermove', move2); h.removeEventListener('pointerup', up);
      if (MT.cuts[i] != null && MT.cuts[i] >= fullOf(i) - 0.05) MT.cuts[i] = null;
      if (MT.ins[i] && inOf(i) < 0.06) MT.ins[i] = 0;
      render();
    };
    h.addEventListener('pointermove', move2); h.addEventListener('pointerup', up);
  });
  root.addEventListener('click', e => {
                            if (e.target.closest('.mt-shot')) { mtShot(); return; }
                        if (e.target.closest('.mt-snd')) { mtSound(); return; }
    if (e.target.closest('.mt-fade')) {
      MT.fadeMode = !MT.fadeMode;
      const b = $('.mt-fade', root);
      // the caption stays: a button that grows with every press pushes the row around and the whole
      // strip jumps. What changes is the fill - on means on - and the tooltip, which costs no pixels.
      if (b) {
        b.classList.toggle('on', MT.fadeMode);
        b.title = MT.fadeMode
          ? 'Затухание включено: метка в клипе - где спуск начинается. Левая лесенка гасит звук к началу клипа, правая - к его концу; стороны включаются независимо, можно держать обе. Повторное нажатие выключает только свою сторону, включённая сторона горит.'
          : 'Режим затухания: ножницы в ленте становятся двумя лесенками. Метка - где спуск начинается, левая лесенка - стихать к началу клипа, правая - к его концу. Нажимать можно обе.';
      }
      render();
      toast(MT.fadeMode ? 'Затухание включено: метка - где начинать стихать; левая лесенка к началу клипа, правая к концу, можно обе' : 'Снова ножницы');
      return;
    }
if (e.target.closest('.mt-clear')) {
      if (!MT.ids.length) { toast('Лента уже пуста'); return; }
      const wipe = () => { MT.ids = []; MT.cuts = []; MT.ins = []; P.picked = false; P.lim = null; render(); toast('Лента очищена: клипы остались в Библиотеке'); };
      if (MT.ids.length < 1) { wipe(); return; }
      confirmBox('Очистить монтаж?', 'Из ленты уберутся все клипы. Сами видео останутся в Библиотеке, готовый ролик - тоже.', 'Очистить', wipe);
      return;
    }
    if (e.target.closest('.mt-treset')) { const i = trimI(); MT.cuts[i] = null; MT.ins[i] = 0; render(); toast('Клип снова целиком'); return; }
  });
  root.addEventListener('input', e => { if (e.target.matches('.mt-px')) setPx(+e.target.value); });
  root.addEventListener('dblclick', e => {        // a cut clip is easy to bring back: double-click restores it
    const it = e.target.closest('.mt-item'); if (!it) return;
    const i = +it.dataset.i;
    if (MT.cuts[i] == null && !MT.ins[i]) return;
    MT.cuts[i] = null; MT.ins[i] = 0; render(); toast('Клип снова целиком');
  });
  root.addEventListener('dragstart', e => { const it = e.target.closest('.mt-item'); if (!it) return; MT.drag = +it.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'mt'); });
  root.addEventListener('dragover', e => { const it = e.target.closest('.mt-item'); if (it && MT.drag != null) { e.preventDefault(); $$('.mt-item', root).forEach(x => x.classList.toggle('over', x === it)); } });
  root.addEventListener('drop', e => { const it = e.target.closest('.mt-item'); if (!it || MT.drag == null) return; e.preventDefault(); const from = MT.drag; MT.drag = null; move(from, +it.dataset.i); });
  root.addEventListener('dragend', () => { MT.drag = null; $$('.mt-item', root).forEach(x => x.classList.remove('over')); });

  let PEND = null; try { PEND = JSON.parse(localStorage.getItem('h3-mt-state') || 'null'); } catch {}
  function applyPend() {   // the order of clips from the last time, as soon as the Library is loaded
    if (!PEND || !LIB.length) return; const p = PEND; PEND = null;
    if (MT.ids.length || !Array.isArray(p.ids)) return;
    const ok = p.ids.map(id => !!byId(id)); MT.ids = p.ids.filter((_, i) => ok[i]); MT.cuts = (p.cuts || []).filter((_, i) => ok[i]); MT.ins = (p.ins || []).filter((_, i) => ok[i]); render();
  }
  const durList = () => MT.ids.map((_, i) => (MT.cuts[i] != null || inOf(i) > 0.05) ? +durOf(i).toFixed(3) : null);
  const inList = () => MT.ids.map((_, i) => +inOf(i).toFixed(3));
  const orderKey = () => JSON.stringify([MT.ids, durList(), inList()]);   // what the joined video was made from: another order or trim makes it out of date

  /* the state of the work (which clips are enlarged, grained, joined) is kept, so it survives closing the program: the finished parts lie in the Library */
  let PIPE = { sig: '', doUp: false, grain: 0, steps: {}, joined: null };
  try { const s = JSON.parse(localStorage.getItem('h3-mt-pipe') || 'null'); if (s && s.steps) PIPE = s; } catch {}
  const pipeSave = () => { try { localStorage.setItem('h3-mt-pipe', JSON.stringify(PIPE)); } catch {} pipePaint(); };
  window.mtSaveState = () => { if (PEND) return; try { const k = MT.ids.map(id => !id.startsWith('up:')); localStorage.setItem('h3-mt-state', JSON.stringify({ ids: MT.ids.filter((_, i) => k[i]), cuts: MT.cuts.filter((_, i) => k[i]), ins: MT.ins.filter((_, i) => k[i]) })); } catch {} };
  window.mtPipeDone = id => { const s = PIPE.steps[id]; return !!(s && (PIPE.grain > 0 ? s.gr : PIPE.doUp ? s.up : false)); };
  function pipePaint() {
    resTabPaint();
    const box = $('.mt-pipe', root), n = MT.ids.length, line = (t, ok) => `<div class="${ok ? 'ok' : ''}">${ok ? '✓ ' : '• '}${t}</div>`;
    let h = '';
    const have = id => PIPE.steps[id] || {};
    if (PIPE.doUp && n) { const c = MT.ids.filter(id => have(id).up).length; h += line(`Увеличение: ${c} из ${clipsW(n)}${c === n ? ' — завершено' : ''}`, c === n); }
    if (PIPE.grain > 0 && n) { const c = MT.ids.filter(id => have(id).gr).length; h += line(`Зерно: ${c} из ${clipsW(n)}${c === n ? ' — завершено' : ''}`, c === n); }
    const j = PIPE.joined && byId(PIPE.joined.id) ? PIPE.joined : null;
    if (MT.joining) h += line('Сохраняю…', false);
    else if (j && j.key === orderKey()) h += line('Сохранено: ролик готов, его можно смотреть и увеличивать', true);
    else if (j) h += line('Устарело: порядок или обрезка изменились — сохраните заново', false);
    else if (h) h += line('Результат: ещё не сохранён', false);
    box.innerHTML = h; box.hidden = !h;
  }
  window.mtPipePaint = pipePaint;
  // The tab and the line under it have to say which result is shown: joined now, or left over from
  // an earlier run while the ribbon has not been joined yet in this one.
  const resTabPaint = () => {
    const tabs = $('.mt-tabs', root), rtab = tabs && $('[data-pv="res"]', tabs);
    if (!rtab || !MT.res) return;
    const when = MT.resAt ? fmtDate(MT.resAt) : 'прежде';
    rtab.textContent = MT.joining ? 'Прошлый ролик · идёт сохранение' : (MT.resFresh ? 'Готовый ролик' : `Ролик от ${when}`);
    rtab.title = MT.joining ? `сейчас показан ролик, сохранённый раньше (${when}); как только новое сохранение закончится, он заменится`
      : (MT.resFresh ? 'сохранён в этом запуске' : `сохранён раньше, ${when}; новое сохранение заменит его`);
  };
  function showDone(item, quiet) {   // quiet: remember the result, but do not steal the window from the ribbon
    const st = $('.mt-status', root), v = $('.mt-res', root);
    v.src = item.url; v.muted = true; MT.res = true;
    MT.resAt = new Date(item.date); MT.resFresh = !quiet;
    resTabPaint();
    if (!quiet) showMode('res');
    st.innerHTML = (quiet ? `Показан ролик, сохранённый раньше (${fmtDate(MT.resAt)}) - в этом запуске ещё не сохраняли. Его можно посмотреть, сохранить или увеличить; новая склейка заменит его.` : 'Склейка завершена: ролик лежит в Библиотеке.') + `<button class="btn pri" id="mtSave" type="button" style="padding:4px 12px;font-size:12px" title="Сохранить готовый ролик целиком на компьютер">Сохранить на компьютер</button> <button class="btn" id="mtUp" type="button" style="padding:4px 12px;font-size:12px" title="Увеличить разрешение (долго)">Увеличить</button>`
      + ` <button class="btn" id="mtDel" type="button" style="padding:4px 12px;font-size:12px" title="Убрать ролик из Библиотеки: файл переместится в корзину Windows">Удалить</button>`;
    $('#mtSave', root).onclick = () => saveItems([byId(item.id) || normItem(item)]);
    $('#mtUp', root).onclick = () => openUpscale(byId(item.id) || normItem(item));
    const drop = () => confirmBox('Удалить готовый ролик?',
      'Файл переместится в корзину Windows, оттуда его можно вернуть. Клипы, из которых он собран, останутся в Библиотеке.',
      'Удалить', async () => {
        try {
          const r = await fetch('/api/library/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [item.id] }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { toast(j.error || 'Не удалось удалить'); return; }
          if ((j.failed || []).length) { toast('Файл не удался: ' + j.failed.length + ' остался на месте'); return; }
          const at = LIB.findIndex(x => x.id === item.id); if (at >= 0) LIB.splice(at, 1);
          if (typeof selected !== 'undefined') selected.delete(item.id);
          renderLib();
        } catch (err) { toast(err.message); return; }
        MT.res = false; if (typeof PIPE !== 'undefined') PIPE.joined = null;
        const rv = $('.mt-res', root); rv.removeAttribute('src'); try { rv.load(); } catch { }
        showMode('seq'); syncPlayer(); pipePaint();
        st.innerHTML = 'Готовый ролик удалён из Библиотеки. Лента на месте - соберите заново, если он нужен.';
      });
    $('#mtDel', root).onclick = drop;
    const tdel = $('.mt-del', root); if (tdel) { tdel.hidden = false; tdel.onclick = drop; }
  }
  window.mtRestoreResult = () => {   // after a restart: show the joined video again if it is still in the Library
    const j = PIPE.joined, it = j && byId(j.id); if (!it || MT.res || it.missing) return;
    showDone(it, true);   // the tab appears and is clickable, the window keeps showing the ribbon
  };

  $('.mt-go', root).onclick = () => { if (+$('.mt-grain', root).value > 0) chain('none'); else joinNow(MT.ids.slice(), durList(), inList()); };
  async function applyStripFades(id, ids, durs, ins) {
    const plan = (ids || []).map((_, i) => {
      const fd = fadeOf(i);
      // the snapshot of lengths says "null" for a clip nobody trimmed - that means the WHOLE clip
      // goes into the film, so the live length of the strip is the truth here, not the snapshot
      let dur = 0, from = 0;
      try { dur = +durOf(i); from = +inOf(i) || 0; } catch (e) { }
      if (!(dur > 0)) dur = +(durs && durs[i] ? durs[i] : 0) || 0;
      if (!(dur > 0)) dur = Math.max(0.3, +((MT.info && MT.info[i] && MT.info[i].len) || 0)) || 0;
      if (!(from > 0)) from = +((ins && ins[i]) || 0) || 0;
      const rel = x => +Math.max(0, Math.min(dur, x - from)).toFixed(3);
      const seg = { dur: +dur.toFixed(3) };
      if (fd.l != null) seg.at_in = rel(fd.l);
      if (fd.r != null) seg.at_out = rel(fd.r);
      return seg;
    }).filter(x => x.dur > 0 && (x.at_in != null || x.at_out != null));
    if (!plan.some(x => x.at_in != null || x.at_out != null)) return;
    const st = $('.mt-status', root);
    try {
      const r = await fetch('/api/montage/fade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, timeline: plan }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { toast('Затухание наложить не удалось: ' + (j.error || r.status)); if (st) st.textContent = 'Ролик сохранён, но затухание не леглось: ' + (j.error || r.status); return; }
      if (!j.fades) { if (st) st.textContent = 'Ролик сохранён, но затухание не наложилось: ни один спуск не лёг'; return; }
      toast('Затухание легло на собранный ролик - ' + j.fades + ' спуск(ов); клипы не тронуты');
      if (st) st.textContent = 'Ролик сохранён · затухание наложено на него (' + j.fades + ') · исходные клипы не менялись';
      const rv = $('.mt-res', root); if (rv && MT.res) { const s = rv.src; rv.removeAttribute('src'); rv.src = s + (s.includes('?') ? '&' : '?') + 'fade=1'; }
    } catch (err) { toast('Затухание наложить не удалось: ' + err.message); }
  }
  async function joinNow(ids, durs, ins) {
    const st = $('.mt-status', root);
    if (MT.busy && !MT.chaining) return;
    if (ids.length < 1) { st.textContent = 'Добавьте в монтаж хотя бы один клип'; return; }
    const key = orderKey();
    MT.busy = true; MT.joining = true; $('.mt-go', root).disabled = true; st.textContent = 'Отправляем клипы в ComfyUI…'; pipePaint();
    const fail = msg => { MT.busy = false; MT.joining = false; MT.chaining = false; $('.mt-go', root).disabled = false; st.textContent = msg; pipePaint(); };
    try {
      const fd = new FormData(); fd.append('ids', JSON.stringify(ids)); fd.append('durs', JSON.stringify(durs)); fd.append('ins', JSON.stringify(ins || []));
      ids.filter(id => id.startsWith('up:')).forEach(id => { const u = get(id), k = id.slice(3); fd.append('res_' + k, u.res || ''); fd.append('len_' + k, String(u.len || 0)); fd.append('file_' + k, u.file, u.file.name); });
      const r = await fetch('/api/montage', { method: 'POST', body: fd });
      const txt = await r.text(); let res; try { res = JSON.parse(txt); } catch { res = { error: txt }; }
      if (!r.ok) throw new Error(res.error || r.statusText);
      qAdd(res.prompt_id, 'montage', clipsW(ids.length));
      st.textContent = 'Сохраняем…';
      onPrompt(res.prompt_id, ev => {
        if (ev.prompt_id !== res.prompt_id) return;
        if (ev.type === 'done') {
          offPrompt(res.prompt_id); MT.busy = false; MT.joining = false; MT.chaining = false; $('.mt-go', root).disabled = false;
          PIPE.joined = { id: ev.item.id, key }; pipeSave();
          showDone(byId(ev.item.id) || normItem(ev.item));
          applyStripFades(ev.item.id, ids, durs, ins);   // the fade belongs to the joined film, never to its clips
        } else if (ev.type === 'error') fail('Сохранить не удалось: ' + ev.message);
        else if (ev.type === 'interrupted') fail('Сохранение остановлено');
      });
    } catch (err) { fail('Сохранить не удалось: ' + err.message); }
  }

  /* «Увеличить каждый клип и сохранить» / зерно: the clips are done one by one (each is short, so memory is enough), then the finished ones are joined.
     What is finished is remembered, so after an error or a restart the work goes on from the first clip that is not done. */
  const upBtn = $('.mt-upgo', root), upTxt = upBtn.textContent;
  const setsPaint = () => { const relay = $('.mt-upeng', root).value === 'relay'; $('.mt-s-detail', root).hidden = !relay; $('.mt-s-sharp', root).hidden = relay; };   // the detail slider belongs to RelayVSR, the sharpness one to SeedVR2
  $('.mt-upeng', root).onchange = setsPaint; setsPaint();
  [['.mt-detail', '.mt-dv'], ['.mt-sharp', '.mt-sv'], ['.mt-grain', '.mt-gv']].forEach(([a, b]) => { $(a, root).oninput = () => { $(b, root).textContent = $(a, root).value; }; });
  upBtn.onclick = () => chain($('.mt-upeng', root).value);
  const waitItem = r => new Promise((res, rej) => onPrompt(r.prompt_id, ev => {
    if (ev.prompt_id !== r.prompt_id) return;
    if (ev.type === 'done') { offPrompt(r.prompt_id); res(ev.item); }
    else if (ev.type === 'error') { offPrompt(r.prompt_id); rej(new Error('ошибка ComfyUI: ' + ev.message)); }
    else if (ev.type === 'interrupted') { offPrompt(r.prompt_id); rej(new Error('остановлено')); }
  }));
  async function chain(eng) {   // eng: 'relay' | 'seed' (enlarge each clip) | 'none' (only the grain)
    const st = $('.mt-status', root);
    if (MT.upBusy) { MT.cancel = true; st.textContent = 'Останавливаем…'; if (MT.curPrompt) fetch('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: MT.curPrompt }) }); return; }
    if (MT.busy) return;
    if (MT.ids.length < 1) { st.textContent = 'Добавьте в монтаж хотя бы один клип'; return; }
    const doUp = eng !== 'none', grain = +$('.mt-grain', root).value;
    if (doUp) {
      let stt = {}; try { stt = await (await fetch('/api/status')).json(); } catch {}
      const haveRelay = (stt.modes || []).includes('relayvsr') && !(stt.models || []).some(m => m.role.startsWith('relayvsr') && !m.have);
      const haveSeed = (stt.modes || []).includes('upscale') && !(stt.models || []).some(m => m.role.startsWith('seedvr') && !m.have);
      if (eng === 'relay' ? !haveRelay : !haveSeed) { st.textContent = `Нужна модель ${eng === 'relay' ? 'RelayVSR' : 'SeedVR2'}: её можно скачать кнопкой «Увеличить» у любого видео в Библиотеке.`; return; }
    }
    const opt = { scale: '2', method: '', engine: eng === 'relay' ? 'relay' : '', detail: +$('.mt-detail', root).value / 100, sharp: +$('.mt-sharp', root).value / 100 };
    const sig = [doUp ? eng : '-', doUp ? (eng === 'relay' ? opt.detail : opt.sharp) : '-', grain].join('|');
    if (PIPE.sig !== sig) PIPE = { sig, doUp, grain, steps: {}, joined: null };   // other settings: the clips are done again
    const ids = MT.ids.slice(), durs = durList(), ins = inList(), out = [], todo = ids.filter(id => !(PIPE.steps[id] && (!doUp || PIPE.steps[id].up) && (!grain || PIPE.steps[id].gr))).length;
    MT.upBusy = true; MT.busy = true; MT.chaining = true; MT.cancel = false; $('.mt-go', root).disabled = true; upBtn.textContent = 'Остановить'; pipeSave();
    const job = async (url, id, srcFile, extra, label, k) => {   // one job on ComfyUI; returns the finished Library item
      let r;
      if (srcFile) {
        const fd = new FormData(); Object.entries(extra).forEach(([a, b]) => fd.append(a, b)); fd.append('res', srcFile.res || ''); fd.append('len', srcFile.len || 0); fd.append('file', srcFile.file, srcFile.file.name);
        const resp = await fetch(url + (url === '/api/upscale' ? '_file' : ''), { method: 'POST', body: fd }), txt = await resp.text(); let j; try { j = JSON.parse(txt); } catch { j = { error: txt }; }
        if (!resp.ok) throw new Error(j.error || txt || resp.statusText); r = j;
      } else if (url === '/api/grain') {
        const fd = new FormData(); fd.append('id', id); fd.append('strength', extra.strength);
        const resp = await fetch(url, { method: 'POST', body: fd }), txt = await resp.text(); let j; try { j = JSON.parse(txt); } catch { j = { error: txt }; }
        if (!resp.ok) throw new Error(j.error || txt || resp.statusText); r = j;
      } else r = await postJSON(url, { id, ...extra });
      qAdd(r.prompt_id, label === 'grain' ? 'montage' : 'upscale', (get(ids[k]).prompt || '') || (label === 'grain' ? 'Зерно плёнки' : 'Увеличение')); MT.curPrompt = r.prompt_id;
      return waitItem(r);
    };
    try {
      for (let k = 0; k < ids.length; k++) {
        if (MT.cancel) throw new Error('остановлено');
        const src = ids[k], step = PIPE.steps[src] || (PIPE.steps[src] = { up: null, gr: null }), u = src.startsWith('up:') ? get(src) : null;
        let cur = src;
        if (doUp) {
          if (!step.up) { st.textContent = `Клип ${k + 1} из ${ids.length}: увеличиваем…`; step.up = (await job('/api/upscale', src, u, opt, 'up', k)).id; pipeSave(); }
          cur = step.up;
        }
        if (grain > 0) {
          if (!step.gr) { st.textContent = `Клип ${k + 1} из ${ids.length}: накладываем зерно…`; step.gr = (await job('/api/grain', cur, doUp ? null : u, { strength: grain }, 'grain', k)).id; pipeSave(); }
          cur = step.gr;
        }
        out.push(cur);
      }
    } catch (err) {
      MT.upBusy = false; MT.busy = false; MT.chaining = false; MT.curPrompt = null; $('.mt-go', root).disabled = false; upBtn.textContent = upTxt; pipePaint();
      const left = ids.filter(id => !(PIPE.steps[id] && (!doUp || PIPE.steps[id].up) && (!grain || PIPE.steps[id].gr))).length;
      st.textContent = `Обработка прервана: ${err.message}. Готово ${ids.length - left} из ${clipsW(ids.length)}, они сохранены. Нажмите кнопку ещё раз: работа продолжится с первого неготового клипа.`;
      return;
    }
    MT.upBusy = false; MT.curPrompt = null; upBtn.textContent = upTxt;
    st.textContent = `${doUp ? 'Увеличение' : 'Зерно'} завершено · ${clipsW(ids.length)}. Сохраняем…`;
    await joinNow(out, durs, ins);
  }
  IMG_PANELS.push(() => { applyPend(); pipePaint(); window.mtRestoreResult(); });
  pipePaint();
  /* a handle under the strip: drag down or up and the clips grow or shrink (the same scale as «−» «+»); the divider before the preview moves left and right */
  (() => {
    const h = $('.mt-vh', root); let y0 = 0, px0 = 0, on = false;
    h.addEventListener('pointerdown', e => { e.preventDefault(); h.setPointerCapture(e.pointerId); on = true; y0 = e.clientY; px0 = MT.hpx; });
    h.addEventListener('pointermove', e => {
      if (!on) return;
      MT.hpx = Math.min(240, Math.max(56, Math.round(px0 + (e.clientY - y0))));
      root.style.setProperty('--mt-h', MT.hpx + 'px');   // every block the same: only taller or shorter
    });
    h.addEventListener('pointerup', e => { if (!on) return; on = false; try { h.releasePointerCapture(e.pointerId); } catch {} try { localStorage.setItem('h3-mt-h', MT.hpx); } catch {} });
    h.addEventListener('dblclick', () => { MT.hpx = 96; root.style.setProperty('--mt-h', '96px'); try { localStorage.setItem('h3-mt-h', 96); } catch {} });
  })();
  if (window.gridResize) window.gridResize($('.grid', root));
  IMG_PANELS.push(render);
  render();
})();
