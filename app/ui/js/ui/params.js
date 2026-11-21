import { $, $$, copyText, newSeed, paintRange, toast } from '../core/util.js';
import { goTo } from '../core/tabs.js';

/* ---------- resolution / duration math (from the workflows) ---------- */
export const ASPECTS = [
  { id: '16:9', w: 16, h: 9, name: 'Горизонт' },
  { id: '9:16', w: 9, h: 16, name: 'Вертикаль' },
  { id: '1:1', w: 1, h: 1, name: 'Квадрат' },
  { id: '4:3', w: 4, h: 3, name: '4:3' },
  { id: '3:4', w: 3, h: 4, name: '3:4' },
  { id: '21:9', w: 21, h: 9, name: 'Кино 21:9' },
];
// the sizes of the original workflow's table (16:9 base). The buttons show the eight most used ones as plain sizes;
// the rest stay known (saved settings and old library items use them) but are not offered
export const QUALITY_ALL = [
  { id: '0.2', px: 608 * 352, res: '608×352' },
  { id: '0.3', px: 736 * 416, res: '736×416', sub: 'самый быстрый', show: 1 },
  { id: '480p', px: 864 * 480, res: '864×480', sub: 'быстро', show: 1 },
  { id: '0.5', px: 960 * 544, res: '960×544', sub: 'под ×2 = 1920', show: 1 },
  { id: '0.6', px: 1056 * 608, res: '1056×608', show: 1 },
  { id: '0.7', px: 1152 * 640, res: '1152×640' },
  { id: '0.8', px: 1216 * 672, res: '1216×672', show: 1 },
  { id: '720p', px: 1280 * 736, res: '1280×736', sub: 'баланс', show: 1 },
  { id: 'HD+', px: 1376 * 768, res: '1376×768', sub: 'чётче', show: 1 },
  { id: '1.2', px: 1504 * 832, res: '1504×832', show: 1 },
  { id: '1.5', px: 1664 * 928, res: '1664×928' },
  { id: '1.8', px: 1824 * 1024, res: '1824×1024' },
  { id: '1080p', px: 1920 * 1088, res: '1920×1088', sub: 'максимум, долго', show: 1 },
];
export const QUALITY = QUALITY_ALL.filter(q => q.show);
export const qLabel = q => q.res;
export const r32 = v => Math.max(32, Math.round(v / 32) * 32);
export function resFor(aspect, q) {
  const a = ASPECTS.find(x => x.id === aspect), p = QUALITY_ALL.find(x => x.id === q).px;
  return [r32(Math.sqrt(p * a.w / a.h)), r32(Math.sqrt(p * a.h / a.w))];
}
// frame count formula from the workflow: 24 fps, length = 17k + 5
export function frames(sec) { let f = Math.max(5, Math.round(sec * 24)); return f + (5 - f % 17 + 17) % 17; }

