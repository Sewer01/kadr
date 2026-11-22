import { paintRange, toast } from '../core/util.js';
/* Разделы сюда не импортируются: из-за импорта раздела его классы (AudioTrimmer и
   прочие) не успевали бы родиться к моменту, когда раздел создаёт себе контрол,
   и страница падала на всего графе модулей. Что нужно от разделов - берём из общего
   хаба, где разделы сами о себе заявили (registerViews). */
import { views } from '../core/state.js';
const agentState = () => views.AG || {};             // состояние раздела «Сценарист»
const agentGo = () => views.agGo && views.agGo();
const agentStatus = () => (views.agStatus ? views.agStatus() : Promise.resolve(null));
const agentSetAudio = (...a) => (views.setChatAudio ? views.setChatAudio(...a) : Promise.resolve(null));

// audio editor: the decoded buffer and its name, everything else lives in the shared editor class
export let actx;
export function setActx(v) { return actx = v !== undefined ? v : (actx || new AudioContext()); }   // аудиоконтекст: пишет его ui/audio
export class VideoTrimmer {
  /* One bench for any single clip: the film strip with frames, a marker you can step frame by frame,
     scissors sitting ON the timeline next to the marker, and a zoom that only changes how wide the strip
     is - so a second of film always stays readable. The player above the strip stands on the marker and
     shows it as a still: choosing the exact frame is the whole point of the bench.
     It is written to be mounted anywhere (the «Референс-видео» card, the swap mode, and later the
     montage), so it knows nothing about tiles: it takes a file and gives a file back. */
  constructor(o = {}) {
    this.o = o;
    this.limit = o.limit || 25;                       // seconds: the model does not look further
    this.fps = o.fps || 24;                           // the frame step, as in the montage strip
    this.onFile = o.onFile || (() => {});
    this.onWhole = o.onWhole || (() => {});
    this.say = o.onNotice || (m => toast(m));
    this.whereLabel = o.whereLabel || null;
    this.dur0 = 0; this.start = 0; this.end = 0; this.t = 0;   // t is the MARKER - it never moves by itself
    this.run = 0;                                   // the time the preview stands on while it plays
    this.pps = 0;                                     // pixels per second: 0 means "fit the window"
    try { const p = +localStorage.getItem('h3-vt-px'); if (p >= 10 && p <= 300) this.pps = p; } catch (e) {}
    this.cut = null; this.undo = []; this.file = null; this.url = ''; this.busy = false;
    this.origFile = null; this.isPiece = false;
    this.name = ''; this.frames = []; this.raf = 0;
    // the root carries atrim as well: the marks, the names and the hint are styled there, and a second
    // copy of those rules would only start disagreeing with the first one later
    this.el = document.createElement('div'); this.el.className = 'atrim vtrim';
    this.el.innerHTML =
      '<div class="at-top"><button class="btn mini vt-play" type="button" title="Показать выбранное">&#9654;</button>' +
      '<div class="at-name">видео не загружено</div><div class="at-len">—</div></div>' +
      '<div class="vt-body" hidden>' +
      '<video class="vt-view" muted playsinline preload="auto"></video>' +
      '<div class="vt-stripwrap"><div class="vt-strip">' +
      '<canvas class="vt-cv" height="86"></canvas>' +
      '<span class="vt-span" title="здесь стоит маркер: от него режут ножницы"></span>' +
      '<div class="vt-sel">' +
      '<i class="at-h" data-h="l"></i><i class="at-h" data-h="r"></i></div>' +
      '<div class="vt-ph" title="маркер: его и тянут, от него режут"><i class="vt-line"></i><i class="vt-head"></i>' +
      '<span class="vt-step">' +
      '<button class="vt-b" data-s="back" type="button" title="Кадр назад">&#9664;</button>' +
      '<button class="vt-b" data-s="fwd" type="button" title="Кадр впер">&#9654;</button></span>' +
      '<button class="vt-b vt-cutl" data-s="left" type="button" title="Убрать всё до маркера">&#9986;</button>' +
      '<button class="vt-b vt-cutr" data-s="right" type="button" title="Убрать всё после маркера">&#9986;</button>' +
      '</div>' +
      '<div class="vt-run" title="идёт просмотр"></div></div></div>' +
      '<div class="mt-scale"><span>Шире лента - точнее кадр:</span>' +
      '<input type="range" class="vt-zr" min="10" max="300" step="5" value="0">' +
      '<span class="vt-pp">по ширине окна</span>' +
      '<button class="btn mini vt-zm" type="button" title="Сжать ленту">−</button>' +
      '<button class="btn mini vt-zp" type="button" title="Растянуть ленту">+</button>' +
      '<button class="btn mini vt-fit" type="button" title="Чтобы весь клип влез в окно">По ширине</button></div>' +
      '<div class="at-hint"></div>' +
      '<div class="mt-trim"><span class="tt-what">Обрезка</span>' +
      '<label>с <input type="number" class="vt-a" step="0.1" min="0" value="0"> с</label>' +
      '<label>до <input type="number" class="vt-b2" step="0.1" min="0" value="0"> с</label>' +
      '<span class="vt-left"></span><button class="btn mini vt-reset" type="button" disabled>Вернуть целый</button></div>' +
      '<div class="vt-acts"><button class="btn pri vt-keep" type="button" disabled>Оставить выбранное</button>' +
      '<button class="btn vt-shot" type="button" disabled title="Сохранить кадр, на котором стоит маркер, как фотографию">&#128247; Сделать кадр</button>' +
      '<button class="btn vt-und" type="button" disabled>Отменить</button>' +
      '<button class="btn vt-ag" type="button" disabled title="Сценарист посмотрит на клип как на кадры">🤖 К сценаристу</button></div>' +
      '</div>';
    this._wire();
    if (o.mount) this.mount(o.mount);
  }
  mount(el) { el.append(this.el); return this; }
  q(s) { return this.el.querySelector(s); }
  len() { return Math.max(0, this.end - this.start); }
  fmt(x) { return (Math.round(x * 10) / 10 + '').replace('.', ','); }
  fmt2(x) { return (Math.round(x * 100) / 100 + '').replace('.', ','); }
  stripW() { return this.pps ? Math.max(80, this.dur0 * this.pps) : 0; }   // 0 = as wide as the window
  _push() { this.undo.push({ s: this.start, e: this.end, cut: this.cut, t: this.t }); if (this.undo.length > 20) this.undo.shift(); this.q('.vt-und').disabled = false; }
  setFile(f, silent) {
    if (!f) { this.clear(); return; }
    this.file = f; this.name = f.name;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(f);
    const v = this.q('.vt-view');
    this.el.hidden = false;
    this.q('.vt-body').hidden = false;
    this.q('.at-name').textContent = f.name;
    // without this the player never learns anything: the marks, the strip and the scissors all wait here
    v.onloadedmetadata = () => {
      this.dur0 = v.duration || 0;
      if (!this.origFile) this.origFile = f;              // the very first file stays reachable
      this.start = 0; this.end = this.dur0; this.t = 0; this.cut = null; this.undo = [];
      this.pps = 0; this.q('.vt-zr').value = 0;
      this._thumbs(); this._sync(); this._still();
      if (!silent) this.out();
    };
    v.onerror = () => this.say('Браузер не может показать это видео - для резки оно всё равно подойдёт, если декодер его читает');
    v.src = this.url;
    try { v.load(); } catch (e) {}
    return this;
  }
  clear() {
    this.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = ''; this.file = null; this.frames = [];
    this.dur0 = 0; this.start = this.end = this.t = 0; this.cut = null; this.pps = 0; this.undo = [];
    this.q('.at-name').textContent = 'видео не загружено';
    this.q('.at-len').textContent = '—';
    this.q('.vt-body').hidden = true;
  }
  async _thumbs() {                            // frames across the whole strip: the bench must not be blind
    const v = this.q('.vt-view'), n = 16;
    this.frames = new Array(n).fill(null);
    if (v.readyState < 2) {
      await new Promise(res => {
        let to = 0;
        const done = () => { clearTimeout(to); v.removeEventListener('loadeddata', done); res(); };
        to = setTimeout(done, 1200);
        v.addEventListener('loadeddata', done);
      });
    }
    const was = v.currentTime;
    for (let i = 0; i < n; i++) {
      const tt = Math.min(Math.max(0, this.dur0 - 0.05), this.dur0 * (i + 0.5) / n);
      // every seek gets its own deadline: one frame the browser refuses must not stop the whole strip
      await new Promise(res => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(to); v.onseeked = null; res(); };
        const to = setTimeout(finish, 400);
        v.onseeked = finish;
        try { v.currentTime = tt; } catch (e) { finish(); }
      });
      try {
        const c = document.createElement('canvas');
        c.width = 140; c.height = Math.max(28, Math.round(140 * (v.videoHeight || 9) / (v.videoWidth || 16)));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        this.frames[i] = c;
      } catch (e) { this.frames[i] = null; }
      this._paint();
    }
    v.onseeked = null;
    try { v.currentTime = this.t; } catch (e) {}
    this._paint();
  }
  _paint() {
    const cv = this.q('.vt-cv'); if (!cv || !this.dur0) return;
    const dpr = devicePixelRatio || 1, cssW = cv.clientWidth || 600;
    cv.width = Math.round(cssW * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, 86);
    if (!this.frames.filter(Boolean).length) {         // frames are still coming: a grid is honest, a void is not
      g.fillStyle = '#151a21'; g.fillRect(0, 0, cssW, 86);
      g.fillStyle = 'rgba(255,255,255,.45)'; g.font = '11px system-ui';
      g.fillText('кадры ещё читаются…', 8, 18);
    }
    const n = this.frames.length || 1;
    this.frames.forEach((im, i) => {
      if (!im) return;
      const x = cssW * i / n, cw = cssW / n;
      g.drawImage(im, x, 0, cw + 1, 86);
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x + cw - 1, 0, 1, 86);
    });
    // the ruler under the frames: how many seconds fit depends on the strip width
    const span = this.dur0, pps = cssW / span;
    const step = span / (cssW / 70) > 4 ? 5 : span / (cssW / 70) > 1.6 ? 2 : 1;
    g.font = '10px system-ui';
    for (let s2 = 0; s2 <= span + .001; s2 += step) {
      const x = s2 * pps;
      g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(x, 78, 1, 8);
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.fillText(Math.round(s2) + ' с', Math.min(cssW - 26, x + 3), 76);
    }
  }
  _sync() {
    const strip = this.q('.vt-strip'), wrap = this.q('.vt-stripwrap');
    const wpx = this.stripW();
    strip.style.width = wpx ? wpx + 'px' : '100%';
    wrap.style.overflowX = wpx ? 'auto' : 'hidden';
    const sel = this.q('.vt-sel'), ph = this.q('.vt-ph');
    sel.style.left = (this.start / this.dur0 * 100) + '%';
    sel.style.width = (Math.max(0, this.len()) / this.dur0 * 100) + '%';
    sel.hidden = !this.dur0;
    // the grip is placed in pixels and clamped inside the film, so at the very first second it is still
    // under the cursor; --k keeps the yellow line exactly at its time whatever the grip does
    const W = strip.clientWidth || 1, GRIP = 24;
    const linePx = this.dur0 ? this.t / this.dur0 * W : 0;
    const boxLeft = Math.max(0, Math.min(W - GRIP, linePx - GRIP / 2));
    ph.style.left = boxLeft + 'px';
    ph.style.setProperty('--k', (linePx - boxLeft) + 'px');
    ph.hidden = !this.dur0;
    const runPx = this.dur0 ? this.run / this.dur0 * W : 0;
    const run = this.q('.vt-run');
    run.style.left = Math.max(0, Math.min(W - 2, runPx)) + 'px';
    run.style.setProperty('--k', '0px');
    run.hidden = !this.dur0 || Math.abs(this.run - this.t) < .01;
    ph.classList.toggle('near-left', linePx < 34);
    ph.classList.toggle('near-right', linePx > W - 34);
    // two decimals and the frame number: a frame is 1/24 = 0,04 с, so with one decimal two
    // neighbouring frames showed the same number, which is exactly what the plate is for
    this.q('.vt-span').textContent = this.dur0
      ? 'маркер ' + this.fmt2(this.t) + ' с · кадр ' + Math.round(this.t * this.fps) : '';
    this.q('.at-len').textContent = this.dur0 ? this.fmt(this.dur0) + ' с' : '—';
    this.q('.vt-a').value = this.fmt(this.start).replace(',', '.');
    this.q('.vt-b2').value = this.fmt(this.end).replace(',', '.');
    const over = this.len() > this.limit + .1;
    this.q('.vt-left').innerHTML = this.dur0
      ? 'в монтаже останется <b>' + this.fmt(this.len()) + ' с</b> из ' + this.fmt(this.dur0) + ' с' +
        (over ? ' · <b style="color:var(--pink)">дальше ' + this.limit + ' с модель не смотрит</b>' : '')
      : '';
    this.q('.at-hint').textContent = this.isPiece
      ? 'В ленте лежит нарезанный кусок - ' + this.fmt(this.dur0) + ' с. Оригинальный файл цел: «Вернуть целый» положит его обратно.'
      : (this.cut ? 'Отмечено ' + this.fmt(this.len()) + ' с из ' + this.fmt(this.dur0) + ' с.' : '');
    this.q('.vt-keep').disabled = !this.dur0 || this.busy;
    this.q('.vt-shot').disabled = !this.dur0;
    this.q('.vt-reset').disabled = !this.isPiece;
    this.q('.vt-ag').disabled = !this.dur0;
    const zr = this.q('.vt-zr');
    zr.value = this.pps || 0;
    if (typeof paintRange === 'function') paintRange(zr);
    this.q('.vt-pp').textContent = this.pps ? Math.round(this.pps) + ' px/с' : 'по ширине окна';
    this._paint();
  }
  _still() {                                  // the player stands on the marker and shows it as a still
    const v = this.q('.vt-view');
    if (!this.dur0) return;
    this.stop();
    try { v.currentTime = Math.min(this.dur0 - 0.04, this.t); } catch (e) {}
  }
  _step(dir, n) {                             // one frame at a time - that is what the arrows are for
    const dt = (n || 1) / this.fps;
    this.t = Math.min(this.dur0, Math.max(0, this.t + dir * dt));
    this._sync(); this._still();
  }
  _play(from, to) {
    const v = this.q('.vt-view');
    if (!this.dur0) return;
    v.currentTime = from;
    v.play().catch(() => {});
    cancelAnimationFrame(this.raf);
    const step = () => {
      this.run = v.currentTime || 0;                 // the marker stays where the person put it
      this._sync();
      if (this.run >= to - .02 || this.run >= this.dur0 - .02) { this.stop(); return; }
      this.raf = requestAnimationFrame(step);
    };
    step();
  }
  stop() { const v = this.q('.vt-view'); if (v) v.pause(); cancelAnimationFrame(this.raf); this.raf = 0; this.run = this.t; }
  _setPps(v) {
    this.pps = v <= 0 ? 0 : Math.min(300, Math.max(10, v));
    try { localStorage.setItem('h3-vt-px', String(this.pps)); } catch (e) {}
    this._sync();
    requestAnimationFrame(() => this._sync());   // the strip just changed size - the ruler needs a repaint
  }
  _wire() {
    const strip = this.q('.vt-strip');
    const at = e => {
      const r = strip.getBoundingClientRect();
      return Math.min(this.dur0, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width) * this.dur0));
    };
    let drag = null;
    strip.addEventListener('pointerdown', e => {
      if (!this.dur0) return;
      const h = e.target.closest('.at-h');
      if (h) { drag = h.dataset.h; this._dragH = drag; }   // later events no longer carry the handle
      else if (e.target.closest('.vt-ph')) {
        if (e.target.closest('button')) return;            // its own buttons step and cut
        drag = 'ph'; this._dragH = 'ph';                   // the line itself is the thing you drag
      } else if (e.target.closest('button')) return;
      else {
        // a click does not move the marker: left of it plays up to it, right of it plays from it
        const x = at(e);
        if (x < this.t) this._play(this.start, this.t);
        else this._play(this.t, Math.min(this.end, this.dur0));
        return;
      }
      // a synthetic or already-released pointer has no capture to take, and that must not stop the drag
      try { strip.setPointerCapture(e.pointerId); } catch (err) {}
      const up = () => { drag = null; this._dragH = null; window.removeEventListener('pointerup', up); };
      window.addEventListener('pointerup', up);
      this._move(e);
    });
    strip.addEventListener('pointermove', e => { if (drag) this._move(e); });
    window.addEventListener('pointermove', e => {
      if (!drag || strip.contains(e.target)) return;      // outside the strip the capture may be lost
      const r = strip.getBoundingClientRect();
      this._move({ clientX: Math.min(r.right, Math.max(r.left, e.clientX)), target: strip, currentTarget: strip });
    });
    strip.addEventListener('pointerup', () => { drag = null; });
    strip.addEventListener('pointercancel', () => { drag = null; });
    strip.addEventListener('dblclick', () => {           // the same double click the montage taught
      if (!this.dur0) return;
      if (this.cut || this.start > .02 || this.end < this.dur0 - .02) {
        this._push(); this.start = 0; this.end = this.dur0; this.cut = null;
        this._sync(); this.onWhole(this);
        this.say('Вернули целый клип');
      }
    });
    this.el.querySelectorAll('.vt-b').forEach(b => {
      b.onclick = ev => {
        ev.stopPropagation();
        const k = b.dataset.s;
        if (k === 'back') this._step(-1);
        else if (k === 'fwd') this._step(1);
        else if (k === 'left') {
          if (this.t <= this.start + .02 || this.t >= this.end - .02) { this.say('Поставьте маркер внутрь куска'); return; }
          this._push(); this.start = this.t; this._sync();
          this.say('Убрано до маркера: осталось ' + this.fmt(this.len()) + ' с');
        } else if (k === 'right') {
          if (this.t >= this.end - .02 || this.t <= this.start + .02) { this.say('Поставьте маркер внутрь куска'); return; }
          this._push(); this.end = this.t; this._sync();
          this.say('Убрано после маркера: осталось ' + this.fmt(this.len()) + ' с');
        }
      };
    });
    this.q('.vt-play').onclick = () => {
      const v = this.q('.vt-view');
      if (this.busy) return;
      if (v.paused) this._play(this.start, this.end); else { this.stop(); this._still(); }
    };
    this.q('.vt-zm').onclick = () => this._setPps((this.pps || Math.round((this.q('.vt-stripwrap').clientWidth || 600) / Math.max(1, this.dur0))) - 20);
    this.q('.vt-zp').onclick = () => this._setPps((this.pps || Math.round((this.q('.vt-stripwrap').clientWidth || 600) / Math.max(1, this.dur0))) + 20);
    this.q('.vt-fit').onclick = () => this._setPps(0);
    this.q('.vt-zr').addEventListener('input', e => this._setPps(+e.target.value));
    const num = (inp, which) => inp.onchange = () => {
      const v = Math.min(this.dur0, Math.max(0, parseFloat(String(inp.value).replace(',', '.')) || 0));
      if (which === 'a') this.start = Math.min(v, this.end - .1); else this.end = Math.max(v, this.start + .1);
      this._sync();
    };
    num(this.q('.vt-a'), 'a'); num(this.q('.vt-b2'), 'b');
    this.q('.vt-reset').onclick = () => {
      if (this.origFile && this.isPiece) {          // the whole file goes back onto the strip
        this.isPiece = false; this.cut = null;
        this.setFile(this.origFile, true);
        this.onWhole(this);
        this.say('Вернули целый файл: ' + this.fmt(this.dur0) + ' с');
        return;
      }
      this._push(); this.start = 0; this.end = this.dur0; this.cut = null; this._sync(); this.onWhole(this);
    };
    this.q('.vt-und').onclick = () => {
      const s = this.undo.pop(); if (!s) return;
      this.start = s.s; this.end = s.e; this.cut = s.cut; this.t = s.t;
      this.q('.vt-und').disabled = !this.undo.length;
      this._sync(); this._still();
    };
    this.q('.vt-keep').onclick = () => this.out(true);
    this.q('.vt-shot').onclick = () => this.shot();
    this.q('.vt-ag').onclick = async () => {
      // the agent can look at a video only as at frames, and that road already exists - the paperclip's
      const go = window.agFramesFromFile;
      if (typeof go !== 'function') { this.say('Сценарист пока не умеет смотреть видео'); return; }
      const tg = document.querySelector('#agTarget [data-t="' + (this.o.agentTarget || 'long') + '"]');
      if (tg) tg.click();
      agentGo();
      try { if (!agentState().status || !agentState().status.speech_ready) await agentStatus(); } catch (e) {}
      const ok = await go(this.cut ? this.cutFile : this.file);
      if (ok !== false) this.say('Клип отправлен сценаристу: вырежем из него кадры');
    };
    window.addEventListener('resize', () => { if (this.dur0) this._sync(); });
  }
  _move(e) {
    const r = this.q('.vt-strip').getBoundingClientRect();
    const t2 = Math.min(this.dur0, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width) * this.dur0));
    // which handle was grabbed is remembered at pointerdown: a move event does not carry it any more
    const h = this._dragH || (e.target && e.target.closest ? (e.target.closest('.at-h') || {}).dataset?.h : null);
    if (h === 'l') this.start = Math.min(t2, this.end - .1);
    else if (h === 'r') this.end = Math.max(t2, this.start + .1);
    else { this.t = t2; this.run = t2; }
    this._sync();
    if (h === 'ph' || !h) this._still();   // dragging the marker shows that frame in the player
  }
  async shot() {
    // the marker is the place; the player already stands on it, and if it does not - we ask for that frame
    const v = this.q('.vt-view');
    if (!this.dur0) { this.say('Сначала загрузите видео'); return null; }
    this.stop();
    const want = Math.min(Math.max(0, this.t), Math.max(0, this.dur0 - .02));
    // always ask for the frame, even when the clock already shows that time: the picture on the screen can
    // still be the previous one, and a photograph of it would be a lie - so we wait for seeked, then for a
    // paint, and only then take the canvas
    for (let tries = 0; tries < 3; tries++) {
      await new Promise(res => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(to); v.onseeked = null; res(); };
        const to = setTimeout(finish, 1200);
        v.onseeked = finish;
        try { v.currentTime = want; } catch (e) { finish(); }
        if (Math.abs((v.currentTime || 0) - want) < .005) setTimeout(finish, 60);
      });
      await new Promise(res => requestAnimationFrame(() => res()));
      if (v.videoWidth) break;
    }
    if (Math.abs((v.currentTime || 0) - want) > .35) {
      this.say('Браузер не перематывает к нужному месту - кадр не взят, чтобы не врать');
      return null;
    }
    const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
    const c = document.createElement('canvas'); c.width = vw; c.height = vh;
    let ok = true;
    try { c.getContext('2d').drawImage(v, 0, 0, vw, vh); } catch (e) { ok = false; }
    if (!ok) { this.say('Кадр взять не удалось - браузер не отдаёт картинку'); return null; }
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    if (!blob || !blob.size) { this.say('Кадр не получился'); return null; }
    const stem = this.name.replace(/\.[a-z0-9]+$/i, '');
    const f = new File([blob], stem + ' \u00b7 \u043a\u0430\u0434\u0440 ' + Math.round(this.t * this.fps) +
      ' (' + this.fmt2(this.t) + ' \u0441).png', { type: 'image/png' });
    f.__from = this.name; f.__at = this.fmt2(this.t) + ' \u0441';   // the library shows where it came from
    if (this.o.onFrame) this.o.onFrame(f, this);
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f); a.download = f.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.say('Кадр сохранён в файл: ' + f.name);
    }
    return f;
  }
  out(force) {
    if (!force || !this.dur0) { this._sync(); return null; }
    const s = this.start, e = this.end;
    if (e - s < .6) { this.say('Кусок короче секунды: модель его не разберёт'); return null; }
    if (e - s > this.limit + .1) { this.say('Видео не длиннее ' + this.limit + ' с: сейчас ' + this.fmt(e - s) + ' с'); return null; }
    if (Math.abs(s) < .02 && Math.abs(e - this.dur0) < .02) { this.say('Ничего не убрано - клип пойдёт целиком'); return null; }
    if (this.busy) return null;
    this.busy = true; this.q('.vt-keep').disabled = true;
    this.say('Режу клип - это секунды, не минуты…');
    const stem = this.name.replace(/\.[a-z0-9]+$/i, '').replace(/(-кусок)+$/g, '');
    fetch('/api/video/cut?start=' + s.toFixed(3) + '&end=' + e.toFixed(3) + '&name=' + encodeURIComponent(this.name),
      { method: 'POST', body: this.file })
      .then(async r => {
        if (!r.ok) {
          let msg = 'Разрезать не удалось';
          try { msg = (await r.json()).error || msg; } catch (e3) {}
          throw new Error(msg);
        }
        return r.blob();
      })
      .then(blob => {
        this.busy = false;
        const piece = new File([blob], stem + '-кусок.mp4', { type: 'video/mp4' });
        this.cutFile = piece;
        this.onFile(piece, this);
        // what lies on the strip must be what goes to the model: the piece itself, cut out and with its
        // own frames - not the old film with two marks on it, where one frame was stretched over everything
        this.isPiece = true;
        this.setFile(piece, true);
        this.say('Клип разрезан: ' + this.fmt(e - s) + ' с - в ленте теперь он целиком');
      })
      .catch(err => { this.busy = false; this._sync(); this.say((err && err.message) || 'Разрезать не удалось'); });
    return null;
  }
}

