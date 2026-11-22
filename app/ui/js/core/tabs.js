/* Вкладки: единый реестр и строительство навигации (кнопки левого столбца).

   Модуль намеренно без импортов: сторож uisnapshot.py прогоняет renderNavHtml()
   в node без браузера и сверяет с замороженным блоком nav_html побайтово.
   Обработчики, которым нужна кнопка, приходят через onNav() и вешаются при сборке. */

/* реестр вкладок: порядок, раздел, ключ, подпись, вложенность, состояние */
export const TABS = [
  {order: 1, section: "Создать", key: "presets", caption: "Главная", sub: false, active: false, hidden: false},
  {order: 2, section: "Создать", key: "agent", caption: "Сценарист", sub: false, active: false, hidden: false},
  {order: 3, section: "Создать", key: "actors", caption: "Карточки", sub: false, active: false, hidden: false},
  {order: 4, section: "Создать", key: "video", caption: "Видео", sub: true, active: true, hidden: false},
  {order: 5, section: "Создать", key: "lipsync", caption: "Клип", sub: true, active: false, hidden: false},
  {order: 6, section: "Создать", key: "refs", caption: "Видеостудия", sub: true, active: false, hidden: false},
  {order: 7, section: "Создать", key: "actor", caption: "Актёр", sub: true, active: false, hidden: false},
  {order: 8, section: "Создать", key: "swap", caption: "Замена", sub: true, active: false, hidden: false},
  {order: 9, section: "Создать", key: "long", caption: "Киностудия", sub: true, active: false, hidden: false},
  {order: 10, section: "Создать", key: "action", caption: "Экшн-видео", sub: true, active: false, hidden: false, group: "refs"},
  {order: 11, section: "Создать", key: "actionsc", caption: "Экшн-студия", sub: true, active: false, hidden: false, group: "long"},
  {order: 12, section: "Создать", key: "clipsc", caption: "Клип-студия", sub: true, active: false, hidden: false, group: "long"},
  {order: 13, section: "Создать", key: "voicelab", caption: "Озвучка", sub: true, active: false, hidden: false},
  {order: 14, section: "Создать", key: "reflab", caption: "Студия референсов", sub: true, active: false, hidden: false},
  {order: 15, section: "Создать", key: "krea", caption: "Изображение по тексту", sub: true, active: false, hidden: false},
  {order: 16, section: "Создать", key: "qwen", caption: "Изменение изображения", sub: true, active: false, hidden: false},
  {order: 17, section: "Создать", key: "custom", caption: "Свои workflow", sub: false, active: false, hidden: true},
  {order: 18, section: "Студия", key: "queue", caption: "Очередь", sub: false, active: false, hidden: false},
  {order: 19, section: "Студия", key: "library", caption: "Библиотека", sub: false, active: false, hidden: false},
  {order: 20, section: "Студия", key: "montage", caption: "Монтаж", sub: false, active: false, hidden: false},
  {order: 20, section: "Студия", key: "upfile", caption: "Апскейлинг", sub: true, active: false, hidden: false},
  {order: 21, section: "Система", key: "models", caption: "Настройки", sub: false, active: false, hidden: false},
  {order: 22, section: "Система", key: "about", caption: "О программе", sub: false, active: false, hidden: false},
];

/* Группы режимов: в меню одна кнопка, а режимы внутри неё выбираются переключателем
   на странице. Страницы при этом остаются собой: у каждой своё тело, свои файлы и свой
   расчёт - меню просто перестаёт их плодить. Кнопкой группы открывается тот режим,
   на котором человек останавливался. */
export const NAV_GROUPS = [
  { nav: "long", store: "h3-grp-film", parts: ["long", "actionsc", "clipsc"] },
  { nav: "refs", store: "h3-grp-video", parts: ["refs", "action"] },
];
export const NAV_GROUP_TITLES = {
  long: "Киностудия", actionsc: "Экшн-студия", clipsc: "Клип-студия",
  refs: "Видеостудия", action: "Экшн-видео",
};
export const groupOf = key => NAV_GROUPS.find(g => g.parts.includes(key)) || null;
/* кнопка в меню есть только у головы группы; у остальных режимов группы кнопки нет */
export const navKeyOf = key => { const g = groupOf(key); return g && key !== g.nav ? g.nav : key; };
export function partOfGroup(nav) {
  const g = NAV_GROUPS.find(x => x.nav === nav);
  if (!g) return nav;
  try { const v = localStorage.getItem(g.store); if (g.parts.includes(v)) return v; } catch (e) { }
  return g.nav;
}

/* значки и хвосты кнопок: строки, записанные один в один со старой разметкой;
   что между маркерами UISNAP - статическая разметка навигации, а не динамические классы раннера */
