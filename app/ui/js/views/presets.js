import { $, $$ } from '../core/util.js';

/* ---------- ГОТОВЫЕ ПРЕСЕТЫ: каждая карточка — готовый сценарий, всё нужное докачивается само ---------- */
export const PRESETS = [
  { id: 'video', kind: 'video', badge: ['Быстро', 'f'], title: 'Видео', need: 'текст или изображение',
    text: 'Оживить изображение или сделать видео из текста. Можно начальный и конечный кадр.' },
  { id: 'refs', kind: 'video', badge: ['Лучшее качество', 'q'], title: 'Видеостудия', need: 'изображения, по желанию видео и аудио',
    text: 'Видео по вашим изображениям: персонаж, одежда, локация. Видео задаёт движение, аудио — голос или атмосферу.' },
  { id: 'long', kind: 'video', badge: ['Быстрый черновик', 'f'], title: 'Киностудия', need: 'изображения героев + сцены',
    text: 'Ролик из нескольких сцен, каждая продолжает прошлую: клипы, истории, музыка. Своё аудио — на весь ролик или на каждую сцену.' },
  { id: 'action', kind: 'video', title: 'Экшн-видео', need: 'изображения героев',
    text: 'Бой, погоня, бег: динамичные сцены с вашими персонажами. До трёх аудио задают голос, ритм и атмосферу.' },
  { id: 'actionsc', kind: 'video', isNew: true, role: 'action_unet', badge: ['8 + 4 шага', 'f'], title: 'Экшн фильм',
    need: 'изображения героев + сцены',
    text: 'Длинный экшн по сценам: погоня или бой нарастает от сцены к сцене, клипы склеиваются в один ролик. Быстрый гибрид-расчёт, звук модель делает сама.' },
  { id: 'clipsc', kind: 'video', isNew: true, role: 'lipsync_unet', badge: ['клип по треку', 'f'], title: 'Большой музыкальный клип',
      need: 'трек + изображения героев',
      text: 'Клип по вашей музыке: сцены рождаются из трека и склеиваются в один ролик. Считается на модели Студии.' },
    { id: 'lipsync', kind: 'video', title: 'Клип', need: 'аудио + лицо героя',
    text: 'Персонаж говорит или поёт ваше аудио: губы попадают в слова.' },
  { id: 'actor', kind: 'video', title: 'Актёр', need: 'изображение + образец голоса',
    text: 'Диалоги и крупные планы: эмоции, речь и голос по образцу.' },
  { id: 'swap', kind: 'video', title: 'Замена', isNew: true, role: 'swap_lora', need: 'видео + изображение героя',
    text: 'Берёте любое видео и меняете в нём человека на своего персонажа. Движения, камера и фон остаются прежними.' },
  { id: 'krea', kind: 'image', title: 'Изображение по тексту', need: 'только текст',
    text: 'Красивые изображения по описанию: Krea 2, MiniMax H3 Image до 16 МП, FLUX klein, Qwen 2.1; серии по списку промптов.' },
  { id: 'qwen:edit', kind: 'image', icon: 'qwen', poster: 'qwen', title: 'Править изображение', need: 'изображение + что изменить',
    text: 'Меняете на своём изображении одежду, фон, свет или детали словами. Лицо и характер персонажа остаются прежними.' },
  { id: 'qwen:sheet', kind: 'image', icon: 'qwen', poster: 'qwen', title: 'Лист персонажа', need: 'изображение героя',
    text: 'Из одной картинки - лист из 4 или 6 видов героя с разных сторон. Лист потом можно брать как референс в других разделах.' },
  { id: 'qwen:story', kind: 'image', icon: 'qwen', poster: 'qwen', title: 'Раскадровка', need: 'изображения героя и места',
    text: 'История в кадрах: от 2 до 9 кадров по вашим референсам - одним листом или отдельными картинками, которые программа склеит сама.' },
];
export const PR = { tab: '', have: {}, q: '', f: 'all', view: 'grid' };
try { PR.favs = JSON.parse(localStorage.getItem('h3-pfav') || '[]'); } catch { PR.favs = []; }
export const navIcon = id => { const v = $(`.nav[data-view="${id}"] svg`); return v ? v.outerHTML : ''; };
/* у нового режима ещё нет своего ролика: если у карточки указан poster, показываем кадр из
   библиотеки превью - иначе карточка осталась бы с пустым окном слева */
export const prMedia = x => (x.kind === 'image' || x.poster)
  ? `<img class="pr-media" src="/ui/previews/${x.poster || x.id}.jpg" alt="" onerror="this.remove()">`
  : `<video class="pr-media" src="/ui/previews/${x.id}.mp4" muted loop autoplay playsinline preload="auto" onerror="this.remove()"></video>`;