/* ---------- AudioRow: три аудио с тегами и ножницами, один и тот же блок в любом месте ---------- */
/* The row that scene audio grew up with, lifted out so any card can have it: three slots, a chip with
   each file's tag, the same trimmer, a counter. base numbers the tags (1 for the whole film, a decade
   for one scene); limit 0 means "as long as it is" - the fifteen seconds were the rule of the old
   shared loader, not of a sample. It knows nothing about the page it sits on: the owner passes a
   callback, so the same class serves the film and every scene. */
export class AudioRow {
  constructor(o) {
    this.mount = o.mount; this.base = o.base || 1; this.limit = o.limit === 0 ? 0 : (o.limit || 15);
    this.onChange = o.onChange || (() => {}); this.whereLabel = o.whereLabel || (j => 'аудио ' + (j + 1));
    this.files = [null, null, null]; this.src = [null, null, null]; this.sel = [null, null, null]; this.dur = [null, null, null];
    this.pick = -1; this._slot = -1;
    this.el = document.createElement('div');
    this.el.className = 'arow';
    this.el.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center'   // the gaps come from .arow, so the stylesheet can still steer them;
    this.trim = document.createElement('div');
    this.trim.hidden = true; this.trim.style.marginTop = '8px';
    this.mount.append(this.el, this.trim);
    this.inp = document.createElement('input');
    this.inp.type = 'file'; this.inp.accept = 'audio/*,.wav,.mp3,.ogg,.flac,.m4a'; this.inp.hidden = true;
    this.mount.append(this.inp);
    this.inp.onchange = () => {
      const f = this.inp.files && this.inp.files[0];
      let j = this.pick; this.pick = -1; this.inp.value = '';
      if (!f) return;
      if (j < 0) j = this.files.findIndex(x => !x);
      if (j < 0) { toast('Больше трёх аудио здесь нельзя'); return; }
      this.set(j, f);
      toast('Аудио <Audio ' + (this.base + j) + '>: ' + f.name + (this.limit ? ' - при желании обрежьте (до ' + this.limit + ' с)' : ' - при желании обрежьте, длина не ограничена'));
    };
    this.el.onclick = e => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const j = +b.dataset.j;
      if (b.dataset.a === 'add') {
        this.pick = this.files.findIndex(x => !x);
        if (this.pick < 0) { toast('Больше трёх аудио здесь нельзя'); return; }
        this.inp.click();
      } else if (b.dataset.a === 'del') {
        this.set(j, null);
        if (this._tr && this._tr._slot === j) { this._tr.clear(); this._tr._slot = -1; this.trim.hidden = true; }
      } else if (b.dataset.a === 'trim') this.openTrim(j);
    };
    // a file may also be dragged onto the row, as the old single loader accepted it
    this.el.addEventListener('dragover', e => { e.preventDefault(); this.el.style.outline = '1px dashed var(--accent)'; });
    this.el.addEventListener('dragleave', () => { this.el.style.outline = ''; });
    this.el.addEventListener('drop', e => {
      e.preventDefault(); this.el.style.outline = '';
      const got = [...((e.dataTransfer && e.dataTransfer.files) || [])].find(x => /^audio\//.test(x.type) || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(x.name));
      if (!got) { toast('Перетащите аудиофайл: mp3, wav, m4a, ogg или flac'); return; }
      const j = this.files.findIndex(x => !x);
      if (j < 0) { toast('Больше трёх аудио здесь нельзя'); return; }
      this.set(j, got);
      toast('Аудио <Audio ' + (this.base + j) + '>: ' + got.name);
    });
    this.paint();
  }
  set(j, f) { this.files[j] = f; this.src[j] = f; this.sel[j] = null; this.dur[j] = null; this.paint(); this.onChange(j, f); }
  used() { return this.files.filter(Boolean).length; }
  openTrim(j) {
    const src = this.src[j] || this.files[j];
    if (!src) return;
    if (!this._tr) {
      this._tr = new AudioTrimmer({
        mount: this.trim, limit: this.limit,
        whereLabel: q => this.whereLabel(q._slot),
        onFile: f => {
          const j2 = this._tr._slot, s0 = this.src[j2] || f;
          this.dur[j2] = this._tr.len();
          this.files[j2] = new File([f], s0.name.replace(/\.[a-z0-9]+$/i, '') + '.wav', { type: 'audio/wav' });
          this.sel[j2] = { start: this._tr.start, end: this._tr.end, of: s0.name };
          this.paint(); this.onChange(j2, this.files[j2]);
        },
        onState: tr => { const j3 = tr._slot; if (j3 >= 0 && tr.dur0 && !this.sel[j3]) this.dur[j3] = tr.dur0; },
      });
    }
    if (!this.trim.hidden && this._tr._slot === j) {          // the second click closes: what was marked is applied
      const keep = this.sel[j] || this._tr._loaded || { start: 0, end: this._tr.dur0 };
      if (this._tr.dur0 && (Math.abs(this._tr.start - keep.start) > .05 || Math.abs(this._tr.end - keep.end) > .05)) this._tr.out();
      this.trim.hidden = true;
      return;
    }
    this.trim.hidden = false;
    if (this._tr._slot !== j || !this._tr.dur0) {
      this._tr._slot = j;
      this._tr.setFile(src, true);                            // the original always opens, so a second cut is possible
      const s = this.sel[j];
      if (s && src === this.src[j] && s.end <= this._tr.dur0 + .2) {
        this._tr.start = s.start; this._tr.end = Math.min(s.end, this._tr.dur0);
        this._tr._loaded = { start: s.start, end: this._tr.end }; this._tr._sync();
      }
    }
  }
  paint() {
    const e2 = s => String(s).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
    const full = this.used() >= 3;
    this.el.innerHTML = '<button class="btn mini" type="button" data-a="add"' + (full ? ' disabled' : '') +
      ' title="До трёх файлов. Модель получает их как образцы и применяет там, где вы упомянули файл тегом в тексте">+ Загрузить аудио</button>' +
      '<span class="counter" title="Аудио здесь: не больше трёх">' + this.used() + ' / 3</span>' +
      this.files.map((f, j) => f ? '<span class="token" style="display:inline-flex;gap:6px;align-items:center">&lt;Audio ' +
        (this.base + j) + '&gt; ' + e2(f.name.slice(0, 18)) +
        (this.sel[j] && this.sel[j].start != null && this.sel[j].end != null ? ' <small style="opacity:.75">с ' + (+this.sel[j].start).toFixed(1).replace('.', ',') + ' по ' + (+this.sel[j].end).toFixed(1).replace('.', ',') + ' с</small>' : '') +
        ' <button class="btn mini" type="button" data-a="trim" data-j="' + j + '" title="Послушать и обрезать: прибор под строкой">Обрезать</button>' +
        '<button class="btn mini" type="button" data-a="del" data-j="' + j + '" title="Убрать это аудио">×</button></span>' : '').join('') +
      (full ? '<span class="hint" style="font-size:12px">три аудио - максимум</span>' : '');
  }
}