/*UISNAP:DATA-BEGIN*/
const TAB_SVG = {
  presets: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"2\"/><rect x=\"13.5\" y=\"3\" width=\"7.5\" height=\"7.5\" rx=\"2\"/><rect x=\"3\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"2\"/><rect x=\"13.5\" y=\"13.5\" width=\"7.5\" height=\"7.5\" rx=\"2\"/></svg>",
  agent: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z\"/><path d=\"M19 15l.8 1.9 1.9.8-1.9.8L19 20.4l-.8-1.9-1.9-.8 1.9-.8z\" opacity=\".6\"/></svg>",
  actors: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75\"/></svg>",
  video: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"5\" width=\"13\" height=\"14\" rx=\"2\"/><path d=\"m16 10 5-3v10l-5-3\"/></svg>",
  lipsync: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z\"/><path d=\"M19 11a7 7 0 0 1-14 0M12 18v3\"/></svg>",
  refs: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><path d=\"M17.5 14v7M14 17.5h7\"/></svg>",
  actor: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h0M15 9.5h0\"/></svg>",
  swap: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"8\" cy=\"8\" r=\"3.2\"/><circle cx=\"16\" cy=\"16\" r=\"3.2\"/><path d=\"M13 6h5v5M11 18H6v-5\"/></svg>",
  long: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"6\" width=\"9\" height=\"12\" rx=\"2\"/><rect x=\"13\" y=\"6\" width=\"9\" height=\"12\" rx=\"2\"/></svg>",
  action: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 2 4 14h7l-1 8 9-12h-7z\"/></svg>",
  actionsc: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M9.6 2 4 11.4h4.3L7.6 16.6 13.4 7H8.9z\"/><path d=\"M16.4 7.4 11 16.8h4.3l-.7 5.2 5.8-9.6h-4.5z\"/></svg>",
  voicelab: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 12v-2M7 12V7M11 12V4M15 12v-6M19 12v-3M3 16h18\"/></svg>",
  reflab: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 9h18M12 9v11\"/></svg>",
  krea: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"3\"/><circle cx=\"9\" cy=\"10\" r=\"1.6\"/><path d=\"m21 16-5-5L6 20\"/></svg>",
  qwen: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z\"/></svg>",
  custom: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><path d=\"M10 6.5h4a3 3 0 0 1 3 3V14\"/></svg>",
  queue: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 6h12M4 12h12M4 18h8\"/><circle cx=\"19\" cy=\"16\" r=\"3\"/><path d=\"M19 14.7V16l1 .6\"/></svg>",
  library: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 9h18M8 4v5M16 4v5\"/><path d=\"m10 13 4 2.5-4 2.5z\" fill=\"currentColor\"/></svg>",
  montage: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"2\" y=\"5\" width=\"6\" height=\"14\" rx=\"1.5\"/><rect x=\"9\" y=\"5\" width=\"6\" height=\"14\" rx=\"1.5\"/><rect x=\"16\" y=\"5\" width=\"6\" height=\"14\" rx=\"1.5\"/></svg>",
  upfile: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7\"/></svg>",
  models: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z\"/></svg>",
  about: "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 16v-4M12 8h.01\"/></svg>",
};
const TAB_TAIL = {
  presets: "\n      Главная\n    ",
  agent: "\n      Сценарист\n    ",
  actors: "\n      Карточки\n    ",
  video: "\n      Видео\n    ",
  lipsync: "\n      Клип\n    ",
  refs: "\n      Видеостудия\n    ",
  actor: "\n      Актёр\n    ",
  swap: "\n      Замена\n    ",
  long: "\n      Киностудия\n    ",
  action: "\n      Экшн-видео\n    ",
  actionsc: "\n      Экшн-студия\n    ",
  voicelab: "\n      Озвучка\n    ",
  reflab: "\n      Студия референсов\n    ",
  krea: "\n      Изображение по тексту\n    ",
  qwen: "\n      Изменение изображения\n    ",
  custom: "\n      Свои workflow\n    ",
  queue: "\n      Очередь <span class=\"badge\" id=\"qBadge\" hidden></span>\n    ",
  library: "\n      Библиотека <span class=\"badge\" id=\"libBadge\">0</span>\n    ",
  montage: "\n      Монтаж\n    ",
  upfile: "\n      Апскейлинг\n    ",
  models: "\n      Настройки <span class=\"badge\" id=\"modelsBadge\" hidden></span><span class=\"starthere\">Начните здесь</span>\n    ",
  about: "\n      О программе\n    ",
};

