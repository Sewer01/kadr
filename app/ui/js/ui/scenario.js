import { $, $$, toast } from '../core/util.js';
import { goTo } from '../core/tabs.js';
import { earlyEvents } from '../core/state.js';
import { setDropFile } from './slots.js';
import { AG } from '../views/agent.js';
import { IMG } from '../views/images.js';
import { RM } from '../views/modes.js';

export const promptHandlers = new Map();
export const previewHandlers = new Map();
export function onPrompt(id, fn) {
  promptHandlers.set(id, fn);
  (earlyEvents.get(id) || []).forEach(fn); earlyEvents.delete(id);
}
export function offPrompt(id) { promptHandlers.delete(id); }
export function audioTokens(c, bs, film) {
  const ta = c.querySelector('textarea'), text = ta ? ta.value : '';
  const used = new Set((text.match(/<Audio\s*\d+>/g) || []).map(s => +s.replace(/\D+/g, '')));
  const list = [];
  (film || []).forEach((f, j) => { if (f && j > 0) list.push({ tag: 1 + j, name: f.name, own: false }); });   // №1 is the film's own sound, not a sample
  (c._auds || []).forEach((f, j) => { if (f) list.push({ tag: bs + j, name: f.name, own: true }); });
  const full = used.size >= 3;
  return list.map(x => {
    const here = used.has(x.tag), off = !here && full;
    return '<button class="token" type="button" data-ins="&lt;Audio ' + x.tag + '&gt;" data-audio="1"' + (off ? ' disabled' : '') +
      ' title="' + (here ? 'Этот тег уже в тексте сцены' : off ? 'В сцене уже три аудио - модель слушает не больше трёх'
        : 'Вставить в текст тег <Audio ' + x.tag + '> - ' + (x.own ? 'аудио этой сцены' : 'общее аудио ролика') + ': ' + x.name) + '">&lt;Audio ' +
      x.tag + (here ? ' ✓' : '') + '</button>';
  });
}

/* What a scene really sends: the files whose tags stand in its text, in the order of those tags, never
   more than the three places the model has. A text that names no audio sends the scene's own files, as
   always. The copy handed to the model gets the tags renumbered to the places the files took - the
   numbers on the screen stay the ones the person wrote. */