export const prHave = x => !x.role || PR.have[x.role] !== false;
export function presetsPaint() {
  // разметку раздела создаёт views/images.js, а он исполняется позже нас: до этого
  // красить нечего, первая покраска придёт сразу после того, как разметка встанет
  if (!$('#prTypes')) return;
  const home = !PR.tab;
  $('#prTypes').hidden = !home; $('#prList').hidden = home;
  $$('#prSteps .st').forEach((e, i) => { e.classList.toggle('on', i === (home ? 0 : 1)); e.classList.toggle('ok', i < (home ? 0 : 1)); });
  $('#prTitle').textContent = home ? 'Что создаём?' : PR.tab === 'video' ? 'Выберите вариант видео' : 'Выберите вариант изображения';
  $('#prSub').textContent = home ? 'Выберите, что хотите сделать: изображение, видео или улучшить готовое' : 'Всё нужное программа подготовит сама, ничего настраивать не надо';
  if (home) return;
  const q = PR.q.trim().toLowerCase();
  const ok = (x, f) => f === 'all' || (f === 'have' && prHave(x)) || (f === 'miss' && !prHave(x)) || (f === 'fav' && PR.favs.includes(x.id));
  const list = PRESETS.filter(x => x.kind === PR.tab && ok(x, PR.f) && (!q || (x.title + ' ' + x.text + ' ' + x.need).toLowerCase().includes(q)));
  $$('#prChips button').forEach(b => { b.classList.toggle('on', b.dataset.f === PR.f); b.querySelector('i').textContent = PRESETS.filter(x => x.kind === PR.tab && ok(x, b.dataset.f)).length; });
  $$('#prView button').forEach(b => b.classList.toggle('on', b.dataset.v === PR.view));
  const g = $('#view-presets .pr-grid'); g.classList.toggle('list', PR.view === 'list');
  g.innerHTML = list.map(x => {
    const miss = !prHave(x), fav = PR.favs.includes(x.id);
    return `<div class="pr-card" role="button" tabindex="0" data-p="${x.id}"><div class="pr-pic">${navIcon(x.icon || x.id)}${prMedia(x)}
      <span class="pr-fav${fav ? ' on' : ''}" data-fav="${x.id}" title="В избранное"><svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></span>
      ${x.badge ? `<span class="pr-bdg ${x.badge[1]}">${x.badge[0]}</span>` : ''}${x.isNew ? '<span class="pr-new">Новое</span>' : miss ? '<span class="pr-new warn">Нужно скачать</span>' : ''}</div>
      <div class="pr-body"><b>${x.title}</b><p>${x.text}</p><div class="pr-tags"><span>${x.kind === 'video' ? 'Видео' : 'Изображение'}</span><span>нужно: ${x.need}</span>${miss ? '<span>докачаем 0,16 ГБ</span>' : ''}</div></div></div>`;
  }).join('') || '<p class="pr-empty">Ничего не найдено. Сбросьте поиск или фильтр.</p>';
  prRows();
}
/* the cards are shared evenly between the rows (7 cards: 4 + 3, not 6 + 1) */
export function prRows() {
  const g = $('#view-presets .pr-grid'); if (!g || g.classList.contains('list') || !g.clientWidth) return;
  const n = g.children.length, cap = Math.max(1, Math.floor((g.clientWidth + 16) / (272 + 16))), rows = Math.ceil(n / cap);
  g.style.setProperty('--k', Math.max(1, Math.ceil(n / rows)));
}
new ResizeObserver(() => prRows()).observe($('#view-presets'));
/* the strip of section tabs and the «этап» buttons share one line: the strip stops where the
   buttons begin, otherwise the last tab hides under them */
