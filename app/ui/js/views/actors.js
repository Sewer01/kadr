/* Карточки актёров: лицо, голос и приметы, которые повторяются из ролика в ролик.

   Раздел хранит карточки на сервере (data/actors.json и папка файлов), показывает их списком и
   развешивает по одной плашке под каждым окном «Сценарий»: плашка ставит имя карточки туда,
   где стоит курсор. Ряд плашек принадлежит этому разделу, поэтому режимы его не перерисовывают:
   свои плашки тегов у них свои. */
import { $, confirmBox, esc, toast } from '../core/util.js';
import { onNav } from '../core/tabs.js';
import { registerViews } from '../core/state.js';
import { insertAtCursor, scenarioWindowOf } from '../ui/scenario.js';

const TYPES = [['character', 'Персонаж'], ['vehicle', 'Транспорт'], ['object', 'Предмет'], ['location', 'Локация']];
const MAX_IMAGES = 9;
/* Режимы, куда приходят плашки карточек: те же, у которых есть окно «Сценарий». */
export const SCENARIO_TABS = ['video', 'lipsync', 'refs', 'actor', 'swap', 'action', 'long', 'actionsc', 'clipsc'];
const TITLES = { video: 'Видео', lipsync: 'Клип', refs: 'Видеостудия', actor: 'Актёр', swap: 'Замена', action: 'Экшн-видео', long: 'Студия', actionsc: 'Экшн-студия' };

export const AC = { cards: [], loaded: false };
let pickedImages = [], pickedVoice = null;

const typeName = k => (TYPES.find(t => t[0] === k) || ['', k])[1];