/* ---------- shared params / preview builders ---------- */
export function paramsCard(el, st, opts) {
  el.innerHTML = `
    <div class="card-h"><h3><span class="n">${opts.n}</span>Параметры</h3></div>
    <div class="row">
      <div class="row-l">Формат</div>
      <div class="chips">${ASPECTS.map(a => {
        const k = 18 / Math.max(a.w, a.h);
        return `<button class="chip" data-a="${a.id}"><i class="ar" style="width:${a.w * k}px;height:${a.h * k}px"></i>${a.name}${a.name !== a.id ? ` <small>${a.id}</small>` : ''}</button>`;
      }).join('')}</div>
    </div>
    <div class="row">
      <div class="row-l">Качество <span class="resv"></span></div>
      <div class="seg seg-q">${QUALITY.map(q => `<button data-q="${q.id}"><span class="qt">${qLabel(q)}</span><small>${q.sub || '&nbsp;'}</small></button>`).join('')}</div>
      <div class="hint">Чем меньше размер, тем быстрее расчёт; чем больше, тем чётче изображение. Размеры в кнопках - для выбранного формата: поменяете формат, и они пересчитаются.</div>
    </div>
    <div class="row">
      <div class="row-l">Свой размер <small class="hint">(необязательно)</small></div>
      <div class="path on" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="cw-w" inputmode="numeric" placeholder="ширина" style="width:90px"> <span>×</span>
        <input class="cw-h" inputmode="numeric" placeholder="высота" style="width:90px">
        <button class="btn cw-reset" type="button" hidden style="padding:6px 12px;font-size:12.5px">Сбросить</button>
      </div>
      <div class="hint cw-hint">Впишите нужные числа: программа сама округлит их до значений, которые понимает модель (кратно 32). Пусто — размер по формату и качеству выше.</div>
    </div>
    ${opts.extraRow || ''}
    ${opts.duration ? `
    <div class="row">
      <div class="row-l">Длительность <span class="durv"></span></div>
      <input type="range" min="3" max="25" step="1" class="dur">
      <div class="ticks"><span>3 с</span><span>8</span><span>14</span><span>19</span><span>25 с</span></div>
    </div>` : ''}
    <div class="note warn vwarn" hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v5M12 18h0"/></svg>
      <span>1080p на длинном ролике может не поместиться в видеопамять. Если генерация упадёт — выберите 720p или сократите длительность.</span>
    </div>
    <div class="row" style="margin-top:16px">
        <div class="row-l">Seed — «номер варианта»</div>
        <div class="seg seed-seg" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
          <button data-sf="0">Случайный<small>каждый раз новое видео</small></button>
          <button data-sf="1">Фиксированный<small>тот же вариант снова</small></button>
        </div>
        <div class="path on seed-row" hidden>
          <input class="seed-in" inputmode="numeric" spellcheck="false" placeholder="число, например 123456789">
          <button class="btn seed-new" type="button">🎲 Новый</button>
          <button class="btn seed-copy" type="button">Копировать</button>
        </div>
        <div class="hint seed-hint"></div>
    </div>`;
  const upd = () => {
    $$('.chip', el).forEach(c => c.classList.toggle('on', c.dataset.a === st.aspect));
    $$('.seg button[data-q]', el).forEach(c => c.classList.toggle('on', c.dataset.q === st.q));
    $$('.seg button[data-r]', el).forEach(c => c.classList.toggle('on', c.dataset.r === st.refSize));
    const [w, h] = st.cw && st.ch ? [st.cw, st.ch] : resFor(st.aspect, st.q);
    const rsv = $('.resv', el);
    // the quality button you picked already carries this number and the right-hand panel repeats it,
    // so written always it was only noise; it stays for the one case where nothing else shows the
    // real size - when a width and height of your own were typed in
    if (rsv) {
      const own = !!(st.cw && st.ch);
      rsv.hidden = !own;
      rsv.textContent = own ? `${w}×${h} · свой размер` : '';
    }
    /* кнопки качества раньше всегда показывали горизонтальный кадр: при вертикали или квадрате
       цифры не менялись и не совпадали с тем, что справа. Теперь пересчитываются на каждый формат */
    $$('.seg button[data-q]', el).forEach(c => { const s = resFor(st.aspect, c.dataset.q).join('×'); const qt = $('.qt', c); if (qt && qt.textContent !== s) qt.textContent = s; });
    $('.cw-reset', el).hidden = !(st.cw || st.ch);
    $$('.seg button[data-q]', el).forEach(c => c.style.opacity = st.cw && st.ch ? .45 : '');
    if (opts.duration) {
      const d = $('.dur', el); d.value = st.dur;
      paintRange(d);   // заливка по фактическим min/max: у «Замены» шкала 3-15, а не 3-25
      $('.durv', el).textContent = `${st.dur} с · ${frames(st.dur)} кадров` + (st.dur > 15 ? ' · дольше 15 с модель держит качество хуже' : '');
    }
    $('.vwarn', el).hidden = !(st.q === '1080p' && st.len() > 8);
    $$('.seed-seg button', el).forEach(b => b.classList.toggle('on', (b.dataset.sf === '1') === !!st.seedFixed));
    $('.seed-row', el).hidden = !st.seedFixed;
    if ($('.seed-in', el) !== document.activeElement) $('.seed-in', el).value = st.seed || '';
    $('.seed-hint', el).textContent = st.seedFixed
      ? 'Одинаковый seed + одинаковые настройки и промпт = одинаковое видео. Удобно менять что-то одно и сравнивать. Понравившийся seed можно взять из библиотеки или сразу после генерации.'
      : 'Каждый раз получается новый вариант. Seed понравившегося видео сохраняется в библиотеке — потом его можно зафиксировать.';
    opts.onChange();
  };
  st._upd = upd;  // lets the library and the preview panel switch this mode to a given seed
  el.addEventListener('click', e => {
    if (((st.locked && st.locked() && e.target.closest('.chip[data-a]')) || ((st.lockedQ ? st.lockedQ() : st.locked && st.locked()) && e.target.closest('.seg button[data-q]')))) { toast('Формат и качество нельзя менять, пока в проекте есть готовые сцены: все сцены должны быть одного размера. Чтобы сменить, нажмите «Начать заново».'); return; }
    const c = e.target.closest('.chip[data-a]'); if (c) { const ch = st.aspect !== c.dataset.a; st.aspect = c.dataset.a; st.userAspect = true; upd(); if (ch) st.onSizeChange?.('aspect'); }
    const q = e.target.closest('.seg button[data-q]'); if (q) { const ch = st.q !== q.dataset.q; st.q = q.dataset.q; upd(); if (ch) st.onSizeChange?.('q'); }
    const r = e.target.closest('.seg button[data-r]'); if (r) { st.refSize = r.dataset.r; upd(); }
    const sf = e.target.closest('.seed-seg button'); if (sf) { st.seedFixed = sf.dataset.sf === '1'; if (st.seedFixed && !st.seed) st.seed = newSeed(); upd(); }
    if (e.target.closest('.seed-new')) { st.seed = newSeed(); upd(); }
    if (e.target.closest('.seed-copy')) { copyText(String(st.seed || ''), 'Seed скопирован: ' + st.seed); }
  });
  const cwApply = () => {
    const iw = $('.cw-w', el), ih = $('.cw-h', el), hint = $('.cw-hint', el);
    if (st.lockedQ ? st.lockedQ() : st.locked && st.locked()) { iw.value = st.cw || ''; ih.value = st.ch || ''; toast('Размер нельзя менять, пока в проекте есть готовые сцены. Нажмите «Начать заново».'); return; }
    const a = parseInt(iw.value, 10), b = parseInt(ih.value, 10);
    if (a >= 64 && b >= 64) {
      st.cw = Math.min(2048, Math.max(64, Math.round(a / 32) * 32)); st.ch = Math.min(2048, Math.max(64, Math.round(b / 32) * 32));
      iw.value = st.cw; ih.value = st.ch;
      hint.textContent = `Размер будет ${st.cw}×${st.ch}` + (st.cw !== a || st.ch !== b ? ` (округлено с ${a}×${b})` : '') + (st.cw * st.ch > 1920 * 1088 ? '. Это больше 1080p: может не хватить видеопамяти.' : '');
    } else { st.cw = st.ch = 0; hint.textContent = 'Впишите оба числа (от 64 и больше): программа округлит их до кратных 32. Пусто — размер по формату и качеству.'; }
    upd(); st.onSizeChange?.('q');
  };
  $('.cw-w', el).onchange = $('.cw-h', el).onchange = cwApply;
  $('.cw-reset', el).onclick = () => { $('.cw-w', el).value = $('.cw-h', el).value = ''; st.cw = st.ch = 0; cwApply(); };
  $('.seed-in', el).oninput = e => { st.seed = e.target.value.replace(/\D/g, '').slice(0, 18); e.target.value = st.seed; };
  if (opts.duration) $('.dur', el).oninput = e => { st.dur = +e.target.value; upd(); };
  return upd;
}
export const SZ_ROW = `<div class="row sz-row"><div class="row-l">Свой размер <span class="hint">(необязательно)</span></div>
  <div class="path on" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn sz-p" data-p="0" type="button" title="Обычный размер (около 1 МП): быстро, как эскиз" style="padding:6px 12px;font-size:12.5px">Эскиз</button><button class="btn sz-p" data-p="2k" type="button" title="Сразу 2К: по длинной стороне 2048" style="padding:6px 12px;font-size:12.5px">2К</button><input class="sz-w" inputmode="numeric" placeholder="ширина" style="width:90px"> <span>×</span> <input class="sz-h" inputmode="numeric" placeholder="высота" style="width:90px"> <button class="btn sz-reset" type="button" hidden style="padding:6px 12px;font-size:12.5px">Сбросить</button></div>
  <div class="hint sz-hint">Размер подстраивается под шаг модели, кратно 32: например, 1920×1080 станет 1920×1088. Пусто — размер по формату выше.</div></div>`;
