/* Редактирование изображений: окно выбора варианта правки (перенесено из Студии автора,
    эталон - up-imgedit-ui.js).

    Порядок такой: человек выбирает вариант карточкой, и программа открывает наш раздел
    «Изменение изображения» (views/images.js) уже настроенным на эту задачу: свой заголовок
    вместо общего, свой шаг 2 и кнопка «назад ко всем вариантам». Это один и тот же раздел с
    теми же движками - карточка только передвигает переключатель вариантов и убирает с глаз
    лишнее.

    Что вошло и что нет и почему:
    - в окне ровно те варианты, которые у нас правда есть в переключателе .qw-kind раздела
      «Изменение изображения»: правка по описанию (edit), лист персонажа (sheet) и
      раскадровка (story);
    - вариантов «Инпейнт», «Убрать фон» и «Расширение» нет: у нас их не делает ни один
      движок, а делать карточку, которая ведёт в пустоту или в «скоро будет», честнее
      отказа;
    - вместо стрелок и значков слова: в интерфейсе программы значков нет. */

import { $, $$ } from '../core/util.js';
import { goTo, onNav } from '../core/tabs.js';
import { navIcon } from './presets.js';

const IE_VIEW = $('#view-imgedit'), IE_QWEN = $('#view-qwen');

/* k - значение data-k у кнопки переключателя в views/images.js: карточка открывает ровно
   тот вариант, который человек выбрал, а не похожий на него. */
const CARDS = [
  { k: 'edit', title: 'Править по описанию', text: 'Измените на изображении одежду, цвет, место или детали словами. Всё остальное остаётся прежним.', need: 'изображение + что изменить' },
  { k: 'sheet', title: 'Лист персонажа', text: 'Из одного изображения героя получается лист из 4 или 6 видов с разных сторон.', need: 'изображение героя' },
  { k: 'story', title: 'Раскадровка', text: 'История в кадрах по изображениям героя и места.', need: 'изображения героя и места' },
];

/* Общие надписи страницы правки: снимаются один раз при сборке окна и возвращаются, когда
   человек выходит из режима одной задачи. */
let t0 = '', s0 = '', step0 = '';

/* Шаг 2 на странице правки - заголовок окна «Сценарий»; ищем по его цифре, а не по тексту,
   чтобы правка текста шага в другом месте не ломала подмену. */
const step2 = () => $$('.card-h h3', IE_QWEN).find(h => (((h.querySelector('.n') || {}).textContent || '') + '').trim() === '2') || null;

const iePaint = () => {
  IE_VIEW.innerHTML = `<div class="pr-head"><h1>Редактирование изображений</h1><p>Выберите, что хотите сделать с изображением. Всё нужное программа подготовит сама.</p></div>
    <div class="pr-grid">${CARDS.map(c => `<div class="pr-card" role="button" tabindex="0" data-e="${c.k}"><div class="pr-pic">${navIcon('qwen')}</div>
      <div class="pr-body"><b>${c.title}</b><p>${c.text}</p><div class="pr-tags"><span>Изображение</span><span>нужно: ${c.need}</span></div></div></div>`).join('')}</div>`;
};

/* Кнопка возврата живёт на странице правки, а не в её разметке: окно выбора - отдельный
   раздел, и чужую разметку ради своей кнопки переписывать не стоит. */
const ieBackBar = () => {
  if ($('.qw-backbar', IE_QWEN)) return;
  IE_QWEN.insertAdjacentHTML('afterbegin', '<div class="pr-bar qw-backbar"><button class="pr-back" type="button" data-imgedit>Назад ко всем вариантам</button></div>');
};

/* Выход из режима одной задачи: страница снова обычная, со всеми вариантами. */
const iePlain = () => {
  if (!IE_QWEN.classList.contains('solo')) return;
  IE_QWEN.classList.remove('solo');
  const h1 = $('h1', IE_QWEN), sub = $('.head p', IE_QWEN), st = step2();
  if (h1 && t0) h1.textContent = t0;
  if (sub && s0) sub.textContent = s0;
  if (st && step0) st.innerHTML = step0;
};

/* Открыть вариант: тот же раздел, что и по кнопке в меню, но уже на выбранной задаче. */
const ieOpen = k => {
  const c = CARDS.find(x => x.k === k);
  if (!c) { goTo('qwen'); return; }
  IE_QWEN._hub = true;              // эта смена страницы наша: наблюдатель не должен её отменять
  goTo('qwen');
  const b = $(`.qw-kind button[data-k="${c.k}"]`, IE_QWEN);
  if (b) b.click();
  IE_QWEN.classList.add('solo');
  const h1 = $('h1', IE_QWEN), sub = $('.head p', IE_QWEN), st = step2();
  if (h1) h1.textContent = c.title;
  if (sub) sub.textContent = c.text;
  if (st) st.innerHTML = `<span class="n">2</span>${c.title}`;
};

/* То же окно открывает Сценарист: карточка и он должны приводить в одно место.
   В agent.js вызов не встроен - там на это ушло бы больше одной строки. */
export function openImgEdit(k) { ieOpen(k); }
window.openImgEdit = openImgEdit;

IE_VIEW.onclick = e => { const c = e.target.closest('.pr-card'); if (c) ieOpen(c.dataset.e); };
IE_VIEW.onkeydown = e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const c = e.target.closest('.pr-card');
  if (!c) return;
  e.preventDefault();
  ieOpen(c.dataset.e);
};
document.addEventListener('click', e => { if (e.target.closest('[data-imgedit]')) goTo('imgedit'); });

/* Зашли в правку иначе - из Библиотеки, из Сценариста, по кнопке «Использовать в…»:
   все варианты снова доступны, страница обычная, как была до окна выбора. */
new MutationObserver(() => {
  if (!IE_QWEN.classList.contains('active')) return;
  if (IE_QWEN._hub) IE_QWEN._hub = false; else iePlain();
}).observe(IE_QWEN, { attributes: true, attributeFilter: ['class'] });

onNav('imgedit', () => {
  try {
    iePaint();            // варианты не меняются, но окно должно быть на месте после любой дороги сюда
  } catch { /* окно уже построено при импорте: без него сюда всё равно не входят */ }
});

/* Страховка к наблюдателю: клик по кнопке «Изменение изображения» в меню, когда эта страница
   уже открыта, класс не меняет и наблюдатель бы не проснулся - а выйти из режима одной задачи
   нужно и тогда. */
onNav('qwen', iePlain);

/* Окно строим сразу при импорте: в раздел входят не только по пункту меню, и человек не
   должен видеть пустую страницу. Данные для окна не нужны - это три карточки. */
try {
  const h1 = $('h1', IE_QWEN), sub = $('.head p', IE_QWEN), st = step2();
  t0 = (h1 && h1.textContent) || '';
  s0 = (sub && sub.textContent) || '';
  step0 = (st && st.innerHTML) || '';
  ieBackBar();
  iePaint();
} catch { /* в проверочной среде без настоящего браузера окно может не построиться -
             пусть там тело лишь регистрирует обработчики; в браузере сборка проходит */ }