async function api(path, opt) {
  const r = await fetch('/api' + path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Программа не приняла карточку');
  return j;
}

export async function acLoad() {
  try {
    const r = await fetch('/api/actors');
    AC.cards = r.ok ? await r.json() : [];
  } catch (e) {
    AC.cards = [];
  }
  AC.loaded = true;
  acRender();
  acChips();
  return AC.cards;
}

function filesNote() {
  const n = pickedImages.length;
  $('#acFiles').textContent = (n ? 'фото: ' + n + ' из ' + MAX_IMAGES : 'фото пока не выбраны')
    + ' · ' + (pickedVoice ? 'голос: ' + pickedVoice.name : 'голос не выбран');
}

const thumb = (img, i) => `<button class="ac-thumb${img.on ? '' : ' off'}" type="button" data-toggle="${i}"
  title="${esc(img.name)}: нажмите, чтобы ${img.on ? 'выключить' : 'включить'} это фото"><img src="${esc(img.url)}" alt=""></button>`;

function cardRow(c) {
  const voice = c.voice
    ? `<div class="ac-voice"><audio controls preload="none" src="${esc(c.voice.url)}" style="height:30px;max-width:280px"></audio><button class="btn mini" type="button" data-voice title="Убрать образец голоса">Убрать голос</button></div>`
    : '<div class="ac-voice"><span class="hint">образца голоса нет</span></div>';
  const note = c.text ? esc(c.text) : '<i>описание не заполнено: впишите, что сохранять в этом образе</i>';
  const modes = SCENARIO_TABS.map(k => `<option value="${k}">${TITLES[k] || k}</option>`).join('');
  return `<div class="ac-card" data-id="${esc(c.id)}">
    <div class="ac-top"><b>${esc(c.name)}</b><span class="hint">${esc(typeName(c.type))}</span>
      <span class="hint" title="Как звать карточку в тексте">@${esc(c.token)}</span><span style="flex:1"></span>
      <button class="btn mini" type="button" data-in title="Поставить имя карточки в поле «Сценарий» выбранного режима">Позвать в режим</button>
      <button class="btn mini" type="button" data-del title="Удалить карточку и её файлы">Удалить</button></div>
    <div class="ac-thumbs">${(c.images || []).map(thumb).join('') || '<span class="ac-empty">фото нет</span>'}</div>
    ${voice}
    <p class="hint ac-note">${note}</p>
    <div class="ac-row"><span class="hint">звать в</span><select data-mode>${modes}</select></div>
  </div>`;
}

function acRender() {
  const box = $('#acList');
  if (!box) return;
  $('#acCnt').textContent = AC.cards.length ? '(' + AC.cards.length + ')' : '';
  box.innerHTML = AC.cards.length
    ? AC.cards.map(cardRow).join('')
    : '<div class="ac-empty">Карточек пока нет: соберите первую наверху - имя, приметы и фото.</div>';
}

/* Ряд плашек под полем «Сценарий»: по одному ряду на окно, ряд принадлежит этому разделу. */
export function acChips() {
  document.querySelectorAll('[data-scenario]').forEach(root => {
    let row = root.querySelector(':scope > .ac-actors');
    if (!AC.cards.length) { if (row) row.remove(); return; }
    if (!row) {
      row = document.createElement('div');
      row.className = 'tokens ac-actors';
      root.append(row);
    }
    row.innerHTML = '<span class="hint">карточки: </span>' + AC.cards.map(c =>
      `<button class="token" type="button" data-ac="${esc(c.token)}" title="${esc(c.text || 'описание не заполнено')}">@${esc(c.token)}</button>`).join('');
  });
}

function formOf(card, extra) {
  const fd = new FormData();
  fd.append('id', card.id); fd.append('name', card.name);
  fd.append('type', card.type); fd.append('text', card.text || '');
  Object.entries(extra || {}).forEach(([k, v]) => fd.append(k, v));
  return fd;
}

async function saveCard() {
  const fd = new FormData();
  fd.append('name', $('#acName').value);
  fd.append('type', $('#acType').value);
  fd.append('text', $('#acText').value);
  pickedImages.forEach(f => fd.append('images', f, f.name));
  if (pickedVoice) fd.append('voice', pickedVoice, pickedVoice.name);
  try {
    await api('/actors', { method: 'POST', body: fd });
    pickedImages = []; pickedVoice = null;
    $('#acName').value = ''; $('#acText').value = '';
    $('#acImages').value = ''; $('#acVoice').value = '';
    filesNote();
    await acLoad();
    toast('Карточка легла на полку: зовите её по имени в поле «Сценарий»');
  } catch (e) { toast(e.message); }
}

$('#acType').innerHTML = TYPES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#acImages').onchange = e => { pickedImages = Array.from(e.target.files).slice(0, MAX_IMAGES); filesNote(); };
$('#acVoice').onchange = e => { pickedVoice = e.target.files[0] || null; filesNote(); };
$('#acAdd').onclick = saveCard;

$('#acList').onclick = async e => {
  const row = e.target.closest('.ac-card'); if (!row) return;
  const card = AC.cards.find(c => c.id === row.dataset.id); if (!card) return;
  const tog = e.target.closest('[data-toggle]');
  if (tog) {
    const i = +tog.dataset.toggle;
    const on = card.images.map((im, j) => j === i ? !im.on : im.on);
    try { await api('/actors', { method: 'POST', body: formOf(card, { on: JSON.stringify(on) }) }); await acLoad(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.closest('[data-voice]')) {
    try { await api('/actors', { method: 'POST', body: formOf(card, { drop_voice: '1' }) }); await acLoad(); toast('Образец голоса убран'); }
    catch (err) { toast(err.message); }
    return;
  }
  if (e.target.closest('[data-del]')) {
    confirmBox('Удалить карточку «' + card.name + '»?',
      'Файлы карточки уйдут вместе с ней. Текст, где вы звали её по имени, останется как есть - просто имя больше никуда не ведёт.',
      'Удалить', async () => {
        try { await api('/actors/' + card.id, { method: 'DELETE' }); await acLoad(); toast('Карточка удалена'); }
        catch (err) { toast(err.message); }
      });
    return;
  }
  if (e.target.closest('[data-in]')) {
    const mode = ($('select[data-mode]', row) || {}).value || SCENARIO_TABS[0];
    const win = scenarioWindowOf(mode);
    if (!win) { toast('В режиме «' + (TITLES[mode] || mode) + '» нет поля сценария'); return; }
    insertAtCursor(win.ta, '@' + card.token);
    toast('Позвали «' + card.name + '» в «' + (TITLES[mode] || mode) + '»: её фото положите в слоты режима и поставьте тег плашкой');
  }
};

/* Клик по плашке карточки: вставляем в то окно, внутри которого плашка лежит. Захват (true)
   нужен, чтобы обработчик плашек тега режима не подставил вместо имени свой тег. */
document.addEventListener('click', e => {
  const chip = e.target.closest('[data-ac]'); if (!chip) return;
  const root = chip.closest('[data-scenario]'); if (!root) return;
  const ta = root.querySelector('textarea.sc-draft') || root.querySelector('textarea'); if (!ta) return;
  e.stopPropagation(); e.preventDefault();
  insertAtCursor(ta, '@' + chip.dataset.ac);
}, true);

SCENARIO_TABS.forEach(k => onNav(k, acChips));
onNav('actors', () => { acLoad(); });
registerViews({ AC });