/* The tags one scene offers: the film's samples first, then the scene's own. A chip whose tag already
   stands in the text is marked; once three tags are in, the rest stop offering themselves - the model
   cannot listen to more than three audios in one pass. */
export class AudioTrimmer {
  constructor(o = {}) {
    this.o = o;
    // limit 0 means "no cap": the background of a whole film is longer than one scene
    this.limit = o.limit === 0 ? 0 : (o.limit || 15);
    this.onFile = o.onFile || (() => {});
    this.whereLabel = o.whereLabel || null;   // where this file lives: the place is known here, not by name
    this.say = o.onNotice || (m => toast(m));
    // the owner may want a calmer start than the hard cap (LipSync selects 12 s of a long song), a soft
    // warning before that cap, its own word for the length, and its own veto on separating a voice
    this.preselect = o.preselect || 0;
    this.warnOver = o.warnOver || 0;
    this.canVocals = o.canVocals || null;
    this.lenLabel = o.lenLabel || 'Длина аудио';
    this.dur0 = 0; this.start = 0; this.end = 0;
    this.zoom = 1; this.undo = []; this.buf = null; this.name = '';
    this.mode = 'clip'; this.src = null; this.raf = 0; this.busy = false;
    this.el = document.createElement('div'); this.el.className = 'atrim';
    this.el.innerHTML =
      '<div class="at-top"><button class="btn mini at-play" type="button" title="Прослушать выделенное">&#9654;</button>' +
      '<div class="at-name">аудио не загружено</div><div class="at-len">—</div></div>' +
      '<div class="at-body" hidden>' +
      '<div class="at-wave"><canvas class="at-cv" height="86"></canvas>' +
      '<div class="at-sel" hidden><i class="at-h" data-h="l"></i><i class="at-h" data-h="r"></i></div>' +
      '<div class="at-fade" hidden>' +
      '<button class="at-fd" type="button" data-f="l" title="Плавно набирает силу: тишина у левого маркера - полная громкость у правого. За краями выделенного звук не меняется."><svg viewBox="0 0 20 14" aria-hidden="true"><path d="M1 13V11h4V8h4V5h4V2h6"/></svg></button>' +
      '<button class="at-fd" type="button" data-f="r" title="Плавно стихает: полная громкость у левого маркера - тишина у правого. За краями выделенного звук не меняется."><svg viewBox="0 0 20 14" aria-hidden="true"><path d="M19 13V11h-4V8h-4V5h-4V2H1"/></svg></button>' +
      '</div>' +
      '<div class="at-ph" hidden></div></div>' +
      '<div class="at-modes"><button class="on" type="button" data-m="clip" title="Выбор фрагмента: то, что выделено, пойдёт в клип">Выбор фрагмента</button>' +
      '<button type="button" data-m="cut" title="Вырезание: отметить кусок теми же маркерами, убрать его и склеить остаток">Вырезание</button>' +
      '<button type="button" data-m="fade" title="Затухание: внутри выделенного появятся две лесенки - спуск или подъём от одного маркера до другого">Затухание</button></div>' +
      '<div class="at-hint"></div>' +
      '<div class="at-acts"><button class="btn pri at-keep" type="button" disabled>Оставить выделенное</button>' +
      '<button class="btn at-paus" type="button" disabled>Убрать паузы</button>' +
      '<button class="btn at-voc" type="button" disabled>Отделить голос</button>' +
      '<button class="btn at-und" type="button" disabled title="Вернуть аудио ровно таким, каким оно было загружено: все спуски, разрезы и чистки пауз отменятся">Откат</button>' +
      '<button class="btn at-back" type="button" disabled title="Вернуть последнее изменение аудио - один шаг, а не всё сразу">Шаг назад</button>' +
      '<button class="btn at-ag" type="button" disabled title="Выделенный кусок уйдёт в Сценарист: он послушает слова и ответит с учётом них">🤖 К сценаристу</button></div>' +
      '<div class="at-pz" hidden><span>Паузы длиннее</span><input type="number" class="at-pm" value="0,6" step="0.1" min="0.2" max="5">' +
      '<span>с сократить до</span><input type="number" class="at-pk" value="0,25" step="0.05" min="0.05" max="2"><span>с</span>' +
      '<b class="at-pzi"></b><button class="btn mini pri at-pgo" type="button" disabled>Убрать</button></div>' +
      '<div class="at-zoom"><span>Резать удобнее с приближением:</span><button class="btn mini at-zm" type="button">−</button>' +
      '<input type="range" class="at-zr" min="1" max="40" step="1" value="1"><button class="btn mini at-zp" type="button">+</button>' +
      '<input type="range" class="at-pp" min="0" max="1000" step="1" value="0" title="Какую часть аудио показывает волна: тяните, когда приближено">' +
      '<span class="at-zl">весь фрагмент</span><button class="btn mini at-z0" type="button">Весь фрагмент</button></div>' +
      '<div class="at-nums"><label>Начало, с<input type="text" inputmode="decimal" class="at-a" placeholder="0,0" disabled></label>' +
      '<label>Конец, с<input type="text" inputmode="decimal" class="at-b" placeholder="15,0" disabled></label>' +
      '<div class="at-box"><span class="at-cap">' + this.lenLabel + '</span><b class="at-dur">—</b></div></div>' +
      '<div class="at-warn" hidden></div>' +
      '<div class="at-words" hidden></div>' +
      '</div>' +
      '<div class="at-empty">Загрузите аудио - и здесь появится редактор: волна, выделение, паузы, голос.</div>';
    (o.mount || document.body).append(this.el);
    this.q = s => this.el.querySelector(s);
    this.peaks = [];
    this.cv = this.q('.at-cv'); this.g = this.cv.getContext('2d');
    this._wire(); this._hint();
  }
  len() { return Math.max(0, this.end - this.start); }
  /* window shown on the screen: the whole clip at zoom 1, a narrower piece around the selection above */
  view() {
    const d = this.dur0 || 1, span = d / this.zoom;
    if (this.zoom <= 1.02) return [0, Math.min(d, span)];
    const free = Math.max(0, d - span);
    // the person may slide the window by hand; until they do, it follows the selection
    const a = (this._pan != null) ? free * this._pan : Math.min(Math.max(0, this.start - span * .15), free);
    return [a, Math.min(d, a + span)];
  }
  _zinfo() {
    if (this.zoom <= 1.02) return 'весь фрагмент';
    const [a, b] = this.view();
    return 'видно ' + a.toFixed(1).replace('.', ',') + '–' + b.toFixed(1).replace('.', ',') + ' с из ' +
      Math.round(this.dur0) + ' · ×' + this.zoom;
  }
  fracAt(t) { const [a, b] = this.view(); return (t - a) / Math.max(.001, b - a); }
  tAt(p) { const [a, b] = this.view(); return a + p * (b - a); }
  _hint() {
    this.q('.at-hint').textContent = this.mode === 'fade'
      ? 'Выделите участок и нажмите лесенку ВНУТРИ него: правая - звук плавно стихает от левого маркера до правого, левая - наоборот, набирает силу. За краями выделенного звук остаётся как был.'
      : this.mode === 'cut'
      ? 'Тем же выделением отметьте кусок, который нужно убрать: маркеры слева и справа - начало и конец. Нажмите «Вырезать и склеить» - остаток склеится, а маркеры встанут на место склейки.'
      : 'Выделите, что оставить в клипе, и нажмите «Оставить выделенное» - остальное аудио уберётся.';
  }
  async setFile(f, silent) {
    if (!f) return;
    this.stop();
    try { this.buf = await (actx = actx || new AudioContext()).decodeAudioData(await f.arrayBuffer()); }
    catch { this.say('Не удалось прочитать этот аудиофайл'); return; }
    this.name = f.name; this.dur0 = this.buf.duration;
    this.buf0 = this.buf; this.name0 = f.name;   // what the file was when it came in: «Откат» returns to this
    const cap = this.preselect ? Math.min(this.dur0, this.preselect)
      : (this.limit > 0 ? Math.min(this.dur0, this.limit) : this.dur0);
    this.start = 0; this.end = cap; this.undo = []; this._pan = null;
    this.zoom = 1; this.q('.at-zr').value = 1; paintRange(this.q('.at-zr'));
    if (this.q('.at-pm')) { this.q('.at-pm').value = '0,6'; this.q('.at-pk').value = '0,25'; }
    if (this.q('.at-pz')) this.q('.at-pz').hidden = true;
    this._loaded = { start: this.start, end: this.end };   // closing must apply only what the person changed
    this.busy = !!silent;
    this._peaks(); this._paint(); this._sync();
    if (!silent) this.out();
    this.busy = false;
  }
  _peaks() {
    const ch = this.buf.getChannelData(0), N = 900, step = Math.max(1, Math.floor(ch.length / N));
    this.peaks = Array.from({ length: N }, (_, i) => { let m = 0; for (let j = i * step; j < (i + 1) * step; j += 16) m = Math.max(m, Math.abs(ch[j] || 0)); return m; });
    const mx = Math.max(...this.peaks) || 1; this.peaks = this.peaks.map(p => p / mx);
  }
  _paint() {
    const box = this.q('.at-wave'), dpr = devicePixelRatio || 1, W = Math.max(80, box.clientWidth), H = 86;
    this.cv.width = W * dpr; this.cv.height = H * dpr; this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
    const g = this.g; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const [a, b] = this.view(), P = this.peaks || [], n = P.length || 1, mid = H / 2;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#6d8cff';
    for (let x = 0; x < W; x++) {
      const t0 = a + (b - a) * (x / W), t1 = a + (b - a) * ((x + 1) / W);
      let m = 0, i0 = Math.floor(t0 / (this.dur0 || 1) * n), i1 = Math.ceil(t1 / (this.dur0 || 1) * n);
      for (let i = Math.max(0, i0); i < Math.min(n, Math.max(i0 + 1, i1)); i++) m = Math.max(m, P[i]);
      const h = Math.max(1, m * (H - 8));
      g.globalAlpha = (t0 >= this.start && t1 <= this.end) ? 1 : .34;
      g.fillRect(x, mid - h / 2, 1, h);
    }
    g.globalAlpha = 1;
    const sel = this.q('.at-sel'), px = t => this.fracAt(t) * W;
    if (this.dur0) {
      sel.hidden = false; sel.style.left = Math.max(0, px(this.start)) + 'px';
      sel.style.width = Math.max(0, px(this.end) - px(this.start)) + 'px';
    } else sel.hidden = true;
    // the two stairs of the fade mode stand on the edges of what is marked, not in the corner
    const fd = this.q('.at-fade');
    if (fd) {
      const show = this.mode === 'fade' && !!this.dur0;
      fd.hidden = !show;
      if (show) {
        // both stairs stand INSIDE the marked piece, near its edges: sitting on the markers they
        // covered them and looked like one control, and a narrow selection merged them together
        const x0 = px(this.start), x1 = px(this.end), bw = 34, gap = 5;
        let lx = x0 + gap, rx = x1 - bw - gap;
        if (rx - lx < bw + 6) { const mid = (x0 + x1) / 2; lx = mid - bw - 2; rx = mid + 2; }   // too narrow: split around the middle
        lx = Math.max(0, Math.min(lx, W - bw)); rx = Math.max(0, Math.min(rx, W - bw));
        fd.querySelector('[data-f="l"]').style.left = lx + 'px';
        fd.querySelector('[data-f="r"]').style.left = rx + 'px';
      }
    }
  }
  _sync() {
    const on = !!this.dur0;
    if (this.o && this.o.onState) { try { this.o.onState(this); } catch (e) {} }
    const away = this.dur0 - this.len(), whole = on && this.start <= .001 && this.end >= this.dur0 - .001;
    this.q('.at-name').textContent = on ? this.name : 'аудио не загружено';
    this.q('.at-dur').textContent = on ? this.len().toFixed(1).replace('.', ',') + ' с' : '—';
    this.q('.at-len').textContent = on ? 'всего ' + this.dur0.toFixed(0) + ' с' : '';
    this.q('.at-a').disabled = this.q('.at-b').disabled = !on;
    if (document.activeElement !== this.q('.at-a')) this.q('.at-a').value = on ? this.start.toFixed(1).replace('.', ',') : '';
    if (document.activeElement !== this.q('.at-b')) this.q('.at-b').value = on ? this.end.toFixed(1).replace('.', ',') : '';
    const keep = this.q('.at-keep');
    keep.disabled = !on || this.len() < .05 || (this.mode !== 'cut' && whole);
    keep.textContent = this.mode === 'cut'
      ? '✂ Вырезать ' + this.len().toFixed(1).replace('.', ',') + ' с и склеить'
      : (whole ? '✂ Оставить выделенное' : '✂ Оставить выделенное - убрать ' + away.toFixed(1).replace('.', ','));
    keep.title = this.mode === 'cut'
      ? 'Убрать то, что между маркерами, и склеить остаток; маркеры встанут на место склейки'
      : 'Оставить то, что между маркерами, а остальное аудио убрать';
    this.q('.at-paus').disabled = this.q('.at-voc').disabled = !on;
    this.q('.at-ag').disabled = !on;
    this.q('.at-und').disabled = !(on && this.buf0 && this.buf !== this.buf0);   // live only while the sound differs from the original
    const back = this.q('.at-back'); if (back) back.disabled = !(on && this.undo.length);
    const pp = this.q('.at-pp');
    if (pp) {
      pp.hidden = !(on && this.zoom > 1.02);
      const free = Math.max(1, this.dur0 - this.dur0 / this.zoom);
      const a = this.view()[0];
      if (document.activeElement !== pp) pp.value = String(Math.round(1000 * a / free));
      paintRange(pp);
    }
    this.q('.at-zl').textContent = this._zinfo();
    const body = this.q('.at-body'), empty = this.q('.at-empty');
    if (body) body.hidden = !on;
    if (empty) empty.hidden = !!on;
    const warn = this.q('.at-warn');
    if (on && this.limit > 0 && this.len() > this.limit + .05) {
      warn.hidden = false;
      warn.textContent = 'Максимум ' + this.limit + ' секунд — укоротите фрагмент.';
    } else if (on && this.warnOver > 0 && this.len() > this.warnOver) {
      // the model stops listening before the hard cap: warn while there is still time to shorten
      warn.hidden = false;
      warn.textContent = 'Оставьте небольшую паузу: дальше ' + this.warnOver + ' с модель может не дослушать.';
    } else if (on && this.undo.length && !whole) { warn.hidden = false; warn.textContent = 'Аудио изменено: убрано ' + away.toFixed(1).replace('.', ',') + ' с. «Шаг назад» вернёт последнее, «Откат» — всё сразу.'; }
    else warn.hidden = true;
    this._paint();
  }
  _commit(newBuf, mapT) {
    this.stop();
    this.undo.push({ buf: this.buf, start: this.start, end: this.end });
    if (this.undo.length > 15) this.undo.shift();
    this.buf = newBuf; this.dur0 = newBuf.duration;
    // a mapper over the old markers, or the new markers themselves: cutting the marked piece out
    // leaves the markers nowhere, so that edit hands them over by hand and they stand on the seam
    const pair = Array.isArray(mapT) ? mapT : [mapT(this.start), mapT(this.end)];
    this.start = Math.min(Math.max(0, pair[0]), Math.max(0, this.dur0 - .1));
    this.end = Math.min(Math.max(pair[1], this.start + .1), this.dur0);
    this._pan = null;
    this._peaks(); this._sync(); this.out();
  }
  /* the file the rest of the program should use: the audio as it stands now, cut to the selection */
  out() {
    if (!this.dur0) return null;
    if (this.end - this.start < 1) { this.say('Слишком короткий кусок: меньше секунды модель не разберёт'); return null; }
    const stem = this.name.replace(/\.[a-z0-9]+$/i, '').replace(/(-фрагмент)+$/g, '');   // loading twice must not stack suffixes
    const f = new File([wavSlice(this.buf, this.start, this.end)], stem + '-фрагмент.wav', { type: 'audio/wav' });
    this.onFile(f, this);
    return f;
  }
  /* One step back: every edit leaves a copy in the stack, «Откат» returns to the original at once. */
  undoStep() {
    const s = this.undo.pop();
    if (!s) { this.say('Отменять нечего'); return; }
    this.stop();
    this.buf = s.buf; this.dur0 = s.buf.duration;   // the length must come back with the sound itself
    this.start = Math.min(s.start, this.dur0); this.end = Math.min(s.end, this.dur0);
    this._pan = null;
    this._peaks(); this._sync(); this.out();
    this.say(this.undo.length ? 'Вернул последнее изменение' : 'Вернул последнее изменение: аудио как было');
  }
  clear() { this.stop(); this.buf = null; this.dur0 = 0; this.start = this.end = 0; this.cut = null; this.undo = []; this.name = ''; this.zoom = 1; this._sync(); }
  play() {
    if (!this.dur0 || this.src) return;
    const c = actx = actx || new AudioContext();
    this.src = c.createBufferSource(); this.src.buffer = this.buf;
    this.src.connect(c.destination);
    this.src.onended = () => this.stop();
    const off = c.currentTime + .06;
    this.src.start(off, this.start, this.len());
    this.q('.at-ph').hidden = false;
    const t0 = performance.now();
    const tick = () => {
      if (!this.src) return;
      const p = Math.min(1, (performance.now() - t0) / 1000 / Math.max(.01, this.len()));
      this.q('.at-ph').style.left = (this.fracAt(this.start + this.len() * p) * this.q('.at-wave').clientWidth) + 'px';
      this.raf = requestAnimationFrame(tick);
    };
    tick(); this.q('.at-play').textContent = '❚❚';
  }
  stop() {
    if (this.src) { this.src.onended = null; try { this.src.stop(); } catch {} this.src = null; }
    cancelAnimationFrame(this.raf); this.q('.at-ph').hidden = true; this.q('.at-play').textContent = '▶';
  }
  /* A zoomed ribbon used to recompute its window from the marker being dragged: the marker stayed
     painted in the same spot while the hand walked away, and the ribbon only moved while the mouse
     moved. Now the window is pinned the moment a marker is taken: the marker follows the cursor, and
     when the cursor leans on the edge of the window the ribbon slides on its own - at a calm speed -
     until the hand leaves the band. The arrow at that edge says which way it is going. */
  _pinView() {
    if (this.zoom <= 1.02) { this._pan = null; return; }
    const span = this.dur0 / this.zoom, free = Math.max(.001, this.dur0 - span);
    this._pan = Math.min(1, Math.max(0, this.view()[0] / free));
  }
  _applyGrab() {
    const g = this._grab; if (!g || !this.dur0) return;
    const r = this.q('.at-wave').getBoundingClientRect();
    const v = this.tAt(Math.min(1, Math.max(0, (this._grabX - r.left) / Math.max(1, r.width))));
    if (g === 'l') this.start = Math.min(v, this.end - .1);
    else this.end = Math.max(v, this.start + .1);
    this._sync();
  }
  _dirPaint() {
    const on = !!this._grab;
    const l = this.q('.at-dir-l'), rr = this.q('.at-dir-r');
    if (l) l.hidden = !(on && this._dir === 'l');
    if (rr) rr.hidden = !(on && this._dir === 'r');
  }
  _grabMove(clientX) {
    if (!this._grab || !this.dur0) return;
    this._grabX = clientX;
    if (this.zoom > 1.02) {
      const [a0, b0] = this.view(), span = b0 - a0, free = Math.max(.001, this.dur0 - span);
      const r = this.q('.at-wave').getBoundingClientRect();
      const t = a0 + Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))) * span;
      const edge = span * .05, band = span * .16;   // the band where the ribbon starts to slide
      let na = a0;
      if (t < a0 + edge) na = Math.max(0, a0 - (a0 + edge - t));
      else if (t > b0 - edge) na = Math.min(free, a0 + (t - (b0 - edge)));
      if (Math.abs(na - a0) > 1e-4) this._pan = na / free;
      const dir = (t < a0 + band) ? 'l' : (t > b0 - band) ? 'r' : null;
      this._dir = dir;
      this._dirPaint();
      if (dir && !this._slideRaf) {
        const step = ts => {
          this._slideRaf = 0;
          if (!this._grab || !this._dir) { this._dirPaint(); return; }
          const [a, b] = this.view(), sp = b - a, fr = Math.max(.001, this.dur0 - sp);
          const dt = this._slideTs ? (ts - this._slideTs) / 1000 : 0;
          this._slideTs = ts;
          const na2 = Math.min(fr, Math.max(0, a + sp * .4 * dt * (this._dir === 'l' ? -1 : 1)));
          this._pan = na2 / fr;
          this._applyGrab();
          if (this._grab && this._dir) this._slideRaf = requestAnimationFrame(step);
          else this._dirPaint();
        };
        this._slideTs = 0; this._slideRaf = requestAnimationFrame(step);
      }
      if (!dir && this._slideRaf) { cancelAnimationFrame(this._slideRaf); this._slideRaf = 0; }
    }
    this._applyGrab();
  }
  _releaseGrab() {
    this._grab = null; this._dir = null; this._grabX = null;
    if (this._slideRaf) { cancelAnimationFrame(this._slideRaf); this._slideRaf = 0; }
    this._dirPaint();
  }
  _drag(e) {
    if (!this.dur0 || this._grab) return;   // while a handle is held, the wave must not restart the selection
    const r = this.q('.at-wave').getBoundingClientRect(), px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const t = this.tAt(px);
    if (this._move) {                       // the whole frame follows the hand, its width is kept
      const a = Math.max(0, Math.min(this.dur0 - this._move.len, t - this._move.off));
      this.start = a; this.end = a + this._move.len;
    } else if (this._anchor === null) this._anchor = t;
    else { this.start = Math.min(this._anchor, t); this.end = Math.max(this._anchor, t); }
    this._sync();
  }
  _wire() {
    const el = this.q('.at-wave');
    if (!this.q('.at-dir-l')) {
      // words, not glyphs: the arrow only has to say which way the ribbon is sliding
      const dl = document.createElement('i'); dl.className = 'at-dir at-dir-l'; dl.textContent = 'влево'; dl.hidden = true;
      const dr = document.createElement('i'); dr.className = 'at-dir at-dir-r'; dr.textContent = 'вправо'; dr.hidden = true;
      el.append(dl, dr);
    }
    this._sync();
    this._anchor = null;
    const at = e => Math.min(this.dur0, Math.max(0, this.tAt(Math.min(1, Math.max(0, (e.clientX - el.getBoundingClientRect().left) / el.getBoundingClientRect().width)))));
    // a handle is grabbed on its own: without this a press on the edge started a brand new selection,
    // and the markers could not be moved at all (that is how the LipSync panel does it too)
    this.el.querySelectorAll('.at-h').forEach(h => {
      h.addEventListener('pointerdown', e => {
        if (!this.dur0) return;
        e.stopPropagation(); e.preventDefault();
        this._grab = h.dataset.h;
        this._grabX = e.clientX; this._dir = null;
        this._pinView();                        // the window stops chasing the marker: it now follows the hand
        try { h.setPointerCapture(e.pointerId); } catch (err) { }   // a released pointer is not an error: the drag still works
      });
      h.addEventListener('pointermove', e => { if (this._grab) this._grabMove(e.clientX); });
      h.addEventListener('pointerup', e => {
        if (!this._grab) return;
        this._grabMove(e.clientX);
        this._releaseGrab();
        this.out();
      });
      h.addEventListener('pointercancel', () => this._releaseGrab());
    });
    el.addEventListener('pointerdown', e => {
      if (!this.dur0 || this._grab) return;
      if (e.target.closest('.at-fd')) return;   // pressing a stair is a press, not a drag: the markers
                                                // used to jump together and the fade then had nothing to cover
      const t = at(e);
      // pressing inside the marked piece moves it whole; on its edges or outside it starts a new mark
      const inside = t > this.start + .2 && t < this.end - .2 && !e.target.closest('.at-fd');
      if (inside && this.mode !== 'fade') this._move = { off: t - this.start, len: this.len() };
      else this._anchor = t;
      this._pinView();   // the piece follows the hand, not the sliding window
      try { el.setPointerCapture(e.pointerId); } catch (err) { }      // a released pointer is not an error
      this._drag(e);
    });
    el.addEventListener('pointermove', e => { if (this._anchor !== null || this._move) this._drag(e); });
    el.addEventListener('pointerup', e => {
      if (this._grab) return;
      this._drag(e); this._anchor = null; this._move = null;
      this.out();
    });
    this.q('.at-fade').onclick = e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      if (!this.dur0) { this.say('Сначала загрузите аудио'); return; }
      if (this.len() < .3) { this.say('Выделите участок длиннее полсекунды'); return; }
      actx = actx || new AudioContext();   // _commit keeps the previous sound itself - no second copy
      this._commit(fadeRange(this.buf, actx, this.start, this.end, b.dataset.f), x => x);
      this.say(b.dataset.f === 'r' ? 'Готово: звук плавно стихает от левого маркера до правого' : 'Готово: звук плавно набирает силу от левого маркера до правого');
    };
    this.q('.at-modes').onclick = e => {
      const b = e.target.closest('button[data-m]'); if (!b || !this.dur0) return;
      this.mode = b.dataset.m;
      [...this.el.querySelectorAll('.at-modes button')].forEach(x => x.classList.toggle('on', x === b));
      this._hint(); this._sync(); this._paint();   // the stairs of the fade mode stand on the wave
    };
    this.q('.at-play').onclick = () => this.src ? this.stop() : this.play();
    this.q('.at-keep').onclick = () => {
      if (!this.dur0) return;
      if (this.len() < .05) return;
      if (this.mode !== 'cut') {
        if (this.start <= .001 && this.end >= this.dur0 - .001) { this.say('Выделено всё аудио: убирать нечего'); return; }
        const left = this.dur0 - this.len(), from = this.start;
        this._commit(keepRanges(this.buf, [[from, this.end]]), x => x - from);
        setZoom(1);   // the kept piece is what you want to see whole, not a zoomed-out leftover of the old length
        this.say('Оставлено ' + this.len().toFixed(1).replace('.', ',') + ' с · убрано ' + left.toFixed(1).replace('.', ',') + ' с');
        return;
      }
      // the marked piece goes out, the rest is glued, the markers land on the seam: a selection
      // squeezed to nothing by the cut would only wake the warning about a piece under a second
      const a = this.start, b = this.end;
      const rest = [[0, a], [b, this.dur0]].filter(([x, y]) => y - x > .001);
      if (!rest.length) { this.say('Нельзя вырезать всё аудио'); return; }
      const seam = Math.min(a, Math.max(0, this.dur0 - (b - a) - 1.5));
      this._commit(keepRanges(this.buf, rest), [seam, Math.min(this.dur0 - (b - a), seam + 1.5)]);
      setZoom(1);   // the same: after a cut the whole remainder stands in front of the person
      this.say('Вырезано ' + (b - a).toFixed(1).replace('.', ',') + ' с · маркеры на месте склейки, «Шаг назад» вернёт');
    };
    // the pauses panel keeps its own numbers: the same two knobs the person could set before
    this.q('.at-paus').onclick = () => {
      if (!this.dur0) return;
      const pz = this.q('.at-pz');
      pz.hidden = !pz.hidden;
      if (!pz.hidden) this._pzShow();
    };
    const pnum = (el, def) => { const v = parseFloat(String(el.value).replace(',', '.')); return isFinite(v) ? v : def; };
    this._pzFind = () => findPauses(this.buf, pnum(this.q('.at-pm'), .6), pnum(this.q('.at-pk'), .25));
    this._pzShow = () => {
      const f = this._pzFind(), saved = f.reduce((s, [x, y]) => s + y - x, 0);
      this.q('.at-pzi').textContent = f.length
        ? 'найду ' + f.length + ' пауз, короче на ' + saved.toFixed(1).replace('.', ',') + ' с'
        : 'длинных пауз нет';
      this.q('.at-pgo').disabled = !f.length;
    };
    this.q('.at-pm').oninput = this.q('.at-pk').oninput = () => this._pzShow();
    this.q('.at-pgo').onclick = () => {
      const f = this._pzFind();
      if (!f.length) { this.say('Длинных пауз не найдено'); return; }
      const left = f.reduce((s, [x, y]) => s + y - x, 0);
      const gaps = []; let prev = 0;
      f.forEach(([x, y]) => { if (x - prev > .001) gaps.push([prev, x]); prev = y; });
      if (this.dur0 - prev > .001) gaps.push([prev, this.dur0]);
      this._commit(keepRanges(this.buf, gaps), shiftAfter(f));
      this.q('.at-pz').hidden = true;
      this.say('Пауз убрано: ' + f.length + ' · стало короче на ' + left.toFixed(1).replace('.', ',') + ' с');
    };
    this.q('.at-back').onclick = () => this.undoStep();
    if (this.q('.at-pp')) this.q('.at-pp').oninput = e => {
      this._pan = Math.min(1, Math.max(0, (+e.target.value || 0) / 1000));
      paintRange(e.target); this._paint(); this.q('.at-zl').textContent = this._zinfo();
    };
    this.q('.at-voc').onclick = async () => {
      if (!this.dur0 || this.busy) return;
      // the model that separates a voice may be absent, or the file too long for it: the owner says
      if (this.buf.duration > 360) { this.say('Голос отделяется только от аудио длиннее 6 минут? Слишком длинное: отрежьте лишнее'); return; }
      if (this.canVocals) {
        const why = await this.canVocals();
        if (why) { this.say(why); return; }
      }
      const fd = new FormData();
      fd.append('file', new File([wavSlice(this.buf, 0, this.dur0)], 'in.wav', { type: 'audio/wav' }));   // the endpoint reads 'file'
      this.busy = true; this.q('.at-voc').disabled = true; this.q('.at-voc').textContent = 'Отделяю…';
      try {
        const r = await fetch('/api/audio/separate', { method: 'POST', body: fd });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Не удалось отделить голос');
        const nb = await (actx = actx || new AudioContext()).decodeAudioData(await r.arrayBuffer());
        this._commit(nb, x => x);
        this.say('Голос отделён · музыка убрана из аудио');
      } catch (e) { this.say(e.message); }
      this.busy = false; this.q('.at-voc').textContent = 'Отделить голос'; this._sync();
    };
    this.q('.at-ag').onclick = async () => {
      if (!this.dur0) { this.say('Сначала загрузите аудио'); return; }
      // the agent writes where its target says: choose our section first, the way the section itself
      // does it - opening the agent alone left the previous target (for example Lipsync) in place
      const tg = document.querySelector('#agTarget [data-t="' + (this.o.agentTarget || 'long') + '"]');
      if (tg) tg.click();
      agentGo();
      // the agent refuses audio while it does not know whether recognition is ready: on the first press
      // in a fresh session that status was not fetched yet, and the button looked dead
      try { if (!agentState().status || !agentState().status.speech_ready) await agentStatus(); } catch (e) {}
      if (!agentState().status || !agentState().status.speech_ready) { this.say('Сценарист ещё не может слушать аудио: распознавание речи не готово - строчка «Модель сценариста», кнопка «Докачать»'); return; }
      if (this.len() < 1) { this.say('Кусок короче секунды: Сценарист и модель всё равно его не разберут - выделите полторы-две секунды'); return; }
      try { await agentSetAudio(wavSlice(this.buf, this.start, this.end), (this.name || 'фрагмент').replace(/\.[^.]+$/, ''), this.len(),
                              this.whereLabel ? this.whereLabel(this) : ''); }
      catch (e) { this.say((e && e.message) || 'Не удалось передать аудио в Сценарист'); }
      const box = document.querySelector('#agAudioBox');
      if (box && box.hidden) this.say('Аудио не принято: Сценарист не смог его взять'); else this.say('Фрагмент отправлен в Сценарист: ' + this.len().toFixed(1).replace('.', ',') + ' с');
    };
    this.q('.at-und').onclick = () => {
      if (!this.buf0 || this.buf === this.buf0) { this.say('Аудио и так целое - откатывать нечего'); return; }
      // one button, one meaning: the sound exactly as it arrived, every cut and every descent gone
      this.stop(); this.buf = this.buf0; this.dur0 = this.buf0.duration; this.name = this.name0 || this.name;
      this.start = 0; this.end = this.limit > 0 ? Math.min(this.dur0, this.limit) : this.dur0;
      this.cut = null; this.undo = []; this.zoom = 1;
      const zr = this.q('.at-zr'); zr.value = 1; paintRange(zr);
      this._peaks(); this._paint(); this._sync(); this.out();
      this.say('Откат: аудио снова такое, каким оно было загружено');
    };
    const setZoom = v => {
      this.zoom = Math.min(40, Math.max(1, v));
      this._pan = null;   // a new scale shows the whole selection again; pinning starts when a marker is taken
      const sl = this.q('.at-zr');
      sl.value = this.zoom;
      paintRange(sl);   // the blue part is a CSS variable: a programmatic value does not wake the listener
      this._sync();
    };
    this.q('.at-zr').oninput = e => setZoom(+e.target.value);
    this.q('.at-zm').onclick = () => setZoom(Math.max(1, Math.round(this.zoom / 1.6)));
    this.q('.at-zp').onclick = () => setZoom(Math.min(40, Math.max(2, Math.round(this.zoom * 1.6))));
    this.q('.at-z0').onclick = () => setZoom(1);
    const num = s => parseFloat(String(s).replace(',', '.')) || 0;
    this.q('.at-a').oninput = e => { if (!this.dur0) return; this.start = Math.min(Math.max(0, num(e.target.value)), this.end - .1); this._sync(); };
    this.q('.at-b').oninput = e => { if (!this.dur0) return; this.end = Math.max(Math.min(this.dur0, num(e.target.value)), this.start + .1); this._sync(); };
    this.q('.at-a').onchange = this.q('.at-b').onchange = () => this.out();
    addEventListener('resize', () => this.dur0 && this._paint());
    // the card is hidden until «Своё аудио» chosen: the wave has to be redrawn when it gets a width
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this._paint()).observe(this.q('.at-wave'));
  }
}