export function sceneAudioPlan(c, film, bs) {
  /* Numbers written on the cards belong to the SCENE, not to the place it happens to stand in:
     the person moved a scene and its text kept <Picture 30>, while the server waits for the decade
     of the new place and leaves a foreign number exactly as written - the model then invents what
     the missing picture should show, and a fox becomes a sack. Here every number of this scene's
     own decade is moved onto the place the file really takes; a number with no file behind it in
     THIS scene is taken out of the text and named in the report, because a tag with nothing behind
     it is a lie to the model. */
  const ta = c.querySelector('textarea'), raw = ta ? ta.value : '';
  const own = (c && c._baseFixed) || bs;      // the decade written on the cards of this scene
  const byTag = new Map();
  (film || []).forEach((f, j) => { if (f && j > 0) byTag.set(1 + j, f); });   // the background has its own road to the model
  (c._auds || []).forEach((f, j) => { if (f) byTag.set(own + j, f); });
  const seen = (raw.match(/<Audio\s*\d+/g) || []).map(s => +s.replace(/\D+/g, ''));
  const picked = [];
  seen.forEach(t => { if (byTag.has(t) && picked.indexOf(t) < 0 && picked.length < 3) picked.push(t); });
  const left = [];
  let text = raw.replace(/<Audio\s*(\d+)>/g, (whole, t) => {
    const k = picked.indexOf(+t);
    if (k >= 0) return '<Audio ' + (bs + k) + '>';
    if (byTag.has(+t)) { left.push(+t); return ''; }   // the fourth and further: the quota is three, the tag goes
    return whole;                              // a number of another scene or one typed by hand stays
  });
  const slots = (c && c._files) || [];
  const lostP = [];
  text = text.replace(/<Picture\s*(\d+)>/g, (whole, t) => {
    t = +t;
    if (t < 10) return whole;                  // the common references count by their own places
    const j = t - own;
    if (j >= 0 && j < 9 && slots[j]) return '<Picture ' + (bs + j) + '>';
    lostP.push(t); return '';                  // no such photo in this scene: the model must not guess one
  });
  const dropped = left.filter((v, i) => left.indexOf(v) === i);
  const lostPics = lostP.filter((v, i) => lostP.indexOf(v) === i);
  const tidy = s => s.replace(/ {2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();
  const out = tidy(text);
  if (!picked.length) return { files: (c._auds || []).slice(0, 3), text: out, rewritten: out !== raw.trim(), dropped: [], lostPics: lostPics };
  return { files: picked.map(t => byTag.get(t)), text: out, rewritten: out !== raw.trim(), dropped: dropped, lostPics: lostPics };
}

export async function sendPrompt(blk, to) {
  let prompt = $('pre', blk).textContent;
  // pictures of a reopened chat exist only as data URLs; turn them back into files
  const toFile = (u, i) => { const [h, b] = u.split(','); const bin = atob(b); const a = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k); return new File([a], `picture${i + 1}.jpg`, { type: h.slice(5, h.indexOf(';')) }); };
  const own = m => (m.files && m.files.length ? m.files
    : (m.images || []).slice(0, (m.images || []).length - (m.nframes || 0)).map(toFile));
  const msgIdx = +(blk.closest('.msg')?.dataset.i ?? -1);
  const answer = msgIdx >= 0 ? AG.msgs[msgIdx] : null;
  const fix = answer ? answer.edit !== false : true;   // этот ответ — правка или продолжение сюжета
  // a draft that left a mode is expected back in the very same field: the files of the mode stay
  // where the person put them, and the tags in the text point at THOSE files, not at the chat's
  const back = !!(AG.draft && AG.draft.to && (answer && answer.to ? answer.to === AG.draft.to : to === AG.draft.to));
  if (back) AG.draft = null;
  // only the pictures the prompt actually names go along, in the order they are named, and the
  // numbers in the text are rewritten to the slots they will take: otherwise "Picture 3" lands
  // on the first free cell and the prompt describes somebody else's face
  const allFiles = AG.msgs.filter(m => m.role === 'user').flatMap(own);   // Picture N counts exactly these (frames excluded)
  const order = [];
  if (!back) prompt = prompt.replace(/<image(\d+)>|Picture\s+(\d+)|image\s+(\d+)/gi, (m, t1, p, f) => {
    const n = +(t1 || p || f);
    if (n < 1 || n > allFiles.length) return m;
    if (!order.includes(n)) order.push(n);
    return m.replace(/\d+/, String(order.indexOf(n) + 1));
  });
  let files = [];
  if (order.length) files = order.map(n => allFiles[n - 1]);
  else if (fix) {   // no numbers in the text: the pictures that were discussed in that message
    for (let k = msgIdx - 1; k >= 0; k--) {
      const m = AG.msgs[k];
      if (m.role !== 'user') continue;
      files = own(m);
      if (files.length) break;
    }
  }
  if (!files.length) files = AG.msgs.flatMap(own);
  if (back) files = [];   // the mode keeps its own pictures: replacing them would move the tags
  // the videos the agent watched travel as real files: a section takes as many as it has places for,
  // beginning with the first one - the rest are named in the word about the transfer
  const vidFiles = [];
  for (const m of AG.msgs) (m.videos || [m.videoFile].filter(Boolean)).forEach(v => { if (v && !vidFiles.some(x => x.name === v.name && x.size === v.size)) vidFiles.push(v); });
  if (back) vidFiles.length = 0;   // the video the person put in the mode stays there
  let vUsed = 0, vAll = 0;
  const handVids = async box => {
    const slots = $$('.rm-vids input', box);
    let used = 0;
    for (const v of vidFiles.slice(0, slots.length)) { await setDropFile(slots[used], v); used++; }
    return { used, all: slots.length };
  };
  if (to === 'story' && (AG.storyFrames || (files.length && AG.storyModel !== 'krea'))) {
    IMG.qwen.fill({ prompt, kind: 'story', engine: AG.storyFrames && AG.storyModel === 'krea' ? 'flux' : AG.storyModel, frames: AG.storyFrames });
    // a draft coming home belongs to the pictures that are already here: clearing them threw the
    // person's own photos away, because the round trip deliberately carries no files
    if (!back) for (const [i, sel] of ['#qwDrop', '#qwDrop2', '#qwDrop3', '#qwDrop4', '#qwDrop5'].entries()) {
      $(sel + ' .x')?.click();
      if (files[i]) await setDropFile($(sel + ' input'), files[i]);
    }
    to = 'qwen';
  } else if (to === 'plist') {
    IMG.krea.fillList(prompt); to = 'krea';
  } else if (to === 'krea' || to === 'story' || to === 'sheet' || to === 'sheet6' || to === 'fluxt' || to === 'qwent' || to === 'h3t') {
    const six = AG.target === 'sheet6' || to === 'sheet6';
    const engine = to === 'h3t' || AG.target === 'h3t' ? 'h3img' : to === 'fluxt' ? 'flux' : to === 'qwent' ? 'qwen' : (AG.target === 'fluxt' ? 'flux' : AG.target === 'qwent' ? 'qwen' : AG.target === 'story' ? AG.storyModel : 'krea');
    IMG.krea.fill({ prompt, engine, aspect: six ? '21:9' : AG.target === 'sheet' || to === 'sheet' || AG.target === 'story' ? '16:9' : undefined }); to = 'krea';
  } else if (to === 'qwen' || to === 'h3e') {
    IMG.qwen.fill(to === 'h3e' || AG.target === 'h3e' ? { prompt, engine: 'h3img' } : { prompt });
    // a draft coming home belongs to the pictures that are already here: clearing them threw the
    // person's own photos away, because the round trip deliberately carries no files
    if (!back) for (const [i, sel] of ['#qwDrop', '#qwDrop2', '#qwDrop3', '#qwDrop4', '#qwDrop5'].entries()) {
      $(sel + ' .x')?.click();
      if (files[i]) await setDropFile($(sel + ' input'), files[i]);
    }
  } else if (to === 'video') {
    $('#vPrompt').value = prompt; $('#vPrompt').oninput({ target: $('#vPrompt') });
    if (files.length) { $('#dFirst .x')?.click(); if (fix) $('#dLast .x')?.click(); }   // a fix replaces both frames
    if (files[0]) await setDropFile($('#dFirst input'), files[0]);
    if (files[1]) await setDropFile($('#dLast input'), files[1]);
  } else if (to === 'long' || to === 'actionsc') {
    const L2 = RM[to] || RM.long, list = []; let cur = null;   // the same sheet of scenes fits both studios
    const hasHead = /^\s*SCENE\s*\d+\s*\|/im.test(prompt);   // text before "SCENE 1" (a stray roles line) is not a scene
    for (const line of prompt.split('\n')) {
      if (hasHead && !cur && !/^\s*SCENE\s*\d+\s*\|/i.test(line)) continue;
      const mm = line.match(/^\s*SCENE\s*(\d+)\s*\|\s*(\d+(?:\.\d+)?)\s*(\|\s*new)?\s*$/i);
      if (mm) { cur = { sec: +mm[2], fresh: !!mm[3], text: [] }; list.push(cur); } else if (cur) cur.text.push(line); else if (line.trim()) { cur = { sec: 10, text: [line] }; list.push(cur); }
    }
    // строки про звук принадлежат сцене: раньше такая строка вырезалась вместе со всем текстом,
    // написанным на ней; снимаем только префикс поля описания, чтобы программа поставила выравнивание сама
    const clean = t => t.split('\n').map(l => l.replace(/^\s*integrated_multimodal_description\s*:\s*(\[Shot \d+\]\s*)?/i, '')).join('\n').trim();
    const scenesMade = list.map(x => ({ prompt: clean(x.text.join('\n')), sec: x.sec, fresh: x.fresh })).filter(x => x.prompt);
    {   // the model sometimes copies a scene instead of moving the story on: say it out loud, do not generate the same clip four times
      const key = s => s.prompt.toLowerCase().replace(/<[^>]+>/g, '').replace(/\W+/g, ' ').trim();
      const by = {};
      scenesMade.forEach((s, i) => { (by[key(s)] = by[key(s)] || []).push(i + 1); });
      const twins = Object.keys(by).filter(k => by[k].length > 1 && k.length > 40).map(k => by[k].join(', '));
      if (twins.length) toast('Агент повторил сцены ' + twins.join(' · ') + ' одинаковым текстом: поправьте текст или попросите его продолжить дальше');
    }
    L2.root._setScenes(scenesMade);
    /* Своё фото и своя песня сцены живут под её номером места: у второй сцены это 20.
       В чате эти номера сохраняются в подписях вложений, поэтому на обратном пути
       картинка и песня кладутся ровно в ту сцену, которая их назвала. Без этого в
       раздел возвращались только тексты и общие фото, а теги вида <Picture 20>
       оставались без файлов - и модель рисовала их по своему вкусу. */
    const tagNum = (txt, kind) => {
      const m = new RegExp('<\\s*' + kind + '\\s*(\\d+)\\s*>', 'i').exec(txt || '');
      return m ? +m[1] : 0;
    };
    const home = { pics: 0, auds: 0, gone: [], where: [], said: -1 };
    const sameFile = (a, b) => !!a && !!b && a.name === b.name && a.size === b.size;
    const deliver = () => {
      const cards = $$('.sc', L2.root);
      if (!cards.length) return;
      const nums = (typeof window.agAttTags === 'function' ? window.agAttTags() : []) || [];
      for (let ai = 0; ai < (AG.att || []).length; ai++) {
        const a = AG.att[ai];
        if (!a || a.frame || !a.file) continue;
        const n = tagNum(a.note, 'Picture') || nums[ai] || 0;   // подпись вложения, а если её нет - число на плитке
        if (n < 10) continue;                                   // общие места переносит обычный перенос
        const dec = Math.floor(n / 10) * 10;                    // последняя цифра - место, остальное - сцена
        const c = cards.filter(x => (x._baseFixed || x._base) === dec)[0] || cards[Math.floor(n / 10) - 1];
        if (!c) { if (!home.gone.some(s => s === '<Picture ' + n + '>')) home.gone.push('<Picture ' + n + '>'); continue; }
        c._files = c._files || new Array(9).fill(null);
        if (c._files.some(f => sameFile(f, a.file))) continue;  // файл уже лежит в этой сцене - не дублируем
        let j = (n % 10 <= 8 && !c._files[n % 10]) ? n % 10 : c._files.findIndex(f => !f);
        if (j < 0) { home.gone.push('<Picture ' + n + '> - в сцене нет свободного места'); continue; }
        if (c._setOwn) c._setOwn(j, a.file); else { c._files[j] = a.file; c._paint?.(); }
        home.pics++;
        home.where.push('<Picture ' + n + '> → сцена ' + Math.floor(n / 10) + ', место ' + (dec + j) + ' · ' + a.file.name);
        files = files.filter(f => !sameFile(f, a.file));        // тот же файл не встанет ещё и на общую полку
      }
      for (const a of (AG.audios || [])) {
        if (!a || !a.file) continue;
        const n = tagNum(a.where, 'Audio');
        if (n < 10) continue;
        const dec = Math.floor(n / 10) * 10;
        const c = cards.filter(x => (x._baseFixed || x._base) === dec)[0] || cards[Math.floor(n / 10) - 1];
        if (!c) { if (!home.gone.some(s => s === '<Audio ' + n + '>')) home.gone.push('<Audio ' + n + '>'); continue; }
        c._auds = c._auds || []; c._audSrc = c._audSrc || []; c._audSel = c._audSel || [];
        if ((c._auds || []).some(f => sameFile(f, a.file))) continue;
        let j = (n % 10 <= 2 && !c._auds[n % 10]) ? n % 10 : [0, 1, 2].findIndex(k => !c._auds[k]);
        if (j < 0) { home.gone.push('<Audio ' + n + '> - в сцене нет свободного места для песни'); continue; }
        c._auds[j] = a.file; c._audSrc[j] = a.file; c._audSel[j] = null; if (!a.file.__key) window.audioKey(a.file);
        c._audWords = c._audWords || [];
        // слова уже услышаны в агенте: переносим их в карточку сцены, а не слушаем заново
        if ((a.text || '').trim() && !(c._audWords[j] || '').trim()) c._audWords[j] = String(a.text).trim();
        c._paintAuds?.(); c._paintWords?.(); c._paint?.(); home.auds++;
        home.where.push('<Audio ' + n + '> → сцена ' + Math.floor(n / 10) + ' · ' + a.file.name);
      }
      const now = home.pics + home.auds;
      if (now > home.said) {
        home.said = now;
        if (now) {
          L2.root._save?.();
          toast('В сцены вернулось из чата: ' + [home.pics ? 'фото ' + home.pics : '', home.auds ? 'песен ' + home.auds : ''].filter(Boolean).join(' · ')
            + (home.where.length ? ' (' + home.where.join('; ') + ')' : '')
            + (home.gone.length ? ' · а ' + home.gone.join(', ') + ' некуда положить' : ''));
        } else if (home.gone.length) {
          toast('В чате есть ' + home.gone.join(', ') + ', но такой сцены в ответе нет - файл некуда положить');
        }
      }
    };
    deliver();
    /* Карточки раздела перестраиваются не в тот же миг: доставка, сделанная один раз,
       попадала в карточки, которые потом заменялись новыми, и фото сцены исчезало.
       Поэтому она повторяется, когда Киностудия уже на экране. Повтор ничего не
       дублирует: лежащий в сцене файл узнаётся по имени и размеру. */
    setTimeout(deliver, 400);
    setTimeout(deliver, 1400);
    // the studio never receives the frames from the chat: a <Video N> in the text would point at nothing,
    // and the numbers would land on the person's photos. What the studio really has is the base frame.
    prompt = prompt.replace(/<\s*Video\s*\d+\s*>/g, '<Frame>');
    if (to === 'long' && vidFiles.length) {   // only the video studio continues a finished video; the action one has no base yet
      const got = await L2.root._takeVideo(vidFiles[0]);
      vUsed = 1; vAll = 1;
      toast(got.frame
        ? `Киностудия продолжит «${vidFiles[0].name}»: режим «продолжить своё видео» включён, его последний кадр встал перед вашими фото`
        : `Киностудия продолжит «${vidFiles[0].name}», но последний кадр взять не удалось (${got.why || 'не читается'}): ваших мест тогда 9`);
    }
    if (fix && files.length) $$('label.ref.filled .x', L2.root).forEach(x => x.click());   // a fix replaces the pictures; a continuation keeps the old ones
    for (const f of files) {   // existing references (e.g. the last frame of the video being continued) stay; new pictures take the free slots
      /* Плитки собственных фото сцен носят тот же класс ref: без оговорки ниже лишние
         картинки из чата заполняли места сцен и затирали то, что легло туда по номеру
         тега - возвращённое из чата фото сцены пропадало под чужим файлом. */
      const have = $$('label.ref:not(.own).filled', L2.root).some(r => r._file && r._file.name === f.name && r._file.size === f.size);
      const free = $$('label.ref:not(.own):not(.filled) input', L2.root)[0];
      if (have || !free) continue;
      await setDropFile(free, f);
    }
  } else {
    const box = to === 'lipsync' ? refsEl : RM[to].root;
    (to === 'lipsync' ? $('#lPrompt') : RM[to].prompt()).value = prompt;
    if (files.length) {
      // картинки из чата - это референсы: свои кадры начала и конца человек выбрал сам, их не трогаем
      $$('.ref:not(.frame).filled .x', box).forEach(x => x.click());
      const slots = $$('.ref:not(.frame) input', box);
      for (let i = 0; i < Math.min(files.length, slots.length); i++) await setDropFile(slots[i], files[i]);
    }
  }
  // the song itself goes to Lipsync together with the prompt (the whole clip; trim it there if needed)
  const au = [...AG.msgs].reverse().find(m => m.audioFile)?.audioFile;
  if (to === 'lipsync' && au && !back) await setDropFile($('#aFile'), au);   // a returned draft keeps its own song
  if (to === 'swap' || to === 'refs') { const r = await handVids(RM[to].root); vUsed = r.used; vAll = r.all; }
  goTo(to);
  const name = { video: '«Видео»', lipsync: '«Клип»', refs: '«Видеостудия»', actor: '«Актёр»', swap: '«Замена»', action: '«Экшн-видео»', actionsc: '«Экшн-студия»', long: '«Киностудия»', krea: '«Изображение по тексту»', qwen: '«Изменение изображения»' }[to];
  toast(`${back ? 'Черновик вернулся в' : 'Промпт перенесён в режим'} ${name}` + (back ? ', ваши файлы остались на местах' : '') + (files.length && to !== 'video' && to !== 'krea' ? ' вместе с изображениями' : '')
    + (vUsed ? ` и видео: ${vUsed}` : '') + (vidFiles.length > vUsed ? ` (видео в чате ${vidFiles.length}, раздел принимает ${vAll || 1}: лишние не перенесены)` : '') + (to === 'lipsync' && !back ? (au ? ' и аудио — выделите нужный фрагмент' : ' — добавьте аудио') : ''));
}
/* Right mouse button over a field where a person writes: the browser's own menu does not offer
   spelling fixes here, so the local model is asked. It gives up to three ways to write the word, and
   the chosen one replaces exactly that word - the caret and the undo history stay in the field. */