export function fitTopBar() {
  const mb = $('#modeBar'); if (!mb) return;
  const act = document.querySelector('.view.active');
  if (act && window.__stBars) {   // a view that rebuilt its markup gets its buttons back
    const b = window.__stBars[act.id.replace('view-', '')], h = $('.head', act);
    if (b && h && b.parentElement !== h) h.appendChild(b);
  }
  const bar = document.querySelector('.view.active .st-bar');
  let w = 0;
  if (bar && bar.offsetParent && !bar.closest('.head')) {   // only a bar that still sits on the tabs line takes room from it
    const kids = [...bar.children].filter(el => el.offsetParent);
    w = kids.reduce((s, el) => s + el.getBoundingClientRect().width, 0) + Math.max(0, kids.length - 1) * 8;
    w = Math.min(Math.ceil(w), Math.floor(innerWidth * 0.42));   // tabs always keep most of the line
  }
  mb.style.right = (w ? w + 18 : 24) + 'px';
  /* a tab that is not visible is worse than a tab without a word under it: names go away first,
     and only what still does not fit stays behind the edge that fades out */
  mb.classList.remove('tight');
  if (mb.scrollWidth > mb.clientWidth + 26) mb.classList.add('tight');   // a finger's width of slack: names stay until it really does not fit   // узкое окно - полоса сжимается в иконки
  mb.classList.toggle('can-right', mb.scrollWidth > mb.clientWidth + 4);
  const on = mb.querySelector('.mb.on');
  if (on && mb.scrollWidth > mb.clientWidth) {
    const l = on.offsetLeft, r = l + on.offsetWidth;
    if (l < mb.scrollLeft || r > mb.scrollLeft + mb.clientWidth) mb.scrollTo({ left: l - (mb.clientWidth - on.offsetWidth) / 2, behavior: 'smooth' });
  }
}
document.addEventListener('wheel', e => {           // a wheel over the strip moves it sideways
  const mb = e.target.closest && e.target.closest('#modeBar');
  if (mb && mb.scrollWidth > mb.clientWidth) { e.preventDefault(); mb.scrollLeft += (e.deltaY || e.deltaX); }
}, { passive: false });
addEventListener('resize', fitTopBar);
document.addEventListener('click', e => { if (e.target.closest('.nav')) setTimeout(fitTopBar, 30); }, true);
setTimeout(fitTopBar, 60);

/* settings: every block folds (the state is remembered); the long rarely needed ones start folded */
export const FOLD_ON_OPEN = ['mdEngineCard', 'mdRentCard', 'mdOwnCard', 'clCard', 'mdNodesCard', 'mdServiceCard'];
/* «Настройки» - справочная страница: она открывается короткой, а что раскрывать, решает человек.
   Его клики работают, пока он здесь; при следующем открытии список снова свёрнут */
export function foldOnOpen() { FOLD_ON_OPEN.forEach(id => document.getElementById(id)?.classList.add('collapsed')); }

(function () {
  const KEY = 'h3-fold', def = { mdEngineCard: 1, mdRentCard: 1, mdOwnCard: 1, clCard: 1, mdNodesCard: 1 }; let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  $$('#mdStatus > .card').forEach((c, i) => {
    if (c.id === 'mdDl') return;
    const id = c.id || ('c' + i), h = c.querySelector('.card-h'); if (!h) return;
    c.classList.add('fold'); if (id in st ? st[id] : def[id]) c.classList.add('collapsed');
    h.addEventListener('click', e => {
      if (e.target.closest('button,input,a,label')) return;
      c.classList.toggle('collapsed'); st[id] = c.classList.contains('collapsed') ? 1 : 0;
      try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {}
    });
  });
})();
/* Every numbered card folds: a triangle in its heading, folded by default. Without this the program is a
   wall of controls, while a person usually works with one or two of them at a time. The choice is kept per
   card; when a card opens we tell the window about the resize - a waveform or a slider drawn while hidden
   got a zero width and would stay blank otherwise. */
(function () {
  const KEY = 'h3-fold-all'; let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  const keyOf = c => {
    const v = c.closest('[id^="view-"]'), n = c.querySelector(':scope > .card-h .n');
    return (v ? v.id : 'app') + ':' + (n ? n.textContent.trim() : '?');
  };
  const mark = c => {
    if (c._foldAll || c.classList.contains('fold')) return;      // the settings cards fold by their own rules
    const h = c.querySelector(':scope > .card-h'); if (!h || !h.querySelector('.n')) return;
    c._foldAll = true; c.classList.add('fold');
    const k = keyOf(c);
    // the hiding is done by a class and one strong stylesheet rule (see .card.fold.collapsed below):
    // inline styles stuck to the controls that the setup later MOVES - the «Новые сцены / Продолжить
    // видео» strip was folded away for good because it had been a child of a settings card
    if (!(k in st) || st[k]) c.classList.add('collapsed');       // folded by default, until a person says otherwise
    h.addEventListener('click', e => {
      if (e.target.closest('button,input,a,label,select,textarea')) return;
      c.classList.toggle('collapsed');
      st[k] = c.classList.contains('collapsed') ? 1 : 0;
      try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (err) {}
      if (!c.classList.contains('collapsed')) setTimeout(() => dispatchEvent(new Event('resize')), 90);
    });
  };
  const scan = () => {
    // a section keeps gaining cards after its own build - the settings card comes last - so numbers are
    // put right first: otherwise two cards share one key in the saved fold state and fold together
    $$('.view').forEach(v => { try { if (typeof v._h3Renumber === 'function') v._h3Renumber(); } catch (e) {} });
    $$('.card').forEach(mark);
  };
  scan();
  let timer = 0;
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 250); }).observe(document.body, { childList: true, subtree: true });
})();

export async function presetsHave() {
  try { const st = await (await fetch('/api/status')).json(); (st.models || []).forEach(m => { PR.have[m.role] = !!m.have; }); } catch {}
  return PR.have;
}
