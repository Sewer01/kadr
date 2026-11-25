/* ---------- dropzones ---------- */
export const REF_HINT = {
  max: 'Модель внимательно разглядывает ваши изображения в полном размере, поэтому лицо и одежда похожи сильнее всего. Но работает в 2–3 раза дольше. Берите для готового видео.',
  match: 'Модель смотрит на изображения в уменьшенном виде: быстрее, но сходство с лицом чуть хуже. Берите для проб, пока подбираете промпт.',
};
export const MODE_ORDER = ['video', 'lipsync', 'refs', 'actor', 'swap', 'action', 'long', 'krea', 'kreareal', 'qwen', 'flux', 'h3img', 'upscale', 'relayvsr'];
/* ---------- LIBRARY ---------- */
export const MODE_NAME = {
    // one name per mode, the same the bar shows; the key used to be written twice, and the last
    // one silently won - that is how an old name kept surviving every rename
    montage: 'Монтаж', about: 'О программе', custom: 'Свой workflow', video: 'Видео', lipsync: 'Клип', refs: 'Видеостудия',
    actor: 'Актёр', swap: 'Замена', action: 'Экшн-видео', actionsc: 'Экшн фильм', long: 'Киностудия',
    krea: 'Изображение по тексту', fluxt: 'Изображение по тексту', qwent: 'Изображение по тексту', qwen: 'Изображения', upfile: 'Апскейлинг',
    upscale: 'Апскейлинг', relayvsr: 'Апскейлинг · быстро', plist: 'Список кадров', story: 'Раскадровка', sheet: 'Лист персонажа',
  };

/* Что каждый режим умеет - одна таблица, а не разбросанные по коду проверки его id.
   Заполняет фабрика разделов, когда собирает окно; читают все: сам раздел, окно
   сценария и сценарист. Новый режим описывается здесь одной строкой.
   graph      - чем считается: 'single' один проход, 'pika' сцены по Pika,
                'hybrid' гибрид 8 + 4 шага
   draftPass  - есть ли черновик (4 шага) помимо хорошего качества
   baseVideo  - продолжает ли режим готовое видео (база, последний кадр)
   partsOnly  - считается только по частям, режима «весь ролик» нет
   scenes     - режим со сценарной лентой */
export const STUDIO_CAPS = {};
export function studioCaps(mode) { return STUDIO_CAPS[mode] || {}; }
