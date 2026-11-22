/* Озвучка: придумать голос, скопировать его по образцу, озвучить диалог или переозвучить свою запись.

   Раздел говорит с нодами OmniVoice в ComfyUI: графы собирает сервер (app/areas/voicelab.py), здесь
   только окно - режимы, простой монтаж образца голоса и список вариантов. Сохранённые голоса и
   варианты хранит сервер (папка data/voicelab), окно их показывает и просит.
   Текст и настройки переживают закрытие окна; сам файл образца - нет: его нужно положить заново. */
import { $, $$, confirmBox, esc, toast } from '../core/util.js';
import { onNav } from '../core/tabs.js';
import { findPauses, keepRanges, setActx, wavSlice } from '../ui/audio.js';
import { AC, acLoad } from './actors.js';

(() => {
  const root = $('#view-voicelab');
  const WKEY = 'kadr-vl-left';    // ширина колонки с формой: её человек настраивает сам
  const DKEY = 'kadr-vl-draft';   // текст и настройки: закрыл окно - завтра они на месте
  const GEN = { female: 'Женский', male: 'Мужской' };
  const AGE = { child: 'Ребёнок', teenager: 'Подросток', 'young adult': 'Молодой', 'middle-aged': 'Средний возраст', elderly: 'Пожилой' };
  const PITCH = { 'very low pitch': 'Очень низкий', 'low pitch': 'Низкий', 'moderate pitch': 'Средний', 'high pitch': 'Высокий', 'very high pitch': 'Очень высокий' };
  const ACC = { 'russian accent': 'Русский', 'american accent': 'Американский', 'british accent': 'Британский', 'australian accent': 'Австралийский',
    'canadian accent': 'Канадский', 'indian accent': 'Индийский', 'chinese accent': 'Китайский', 'japanese accent': 'Японский',
    'korean accent': 'Корейский', 'portuguese accent': 'Португальский' };
  const TAGS = [['[laughter]', 'смех'], ['[sigh]', 'вздох'], ['[sniff]', 'шмыганье'], ['[dissatisfaction-hnn]', 'недовольство']];
  const TITLES = [['design', 'Новый голос'], ['clone', 'Клонировать голос'], ['dialog', 'Диалог'], ['vc', 'Своя интонация'], ['saved', 'Мои голоса']];
  const MODES = { design: 'Новый голос', clone: 'Клон голоса', dialog: 'Диалог', vc: 'Своя интонация' };
  const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
  const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/></svg>';

  const S = { tab: 'design', st: null, saved: [], takes: [], pend: [], busy: false, stop: false, sp: 2, q: 'normal', count: 3, onlyStar: false, playId: '' };
  const SM = new Map();          // окно образца голоса: ключ -> что в нём лежит
  const TV = new Map();          // карточка варианта: id -> {audio, peaks, raf}

  // ---------- что просим у сервера ----------

  async function loadSaved() { try { S.saved = await (await fetch('/api/voice/saved')).json(); } catch { S.saved = []; } }
  async function loadTakes() { try { S.takes = await (await fetch('/api/voice/takes')).json(); } catch { S.takes = []; } }
  async function loadStatus() {
    stopVcPoll();
    try { S.st = await (await fetch('/api/voice/status')).json(); }
    catch { S.st = { ready: false, state: 'offline', reason: 'Программа не отвечает.' }; }
    if (S.tab === 'vc' && S.st && S.st.vc === false) pollVc();   // «Своя интонация» ждёт большую модель
  }
  async function postJSON(url, body) {
    return send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  async function sendForm(url, fd) { return send(url, { method: 'POST', body: fd }); }
  /* Ответ читается и как json, и как простой текст: так человек видит настоящую причину отказа,
     а не общее «программа не приняла запрос». */
  async function send(url, opt) {
    let r;
    try { r = await fetch(url, opt); } catch { throw new Error('Программа не отвечает'); }
    const raw = await r.text();
    let j = {};
    try { j = raw ? JSON.parse(raw) : {}; } catch { j = { error: raw.slice(0, 400) }; }
    if (!r.ok) throw new Error(j.error || 'Программа не приняла запрос');
    return j;
  }

  // скачивание модели «своей интонации» идёт само (её качает нода), мы только показываем ход
  let vcTimer = 0;
  function stopVcPoll() { if (vcTimer) { clearInterval(vcTimer); vcTimer = 0; } }
  function pollVc() {
    if (vcTimer) return;
    vcTimer = setInterval(async () => {
      if (!root.classList.contains('active') || S.tab !== 'vc') { stopVcPoll(); return; }
      let j = {};
      try { j = await (await fetch('/api/voice/progress')).json(); } catch { stopVcPoll(); return; }
      const el = $('#vlVcNote', root);
      if (!el) { stopVcPoll(); return; }
      el.textContent = j.downloading ? 'Программа качает голосовую модель: ' + gb(j.bytes) + ' из примерно ' + gb(j.total) + ' - это один раз.' : '';
    }, 3000);
  }
  const gb = b => b < 1e9 ? Math.round(b / 1e6) + ' МБ' : (b / 1e9).toFixed(1) + ' ГБ';
  const fmt = t => { t = Math.max(0, t || 0); return t.toFixed(t < 10 ? 2 : 1) + ' с'; };
  const tm = t => t.toFixed(1).replace('.', ',') + ' с';
  const opts = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
  // язык узнаём по кодам знаков: самих иероглифов в коде нет, только их границы
  function langOf(t) {
    const cy = (t.match(/[\u0400-\u04ff]/g) || []).length, la = (t.match(/[A-Za-z]/g) || []).length;
    const cj = (t.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    return cj > cy + la ? 'иероглифы' : (cy && la > cy * 0.5 ? 'смешанный' : (cy >= la ? 'русский' : 'латиница'));
  }

  // ---------- память окна: текст и настройки не теряются между запусками ----------

  function draftGet() { try { return JSON.parse(localStorage.getItem(DKEY) || '{}') || {}; } catch { return {}; } }
  function draftSet(part) {
    const d = Object.assign(draftGet(), part);
    try { localStorage.setItem(DKEY, JSON.stringify(d)); } catch { /* нет места - не страшно */ }
  }
  function saveForm() {
    const f = {}, texts = draftGet().texts || {};
    $$('.vl-left [id]', root).forEach(el => { f[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
    const ta = $('#vlText', root);
    if (ta) texts[S.tab] = ta.value;
    draftSet({ form: f, texts, tab: S.tab, count: S.count, q: S.q, sp: S.sp });
  }
  function restoreForm() {
    const d = draftGet(), f = d.form || {};
    Object.keys(f).forEach(k => {
      const el = $('#' + k, root);
      if (!el || el.type === 'file') return;
      if (el.type === 'checkbox') el.checked = !!f[k]; else el.value = f[k];
    });
    const ta = $('#vlText', root);
    if (ta && (d.texts || {})[S.tab] != null && !ta.value) ta.value = d.texts[S.tab];
    const l = $('#vlLang', root);
    if (l && ta && ta.value.trim()) l.textContent = 'Язык: ' + langOf(ta.value);
  }

  // ---------- мелкие строки формы ----------

  const nf = (id, label, hint, min, max, step, val) =>
    `<div class="vl-f"><label>${label}</label><input type="number" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><small class="hint">${hint}</small></div>`;
  const cf = (id, label, hint, on) =>
    `<label class="vl-chk"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><span><b>${label}</b><small class="hint">${hint}</small></span></label>`;
  const sf = (id, label, hint, list) =>
    `<div class="vl-f"><label>${label}</label><select id="${id}">${list.map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select><small class="hint">${hint}</small></div>`;
  const MP3 = [['V0', 'V0 (лучшее)'], ['320k', '320 кбит/с'], ['128k', '128 кбит/с']];

  /* окно образца голоса: файл, голос из «Моих голосов», готовый вариант или запись микрофона.
     Под окном - простой монтаж: оставить один кусок, вырезать лишнее, убрать паузы. */
  function pickHtml(key, label, hint) {
    const groups = (S.saved.length ? `<optgroup label="Мои голоса">${S.saved.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</optgroup>` : '')
      + (S.takes.length ? `<optgroup label="Варианты раздела">${S.takes.map(t => `<option value="take:${esc(t.id)}">${esc(t.name)}</option>`).join('')}</optgroup>` : '');
    return `<div class="vl-f" data-pk="${key}"><label>${label} <small>${hint}</small></label>
      <div class="vl-row"><select data-pks style="flex:1;min-width:190px"><option value="">Выберите голос из списка…</option>${groups}</select>
        <label class="btn mini">Файл с компьютера<input type="file" data-pkf accept="audio/*" hidden></label>
        <button class="btn mini" type="button" data-rec title="Нажмите, говорите, нажмите ещё раз: запись станет образцом">Записать с микрофона</button></div>
      <div class="vl-sm" hidden><div class="vl-smwave"><canvas></canvas></div>
        <div class="vl-smtools"><button class="btn mini" data-s="play" type="button">Слушать</button><button class="btn mini" data-s="stop" type="button">Стоп</button><span class="hint" data-sinfo></span></div>
        <div class="vl-smtools"><span class="vl-lbl">Мышкой на волне:</span>
          <button class="chip on" data-m="keep" type="button" title="Потяните края, чтобы оставить только нужный кусок">Оставить кусок</button>
          <button class="chip" data-m="cut" type="button" title="Обведите на волне лишнее - оно станет красным и пропадёт. Клик по красному возвращает">Вырезать кусок</button>
          <button class="btn mini" data-s="pauses" type="button" title="Вырезает тихие места длиннее 0,4 секунды">Убрать паузы</button>
          <button class="btn mini pri" data-s="apply" type="button" hidden title="Окончательно убирает вырезанное из образца">Удалить вырезанное</button>
          <button class="btn mini" data-s="undo" type="button" hidden>Вернуть вырезанное</button>
          <button class="btn mini" data-s="reset" type="button">Весь файл</button></div>
        <div class="hint">Лучше всего 3-15 секунд чистой речи одного человека без музыки. Слова образца можно не вписывать: программа распознает их сама.</div></div></div>`;
  }
  const wordsHtml = attr => `<input type="text" ${attr} maxlength="1000" placeholder="что сказано в образце (можно не заполнять)">`;

  function settingsCard() {
    const m = (S.st && S.st.models) || [];
    return `<div class="card"><div class="card-h"><h3>Настройки</h3><button class="btn mini" id="vlReset" type="button">Сбросить всё</button></div>
      <div class="vl-grid"><div class="vl-f"><label>Качество</label><div class="vl-row" id="vlQ">${[['fast', 'Быстро', 16], ['normal', 'Обычно', 32], ['best', 'Лучшее', 64]]
        .map(([k, t, n]) => `<button type="button" class="chip${S.q === k ? ' on' : ''}" data-q="${k}" data-n="${n}">${t}</button>`).join('')}</div><small class="hint">Задаёт число шагов ниже</small></div>
        <div class="vl-f"><label>Скорость речи: <b id="vlSpV">1.0</b></label><input type="range" id="vlSp" min="0.5" max="2" step="0.1" value="1"><small class="hint">меньше - медленнее, больше - быстрее</small></div></div>
      <details class="vl-adv" open><summary>Точность и качество звука</summary><div class="vl-grid">
        <div class="vl-f"><label>Шагов обработки</label><input type="number" id="vlSteps" min="4" max="64" step="1" value="32">
          <small class="hint">от 4 до 64. Больше - чище, но дольше</small></div>
        ${nf('vlGu', 'Строгость к тексту', 'от 0 до 10. Больше - точнее читает написанное', 0, 10, 0.1, 2)}
        ${nf('vlTs', 'Сдвиг по времени', 'от 0 до 1, обычно 0,1', 0, 1, 0.01, 0.1)}
        ${nf('vlDu', 'Длина записи, секунд', 'от 0 до 60. 0 - сама', 0, 60, 0.5, 0)}</div></details>
      <details class="vl-adv"><summary>Характер голоса и случайность</summary><div class="vl-grid">
        ${nf('vlPt', 'Случайность интонации', 'от 0 до 20. 0 - ровно, больше - живее', 0, 20, 0.5, 5)}
        ${nf('vlCt', 'Случайность звука', 'от 0 до 5. 0 - стабильно', 0, 5, 0.1, 0)}
        ${nf('vlLp', 'Штраф за слои', 'от 0 до 20, обычно 5', 0, 20, 0.5, 5)}
        ${nf('vlSeed', 'Номер варианта', '0 - каждый раз новый. Одно число даёт тот же результат', 0, 2147483647, 1, 0)}
        ${S.tab === 'dialog' ? nf('vlPause', 'Пауза между репликами, с', 'от 0 до 3', 0, 3, 0.1, 0.3) : ''}
        ${S.tab === 'clone' ? nf('vlWpc', 'Слов в одной части', 'длинный текст режется на части. 0 - не резать', 0, 500, 10, 100) : ''}
        ${S.tab === 'clone' ? '<div class="vl-f"><label>Подсказка по стилю <small>по-английски</small></label><input type="text" id="vlInstr" maxlength="300" placeholder="calm, warm"><small class="hint">Если пусто, берётся стиль образца</small></div>' : ''}</div></details>
      <details class="vl-adv"><summary>Обработка звука</summary><div class="vl-grid">
        ${cf('vlDen', 'Убирать шум', 'очищает результат от лишнего шума', true)}
        ${S.tab !== 'design' ? cf('vlPre', 'Подготовить образец', 'обрезает паузы и выравнивает образец', true) : ''}
        ${cf('vlPost', 'Довести звук', 'финальная обработка: убирает хвосты и щелчки', true)}
        ${sf('vlMp3', 'Качество файла mp3', 'V0 - лучшее для mp3', MP3)}</div></details>
      <details class="vl-adv"><summary>Модель и видеокарта</summary><div class="vl-grid">
        ${sf('vlModel', 'Модель', 'по умолчанию выбирает программа', [['', 'Выбрать само'], ...m.map(x => [x, x])])}
        ${sf('vlDev', 'Где считать', 'auto - на видеокарте, если есть', [['auto', 'auto (само)'], ['cuda', 'Видеокарта NVIDIA'], ['cpu', 'Процессор (медленно)']])}
        ${sf('vlDt', 'Точность чисел', 'auto подходит почти всегда', [['auto', 'auto (само)'], ['bf16', 'bf16'], ['fp16', 'fp16'], ['fp32', 'fp32 (тяжелее)']])}
        ${sf('vlAtt', 'Способ внимания', 'sage_attention быстрее, нужен спец. модуль', [['auto', 'auto (само)'], ['eager', 'eager'], ['sage_attention', 'sage_attention']])}
        ${cf('vlKeep', 'Держать модель в памяти', 'следующая озвучка стартует быстрее, но память занята', false)}</div></details></div>`;
  }

  function textCard(ph, hint) {
    return `<div class="card"><div class="card-h"><h3>Текст</h3><span class="hint" id="vlLang"></span></div>
      <textarea class="vl-text" id="vlText" maxlength="20000" placeholder="${ph}"></textarea>
      <div class="vl-row" style="margin-top:8px"><span class="hint">Вставить:</span>${TAGS.map(([t, n]) => `<button type="button" class="btn mini" data-tag="${t}">${n}</button>`).join('')}</div>
      <div class="hint" style="margin-top:6px">${hint} Язык речи определяется по тексту.</div></div>`;
  }

  // ---------- левая колонка: четыре режима ----------

  function designCard() {
    return `<div class="card"><div class="card-h"><h3>Какой это голос</h3></div><div class="vl-grid">
      <div class="vl-f"><label>Пол</label><select id="vlG">${opts(GEN, 'female')}</select></div>
      <div class="vl-f"><label>Возраст</label><select id="vlA"><option value="">Не важно</option>${opts(AGE, 'young adult')}</select></div>
      <div class="vl-f"><label>Высота голоса</label><select id="vlP"><option value="">Не важно</option>${opts(PITCH, 'moderate pitch')}</select></div>
      <div class="vl-f"><label>Акцент</label><select id="vlC"><option value="">Без акцента</option>${opts(ACC, 'russian accent')}</select></div></div>
      <label class="vl-row" style="margin-top:10px"><input type="checkbox" id="vlW"> Говорить шёпотом</label>
      <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Описать голос своими словами (по-английски)</summary>
        <input type="text" id="vlCu" maxlength="300" style="margin-top:8px;width:100%" placeholder="female, low pitch, british accent">
        <div class="hint" style="margin-top:4px">Если здесь что-то написано, список выше не используется.</div></details></div>`;
  }

  function vcCard() {
    if (!(S.st && S.st.vc)) {
      return `<div class="card vl-warn"><b>Для этого режима нужен модуль преобразования голоса (Chatterbox).</b>
        <div class="hint">Установка скачает небольшой модуль - это несколько минут. Саму модель (около 3 ГБ) программа скачает при первом преобразовании, один раз.
        После установки перезапустите ComfyUI и вернитесь сюда.</div>
        <div class="vl-row"><button class="btn pri" id="vlInstallVc" type="button">Установить модуль преобразования</button></div>
        <div class="hint" id="vlVcNote"></div></div>`;
    }
    return `<div class="card"><div class="card-h"><h3>1. Ваша запись</h3></div>
      <div class="hint" style="margin-bottom:8px">Наговорите фразу так, как она должна прозвучать: с нужной интонацией, паузами и эмоцией. Слова, ритм и подача
        сохранятся, поменяется только голос.</div>${pickHtml('src', 'Ваша запись', 'файл или запись микрофона, до 30 секунд')}</div>
      <div class="card"><div class="card-h"><h3>2. Чьим голосом сказать</h3></div>${pickHtml('ref', 'Образец голоса', 'свой образец или голос из «Мои голоса», 5-15 секунд чистой речи')}</div>
      <div class="card"><div class="card-h"><h3>Настройки</h3></div><div class="vl-grid">
        ${nf('vlCvSteps', 'Шагов обработки', 'от 2 до 50. Больше - чище, но дольше', 2, 50, 1, 10)}
        ${nf('vlCvCfg', 'Похожесть на выбранный голос', 'от 0 до 2. Больше - ближе к голосу, но менее естественно', 0, 2, 0.05, 1)}
        ${nf('vlCvPass', 'Проходов преобразования', 'от 1 до 5. Больше - голос держится до конца фразы, но дольше. Лучше 2-3', 1, 5, 1, 2)}
        ${sf('vlMp3', 'Качество файла mp3', 'V0 - лучшее для mp3', MP3)}</div></div>`;
  }

  function dialogCard() {
    const rows = Array.from({ length: S.sp }, (_, i) => `<div class="vl-sp"><b>Голос ${i + 1}</b><span class="hint">в тексте: [Speaker_${i + 1}]:</span>
      ${pickHtml('sp' + (i + 1), 'Образец голоса', 'файл, микрофон или сохранённый голос')}${wordsHtml('data-spw="' + (i + 1) + '"')}</div>`).join('');
    return `<div class="card"><div class="card-h"><h3>Голоса диалога</h3><div class="vl-row">
        <button class="btn mini" id="vlSpMinus" type="button">Меньше голосов</button><button class="btn mini" id="vlSpPlus" type="button">Больше голосов</button></div></div>
      <div class="vl-grid" style="grid-template-columns:1fr">${rows}</div></div>`;
  }

  const goLabel = () => S.busy ? 'Озвучиваю…' : `Озвучить: ${S.count} ${S.count === 1 ? 'вариант' : S.count < 5 ? 'варианта' : 'вариантов'}`;

  function leftBody() {
    let main = '';
    if (S.tab === 'design') main = textCard('Привет! Давай придумаем свой собственный голос.', 'Можно писать на русском и на других языках.') + designCard();
    else if (S.tab === 'clone') main = `<div class="card"><div class="card-h"><h3>Чей голос взять</h3></div>${pickHtml('ref', 'Образец голоса', '3-15 секунд чистой речи без музыки')}
      <div class="vl-f"><label>Что сказано в образце <small>можно не заполнять</small></label>${wordsHtml('id="vlRefText"')}</div></div>`
      + textCard('Что должен сказать этот голос. Текст можно длинный: программа сама поделит его на части.', 'Сохранённые голоса лежат во вкладке «Мои голоса».');
    else if (S.tab === 'vc') main = vcCard();
    else main = dialogCard() + textCard('[Speaker_1]: Привет! Как дела?\n[Speaker_2]: Отлично, спасибо!', 'Каждая реплика с новой строки. Без [Speaker_N]: реплики пойдут голосами по очереди.');
    const first = (S.tab === 'vc' || (S.st && S.st.downloaded)) ? ''
      : '<div class="hint">При первой озвучке программа скачает голосовой движок (около 2 ГБ). Это один раз.</div>';
    return `<div class="vl-row" style="justify-content:flex-end"><span class="hint" style="flex:1">Текст и настройки запоминаются сами.</span>
      <button class="btn mini" id="vlWipe" type="button" title="Текст и настройки вернутся к начальным">Очистить всё</button></div>${first}${main}
      ${S.tab === 'vc' ? '' : settingsCard()}
      <div><div class="vl-f" style="margin-bottom:8px"><label>Сколько вариантов сделать</label>
        <div class="vl-row" id="vlN">${[1, 2, 3, 4, 6].map(n => `<button type="button" class="chip${S.count === n ? ' on' : ''}" data-n="${n}">${n}</button>`).join('')}</div></div>
        <div style="display:flex;gap:8px"><button class="btn pri vl-big" id="vlGo" type="button" style="flex:1">${goLabel()}</button>
          <button class="btn vl-big vl-stop" id="vlStop" type="button" hidden style="width:auto;padding:0 20px">Остановить</button></div>
        <div class="hint" id="vlMsg" style="margin-top:6px;text-align:center;line-height:1.5"></div></div>`;
  }

  // ---------- правая колонка: варианты ----------

  function takeCard(t) {
    const marks = [`<i class="m">${esc(MODES[t.mode] || t.mode || '')}</i>`, `<i>${esc((t.params || {}).steps || '')} шагов</i>`,
      `<i>номер ${esc(t.seed || 'нет')}</i>`, `<i>${langOf(t.text || '')}</i>`];
    const on = S.playId === t.id;
    return `<div class="vl-take${t.star ? ' star' : ''}" data-id="${esc(t.id)}">
      <button class="vl-play" data-a="play" type="button" title="${on ? 'Пауза' : 'Слушать'}">${on ? PAUSE_SVG : PLAY_SVG}</button>
      <div class="vl-tt"><b data-a="ren" title="Нажмите, чтобы переименовать">${esc(t.name)}</b>
        <span><button class="btn mini" data-a="ren" type="button">Переименовать</button><em data-dur style="font-style:normal"></em>
          <button class="vl-star${t.star ? ' on' : ''}" data-a="star" type="button" title="Помеченное не удаляется при очистке">${t.star ? 'Помечено' : 'Пометить'}</button></span></div>
      <div class="vl-wave" data-a="seek"><canvas></canvas></div>
      <div class="vl-quote">«${esc(t.text || '')}»</div>
      <div class="vl-marks">${marks.join('')}</div>
      <div class="vl-acts"><button class="btn mini pri" data-a="save" type="button">В «Мои голоса»</button>
        <button class="btn mini" data-a="card" type="button">Отдать карточке</button>
        <button class="btn mini" data-a="clone" type="button">Озвучить этим голосом</button>
        <button class="btn mini" data-a="reuse" type="button">Повторить настройки</button>
        <a class="btn mini" href="${esc(t.url)}" download="${esc(t.name)}.mp3">Скачать</a><span class="sp"></span>
        <button class="btn mini" data-a="del" type="button">Удалить</button></div></div>`;
  }

  function pendHtml(p) {
    return `<div class="vl-take pend" data-p="${p.k}"><button class="vl-play" type="button" disabled>…</button>
      <div class="vl-tt"><b>${esc(p.name)}</b><span>считается…</span></div>
      <div class="vl-quote">${esc(p.text)}</div>
      <div class="vl-wave" style="grid-column:2"><div class="vl-pb"><i></i></div><div class="hint" data-eta style="margin-top:6px"></div></div></div>`;
  }

  function takesHtml() {
    const list = S.takes.filter(t => !S.onlyStar || t.star);
    const empty = S.pend.length ? ''
      : `<div class="vl-empty">${S.onlyStar ? 'Помеченных вариантов пока нет.' : 'Здесь появятся варианты голоса. Напишите текст слева и нажмите «Озвучить»: можно сделать сразу несколько и выбрать лучший.'}</div>`;
    return `<div class="vl-takes"><div class="vl-th"><h3>Варианты <span class="chip" style="cursor:default">${S.takes.length}</span></h3>
        <div class="vl-row"><button class="btn mini${S.onlyStar ? ' pri' : ''}" id="vlFilter" type="button">Только помеченные</button>
          <button class="btn mini" id="vlClear" type="button">Убрать неотмеченные</button></div></div>
      ${S.pend.map(pendHtml).join('')}${list.map(takeCard).join('')}${empty}</div>`;
  }

  function savedHtml() {
    const rows = S.saved.map(v => `<div class="vl-sv" data-id="${esc(v.id)}"><b>${esc(v.name)}</b>
      <audio controls preload="none" src="${esc(v.url)}"></audio><span class="hint">${esc(v.note || '')}</span>
      <button class="btn mini" data-a="use" type="button">Озвучить этим голосом</button>
      <button class="btn mini" data-a="card" type="button">Отдать карточке</button>
      <button class="btn mini" data-a="del" type="button">Удалить</button></div>`).join('<div style="height:8px"></div>');
    return `<div class="card"><div class="card-h"><h3>Мои голоса</h3></div>
      <div class="hint" style="margin-bottom:10px">Здесь живут сохранённые голоса: короткий образец и название. Любой из них выбирается при клонировании и в диалоге,
        его же можно отдать карточке в разделе «Карточки» - тогда её начнут озвучивать этим голосом.</div>
      ${rows || '<div class="hint">Пока пусто. Придумайте голос и нажмите «В «Мои голоса»» у понравившегося варианта, либо добавьте свой образец ниже.</div>'}
      <div class="vl-row" style="margin-top:14px"><input type="text" id="vlNewName" maxlength="60" placeholder="Название голоса" style="max-width:240px">
        <label class="btn mini">Добавить образец с компьютера<input type="file" id="vlNewFile" accept="audio/*" hidden></label></div></div>`;
  }

  function statusHtml() {
    const st = S.st || { ready: false, state: 'offline', reason: 'Раздел ещё не проверял ComfyUI.' };
    if (st.ready) return '';
    const dir = (st.state === 'nonode' && !st.nodes_known)
      ? `<div class="vl-dir"><input type="text" id="vlDir" placeholder="папка вашего ComfyUI, где лежит custom_nodes" spellcheck="false">
         <button class="btn" id="vlDirSet" type="button">Указать папку</button></div>` : '';
    const btns = (st.state === 'nonode' ? `<button class="btn pri" id="vlInstall" type="button">Установить модуль голоса</button> ` : '')
      + (st.restart ? '<button class="btn pri" id="vlRestart" type="button">Перезапустить ComfyUI</button> ' : '')
      + '<button class="btn" id="vlRecheck" type="button">Проверить ещё раз</button>';
    return `<div class="card vl-warn"><b>${esc(st.reason || 'Голоса пока недоступны')}</b>
      ${st.state === 'nonode' ? '<div class="hint">Установка скачает небольшой модуль и нужные Python-пакеты - это несколько минут. Сам голосовой движок '
        + '(около 2 ГБ) скачается при первой озвучке. После установки ComfyUI нужно перезапустить.</div>' : ''}
      ${dir}<div class="vl-row">${btns}</div><div class="hint" id="vlNote"></div></div>`;
  }

  // ---------- сборка страницы ----------

  function paint() {
    stopAll();
    const st = S.st;
    let body;
    if (st && !st.ready) body = statusHtml();
    else if (S.tab === 'saved') body = savedHtml();
    else body = `<div class="vl-layout"><div class="vl-left">${leftBody()}</div>
      <div class="vl-split" id="vlSplit" title="Потяните, чтобы изменить ширину. Двойной щелчок - вернуть как было"></div>
      <div id="vlRight">${takesHtml()}</div></div>`;
    root.innerHTML = `<div class="head"><div><h1>Озвучка</h1>
      <p>Придумайте голос, скопируйте чужой по образцу, озвучьте диалог или переозвучьте свою запись. Можно делать сразу несколько вариантов и выбирать лучший.
        Всё считается на вашем компьютере</p></div></div>
      <div class="vl-tabs" id="vlTabs">${TITLES.map(([k, t]) => `<button type="button" class="chip${S.tab === k ? ' on' : ''}" data-t="${k}">${t}</button>`).join('')}</div>${body}`;
    if (st && st.ready && S.tab !== 'saved') {
      restoreForm();
      bindForm();
      applyWidth();
      $$('[data-pk]', root).forEach(b => { if ($('[data-pks]', b).value) smLoad(b.dataset.pk); });
      drawAll();
      if (S.tab !== 'vc') prefetch();
    }
  }
  const prefetch = () => S.takes.slice(0, 6).forEach(t => peaksOfTake(t).catch(() => {}));
  /* Волну и длительность рисуем по файлу варианта: сервер их не считает. Первые карточки
     загружаем сразу - список сразу живой, остальные дорисуются при первом прослушивании. */
  function paintTakes() {
    const box = $('#vlRight', root);
    if (!box) return;
    box.innerHTML = takesHtml();
    drawAll();
    prefetch();
  }

  // ширина колонки с формой: палка между формой и вариантами
  let leftW = 440;
  try { leftW = Math.max(300, +localStorage.getItem(WKEY) || 440); } catch { /* начальная */ }
  function applyWidth() {
    const lay = $('.vl-layout', root); if (!lay) return;
    const max = Math.max(320, lay.clientWidth - 360);
    lay.style.setProperty('--vl-left', Math.min(max, Math.max(300, leftW)) + 'px');
    drawAll();
  }
  root.addEventListener('pointerdown', e => {
    const sp = e.target.closest('#vlSplit'); if (!sp) { smPointer(e); return; }
    e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
    const lay = $('.vl-layout', root), x0 = e.clientX, w0 = $('.vl-left', root).getBoundingClientRect().width;
    const move = ev => { leftW = Math.round(w0 + ev.clientX - x0); applyWidth(); };
    const up = () => {
      sp.classList.remove('drag'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
      try { localStorage.setItem(WKEY, String(leftW)); } catch { /* не сохранилось */ }
    };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  });
  root.addEventListener('dblclick', e => { if (e.target.closest('#vlSplit')) { leftW = 440; applyWidth(); try { localStorage.removeItem(WKEY); } catch { /* ок */ } } });
  addEventListener('resize', () => { if ($('.vl-layout', root)) applyWidth(); });

  function bindForm() {
    $('#vlSp', root)?.addEventListener('input', e => { $('#vlSpV', root).textContent = (+e.target.value).toFixed(1); });
    $('#vlSteps', root)?.addEventListener('input', e => {
      const v = +e.target.value, k = v <= 16 ? 'fast' : v >= 64 ? 'best' : v === 32 ? 'normal' : '';
      S.q = k || S.q;
      $$('#vlQ .chip', root).forEach(x => x.classList.toggle('on', x.dataset.q === k));
    });
    $('#vlText', root)?.addEventListener('input', e => {
      const l = $('#vlLang', root); if (l) l.textContent = e.target.value.trim() ? 'Язык: ' + langOf(e.target.value) : '';
    });
  }

  // ---------- окно образца голоса ----------

  const smOf = key => SM.get(key);
  function segsOf(st) {            // куски, которые остаются: выбранный промежуток минус вырезанное
    let out = [[st.a, st.b]];
    st.cuts.forEach(([c0, c1]) => {
      out = out.flatMap(([x, y]) => (c1 <= x || c0 >= y) ? [[x, y]] : [c0 > x ? [x, c0] : null, c1 < y ? [c1, y] : null].filter(Boolean));
    });
    return out.filter(([x, y]) => y - x > 0.02);
  }
  const keptLen = st => segsOf(st).reduce((n, [x, y]) => n + y - x, 0);
  const smEdited = st => !!st && (st.buf.duration !== st.dur0 || st.a > 0.02 || st.b < st.buf.duration - 0.02 || st.cuts.length > 0);
  function wavOf(st) {             // то, что уйдёт на сервер: оставленные куски, склеенные в wav
    setActx();                     // keepRanges работает через общий аудиоконтекст
    return wavSlice(keepRanges(st.buf, segsOf(st)), 0, st.buf.duration);
  }
  function peaksOf(buf) {
    const ch = buf.getChannelData(0), n = 300, step = Math.floor(ch.length / n) || 1, pk = [];
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < step; j += 8) m = Math.max(m, Math.abs(ch[i * step + j] || 0));
      pk.push(m);
    }
    const top = Math.max(...pk) || 1;
    return pk.map(v => Math.min(1, v / top * 0.95 + 0.03));
  }
  async function decode(src) {     // аудио из адреса или файла: общий аудиоконтекст окна
    const buf = await setActx().decodeAudioData(await src);
    return buf;
  }
  function smInfo(key) {
    const st = smOf(key), box = $(`[data-pk="${key}"]`, root); if (!st || !box) return;
    const len = keptLen(st), el = $('[data-sinfo]', box);
    if (el) {
      el.textContent = 'Оставлено ' + tm(len) + (st.a > 0.02 || st.b < st.buf.duration - 0.02 ? ` (кусок ${tm(st.a)}-${tm(st.b)})` : '')
        + (st.cuts.length ? ` · вырезано кусков: ${st.cuts.length}` : '')
        + (len > 15 ? ' · длинновато: лучше до 15 с' : len < 3 ? ' · коротковато: лучше от 3 с' : '');
      el.classList.toggle('bad', len > 15 || len < 3);
    }
    $('[data-s="undo"]', box) && ($('[data-s="undo"]', box).hidden = !st.cuts.length);
    $('[data-s="apply"]', box) && ($('[data-s="apply"]', box).hidden = !(st.cuts.length || st.a > 0.02 || st.b < st.buf.duration - 0.02));
    $$('[data-m]', box).forEach(x => x.classList.toggle('on', x.dataset.m === st.mode));
  }
  function wave(cv, pk, st) {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1; if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const on = cs.getPropertyValue('--accent').trim() || '#e8264f', off = cs.getPropertyValue('--line-2').trim() || '#55283a';
    const dur = st.dur || 1, cut = t => (st.cuts || []).some(([x, y]) => t >= x && t <= y)
      || (st.live && t >= Math.min(st.live[0], st.live[1]) && t <= Math.max(st.live[0], st.live[1]));
    const n = Math.floor(w / 3);
    for (let i = 0; i < n; i++) {
      const v = pk[Math.floor(i / n * pk.length)] || 0, bh = Math.max(2, v * (h - 8)), x = i * (w / n), t = i / n * dur;
      const inside = (st.a == null || (t >= st.a && t <= st.b)) && !cut(t);
      c.fillStyle = inside ? on : off; c.globalAlpha = inside ? 1 : 0.3;
      c.fillRect(x, (h - bh) / 2, Math.max(1.2, w / n - 1), bh);
    }
    c.globalAlpha = 0.28; c.fillStyle = '#e5484d';
    (st.cuts || []).concat(st.live ? [[Math.min(st.live[0], st.live[1]), Math.max(st.live[0], st.live[1])]] : [])
      .forEach(([x, y]) => c.fillRect(x / dur * w, 0, (y - x) / dur * w, h));
    c.globalAlpha = 1; c.fillStyle = on;
    if (st.a != null) [st.a, st.b].forEach(t => {
      const x = t / dur * w;
      c.fillRect(Math.min(w - 3, Math.max(0, x - 1.5)), 0, 3, h);
      c.fillRect(Math.min(w - 9, Math.max(0, x - 4.5)), h / 2 - 9, 9, 18);
    });
    if (st.at != null) { c.fillStyle = '#fff'; c.fillRect(st.at / dur * w - 1, 0, 2, h); }
  }
  function smDraw(key) {
    const st = smOf(key), box = $(`[data-pk="${key}"]`, root); if (!st || !box) return;
    const cv = $('.vl-smwave canvas', box); if (!cv) return;
    wave(cv, st.peaks, { a: st.a, b: st.b, cuts: st.cuts, live: st.live, dur: st.buf.duration, at: st.audio.paused ? null : st.audio.currentTime });
  }
  function smTick(key) {
    const st = smOf(key); if (!st) return;
    cancelAnimationFrame(st.raf);
    if (!st.audio.paused) {
      const t = st.audio.currentTime, cut = st.cuts.find(([x, y]) => t >= x - 0.01 && t < y);
      if (cut) st.audio.currentTime = cut[1];                      // проигрываем без вырезанного
      if (st.audio.currentTime >= st.b - 0.02) { st.audio.pause(); smBtn(key, 'play', 'Слушать'); }
    }
    smDraw(key);
    if (!st.audio.paused) st.raf = requestAnimationFrame(() => smTick(key));
  }
  const smBtn = (key, act, text) => { const box = $(`[data-pk="${key}"]`, root); if (box) $(`[data-s="${act}"]`, box).textContent = text; };
  function addCut(st, x, y) {          // кусок вырезания: сливается с соседними, чтобы не плодить мелочь
    let c0 = Math.min(x, y), c1 = Math.max(x, y); const rest = [];
    st.cuts.forEach(([p, q]) => { if (q < c0 || p > c1) rest.push([p, q]); else { c0 = Math.min(c0, p); c1 = Math.max(c1, q); } });
    rest.push([c0, c1]); st.cuts = rest.sort((p, q) => p[0] - q[0]);
  }
  async function smLoad(key) {
    const box = $(`[data-pk="${key}"]`, root); if (!box) return;
    const old = smOf(key); if (old) { old.audio.pause(); cancelAnimationFrame(old.raf); SM.delete(key); }
    const sel = $('[data-pks]', box).value, f = $('[data-pkf]', box).files[0], wrap = $('.vl-sm', box);
    let src = '';
    if (sel.startsWith('take:')) src = '/api/voice/out/' + sel.slice(5);
    else if (sel) src = '/api/voice/saved/' + sel + '/file';
    else if (f) src = URL.createObjectURL(f);
    if (!src) { wrap.hidden = true; SM.delete(key); return; }
    wrap.hidden = false; $('[data-sinfo]', box).textContent = 'Загружаю…';
    try {
      const buf = await decode(f && !sel ? f.arrayBuffer() : (await fetch(src)).arrayBuffer());
      const st = { buf, dur0: buf.duration, a: 0, b: buf.duration, cuts: [], mode: 'keep', live: null, peaks: peaksOf(buf), audio: new Audio(src), raf: 0 };
      st.audio.addEventListener('ended', () => { st.audio.currentTime = st.a; smBtn(key, 'play', 'Слушать'); smDraw(key); });
      SM.set(key, st); smInfo(key); smDraw(key);
    } catch { wrap.hidden = true; toast('Не удалось открыть этот звук. Выберите другой файл (wav, mp3, flac, m4a).'); }
  }
  function smPointer(e) {              // мышь на волне образца: края куска или новое вырезание
    const box = e.target.closest('[data-pk]'); if (!box) return;
    const cv = e.target.closest('.vl-smwave'); if (!cv) return;
    const st = smOf(box.dataset.pk); if (!st) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect(), at = x => Math.min(st.buf.duration, Math.max(0, (x - r.left) / r.width * st.buf.duration));
    const t0 = at(e.clientX), near = st.buf.duration / r.width * 10, prev = [st.a, st.b];
    let mode = st.mode === 'cut' ? 'cut' : Math.abs(t0 - st.a) < near ? 'a' : Math.abs(t0 - st.b) < near ? 'b' : 'new';
    if (mode === 'new') { st.a = st.b = t0; mode = 'b'; }
    if (mode === 'cut') st.live = [t0, t0];
    const key = box.dataset.pk;
    const move = ev => {
      const t = at(ev.clientX);
      if (mode === 'cut') st.live = [t0, t];
      else {
        if (mode === 'a') st.a = Math.min(t, st.b - 0.2); else st.b = Math.max(t, st.a + 0.2);
        if (st.b < st.a) { const s = st.a; st.a = st.b; st.b = s; }
      }
      smInfo(key); smDraw(key);
    };
    const up = () => {
      cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
      if (mode === 'cut') {
        const [x, y] = st.live; st.live = null;
        if (Math.abs(y - x) > 0.05) addCut(st, x, y);
        else {
          const hit = st.cuts.findIndex(([p, q]) => t0 >= p && t0 <= q);
          if (hit >= 0) st.cuts.splice(hit, 1); else st.audio.currentTime = t0;   // клик по красному возвращает кусок
        }
      } else if (st.b - st.a < 0.3) { st.a = prev[0]; st.b = prev[1]; st.audio.currentTime = Math.min(st.b, Math.max(st.a, t0)); }
      else if (st.audio.currentTime < st.a || st.audio.currentTime > st.b) st.audio.currentTime = st.a;
      smInfo(key); smTick(key);
    };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }

  // ---------- волна готового варианта ----------

  function takeOf(id) { return TV.get(id); }
  function drawAll() {
    $$('.vl-take', root).forEach(el => {
      const t = S.takes.find(x => x.id === el.dataset.id), v = takeOf(el.dataset.id), cv = $('.vl-wave canvas', el);
      if (!t || !v || !cv) return;
      const dur = v.dur || v.audio.duration || 0;
      wave(cv, v.peaks, { dur: dur || 1, at: v.audio.currentTime });
      const d = el.querySelector('[data-dur]');
      if (d && isFinite(dur) && dur) d.textContent = fmt(dur);
    });
  }
  async function peaksOfTake(t) {
    let v = takeOf(t.id);
    if (v) return v;
    v = { audio: new Audio(t.url), peaks: [], raf: 0, dur: 0 };
    TV.set(t.id, v);
    try {
      const buf = await decode((await fetch(t.url)).arrayBuffer());
      v.peaks = peaksOf(buf); v.dur = buf.duration;
    } catch { v.peaks = []; }
    drawAll();
    return v;
  }
  function takeStop() {
    TV.forEach(v => { v.audio.pause(); cancelAnimationFrame(v.raf); });
    S.playId = '';
  }
  function takeTick(id) {
    const v = takeOf(id); if (!v) return;
    cancelAnimationFrame(v.raf);
    if (v.audio.paused) { S.playId = ''; paintTakesButtons(); return; }
    drawAll();
    v.raf = requestAnimationFrame(() => takeTick(id));
  }
  /* кнопки меняются без полной перерисовки: волна варианта не должна начинать рисоваться заново
     на каждом кадре проигрывания */
  function paintTakesButtons() {
    $$('.vl-take', root).forEach(el => {
      const b = $('[data-a="play"]', el); if (b) b.innerHTML = S.playId === el.dataset.id ? PAUSE_SVG : PLAY_SVG;
    });
  }
  async function takePlay(t) {
    const v = await peaksOfTake(t);
    if (S.playId === t.id) { v.audio.pause(); S.playId = ''; paintTakesButtons(); return; }
    takeStop();
    S.playId = t.id; paintTakesButtons();
    await v.audio.play().catch(() => { toast('Звук не игрится: файл варианта мог быть удалён'); });
    takeTick(t.id);
  }
  function stopAll() { takeStop(); SM.forEach(st => { st.audio.pause(); cancelAnimationFrame(st.raf); }); }

  // ---------- сборка запроса и озвучка ----------

  const val = (id, def) => { const el = $('#' + id, root); return el && el.value !== '' ? el.value : def; };
  const num = (id, def) => +val(id, def) || 0;
  const chk = id => { const el = $('#' + id, root); return !!el && el.checked; };
  const pickOf = key => {
    const box = $(`[data-pk="${key}"]`, root); if (!box) return { saved: '', file: null };
    const sel = $('[data-pks]', box).value, f = $('[data-pkf]', box).files[0], st = smOf(key);
    if (st && smEdited(st)) return { saved: '', file: new File([wavOf(st)], 'obrazets.wav', { type: 'audio/wav' }) };
    return { saved: sel, file: sel ? null : f };
  };
  function baseParams() {
    return { steps: num('vlSteps', 32), speed: num('vlSp', 1), guidance: num('vlGu', 2), t_shift: num('vlTs', 0.1), duration: num('vlDu', 0),
      position_temperature: num('vlPt', 5), class_temperature: num('vlCt', 0), layer_penalty_factor: num('vlLp', 5),
      denoise: chk('vlDen'), postprocess_output: chk('vlPost'), keep_model_loaded: chk('vlKeep'), preprocess_prompt: chk('vlPre'),
      device: val('vlDev', 'auto'), dtype: val('vlDt', 'auto'), attention: val('vlAtt', 'auto'), mp3: val('vlMp3', 'V0'),
      model: val('vlModel', ''), instruct: val('vlInstr', ''), words_per_chunk: num('vlWpc', 100) };
  }
  function collect(seedAdd) {
    const fd = new FormData(), p = baseParams();
    p.seed = (num('vlSeed', 0) || 0) + seedAdd;
    if (S.tab === 'vc') {
      const a = pickOf('src'), b = pickOf('ref');
      p.mode = 'vc'; p.src_saved = a.saved; p.ref_saved = b.saved;
      p.steps = num('vlCvSteps', 10); p.cfg = num('vlCvCfg', 1); p.passes = num('vlCvPass', 2);
      if (a.file) fd.append('src', a.file, a.file.name);
      if (b.file) fd.append('ref', b.file, b.file.name);
      fd.append('params', JSON.stringify(p));
      return fd;
    }
    p.mode = S.tab;
    p.text = ($('#vlText', root) ? $('#vlText', root).value : '').trim();
    if (S.tab === 'design') {
      p.gender = val('vlG', 'female'); p.age = val('vlA', ''); p.pitch = val('vlP', ''); p.accent = val('vlC', '');
      p.whisper = chk('vlW'); p.custom = val('vlCu', '');
    }
    if (S.tab === 'clone') {
      const a = pickOf('ref');
      p.ref_saved = a.saved; p.ref_text = val('vlRefText', ''); p.pause = num('vlPause', 0.3);
      if (a.file) fd.append('ref', a.file, a.file.name);
    }
    if (S.tab === 'dialog') {
      p.pause = num('vlPause', 0.3);
      p.speakers = [];
      $$('.vl-sp', root).forEach((el, i) => {
        const a = pickOf('sp' + (i + 1)), w = $(`[data-spw="${i + 1}"]`, root);
        p.speakers.push({ saved: a.saved, ref_text: w ? w.value.trim() : '' });
        if (a.file) fd.append('sp' + (i + 1), a.file, a.file.name);
      });
    }
    fd.append('params', JSON.stringify(p));
    return fd;
  }
  function say(text) { const el = $('#vlMsg', root); if (el) el.textContent = text; }

  /* Варианты идут по одному: сервер ждёт каждый до конца, поэтому окно само считает время и
     показывает полосу - иначе человек думает, что программа молчит. */
  async function run() {
    if (S.busy) return;
    const need = S.tab === 'vc' ? null : ($('#vlText', root) ? $('#vlText', root).value.trim() : '');
    if (S.tab !== 'vc' && !need) { say('Напишите, что должен сказать голос'); return; }
    if (S.tab === 'clone' && !pickOf('ref').saved && !$('[data-pk="ref"] input[type=file]', root).files.length) { say('Выберите образец голоса'); return; }
    if (S.tab === 'dialog') {
      const ready = $$('.vl-sp', root).filter(el => $('[data-pks]', el).value || $('[data-pkf]', el).files.length).length;
      if (ready < 2) { say('Для диалога нужно минимум два голоса'); return; }
    }
    saveForm();
    S.busy = true; S.stop = false;
    const btn = $('#vlGo', root), stop = $('#vlStop', root);
    if (btn) btn.hidden = true;
    if (stop) stop.hidden = false;
    S.pend = [];
    for (let i = 0; i < S.count; i++) {
      S.pend = [{ k: 'p' + Date.now() + i, name: `Вариант ${i + 1} из ${S.count}`, text: (need || '').slice(0, 160), t0: Date.now() }];
      paintTakes();
      const tick = setInterval(() => {
        const el = $('[data-eta]', root), bar = $('.vl-pb i', root);
        if (!el || !S.pend.length) return;
        const passed = (Date.now() - S.pend[0].t0) / 1000;
        if (bar) bar.style.width = Math.min(97, passed / 60 * 100).toFixed(0) + '%';
        el.textContent = passed < 3 ? 'Первая озвучка качает голосовой движок - это несколько минут.' : 'Ждём ComfyUI: ' + fmt(passed);
      }, 1000);
      let j = null, err = '';
      try { j = await sendForm('/api/voice/generate', collect(i)); }
      catch (e) { err = e.message; }
      clearInterval(tick);
      if (!j) {
        S.pend = []; paintTakes();
        say(err || 'Не удалось сделать голос');
        if (/Остановлено/.test(err)) break;
        await loadStatus();
        if (S.st && S.st.ready) paint();
        break;
      }
      S.takes.unshift(j);
      paintTakes();
    }
    S.pend = []; S.busy = false;
    if (btn) btn.hidden = false;
    if (stop) stop.hidden = true;
    paintTakes();
    const b2 = $('#vlGo', root); if (b2) b2.textContent = goLabel();
    if (!S.stop) say('Готово: варианты справа');
  }

  // ---------- сохранённые голоса и карточки ----------

  async function saveVoice(fd) {
    const j = await sendForm('/api/voice/saved', fd);
    await loadSaved();
    return j;
  }
  async function saveTake(t, name, note) {
    const fd = new FormData();
    fd.append('name', name || t.name); fd.append('note', note || ''); fd.append('out', t.id);
    return saveVoice(fd);
  }
  /* Голос отдаётся карточке: карточка хранит образец голоса, и режимы берут его оттуда.
     Описание и фото карточки остаются как были - мы приносим только звук. */
  const extOf = t => { const s = String(t.id || t.file || ''); const d = s.lastIndexOf('.'); return d > 0 ? s.slice(d) : '.mp3'; };
  async function giveToCard(t) {
    if (!AC.loaded) await acLoad();
    const list = AC.cards || [];
    let box = $('#vlCardModal', root);
    if (!box) {
      box = document.createElement('div'); box.className = 'modal'; box.id = 'vlCardModal'; box.hidden = true; root.append(box);
    }
    box.hidden = false;
    box.innerHTML = `<div class="box" style="padding:20px;max-width:520px">
      <div class="card-h"><h3>Кому отдать этот голос</h3><button class="btn mini" data-x type="button">Закрыть</button></div>
      <div class="hint" style="margin-bottom:10px">Карточка начнёт озвучиваться этим голосом. Её фото и описание останутся как были.</div>
      ${list.length ? `<div class="vl-f"><select id="vlCardPick">${list.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="vl-row" style="margin-top:12px"><button class="btn pri" id="vlCardOk" type="button">Отдать</button></div>`
        : '<div class="hint">Карточек пока нет: создайте их в разделе «Карточки».</div>'}</div>`;
    box.onclick = async e => {
      if (e.target === box || e.target.closest('[data-x]')) { box.hidden = true; return; }
      if (!e.target.closest('#vlCardOk')) return;
      const id = $('#vlCardPick', box).value, card = list.find(c => c.id === id);
      if (!card) return;
      try {
        const blob = await (await fetch(t.url)).blob();
        const fd = new FormData();
        fd.append('id', card.id); fd.append('name', card.name); fd.append('type', card.type || 'character');
        fd.append('text', card.text || '');
        fd.append('voice', new File([blob], (t.name || 'golosa') + extOf(t), { type: blob.type || 'audio/mpeg' }));
        await sendForm('/api/actors', fd);
        await acLoad();
        box.hidden = true;
        toast('Голос отдан карточке «' + card.name + '»');
      } catch (er) { toast(er.message); }
    };
  }
  // ---------- что делает окно живым ----------

  const enter = async () => {
    await Promise.all([loadStatus(), loadSaved(), loadTakes()]);
    const d = draftGet();
    if (d.tab) S.tab = d.tab;
    if (d.count) S.count = d.count;
    if (d.q) S.q = d.q;
    if (d.sp) S.sp = d.sp;
    paint();
  };
  onNav('voicelab', enter);
  /* Окно строим сразу при загрузке: в раздел входят и по кнопке на полосе режимов, а не
     только по пункту меню; на одну лишь подписку меню окно оставалось пустым. Окно не
     ждёт ответы о нодах: они дорисуются, когда придут. */
  try {
    paint();
  } catch { /* в проверочной среде без настоящего браузера окно может не построиться -
                пусть там тело лишь регистрирует обработчики; в браузере сборка проходит */ }
  enter();

  root.addEventListener('click', async e => {
    const tb = e.target.closest('#vlTabs [data-t]');
    if (tb) { saveForm(); S.tab = tb.dataset.t; draftSet({ tab: S.tab }); stopVcPoll(); paint(); return; }

    const inst = e.target.closest('#vlInstall,#vlInstallVc');
    if (inst) {
      const vc = inst.id === 'vlInstallVc';
      inst.disabled = true; inst.textContent = 'Ставлю модуль…';
      const note = $('#vlNote', root) || $('#vlVcNote', root);
      if (note) note.textContent = 'Скачиваю модуль и его пакеты - несколько минут, окно можно не закрывать.';
      try {
        const j = await postJSON('/api/voice/install', vc ? { pack: 'vc' } : {});
        if (note) note.textContent = j.pip === false ? 'Модуль лег, но его Python-пакеты доучить не удалось: скажите, что покажет ComfyUI при первой озвучке.'
          : 'Модуль установлен. Перезапустите ComfyUI - он читает ноды только на старте.';
        if (j.restart && S.st) S.st.restart = true;
        const r = $('#vlRestart', root); if (r) r.hidden = false;
      } catch (er) { toast(er.message); if (note) note.textContent = er.message; }
      inst.disabled = false; inst.textContent = vc ? 'Установить модуль преобразования' : 'Установить модуль голоса';
      return;
    }
    if (e.target.closest('#vlDirSet')) {
      const raw = ($('#vlDir', root) || {}).value || '';
      try { await postJSON('/api/voice/install', { dir: raw.trim() }); await loadStatus(); paint(); }
      catch (er) { toast(er.message); }
      return;
    }
    if (e.target.closest('#vlRestart')) {
      try { await postJSON('/api/voice/restart', {}); toast('Перезапускаем ComfyUI - вернитесь в раздел через минуту'); }
      catch (er) { toast(er.message); }
      return;
    }
    if (e.target.closest('#vlRecheck')) { await loadStatus(); paint(); return; }

    const q = e.target.closest('[data-q]');
    if (q) {
      S.q = q.dataset.q;
      $$('#vlQ .chip', root).forEach(x => x.classList.toggle('on', x === q));
      const s = $('#vlSteps', root); if (s) s.value = q.dataset.n;
      return;
    }
    const n = e.target.closest('#vlN [data-n]');
    if (n) { S.count = +n.dataset.n; $$('#vlN .chip', root).forEach(x => x.classList.toggle('on', x === n)); const b = $('#vlGo', root); if (b) b.textContent = goLabel(); return; }

    const tg = e.target.closest('[data-tag]');
    if (tg) {
      const ta = $('#vlText', root); if (!ta) return;
      const i = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
      ta.value = ta.value.slice(0, i) + tg.dataset.tag + ta.value.slice(i);
      ta.focus(); ta.setSelectionRange(i + tg.dataset.tag.length, i + tg.dataset.tag.length);
      return;
    }
    if (e.target.closest('#vlSpPlus') || e.target.closest('#vlSpMinus')) {
      const plus = !!e.target.closest('#vlSpPlus');
      const next = S.sp + (plus ? 1 : -1);
      if (next < 2 || next > 4) { toast('В диалоге от двух до четырёх голосов'); return; }
      saveForm(); S.sp = next; paint(); return;
    }
    if (e.target.closest('#vlWipe')) {
      confirmBox('Начать заново', 'Текст, настройки и выбранные образцы вернутся к начальным. Сделанные варианты останутся.', 'Начать заново', async () => {
        try { localStorage.removeItem(DKEY); } catch { /* ок */ }
        SM.forEach(st => st.audio.pause()); SM.clear();
        S.q = 'normal'; S.count = 3; S.sp = 2;
        await loadStatus(); paint();
      });
      return;
    }
    if (e.target.closest('#vlReset')) {
      try { localStorage.removeItem(DKEY); } catch { /* ок */ }
      await loadStatus(); paint(); toast('Настройки вернулись к начальным'); return;
    }
    if (e.target.closest('#vlGo')) { run(); return; }
    if (e.target.closest('#vlStop')) {
      S.stop = true;
      try { await postJSON('/api/voice/cancel', {}); } catch { /* сервер и так останавливается */ }
      return;
    }
    if (e.target.closest('#vlFilter')) { S.onlyStar = !S.onlyStar; paintTakes(); return; }
    if (e.target.closest('#vlClear')) {
      confirmBox('Убрать неотмеченные', 'Помеченные варианты останутся.', 'Убрать', async () => {
        await postJSON('/api/voice/takes/clear', {}); await loadTakes(); paintTakes();
      });
      return;
    }

    // выбор микрофона: запись становится образцом так же, как загруженный файл
    const rec = e.target.closest('[data-rec]');
    if (rec) { recordSample(rec); return; }
    const sb = e.target.closest('[data-s]');
    if (sb) { sampleAction(sb); return; }
    const mb = e.target.closest('[data-m]');
    if (mb) {
      const box = mb.closest('[data-pk]'), st = box && smOf(box.dataset.pk);
      if (st) { st.mode = mb.dataset.m; smInfo(box.dataset.pk); }
      return;
    }

    const act = e.target.closest('[data-a]');
    if (!act) return;
    const card = act.closest('.vl-take'), sv = act.closest('.vl-sv');
    if (sv) {
      const v = S.saved.find(x => x.id === sv.dataset.id); if (!v) return;
      if (act.dataset.a === 'del') {
        confirmBox('Удалить голос', '«' + v.name + '» и его образец будут удалены с этого компьютера.', 'Удалить', async () => {
          await fetch('/api/voice/saved/' + v.id, { method: 'DELETE' }); await loadSaved(); paint();
        });
      }
      if (act.dataset.a === 'use') { S.tab = 'clone'; paint(); const sel = $('[data-pks]', root); if (sel) { sel.value = v.id; sel.dispatchEvent(new Event('change', { bubbles: true })); } }
      if (act.dataset.a === 'card') await giveToCard({ url: v.url, name: v.name, file: v.file });
      return;
    }
    if (!card) return;
    const t = S.takes.find(x => x.id === card.dataset.id); if (!t) return;
    const a = act.dataset.a;
    if (a === 'play' || a === 'seek') {
      if (a === 'seek') {                                  // клик по волне: переставить позицию
        const v = await peaksOfTake(t), r = card.querySelector('.vl-wave').getBoundingClientRect();
        v.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (t.dur || v.audio.duration || 0);
        if (S.playId !== t.id) { S.playId = t.id; paintTakesButtons(); await v.audio.play().catch(() => {}); takeTick(t.id); }
        return;
      }
      await takePlay(t); return;
    }
    if (a === 'star') { const j = await postJSON('/api/voice/takes/' + t.id + '/star', {}); t.star = j.star; paintTakes(); return; }
    if (a === 'ren') {
      const name = window.prompt('Как назвать этот вариант', t.name);
      if (name && name.trim()) { const j = await postJSON('/api/voice/takes/' + t.id + '/rename', { name: name.trim() }); t.name = j.name; paintTakes(); }
      return;
    }
    if (a === 'del') {
      confirmBox('Удалить вариант', 'Файл варианта будет удалён с этого компьютера.', 'Удалить', async () => {
        const v = takeOf(t.id); if (v) { v.audio.pause(); TV.delete(t.id); }
        await fetch('/api/voice/takes/' + t.id, { method: 'DELETE' }); await loadTakes(); paintTakes();
      });
      return;
    }
    if (a === 'save') {
      const name = window.prompt('Название голоса', t.name);
      if (!name) return;
      try { await saveTake(t, name.trim(), (t.text || '').slice(0, 300)); await loadSaved(); toast('Голос сохранён во вкладку «Мои голоса»'); paint(); }
      catch (er) { toast(er.message); }
      return;
    }
    if (a === 'card') { await giveToCard(t); return; }
    if (a === 'clone') { S.tab = 'clone'; paint(); const sel = $('[data-pks]', root); if (sel) { sel.value = 'take:' + t.id; sel.dispatchEvent(new Event('change', { bubbles: true })); } return; }
    if (a === 'reuse') {
      const p = t.params || {};
      S.tab = t.mode || 'design'; paint();
      const put = (id, v) => { const el = $('#' + id, root); if (el && v != null) el.value = v; };
      put('vlSeed', p.seed); put('vlSp', p.speed); put('vlGu', p.guidance); put('vlTs', p.t_shift); put('vlDu', p.duration);
      put('vlPt', p.position_temperature); put('vlCt', p.class_temperature); put('vlLp', p.layer_penalty_factor); put('vlWpc', p.words_per_chunk);
      put('vlPause', p.pause); put('vlInstr', p.instruct); put('vlModel', p.model); put('vlDev', p.device); put('vlDt', p.dtype); put('vlAtt', p.attention);
      put('vlMp3', p.mp3); put('vlSteps', p.steps);
      const setChk = (id, v) => { const el = $('#' + id, root); if (el && v != null) el.checked = !!v; };
      setChk('vlDen', p.denoise); setChk('vlPost', p.postprocess_output); setChk('vlKeep', p.keep_model_loaded); setChk('vlPre', p.preprocess_prompt);
      const ta = $('#vlText', root); if (ta && t.text) ta.value = t.text;
      bindForm();
      toast('Настройки варианта поставлены в форму');
      return;
    }
  });

  /* Запись с микрофона: нажали - говорим, нажали ещё раз - запись лёглась в окно образца. */
  let live = null;
  async function recordSample(btn) {
    if (live && live.btn === btn) { live.mr.stop(); return; }
    if (live) { toast('Сначала остановите идущую запись'); return; }
    const box = btn.closest('[data-pk]');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast('Нет доступа к микрофону: разрешите его в окне Windows или подключите микрофон'); return; }
    const mr = new MediaRecorder(stream), chunks = [], t0 = Date.now(), label = btn.textContent;
    live = { mr, btn }; btn.classList.add('pri');
    const tick = setInterval(() => { btn.textContent = 'Остановить запись (' + Math.round((Date.now() - t0) / 1000) + ' с)'; }, 500);
    tick();
    mr.ondataavailable = ev => chunks.push(ev.data);
    mr.onstop = async () => {
      clearInterval(tick); stream.getTracks().forEach(tr => tr.stop()); live = null;
      btn.textContent = label; btn.classList.remove('pri');
      try {
        const buf = await decode(new Blob(chunks).arrayBuffer());
        if (buf.duration < 0.4) throw new Error('Запись слишком короткая');
        const f = new File([wavSlice(buf, 0, buf.duration)], 'zapis.wav', { type: 'audio/wav' }), dt = new DataTransfer();
        dt.items.add(f);
        $('[data-pks]', box).value = '';
        const inp = $('[data-pkf]', box); inp.files = dt.files;
        await smLoad(box.dataset.pk);
      } catch (er) { toast(er.message || 'Не удалось записать'); }
    };
    mr.start();
  }

  function sampleAction(sb) {
    const box = sb.closest('[data-pk]'), key = box && box.dataset.pk, st = key && smOf(key);
    if (!st) return;
    const act = sb.dataset.s;
    if (act === 'play') {
      if (st.audio.paused) {
        if (st.audio.currentTime < st.a || st.audio.currentTime >= st.b - 0.05) st.audio.currentTime = st.a;
        st.audio.play().catch(() => {}); smBtn(key, 'play', 'Пауза'); smTick(key);
      } else { st.audio.pause(); smBtn(key, 'play', 'Слушать'); smTick(key); }
      return;
    }
    if (act === 'stop') { st.audio.pause(); st.audio.currentTime = st.a; smBtn(key, 'play', 'Слушать'); smDraw(key); return; }
    if (act === 'reset') { st.a = 0; st.b = st.buf.duration; st.cuts = []; st.audio.currentTime = 0; smInfo(key); smDraw(key); return; }
    if (act === 'undo') { st.cuts = []; smInfo(key); smDraw(key); return; }
    if (act === 'pauses') {
      const found = findPauses(st.buf, 0.4, 0.24).filter(([x, y]) => y - x > 0.05 && y > st.a && x < st.b);
      if (!found.length) { toast('Длинных пауз не нашла: образец и так плотный'); return; }
      found.forEach(([x, y]) => addCut(st, x, y));
      smInfo(key); smDraw(key);
      toast('Вырезано пауз: ' + found.length + '. Послушайте результат кнопкой «Слушать»');
      return;
    }
    if (act === 'apply') {
      (async () => {
        try {
          st.audio.pause();
          const blob = wavOf(st), buf = await decode(blob.arrayBuffer());
          st.audio = new Audio(URL.createObjectURL(blob));
          st.audio.addEventListener('ended', () => { st.audio.currentTime = st.a; smBtn(key, 'play', 'Слушать'); smDraw(key); });
          st.buf = buf; st.dur0 = buf.duration; st.peaks = peaksOf(buf); st.a = 0; st.b = buf.duration; st.cuts = []; st.mode = 'keep';
          smInfo(key); smDraw(key); toast('Готово: вырезанное убрано из образца');
        } catch { toast('Не получилось применить. Попробуйте ещё раз.'); }
      })();
    }
  }

  root.addEventListener('change', async e => {
    const box = e.target.closest('[data-pk]');
    if (box && (e.target.matches('[data-pks]') || e.target.matches('[data-pkf]'))) { await smLoad(box.dataset.pk); return; }
    const f = e.target.closest('#vlNewFile');
    if (f && f.files[0]) {
      const name = ($('#vlNewName', root) || {}).value.trim() || f.files[0].name.replace(/\.[^.]+$/, '');
      const fd = new FormData();
      fd.append('name', name); fd.append('file', f.files[0], f.files[0].name);
      try { await saveVoice(fd); paint(); toast('Образец добавлен'); } catch (er) { toast(er.message); }
    }
  });
  root.addEventListener('input', saveSoon);
  let timer = 0;
  function saveSoon() { clearTimeout(timer); timer = setTimeout(saveForm, 700); }
})();