export function szWire(el, st, onChange, getBase) {
  const iw = $('.sz-w', el), ih = $('.sz-h', el), hint = $('.sz-hint', el), rs = $('.sz-reset', el);
  const def = hint.textContent;
  // a preset that shows no sign of being pressed reads as a dead button: the row has to say which
  // size is in force, and the press has to answer even when nothing needed changing
  const mark = () => $$('.sz-p', el).forEach(b => b.classList.toggle('on',
    b.dataset.p === '0' ? !(st.cw || st.ch) : (st.cw || st.ch) > 0 && Math.max(st.cw, st.ch) >= 1920));
  const apply = () => {
    const a = parseInt(iw.value, 10), b = parseInt(ih.value, 10);
    if (a >= 64 && b >= 64) {
      let k = a * b > 2200000 ? Math.sqrt(2200000 / (a * b)) : 1;
      const r = v => Math.min(2048, Math.max(256, Math.round(v * k / 32) * 32));
      st.cw = r(a); st.ch = r(b); iw.value = st.cw; ih.value = st.ch;
      hint.textContent = `Будет ${st.cw}×${st.ch}` + (st.cw !== a || st.ch !== b ? ` (округлено с ${a}×${b}, шаг 32)` : '') + (st.cw * st.ch > 1500000 ? '. Это больше 1,5 МП: дольше и больше видеопамяти.' : '');
    } else { st.cw = st.ch = 0; hint.textContent = def; }
    rs.hidden = !(st.cw || st.ch);
    mark();
    onChange();
  };
  iw.onchange = ih.onchange = apply;
  $$('.sz-p', el).forEach(b => b.onclick = () => {
    const was = !!(st.cw || st.ch);
    if (b.dataset.p === '0') {
      iw.value = ih.value = ''; apply();
      toast(was ? 'Размер сброшен на обычный: около 1 МП, рисуется быстро' : 'Размер и так обычный: около 1 МП, рисуется быстро');
      return;
    }
    const [bw, bh] = (getBase && getBase()) || [1376, 768], k = 2048 / Math.max(bw, bh);
    iw.value = Math.round(bw * k / 32) * 32; ih.value = Math.round(bh * k / 32) * 32; apply();
    toast('Размер ' + iw.value + '×' + ih.value + ': длинная сторона 2048');
    if (st.engine === 'krea') toast('Krea 2 лучше всего работает около 1 МП: для неё надёжнее эскиз и потом «Увеличить до 2К» в Библиотеке');
  });
  mark();
  rs.onclick = () => { iw.value = ih.value = ''; apply(); };
}
export function sizeForm(st, fd) { if (st.cw && st.ch) { fd.append('width', st.cw); fd.append('height', st.ch); } }
// the seed goes to the server only when the user fixed it; otherwise the server draws a new one
export function seedForm(st, fd) { if (st.seedFixed && st.seed) fd.append('seed', st.seed); }
// make a mode use this exact seed (from the library or from a finished video)
export function useSeed(st, seed, go) {
  st.seedFixed = true; st.seed = String(seed); st._upd?.();
  if (go) goTo(go);
  toast(`Seed ${seed} зафиксирован в этом режиме`);
}