/* подсказки и прочие атрибуты кнопок, какие были в разметке */
const TAB_ATTRS = {
  custom: " id=\"navCustom\"",
  models: " title=\"Движок, модели и файлы, тема и размер интерфейса\"",
  about: " title=\"Что это за программа, из чего выросла, где её файлы и кому она обязана\"",
};
/*UISNAP:DATA-END*/

/* точные разделители между элементами навигации - как лежали в разметке */
const NAV_SEP = ["", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n\n    ", "\n    ", "\n\n    ", "\n\n    ", "\n    ", "\n    ", "\n    ", "\n    ", "\n\n    ", "\n    ", "\n    "];

export function renderNavHtml() {
  let html = "", sec = "", i = 0;
  for (const t of TABS) {
    if (t.group) continue;                 // режим группы: своей кнопки в меню у него нет
    if (t.section !== sec) {
      sec = t.section;
      html += NAV_SEP[i++] + '<div class="nav-label">' + sec + '</div>';
    }
    let a = NAV_SEP[i++] + '<button class="nav' + (t.sub ? ' sub' : '') + (t.active ? ' active' : '')
            + '" data-view="' + t.key + '"';
    a += TAB_ATTRS[t.key] || '';
    if (t.hidden) a += ' hidden';
    html += a + '>\n      ' + TAB_SVG[t.key] + TAB_TAIL[t.key] + '</button>';
  }
  return html + "\n";
}

/* кто просит реакцию на клик своей вкладки (режимы, сценарист, свои workflow):
   регистрируется и до сборки - кнопка достанется обработчику, когда навигация собрана */
const NAV_EXTRA = new Map();
let navMounted = false;

export function onNav(key, fn) {
  if (!NAV_EXTRA.has(key)) NAV_EXTRA.set(key, []);
  NAV_EXTRA.get(key).push(fn);
  if (navMounted) {
    const b = document.querySelector('.nav[data-view="' + key + '"]');
    if (b) b.addEventListener('click', fn);
  }
}

export const activeView = () => ((document.querySelector('.view.active') || {}).id || '').replace('view-', '');

export let SET_LOCK = false;
export function setNavLocked(lock) {
  SET_LOCK = lock; firstRun(lock || !localStorage.getItem('h3-seen-settings'));
  document.querySelectorAll('.nav[data-view]').forEach(n => { if (n.dataset.view !== 'models') n.disabled = lock; });
}

export function firstRun(on) { document.body.classList.toggle('first-run', !!on); }

/* открыть страницу: тот же порядок, что был у кнопок. Уйти из раздела - значит
   не оставить за другой страницей играющий клип или песню; последняя страница
   запоминается, чтобы программа открывалась там, где человек её оставил. */
export function navActivate(view) {
  document.querySelectorAll('video, audio').forEach(m => { try { if (!m.paused) m.pause(); } catch (e) { } });
  if (view !== 'custom') { try { localStorage.setItem('h3-last-view', view); } catch (e) { } }
  /* у режима группы своей кнопки в меню нет - светится кнопка группы */
  const b = document.querySelector('.nav[data-view="' + view + '"]')
    || document.querySelector('.nav[data-view="' + navKeyOf(view) + '"]');
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n === b || (!!b && b.classList.contains('sub') && n.dataset.view === 'presets')));   // a section opened from the start page keeps it lit
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
}

/* переключатель на странице: человек выбирает режим своей группы */
export function setGroupPart(part) {
  const g = groupOf(part);
  if (!g || !g.parts.includes(part)) return;
  try { localStorage.setItem(g.store, part); } catch (e) { }
  navActivate(part);
}

export function goTo(view) {
  const n = document.querySelector('.nav[data-view="' + view + '"]');
  if (n) { n.click(); return; }
  navActivate(view);   // a page that has no button of its own (a preset, a mode of a group)
  if (view === 'swap' && window.h3SwapCheck) window.h3SwapCheck();
}

/* сборка навигации из реестра: прямо на месте пустого слота из разметки */
function mountNav() {
  const slot = document.getElementById('navMount');
  if (!slot) return;
  slot.outerHTML = renderNavHtml();
  navMounted = true;
  // кнопка группы открывает тот её режим, на котором человек останавливался
  document.querySelectorAll('.nav[data-view]').forEach(b => b.onclick = () => navActivate(partOfGroup(b.dataset.view)));
  // обработчики, пришедшие до сборки, получают свои кнопки
  NAV_EXTRA.forEach((fns, key) => {
    const b = document.querySelector('.nav[data-view="' + key + '"]');
    if (b) fns.forEach(fn => b.addEventListener('click', fn));
  });
}

if (typeof document !== 'undefined') mountNav();
