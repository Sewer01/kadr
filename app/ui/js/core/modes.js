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
    actor: 'Актёр', swap: 'Замена', action: 'Экшн-видео', actionsc: 'Экшн-студия', long: 'Киностудия',
    krea: 'Изображение по тексту', fluxt: 'Изображение по тексту', qwent: 'Изображение по тексту', qwen: 'Изменение изображения', upfile: 'Апскейлинг',
    upscale: 'Апскейлинг', relayvsr: 'Апскейлинг · быстро', plist: 'Список кадров', story: 'Раскадровка', sheet: 'Лист персонажа',
  };