/* optional LoRAs: the same on/off switch and strength slider in every mode */
export const LORA_DEFS = {
  realism: { name: 'Реализм людей', hint: 'Для живых людей: естественная кожа и лицо. Если лицо выглядит «пластиково» — включите.', min: 0, max: 1, step: .05, v: .5, on: false },
  motion: { name: 'Исправление движения', hint: 'Если движение рвётся, дёргается или «плывёт» — включите.', min: 0, max: 1, step: .05, v: .5, on: false },
  dmad: { name: 'DMAD', hint: 'Усиливает динамику и чёткость движения. Как в исходном экшн-workflow: 0.8.', min: 0, max: 1.2, step: .05, v: .8, on: true },
  speed: { name: 'Speed Slider', hint: 'Скорость движения: 3–4 — быстро и резко; ближе к 0 — спокойнее; со знаком минус — замедление.', min: -8, max: 8, step: .5, v: 4, on: true },
};
export function mountLoras(box, st, keys) {
  st.loras = st.loras || {};
  keys.forEach(k => { st.loras[k] = st.loras[k] || { on: LORA_DEFS[k].on, v: LORA_DEFS[k].v }; });
  box.innerHTML = keys.length ? `<div class="row"><div class="row-l">Дополнительные LoRA <span class="hint" style="font-family:inherit">включите нужные и задайте силу влияния</span></div>`
    + keys.map(k => { const d = LORA_DEFS[k]; return `<div class="lora" data-k="${k}"><div class="lora-h"><button class="chip lora-t" type="button">${d.name}</button><span class="lora-v"></span></div>`
      + `<input type="range" class="lora-r" min="${d.min}" max="${d.max}" step="${d.step}"><div class="hint">${d.hint}</div></div>`; }).join('') + '</div>' : '';
  const paint = () => $$('.lora', box).forEach(el => {
    const s = st.loras[el.dataset.k], r = $('.lora-r', el);
    $('.lora-t', el).classList.toggle('on', s.on);
    r.value = s.v; r.disabled = !s.on; r.style.opacity = s.on ? 1 : .35;
    r.style.setProperty('--p', ((s.v - r.min) / (r.max - r.min) * 100) + '%');
    $('.lora-v', el).textContent = s.on ? `сила ${(+s.v).toFixed(2).replace(/\.?0+$/, '')}` : 'выключена';
  });
  box.onclick = e => { const el = e.target.closest('.lora'); if (!el || !e.target.closest('.lora-t')) return; const s = st.loras[el.dataset.k]; s.on = !s.on; paint(); };
  box.oninput = e => { const el = e.target.closest('.lora'); if (!el) return; st.loras[el.dataset.k].v = +e.target.value; paint(); };
  st._paintLoras = paint;
  paint();
}
export function loraForm(st, fd) { Object.entries(st.loras || {}).forEach(([k, s]) => fd.append('lora_' + k, s.on ? s.v : 'off')); }
