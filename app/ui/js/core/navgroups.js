/* Переключатель режимов на странице: в меню одна кнопка, а режимов под ней несколько.
   Страницы не сливаются - у каждой своё тело, свои файлы и свой расчёт; показывается
   та, которую человек выбрал, и выбор запоминается. Кнопка меню открывает последний. */
import { NAV_GROUPS, NAV_GROUP_TITLES, navKeyOf, partOfGroup, setGroupPart } from './tabs.js';

const barOf = new Map();          // страница -> её переключатель

function bar(g, view) {
  if (barOf.has(view.id)) return;
  const anchor = view.querySelector(':scope > .head > div:first-child') || view.querySelector(':scope > .head');
  if (!anchor) return;            // страницы без шапки не бывает, но и не ломаемся
  const d = document.createElement('div');
  d.className = 'nav-sw';
  d.innerHTML = g.parts.map(k => '<button type="button" data-p="' + k + '">' + (NAV_GROUP_TITLES[k] || k) + '</button>').join('');
  d.onclick = e => { const b = e.target.closest('button'); if (b) setGroupPart(b.dataset.p); };
  anchor.append(d);
  barOf.set(view.id, d);
}

/* Светится тот режим, чья страница открыта; переключатель чужой группы не показывается. */
function paint() {
  const ck = ((document.querySelector('.view.active') || {}).id || '').replace('view-', '');
  barOf.forEach((d, id) => {
    const ik = id.replace('view-', '');
    d.hidden = !ck || navKeyOf(ik) !== navKeyOf(ck);
    const shown = ik === ck ? ik : partOfGroup(navKeyOf(ik));
    Array.prototype.slice.call(d.children).forEach(b => b.classList.toggle('on', b.dataset.p === shown));
  });
}

function scan() {
  NAV_GROUPS.forEach(g => g.parts.forEach(k => {
    const v = document.getElementById('view-' + k);
    if (v) bar(g, v);
  }));
  paint();
}

scan();

/* Страницы собираются не сразу (режимы строятся при своём импорте, карточки - позже),
   а активная страница меняется и без клика по меню: пресеты и Библиотека умеют
   переходить сами. Поэтому смотрим за разметкой, а не за кликами. */
if (typeof MutationObserver !== 'undefined') {
  let timerPaint = 0, timerScan = 0;
  const ours = ms => ms.every(m => m.target && m.target.closest && m.target.closest('.nav-sw'));
  new MutationObserver(ms => {
    if (ours(ms)) return;
    clearTimeout(timerPaint); timerPaint = setTimeout(paint, 120);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  new MutationObserver(ms => {
    if (ours(ms)) return;
    clearTimeout(timerScan); timerScan = setTimeout(scan, 400);
  }).observe(document.body, { childList: true, subtree: true });
}