/* The Clip edits sound with the same editor the studios use: one class for the wave, the markers,
   the fades, the pauses and the voice. Only what is specific to the Clip stays here: the upload zone,
   the 12-second pre-selection, the advice about the pause, and that the piece goes to the generator. */
export function drawWave() { const t = views.lTrim; if (t && t.dur0) t._paint(); }
export function fadeRange(buf, ctx, a, b, dir) {
  const sr = buf.sampleRate, ch = buf.numberOfChannels, N = buf.length;
  const i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(N, Math.ceil(b * sr));
  const out = ctx.createBuffer(ch, N, sr);
  const span = Math.max(1, i1 - i0);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src);
    for (let i = i0; i < i1; i++) {
      const p = (i - i0) / span;                       // 0 at the left edge, 1 at the right one
      dst[i] = src[i] * (dir === 'r' ? 1 - p : p);
    }
    // nothing outside the marked piece is touched: the right stair brings the sound from full at the
    // left marker down to silence at the right one, the left stair does the same the other way round.
    // Silence beyond the markers used to eat the rest of the track, which felt like a broken tool.
  }
  return out;
}
export function keepRanges(buf, ranges) {
  const sr = buf.sampleRate, chs = buf.numberOfChannels, fade = Math.round(0.004 * sr);
  const lens = ranges.map(([a, b]) => Math.max(0, Math.round((b - a) * sr)));
  const out = actx.createBuffer(chs, Math.max(1, lens.reduce((x, y) => x + y, 0)), sr);
  for (let c = 0; c < chs; c++) {
    const srcd = buf.getChannelData(c), dst = out.getChannelData(c); let o = 0;
    ranges.forEach(([a], i) => {
      const s = Math.round(a * sr), n = lens[i];
      dst.set(srcd.subarray(s, s + n), o);
      for (let k = 0; k < Math.min(fade, n); k++) { if (i > 0) dst[o + k] *= k / fade; if (i < ranges.length - 1) dst[o + n - 1 - k] *= k / fade; }
      o += n;
    });
  }
  return out;
}
export const shiftAfter = removed => t => t - removed.reduce((s, [a, b]) => s + (t >= b ? b - a : t > a ? t - a : 0), 0);
export function findPauses(buf, minLen, keep) {
  const sr = buf.sampleRate, win = Math.round(sr * 0.01), n = Math.floor(buf.length / win);
  const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a, rms = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = i * win; j < (i + 1) * win; j += 2) { s += (a[j] * a[j] + b[j] * b[j]) * 0.5; c++; } rms[i] = Math.sqrt(s / c); }
  const sorted = Float32Array.from(rms).sort(), floor = sorted[Math.floor(n * 0.1)] || 0, loud = sorted[Math.floor(n * 0.9)] || 0;
  const thr = Math.min(Math.max(floor * 3, loud * 0.05, 0.002), loud * 0.2), found = []; let run = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && rms[i] < thr;
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) { const s = run * 0.01, e = i * 0.01; if (e - s >= minLen && e - s > keep + 0.02) found.push([s + keep / 2, e - keep / 2]); run = -1; }
  }
  return found;
}
// selected part of the decoded audio as 16-bit PCM WAV
export function wavSlice(buf, t0, t1) {
  const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels);
  const a = Math.floor(t0 * sr), n = Math.max(0, Math.floor(t1 * sr) - a);
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][a + i])); out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
