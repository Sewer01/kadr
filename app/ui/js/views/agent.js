import { API, postJSON } from '../core/net.js';
import { $, $$, GB, UI_Z, confirmBox, copyText, esc, fileKind, fileToDataURL, fmtShort, isImage, sharedAudioCtx, toast } from '../core/util.js';
import { LIB, abuf, audioName, byId, openId, openItem, registerViews, setupModes, setupProfile } from '../core/state.js';
import { goTo, onNav } from '../core/tabs.js';
import { wavSlice } from '../ui/audio.js';
import { putScenario, scenarioWindowOf, sendPrompt } from '../ui/scenario.js';
import { micToggle, transcribeWav } from '../ui/mic.js';
import { dropBox } from '../ui/slots.js';
import { openUpscale } from './library.js';
import { MD_ENGINE, mdStart } from './models.js';
import { L, RM, V } from './modes.js';
import { afterSetup, extK, resetProgress, setStep, showSetupPane } from './setup.js';
import { loadStatus } from './system.js';
import { libToFile } from './workflows.js';

export async function agSettle(max) {
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 700));
  while (Date.now() - t0 < (max || 30000)) {
    const busy = (AG.audios || []).some(a => a && a.busy) || !!(AG.audio && AG.audio.busy);
    if (!busy) break;
    await new Promise(r => setTimeout(r, 500));
  }
}
export const agViewOf = m => (/^(krea|kreareal|fluxt|h3t|qwent)$/.test(m) ? '#view-krea'
  : (/^(qwen|h3e|sheet|sheet6|story)$/.test(m) ? '#view-qwen' : '#view-' + m));
/* Before the Agent rewrites a text the section says what it really holds: every file must be named
   by a number in the text, and no number in the text may stand without a file. Left unchecked, the
   Agent renumbers <Picture 2> to the location, the woman from the third photo is never named, and
   the person gets a stranger on the screen instead of his reference. */
export function agRefCheck(mode) {
  const root = (typeof RM !== 'undefined' && RM[mode] && RM[mode].root) || document.querySelector(agViewOf(mode));
  if (!root) return [];
  const fill = new Map();
  // кадры ролика - не места референсов, их в тексте нет под номерами (<Picture N>)
  $$('label.ref:not(.frame)', root).forEach((r, j) => { if (r._file) fill.set('Picture ' + (j + 1), 'общее место ' + (j + 1)); });
  // the single-text modes keep their media in numbered slots, not in label.ref shelves
  $$('.rm-imgs .slot', root).filter(x => x._file).forEach((r, j) => { if (!fill.has('Picture ' + (j + 1))) fill.set('Picture ' + (j + 1), 'фото ' + (j + 1)); });
  $$('.rm-auds .slot', root).filter(x => x._file).forEach((r, j) => { if (!fill.has('Audio ' + (j + 1))) fill.set('Audio ' + (j + 1), 'звук ' + (j + 1)); });
  const cards = (typeof $$ === 'function' ? $$('.sc', root) : []);
  const named = t => new Set(((t || '').match(/<\s*(?:Picture|Audio)\s*\d+\s*>/g) || []).map(s => s.replace(/[<>]/g, '').replace(/\s+/g, ' ')));
  const bad = [];
  const one = (text, label, own) => {
    (own || []).forEach(x => { if (!named(text).has(x.tag)) bad.push(label + ': ' + x.where + ' - тег <' + x.tag + '> в тексте не назван'); });
    named(text).forEach(tag => { if (!fill.has(tag) && !(own || []).some(x => x.tag === tag)) bad.push(label + ': в тексте есть <' + tag + '>, а такого файла в разделе нет'); });
  };
  cards.forEach((c, i) => {
    const bs = c._baseFixed || c._base || 10 * (i + 1);
    const own = [];
    (c._files || []).forEach((f, j) => { if (f) own.push({ tag: 'Picture ' + (bs + j), where: 'фото сцены ' + (i + 1) }); });
    (c._auds || []).forEach((f, j) => { if (f) own.push({ tag: 'Audio ' + (bs + j), where: 'песня сцены ' + (i + 1) }); });
    one(($('textarea', c) || {}).value, 'сцена ' + (i + 1), own);
  });
  if (!cards.length) {
    const ta = root.querySelector('textarea.rm-prompt') || root.querySelector('textarea');
    if (ta) one(ta.value, 'текст', []);
  }
  const out = [];
  fill.forEach((where, tag) => {
    const anywhere = cards.length ? cards.some(c => (($('textarea', c) || {}).value || '').indexOf('<' + tag + '>') >= 0)
      : ((root.querySelector('textarea.rm-prompt') || root.querySelector('textarea') || {}).value || '').indexOf('<' + tag + '>') >= 0;
    if (!anywhere) out.push(where + ' - <' + tag + '> ни в одном тексте не назван');
  });
  return out.concat(bad.filter((x, i) => bad.indexOf(x) === i));
}
export function agRefWarn(mode, head) {
  try {
    const r = (typeof RM !== 'undefined' && RM[mode] && RM[mode].root);
    if (r && r._restoring) return 0;   // the shelves are still filling from memory: nothing is missing yet
    const bad = agRefCheck(mode);
    if (!bad.length) return 0;
    toast(head + bad.length + ': ' + bad.slice(0, 3).join(' · ') + (bad.length > 3 ? ' · и ещё ' + (bad.length - 3) : ''));
    return bad.length;
  } catch (e) { return 0; }
}
export async function agCarry(mode) {
  const root = (typeof RM !== 'undefined' && RM[mode] && RM[mode].root) || document.querySelector(agViewOf(mode));
  if (!root) return 0;
  if (typeof window._agSync === 'function') { try { window._agSync(); } catch (e) { } }
  // the text button is not a file: the draft goes into the field below, not into the tray
  const btns = Array.prototype.slice.call(root.querySelectorAll('.agall-h'))
    .filter(b => !/Текст к сценаристу|Все промты|Генерация/.test(b.textContent) && !b.disabled);
  if (!btns.length) return 0;
  let made = 0;
  window.__agQuiet = 1;   // these buttons would otherwise walk the person to the chat
  try {
    for (const b of btns) { b.click(); made++; await agSettle(); }
  } finally { window.__agQuiet = 0; }
  return made;
}
export async function agGenerate(btn, gen) {
  const draft = String((typeof gen.text === 'function' ? gen.text() : '') || '').trim();
  if (!draft) { toast('Сначала напишите текст в этом поле'); return; }
  if (AG.busy) { toast('Сценарист уже пишет: дождитесь ответа или остановите его в чате'); return; }
  if (!AG.status || AG.status.installed === undefined) { try { await agStatus(); } catch (e) { } }   // the status is loaded lazily, do not cry «no model» too early
  if (!AG.status || !AG.status.installed) { toast('Модель сценариста не скачана: раздел «Сценарист», строчка «Модель сценариста»'); return; }
  const mode = typeof gen.mode === 'function' ? gen.mode() : gen.mode;
  const name = (typeof AG_NAMES !== 'undefined' && AG_NAMES[mode]) || 'этого раздела';
  const was = btn.textContent, chat = $('#agIn'), keep = chat ? chat.value : '';
  btn.disabled = true; btn.textContent = 'Переносим в чат…';
  try {
    agRefWarn(mode, 'До сценариста: не всё разложено по полочкам - ');   // files and tags must agree BEFORE the rewrite
    const carried = await agCarry(mode);
    btn.textContent = 'Сценарист пишет промпт…';
    const t = $('#agTarget [data-t="' + mode + '"]') || $('#agTarget2 [data-t="' + mode + '"]');
    if (t && !t.classList.contains('on')) t.click();   // the Agent writes for this mode
    AG.draft = { to: mode, at: Date.now() };           // and the answer has to come back to this field
    if (chat) chat.value = (gen.scenes
      // a scene sheet is one document: the answer has to come back with the same headings, or the
      // texts would not know which card they belong to
      ? 'Сцены из раздела ' + name + '. Перепиши каждую сцену как готовый промпт этого режима. Верни ровно те же заголовки SCENE N с той же длительностью, не объединяй и не теряй сцены, сохрани все теги (<Picture N>, <Video N>, <Audio N>) и их номера, от себя ничего не добавляй.\n\n'
      : 'Черновик промпта из раздела ' + name + '. Сделай из него готовый промпт этого режима: сохрани все теги (<Picture N>, <Video N>, <Audio N>) и их номера, не добавляй того, чего в черновике нет, и верни ВЕСЬ промпт одним блоком.\n\n') + draft;
    const before = AG.msgs.length;   // our own reply lands right after our own message, not at the tail
    await agSend();
    if (AG.msgs.length < before + 2) {
      // the send was refused (the agent is busy, the model is missing): the reason was already said
      AG.draft = null;
      if (chat && !chat.value.trim() && keep) chat.value = keep;
      return;
    }
    const last = AG.msgs[before + 1];
    if (!last || last.role !== 'assistant' || last.error) {
      if (!last._reported) { last._reported = true; toast('Сценарист не ответил: ' + ((last && last.error) || 'пустой ответ') + '. Текст в разделе остался как был.'); }
      if (chat && !chat.value.trim() && keep) chat.value = keep;
      return;
    }
    const msg = $('#agMsgs .msg.a:last-child');
    const blks = msg ? Array.prototype.slice.call(msg.querySelectorAll('.pblock')).filter(b => b.querySelector('pre[data-b]')) : [];
    const blk = blks[blks.length - 1];
    if (!blk) { toast('В ответе сценариста нет оформленного промпта: посмотрите чат'); return; }
    AG.draft = { to: mode, at: Date.now() };
    await sendPrompt(blk, mode);   // the round trip: text back into this field, files left alone
    /* The Agent hears the song in the chat but often answers with non_diegetic_music: N/A: the words
       it was given must not evaporate on the way back. */
    try {
      const r0 = (typeof RM !== 'undefined' && RM[mode] && RM[mode].root) || null;
      if (r0 && gen.scenes) {
        const filled = [];
        $$('.sc', r0).forEach((c, i) => { if (c._carryWords && c._carryWords().length) filled.push(i + 1); });
        if (filled.length) toast('Сцены ' + filled.join(', ') + ': слова песни вписаны обратно в текст - Сценарист их не перенёс');
      }
    } catch (e) { }
    agRefWarn(mode, 'После возврата: ');
    toast((gen.scenes ? 'Тексты сцен переписаны и встали в свои карточки' : 'Промпт готов и заменил текст в разделе')
      + (carried ? ' · в чат перенесено файлов: ' + carried : '') + ' · черновик и ответ остались в истории «сценариста»');
  } catch (e) {
    toast('Не вышло: ' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false; btn.textContent = was;
  }
}
$('#wzStart').onclick = async () => {
  $('#wzErr').textContent = ''; $('#wzStart').disabled = true;
  try {
    if (setupOpt === 'external') {
      if (extK === 'rent' && !$('#comfyUrl').value.trim()) throw new Error('Впишите адрес сервера или вставьте ссылку «StableDiffusion» из панели сервиса');
      const url = $('#comfyUrl').value, ckey = $('#comfyKey').value;
      const connected = async (r) => {
        toast(`Подключено к ComfyUI ${r.version || ''}`);
        if (r.ws_ok === false) toast('Внимание: сервер не пропускает живую связь (WebSocket). Задания могут не показывать ход работы и не заканчиваться.');
        await afterSetup();
        if (r.nodes_missing?.length) { goTo('models'); toast(`В вашем ComfyUI нет нод: ${r.nodes_missing.join(', ')}. Подробности в разделе «Модели».`); }
      };
      const r = await postJSON('/api/setup/external', { url, key: ckey, modes: setupModes });
      if (r.need_confirm) {   // адрес не с этого компьютера: сначала спрашиваем, человек должен понимать, что уходит наружу
        $('#wzErr').textContent = 'Программа спросит подтверждение — прочитайте окно.';
        confirmBox('ComfyUI не на этом компьютере', r.need_confirm, 'Подключить', async () => {
          $('#wzStart').disabled = true;
          try { await connected(await postJSON('/api/setup/external', { url, key: ckey, modes: setupModes, confirm: 1 })); }
          catch (e2) { $('#wzErr').textContent = e2.message; }
          $('#wzStart').disabled = false;
        });
      } else await connected(r);
    } else {

      await postJSON('/api/setup/install', { install_dir: $('#instDir').value.trim(), profile: setupProfile, modes: setupModes });
      showSetupPane('progress'); setStep(2); resetProgress();
    }
  } catch (e) { $('#wzErr').textContent = e.message; }
  $('#wzStart').disabled = false;
};

/* ---------- AGENT ---------- */
export const AG = { msgs: [], att: [], target: 'video', busy: false, ctrl: null, status: null, edit: true };
window.dataUrlToFile = (du, name, kind) => {   // сохранённый чат возвращает файл, а не его уменьшенный показ
  const [h, b] = String(du || '').split(',');
  const bin = atob(b || '');
  const a = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
  const mime = kind || (h.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
  return new File([a], name || 'файл', { type: mime });
};
export function agImgCount() { return AG.msgs.reduce((n, m) => n + (m.images?.length || 0) - (m.nframes || 0), 0); }   // frames of a video are not pictures of heroes
/* Номер, который человек видит на плитке лотка, и есть номер, которым его картинка
   называется в тексте. Явный тег из подписи важнее; остальные получают свободные числа
   после картинок, уже отправленных в чат. По этим же номерам картинка возвращается в
   свою сцену: у 10 первая цифра - номер сцены, последняя - её место. Раньше обратно
   читалась только подпись вложения, и плитка с придуманным номером «Picture 10» в
   первую сцену не попадала: тег в тексте оставался без файла. */
window.agAttTags = () => {
  const num = a => { const m = /<\s*(?:Picture|Video|Audio)\s*(\d+)\s*>/i.exec((a && a.note) || ''); return m ? +m[1] : 0; };
  const taken = new Set();
  (AG.att || []).forEach(a => { const n = num(a); if (n) taken.add(n); });
  const base = (typeof agImgCount === 'function' ? agImgCount() : 0);
  let k = 0;
  return (AG.att || []).map(a => {
    if (!a || a.frame) return 0;                       // кадры видео в сцены не едут
    const own = num(a); if (own) return own;
    let n = base + (++k);
    while (taken.has(n)) n++;
    taken.add(n);
    return n;
  });
};
export function renderAtt() {
  const base = agImgCount(); let k = 0;
  // every tile carries the tag it stands for; a video is named to the model as <Video 1>, <Video 2>…
  // in the order the videos appeared, so a frame's tag is its video's number, not the frame's own
  const vnames = [];
  AG.att.forEach(a => { if (a.frame && !vnames.includes(a.vname)) vnames.push(a.vname); });
  /* A photo whose text says <Picture 30> used to be labelled «Picture 4» here - its place in the
     tray - and the person saw his own picture renamed under his hands. The tile carries the tag
     the text really uses; the note of the section says which one that is. */
  const ownTag = a => { const m = /<\s*(Picture|Video|Audio)\s*(\d+)\s*>/i.exec((a && a.note) || ''); return m ? m[1] + ' ' + m[2] : ''; };
  // the number a picture answers to: the section wrote it into the text, the tray must not invent its own
  /* Придуманный номер не должен совпадать с тем, что уже написан на другой плитке: картинка,
     пришедшая из сцены, приносит свой номер (у сцены он десятичный), и рядом вставала плитка
     с таким же числом - человек видел две «Picture 3» и не понимал, какая настоящая. */
  const taken = new Set();
  AG.att.forEach(a => { const m = (ownTag(a).match(/\d+/) || [])[0]; if (m) taken.add(+m); });
  const nums = window.agAttTags();
  const lab = AG.att.map((a, i) => {
    if (a.frame) return '';
    const own = ownTag(a);
    if (own) return own;
    return 'Picture ' + (nums[i] || (base + (++k)));   // то же число, по которому картинка едет в свою сцену
  });
  $('#agAtt').innerHTML = AG.att.map((a, i) => a.frame
    ? `<div data-tag="&lt;${ownTag(a) || 'Video ' + (vnames.indexOf(a.vname) + 1)}&gt;" title="Кадр из видео «${esc(a.vname)}» · нажмите, чтобы вставить тег"><img src="${a.url}"><b style="background:#3a5a8c">🎞 ${esc(a.label)}</b><button data-i="${i}">✕</button></div>`
      : `<div data-tag="&lt;${lab[i]}&gt;" title="${a.note ? esc(a.note) + ' · ' : ''}нажмите, чтобы вставить тег"><img src="${a.url}"><b>${lab[i]}</b><button data-i="${i}">✕</button></div>`).join('');
  { const fold = $('#agAttFold'); if (fold) { fold.hidden = !AG.att.length; if (!AG.att.length) fold.open = false;
      const nm = $('#agAttN'); if (nm) nm.textContent = AG.att.length === 1 ? 'Картинка или кадр' : ('Картинки и кадры: ' + AG.att.length); } }
  agVidBtn();   // the video button lives or sleeps with the tray
}
// a video cannot be shown to the model as a file: several frames are cut out of it and sent as pictures, with the seconds written down
export async function agVideoFrames(file, n = 8) {
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = URL.createObjectURL(file);
  const ok = await new Promise(r => { v.onloadedmetadata = () => r(true); v.onerror = () => r(false); });
  if (!ok || !(v.duration > 0)) { URL.revokeObjectURL(v.src); throw new Error('Не получилось открыть видео «' + file.name + '». Попробуйте MP4 (H.264).'); }
  const dur = v.duration;   // the whole clip: for a continuation the end matters more than the start
  // every frame costs the model context: 512 px is enough to read a scene
  const w = Math.min(512, v.videoWidth || 512), h = Math.round(w * (v.videoHeight || 360) / (v.videoWidth || 640));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), out = [];
  for (let i = 0; i < n; i++) {
    // evenly, from the very beginning to the very end: the last frame is what a continuation starts from
    const t = n === 1 ? Math.max(0.05, dur - 0.06) : Math.min(dur - 0.06, Math.max(0.05, dur * i / Math.max(1, n - 1)));
    v.currentTime = t; await new Promise(r => { v.onseeked = r; setTimeout(r, 1500); });
    g.drawImage(v, 0, 0, w, h);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    out.push({ t, file: new File([blob], `video_${file.name.replace(/\.[^.]+$/, '')}_${t.toFixed(1)}s.jpg`, { type: 'image/jpeg' }), url: await fileToDataURL(blob) });
  }
  URL.revokeObjectURL(v.src);
  return { frames: out, dur: v.duration };
}
export const AG_FRAME_MAX = 15;                     // frames all videos in the tray share
export function agVideoMax() {
  /* The number of videos the Agent may hold is not its own rule: it is how many video places the mode
     this prompt is being written for really has. References take three, the swap and the studio take one
     - and there the new video replaces the old one - while the modes without a video place do not take
     a video at all, and the tray's button says so. */
  const t = AG.target;
  if (t === 'long') return 1;                       // the studio's one video is the one it continues
  const box = dropBox(t);
  return box ? $$('.rm-vids input', box).length : 0;
}
export function agVidBtn() {
  const lb = $('#agVidFile') && $('#agVidFile').closest('label'), n = agVideoMax();
  if (!lb) return;
  if (!AG || !AG.target || !$('#agVidFile')) return;
  lb.style.opacity = n ? '1' : '.4';
  lb.style.pointerEvents = n ? '' : 'none';
  lb.title = n
    ? `Сценарист посмотрит на видео как на кадры - вырежем их сами (этот режим принимает видео: ${n}). При переносе промпта в раздел уйдёт сам файл`
    : 'Это видео не примет режим, для которого пишется промпт: выберите «Видеостудию», «Замену» или «Киностудию»';
}
export function agFitVideos() {
  // the mode changed under the tray: the extra videos leave, the first ones stay
  const max = agVideoMax(), names = [];
  AG.att.forEach(a => { if (a.frame && !names.includes(a.vname)) names.push(a.vname); });
  if (names.length <= max) { agVidBtn(); return 0; }
  const gone = names.slice(max);
  AG.att = AG.att.filter(a => !(a.frame && gone.includes(a.vname)));
  renderAtt(); agCtx();
  toast(max
    ? `Этот режим принимает видео: ${max} · лишние ${gone.length} убраны, осталось первое`
    : 'Этот режим видео не принимает · раскадровка убрана из лотка');
  agVidBtn();
  return gone.length;
}
export function agShareFrames() {
  /* A second and a third video must not force the person to clear the tray by hand: the program leaves
     an even spread over the whole length of each video - the beginning, the middle, the end - and takes
     away the frames that repeat what is already shown. */
  const names = [];
  AG.att.forEach(a => { if (a.frame && !names.includes(a.vname)) names.push(a.vname); });
  if (names.length <= 1) return 0;
  const per = Math.max(4, Math.floor(AG_FRAME_MAX / names.length));
  const keep = new Set();
  names.forEach(nm => {
    const g = AG.att.filter(a => a.frame && a.vname === nm);
    if (g.length <= per) { g.forEach(x => keep.add(x)); return; }
    for (let i = 0; i < per; i++) keep.add(g[Math.round(i * (g.length - 1) / (per - 1))]);
  });
  const before = AG.att.length;
  AG.att = AG.att.filter(a => !a.frame || keep.has(a));
  return before - AG.att.length;
}
export async function agFramesFromFile(f) {   // the only way the agent can look at a video: pieces of it
  const max = agVideoMax();
  if (!max) { toast('Видео не нужен режиму, для которого пишется промпт: выберите «Видеостудию», «Замену» или «Киностудию»'); return false; }
  const again = AG.att.some(a => a.frame && a.vname === f.name);
  if (again) AG.att = AG.att.filter(a => !(a.frame && a.vname === f.name));   // the same video lays its frames out anew
  if (max === 1) AG.att = AG.att.filter(a => !a.frame);                       // one place: the new video takes it from the old
  const seen = new Set(AG.att.filter(a => a.frame).map(a => a.vname));
  if (!again && seen.size >= max) { toast('Этот режим принимает ' + max + ' видео: уберите одно из лотка'); return false; }
  toast('Вырезаем кадры из видео…');
  try {
    // The studio continues a video from its last frame and receives nothing else from the chat, so the
    // agent is shown exactly that one frame - what it sees is what the model will get. The other modes
    // have to recognise heroes and action, they look through the whole clip.
    const want = AG.target === 'long' ? 1 : Math.min(12, AG_FRAME_MAX);
    const { frames, dur } = await agVideoFrames(f, want);
    frames.forEach(fr => AG.att.push({ file: fr.file, url: fr.url, frame: true, label: fr.t.toFixed(1) + ' с', vname: f.name, vdur: dur, vfile: f }));
    const cut = agShareFrames();
    renderAtt(); agCtx();
    const fr = AG.att.filter(a => a.frame);
    const nv = new Set(fr.map(a => a.vname)).size;
    toast(frames.length === 1
      ? `Взят последний кадр видео (${frames[0].t.toFixed(1)} с) - ровно тот, с которого Киностудия продолжит ролик. Опишите, что происходит дальше`
      : `Из видео взято ${frames.length} кадров` + (cut ? `, повторы убраны: ${cut}` : '')
        + (nv > 1 ? ` · всего ${fr.length} кадров с ${nv} видео` : '') + '. Теперь напишите, кого на что заменить');
  } catch (err) { toast(err.message); return false; }
  return true;
}
$('#agVidFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (f) await agFramesFromFile(f);   // the same as a drop: frames
};
$('#agAtt').addEventListener('dragover', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); $('#agAtt').classList.add('over'); } });
$('#agAtt').addEventListener('dragleave', () => $('#agAtt').classList.remove('over'));
$('#agAtt').addEventListener('drop', async e => {
  if (![...(e.dataTransfer.types || [])].includes('Files')) return;
  e.preventDefault(); e.stopPropagation(); $('#agAtt').classList.remove('over');
  for (const f of e.dataTransfer.files) await agAttachFile(f);
});
$('#agAtt').onclick = async e => {
  const b = e.target.closest('button[data-i]'); if (b) { AG.att.splice(+b.dataset.i, 1); renderAtt(); return; }
  // the tile is the tag it shows: a press writes it into the field at the cursor, so nobody has to
  // retype <Picture 3> or remember which number a scene's own photo got
  const t = e.target.closest('[data-tag]'); if (t) agInsertTag(t.dataset.tag);
};
$('#agFile').onchange = async e => {
  for (const f of e.target.files) {
    if (fileKind(f) === 'video') { await agFramesFromFile(f); continue; }   // the picture button: a video turns into frames
    if (!isImage(f)) { toast('Это не картинка: ' + f.name); continue; } const u = await fileToDataURL(f); if (u) AG.att.push({ file: f, url: u }); else toast('Картинка не открылась: ' + f.name); }
  e.target.value = ''; renderAtt();
};
$('#agEmpty').onclick = e => { const s = e.target.closest('span'); if (s) { $('#agIn').value = s.textContent.replace(/[«»]/g, '').replace(/ \+ фото героинь$/, ''); $('#agIn').focus(); } };
$('#agIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#agSend').click(); } });
export const AG_NAMES = { plist: '«Изображение по тексту» · список кадров', h3t: '«Изображение по тексту» · H3 Image', h3e: '«Изменение по референсам» · H3 Image', actionsc: '«Экшн-студия»', long: '«Киностудия»', video: '«Видео»', lipsync: '«Клип»', refs: '«Видеостудия»', actor: '«Актёр»', swap: '«Замена»', action: '«Экшн-видео»', krea: '«Изображение по тексту» · Krea 2', qwen: '«Изменение изображения»', sheet: '«Изменение изображения» · лист персонажа', sheet6: '«Изменение изображения» · лист ×6', fluxt: '«Изображение по тексту» · FLUX klein', qwent: '«Изображение по тексту» · Qwen 2.1', story: '«Изменение изображения» · раскадровка' };
export const AG_IMG = ['plist', 'krea', 'qwen', 'sheet', 'sheet6', 'fluxt', 'qwent', 'h3t', 'h3e', 'story'];
AG.storyModel = 'krea'; AG.storyFrames = true;
AG.think = (() => { try { return localStorage.getItem('h3-ag-think') === 'deep' ? 'deep' : 'fast'; } catch { return 'fast'; } })();
export function agThinkPaint() {
  $$('#agThink button').forEach(b => b.classList.toggle('on', b.dataset.k === AG.think));
  $('#agThinkHint').textContent = AG.think === 'fast' ? 'Сценарист отвечает сразу. Для обычных сцен и промптов этого хватает.' : 'Сценарист сначала долго рассуждает, потом отвечает: на одну сцену может уйти пара минут. Включайте для сложных историй.';
}
$('#agThink').onclick = e => { const b = e.target.closest('button'); if (!b) return; AG.think = b.dataset.k; try { localStorage.setItem('h3-ag-think', AG.think); } catch {} agThinkPaint(); };
agThinkPaint();
export const agTargetClick = e => {
  const b = e.target.closest('button[data-t]'); if (!b) return;
  // a new target means the draft has no way home; the highlight moves with the choice
  AG.target = b.dataset.t; if (AG.draft && AG.draft.to !== AG.target) AG.draft = null;
  $$('#agTarget button, #agTarget2 button').forEach(x => x.classList.toggle('on', x === b)); agCtx(); agFitVideos();
};
$('#agStoryF').onclick = e => { const b = e.target.closest('button[data-f]'); if (!b) return; AG.storyFrames = b.dataset.f === '1'; agCtx(); };
$('#agStoryM').onclick = e => { const b = e.target.closest('button[data-m]'); if (!b) return; AG.storyModel = b.dataset.m; agCtx(); };
$('#agTarget').onclick = agTargetClick; $('#agTarget2').onclick = agTargetClick;
// what will become of the videos in the tray, said before the person presses anything
export function agVidNote() {
  const names = [...new Set(AG.att.filter(a => a.frame).map(a => a.vname))];
  if (AG.target === 'long') {
    return names.length
      ? ` Киностудия продолжит видео «${names[0]}»: режим «продолжить своё видео» включится сам, а его последний кадр встанет отдельной плиткой перед вашими фото. Из видео сценаристу нужен только этот последний кадр - его и берём, другие не пересылаем.`
        + (names.length > 1 ? ` Остальные ${names.length - 1} видео студия не принимает - они останутся в чате.` : '')
      : ' Если приложите видео, Киностудия продолжит именно его: режим включится сам, последний кадр встанет перед вашими фото.';
  }
  if (!names.length) return '';
  const max = agVideoMax();
  return max > 1 ? ` В раздел уйдёт до ${max} видео: ${names.join(', ')}.` : ` В раздел уйдёт видео «${names[0]}».`;
}
export const AG_IN_HINT = 'Опишите сцену, сценарий или вставьте реплики… (Enter — создать промт, Shift+Enter — новая строка)';
export function agPlaceholder() {
  /* When the studio is going to continue a video, the person should read that in the field they are
     about to type into - not only in a line above, which the eye skips. */
  const el = $('#agIn'); if (!el) return;
  const v = [...new Set(AG.att.filter(a => a.frame).map(a => a.vname))];
  const src = (RM.long && RM.long.root && RM.long.root._src) || null;
  const nm = v[0] || (src && src.name) || 'ваше видео';
  el.placeholder = AG.target === 'long' && (v.length || src)
    ? `Киностудия продолжит «${nm.length > 28 ? nm.slice(0, 28) + '…' : nm}» с его последнего кадра. Напишите, что происходит дальше: одно движение, один ход камеры. (Enter — создать промт)`
    : AG_IN_HINT;
}
export function agCtx() {
  agEditLabels(); agPlaceholder();   // названия переключателя зависят от того, добавляет ли режим что-то к готовому
  const n = (AG.edit ? 0 : agImgCount()) + AG.att.filter(a => !a.frame).length;   // a fix counts only the pictures of this message
  $('#agStoryF').hidden = AG.target !== 'story';
  $('#agStoryM').hidden = AG.target !== 'story';
  $$('#agStoryF button').forEach(b => b.classList.toggle('on', (b.dataset.f === '1') === AG.storyFrames));
  $$('#agStoryM button').forEach(b => b.classList.toggle('on', b.dataset.m === AG.storyModel));
  $('#agCtx').textContent = (AG_IMG.includes(AG.target)
    ? ({ krea: 'Опишите изображение словами: сценарист напишет промпт для Krea 2. Изображения в чате — только образцы настроения.',
         qwen: `Приложите изображение, которое нужно изменить (скрепка или «Из Библиотеки»), и напишите, что поменять. Изображений в чате: ${n}.`,
         story: 'Расскажите историю по кадрам («первый кадр — …, второй кадр — …») и скажите, сколько кадров нужно. Сценарист напишет промпт одного изображения-раскадровки без подписей и номеров для выбранной модели.',
         fluxt: 'Опишите изображение словами: сценарист напишет промпт для FLUX klein (без негатива, описание по порядку: главное сначала). Изображения в чате — только образцы настроения.',
         qwent: 'Опишите изображение словами: сценарист напишет промпт для Qwen 2.1. Негатив впишите отдельным полем в разделе. Изображения в чате — только образцы настроения.',
         sheet: `Опишите персонажа: сценарист напишет промпт листа из 4 панелей. Изображений в чате: ${n}.`,
         sheet6: `Опишите персонажа: сценарист напишет промпт листа из 6 панелей (в полный рост спереди, в три четверти, сбоку, сзади + два портрета). Изображений в чате: ${n}.` })[AG.target]
    : AG.target === 'plist'
    ? `Опишите историю или набор изображений («герой утром, героиня днём, вечер у моря…») и скажите, сколько нужно. Сценарист напишет промпт для каждого изображения, а кнопка вставит их на страницу «Изображение», в режим «Список промптов».`
    : AG.target === 'swap'
    ? `Скажите, кого в видео заменить (например, «старика в пиджаке») и каким изображением. Изображения героев приложите скрепкой по порядку: они станут Picture 1, 2. Своё видео приложите кнопкой с камерой: программа вырежет из него кадры, и Сценарист увидит, кто в кадре (видео уйдёт на страницу «Замена»). Изображений героев в чате: ${n}.`
    : AG.target === 'long'
    ? `Опишите историю по сценам («сначала… потом… в конце…») и скажите, с песней ролик или без. Сценарист разобьёт её на сцены и подпишет длину каждой. Изображения в чате: ${n} — станут референсами героя и места (Picture 1, 2…).`
    : AG.target === 'video'
    ? `Берём ${V.dur} с — столько стоит на странице «Видео» (меняется там же). Картинки в чате: ${n} — первая станет первым кадром, вторая последним.`
    : AG.target === 'lipsync'
      ? `Длина видео = длине аудио${L.dur0 ? ` (${L.len().toFixed(1)} с)` : ''}. Изображения в чате: ${n} — станут референсами Picture 1, 2…`
      : `Берём ${RM[AG.target].S.dur} с — столько стоит на странице «${{ refs: 'Видеостудия', actor: 'Актёр', action: 'Экшн-видео', actionsc: 'Экшн-студия' }[AG.target]}» (меняется там же). Картинки в чате: ${n} — станут Picture 1, 2…`) + agVidNote();
}
export function mdLite(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
export function renderAssistant(el, m) {
  let html = m.skills?.length ? `<div class="skc">${m.skills.map(s => `<span>${esc(s)}</span>`).join('')}</div>` : '';
  const parts = (m.content || '').split(/```(?:prompt|text)?\s*\n?/);
  parts.forEach((p, i) => {
    if (i % 2 === 0) { if (p.trim()) html += mdLite(p.trim()); return; }
    const closed = i < parts.length - 1;
    const text = m.edits?.[i] ?? p.replace(/\n$/, '');
    /* Режим, для которого делали текст, и есть ли у него окно «Сценарий». Если окно есть,
       кнопка не уводит человека с его фото и песнями: она кладёт текст в то окно, а
       промпт он там делает сам - привязка картинок и звука живёт в режиме. */
    const into = AG_NAMES[m.to || AG.target] || (m.to || AG.target);
    const put = !!scenarioWindowOf(m.to || AG.target);
    html += `<div class="pblock"><pre${closed ? ` contenteditable="plaintext-only" spellcheck="false" data-b="${i}" title="Текст можно править прямо здесь"` : ''}>${esc(text)}</pre>${closed ? `<div class="pb-act">
      <button class="btn pri" data-send="${m.to || AG.target}" title="${put ? 'Текст ляжет в окно «Сценарий» режима «' + into + '»: фото и песни привязываете там же, а промпт делает кнопка «Генерация промта»' : m.to ? 'Делалось для этого раздела и туда же попадёт' : 'Раздел не записан в этом сообщении: уйдёт в тот, что выбран сейчас'}">${put ? 'Отправить в ' + into : m.to ? 'В ' + into : 'В выбранный раздел'}</button>
      <button class="btn" data-ru title="Русский перевод только для чтения: в модель уходит английский текст">Показать по-русски</button><button class="btn" data-copy>Копировать</button><button class="btn" data-paste title="Вставить скопированный текст на место выделенного (или в конец)">Вставить</button><small class="pb-n">${text.length} симв.</small></div>` : ''}${m.ru?.[i] ? `<div class="pb-ru"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px"><b>По-русски (только для чтения):</b><button class="btn" data-copy-ru type="button" style="padding:3px 10px;font-size:12px">Копировать русский</button></div><span class="pb-ru-t">${esc(m.ru[i]).replace(/\n/g, '<br>')}</span></div>` : ''}</div>`;
  });
  if (m.status && !m.content) html += `<div class="st">${esc(m.status)}</div>`;
  if (m.error) html += `<p style="color:var(--pink)">${esc(m.error)}</p>`;
  el.innerHTML = html || '<div class="st">…</div>';
}
export function renderMsgs() {
  $('#agEmpty').hidden = AG.msgs.length > 0;
  $$('#agMsgs .msg').forEach(x => x.remove());
  AG.msgs.forEach((m, idx) => {
    const d = document.createElement('div'); d.className = 'msg ' + (m.role === 'user' ? 'u' : 'a'); d.dataset.i = idx;
    if (m.role === 'user') {
      d.textContent = m.content;
      const tiles = (m.images || []).map(u => `<img src="${u}">`);
      // a video goes to the generation as a file, so the chat shows its first frame with a word about it
      if (m.vimg) tiles.push(`<span class="vidtile"><img src="${m.vimg}" alt=""><b>🎬 ${esc(m.vname || 'видео')}${m.vdur ? ' · ' + m.vdur + ' с' : ''} · ${(m.videos || []).length > 1 ? (m.videos.length + ' видео') : 'кадры'}</b></span>`);
      if (tiles.length) d.insertAdjacentHTML('beforeend', `<div class="imgs">${tiles.join('')}</div>`);
    } else renderAssistant(d, m);
    $('#agMsgs').append(d);
  });
  $('#agMsgs').scrollTop = 1e9;
}
/* audio in the chat: words from a clip (for lipsync prompts) and voice input */
/* распознавание речи уехало в ui/mic.js: та же кнопка нужна полям «Сценарий» в режимах,
   а раздел не должен быть тем, от кого все зависят */
/* The person may press the button before the page ever asked the server what is installed: an
   answer that was never fetched is not a missing model, so the status is fetched on the spot. */
export async function speechReady() {
  if (AG.status && AG.status.speech_ready) return false;
  // (the fetch below is the difference between «not downloaded» and «we did not look yet»)
  try { await agStatus(); } catch (e) { }
  return needSpeech();
}
export function needSpeech() {
  if (AG.status && AG.status.speech_ready) return false;
  /* A status that never arrived is not a model that was never downloaded. Saying «not downloaded»
     sent the person to download something he already had, while the real fault was a silent
     request - and the transfer of the scene's songs died right there. */
  toast(AG.status ? 'Распознавание речи ещё не скачано — в разделе «Сценарист» откройте строчку «Модель сценариста» и нажмите «Докачать»'
                  : 'Статус сценариста не пришёл, проверить распознавание речи не удалось. Попробуйте ещё раз.');
  return true;
}
export function showAudioBox() {
  const list = AG.audios || [];
  /* The rows stand in the order of their tags, not in the order they happened to arrive: a person
     reads <Audio 1>, then <Audio 2>, then the scenes' tens, and looks for a line by that number.
     The array itself is sorted, so the prompt the agent assembles lists them the same way. Files
     whose tag is unknown go to the end, and never jump around between equal tags. */
  const tagNo = a => { const m = /<Audio\s*(\d+)>/i.exec((a && a.where) || ''); return m ? +m[1] : 1e6; };
  if (list.length > 1 && list.some((a, i) => tagNo(a) > tagNo(list[i + 1] || a))) {
    list.sort((x, y) => (tagNo(x) - tagNo(y)) || String(x.name).localeCompare(String(y.name)));
  }
  const box = $('#agAudioBox'), inside = $('#agAudioList', box);
  box.hidden = !list.length;
  if (!list.length) { box.open = false; AG.audio = null; return; }   // an emptied fold comes back closed
  // the heading is the whole block while it is folded, so it has to say how many there are
  $('#agAudioName').textContent = list.length === 1 ? (list[0].name || 'аудио') : ('Аудио в сообщении: ' + list.length);
  $('#agAudioDur').textContent = list.length === 1 ? (list[0].dur.toFixed(1) + ' с') : (list.reduce((s, a) => s + a.dur, 0).toFixed(1) + ' с всего');
  const esc3 = s => String(s).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  inside.innerHTML = list.map((a, i) => `<div class="ag-audio-item" style="padding:6px 0;border-top:1px solid rgba(255,255,255,.08)">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b${(a.where || '').match(/<Audio\s*\d+>/i) ? ` data-ins="${esc3(a.where.match(/<Audio\s*\d+>/i)[0])}" class="ag-tagb" title="Нажмите - и тег ${esc3(a.where.match(/<Audio\s*\d+>/i)[0])} впишется в текст сцены"` : ''}>${i + 1}. ${esc3(a.name)}</b>
        <span style="opacity:.8">${a.dur.toFixed(1)} с</span>${a.where ? `<span style="opacity:.7">${esc3(a.where)}</span>` : ''}
        <button class="btn mini" type="button" data-k="${i}" title="Убрать это аудио из сообщения">×</button></div>
      <textarea data-t="${i}" rows="1" style="width:100%;margin-top:4px" ${a.busy ? 'disabled' : ''}
        placeholder="${a.busy ? 'Распознаём слова…' : 'Слов не найдено — впишите сами или оставьте пустым (музыка)'}">${esc3(a.text)}</textarea>
    </div>`).join('');
  AG.audio = list[0];
}
$('#agAudioBox').addEventListener('input', e => {
  const ta = e.target.closest('[data-t]'); if (!ta) return;
  const a = (AG.audios || [])[+ta.dataset.t]; if (a) a.text = ta.value;
});
$('#agAudioBox').addEventListener('click', e => {
  const ins = e.target.closest('[data-ins]');
  if (ins) { agInsertTag(ins.dataset.ins); return; }
  const b = e.target.closest('[data-k]'); if (!b) return;
  (AG.audios || []).splice(+b.dataset.k, 1);
  AG.audio = (AG.audios || [])[0] || null;
  showAudioBox();
});
/* The person often loads a file with the agent's own button, and then nothing says where it came
   from. We look the name up in the video studio: the film's background is <Audio 1>, a scene's own
   audio sit in that scene's decade (scene 1 -> <Audio 10..12>, scene 2 -> <Audio 20..22>). */
export function audioTagFor(name, dur) {
  // Only the agent's own file button has to guess: it gets a name and nothing else. The guess depends on
  // the section that stands open - audio in Референсы lives in that mode and is <Audio 1..3> there, and
  // is not the background of a film at all. The studio's buttons pass the label themselves.
  try {
    const norm = s => String(s || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const nm = norm(name);
    if (!nm) return '';
    const near = d => !(d > 0) || !(dur > 0) || Math.abs(d - dur) < 0.4;
    const found = [];
    const view = (document.querySelector('.view.active') || {}).id || '';
    const PLAIN = { 'view-refs': ['refs', 'Видеостудия'], 'view-actor': ['actor', 'Актёр'], 'view-action': ['action', 'Экшн-видео'] };
    if (PLAIN[view]) {
      const key = PLAIN[view][0], R = (typeof RM !== 'undefined' && RM[key]) ? RM[key].root : null;
      if (R) {
        const slots = $$('.rm-auds .slot', R);
        slots.forEach((s, i) => {
          if (s._file && norm(s._file.name) === nm) found.push({ label: 'раздел «' + PLAIN[view][1] + '», аудио ' + (i + 1) + ', тег <Audio ' + (i + 1) + '>', d: s._dur });
        });
      }
    } else {
      // both studios share this card: the picture studio and the action one
      const roots = [];
      ['long', 'actionsc'].forEach(k => {
        const r = (typeof RM !== 'undefined' && RM[k] && RM[k].root) || null;
        if (r && roots.indexOf(r) < 0) roots.push(r);
      });
      roots.forEach(R => {
        $$('.sc', R).forEach((c, i) => {
          const base = c._base || 10 * (i + 1);
          (c._audSrc || c._auds || []).forEach((f, j) => {
            if (f && norm(f.name) === nm) found.push({ label: 'сцена ' + (i + 1) + ', аудио ' + (j + 1) + ', тег <Audio ' + (base + j) + '>', d: (c._audDur || [])[j] });
          });
        });
        const tr = R._trim;
        if (tr && tr.name && norm(tr.name) === nm) found.push({ label: 'фон всего ролика, тег <Audio 1>', d: tr.cut ? (tr.end - tr.start) : tr.dur0 });
        $$('.rm-auds .slot', R).forEach(s => {   // and the file itself: the instrument may not have read it yet
          if (s._file && norm(s._file.name) === nm) found.push({ label: 'фон всего ролика, тег <Audio 1>', d: s._dur });
        });
      });
    }
    if (!found.length) return '';
    const fit = (typeof dur === 'number' && dur > 0) ? found.filter(x => near(x.d)) : found;
    const list = [...new Set((fit.length ? fit : found).map(x => x.label))];
    if (list.length === 1) return list[0];
    return 'лежит в нескольких местах: ' + list.join('; ');
  } catch (e) {}
  return '';
}
export async function setChatAudio(wavBlob, name, dur, where) {
  // a missing status is asked for, not guessed at: the songs of the scenes used to be dropped here
  if (!(AG.status && AG.status.speech_ready)) { try { await agStatus(); } catch (e) { } }
  if (needSpeech()) return false;
  where = where || audioTagFor(name, dur);
  AG.audios = AG.audios || [];
  const file = new File([wavBlob], name.replace(/\.[^.]+$/, '') + '.wav', { type: 'audio/wav' });
  file._dur = dur;
  const key = await window.audioKey(file);   // тот же кусок - та же запись, другой кусок - рядом
  /* Одно место сцены - одно аудио. Картинки так уже делают, а аудио вставалось рядом:
     второе нажатие «в сценариста» удваивало строки под одним тегом, и в промпт уходило
     неизвестно какое из двух исполнений одной и той же сцены. */
  const tagOf = s => { const m = /<\s*Audio\s*(\d+)\s*>/i.exec(s || ''); return m ? +m[1] : 0; };
  const tg = tagOf(where);
  let at = AG.audios.findIndex(x => x.key === key);
  if (at < 0 && tg) at = AG.audios.findIndex(x => tagOf(x.where) === tg);
  if (at >= 0 && tg) {   // устаревшие дубли тега, накопленные до этого правила, убираем сразу
    const keep = AG.audios[at];
    AG.audios = AG.audios.filter((x, i) => i === at || tagOf(x.where) !== tg);
    at = AG.audios.indexOf(keep);
  }
  if (at < 0) at = AG.audios.findIndex(x => x.name === name && Math.abs((x.dur || 0) - dur) < .1 && (x.where || '') === (where || ''));
  /* Кусок с той же подписью уже был услышан: слова переносим, а не слушаем заново -
     каждое новое распознавание может вернуть другую строку, и человек видел, как
     та же песня поёт по-разному. Заново слушаем только действительно другой звук. */
  const prev = at >= 0 ? AG.audios[at] : null;
  const sameAudio = !!(prev && prev.key === key && (prev.text || '').trim());
  const a = { name, dur, where: where || '', text: sameAudio ? String(prev.text).trim() : '', busy: !sameAudio,
    lang: sameAudio ? (prev.lang || '') : '', langName: sameAudio ? (prev.langName || '') : '', file, key };
  if (at >= 0) AG.audios.splice(at, 1, a); else AG.audios.push(a);
  showAudioBox();
  if (sameAudio) return true;
  try { const j = await transcribeWav(wavBlob); a.text = j.text; a.lang = j.lang; a.langName = j.lang_name; }
  catch (e) { toast(e.message); }
  a.busy = false; showAudioBox();
  return true;
}
$('#agAudioFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const buf = await sharedAudioCtx().decodeAudioData(await f.arrayBuffer());
    if (buf.duration > 120) toast('Длинное аудио: берём первые 2 минуты. Для нужного куска выделите его в «Клипе» и нажмите значок микрофона-фрагмента.');
    await setChatAudio(wavSlice(buf, 0, Math.min(buf.duration, 120)), f.name, Math.min(buf.duration, 120));
  } catch { toast('Не удалось прочитать аудиофайл'); }
};
// attach something from the Library to the chat: a picture (or the last frame of a video), or the sound of a video
/* A tile, a frame or a song's title is a tag you can point at: pressing it writes that tag into the
   field at the cursor, so nobody has to type <Picture 3> by hand or guess which number a scene got. */
export function agInsertTag(tag) {
  const ta = $('#agIn'); if (!ta || !tag) return;
  const s = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
  const e = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : s;
  const lead = s > 0 && !/[\s(,[;]/.test(ta.value[s - 1]) ? ' ' : '';
  ta.value = ta.value.slice(0, s) + lead + tag + ' ' + ta.value.slice(e);
  const p = s + lead.length + tag.length + 1;
  ta.focus();
  try { ta.setSelectionRange(p, p); } catch (e2) { }
  toast('Вставлено в текст: ' + tag);
}
export const agAttachFile = async (f, note) => {
  if (fileKind(f) === 'video') return agFramesFromFile(f);   // a video is always frames: this was the reason a second clip vanished
  /* The same file lying in two places is not a duplicate: the scene's text addresses it by the tag
     of ITS place, so <Picture 10> and <Picture 30> may legitimately be the very same photo and the
     model must still receive two files. Only the same place twice means «already there». */
  if (AG.att.some(a => a.file && a.file.name === f.name && a.file.size === f.size && (a.note || '') === (note || ''))) return false;
  const u = await fileToDataURL(f); if (!u) { toast('Картинка не открылась: ' + f.name); return false; }
  AG.att.push({ file: f, url: u, note: note || '' }); renderAtt(); agCtx(); return true;
};
$('#agLib').onclick = () => {
  let m = $('#agLibM'); if (!m) { m = document.createElement('div'); m.className = 'modal'; m.id = 'agLibM'; document.body.append(m); }
  m.hidden = false; let tab = 'img';
  const paint = () => {
    const items = LIB.filter(it => !it.missing && it.url && (tab === 'img' ? it.kind === 'image' : it.kind !== 'image')).sort((a, b) => b.date - a.date);
    m.innerHTML = '<div class="box" style="padding:20px"><div class="card-h"><h3>Из Библиотеки</h3><button class="btn" data-x type="button">Закрыть</button></div>'
      + `<div class="seg" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-bottom:12px"><button data-tab="img" class="${tab === 'img' ? 'on' : ''}">Изображения</button><button data-tab="snd" class="${tab === 'snd' ? 'on' : ''}">Звук из видео<small>голос или песня</small></button></div>`
      + (items.length ? `<div class="cw-pickgrid">${items.map(it => `<button class="cw-th" data-id="${it.id}" type="button" title="${esc((it.label ? it.label + ' · ' : '') + (it.prompt || '').slice(0, 80))}">${it.kind === 'image' ? `<img src="${it.url}" alt="" loading="lazy">` : `<video src="${it.url}#t=0.5" preload="metadata" muted></video>`}</button>`).join('')}</div>`
        : `<div class="hint" style="padding:20px 4px">${tab === 'img' ? 'Изображений в Библиотеке пока нет.' : 'Видео в Библиотеке пока нет.'}</div>`)
      + (tab === 'snd' ? '<div class="hint" style="margin-top:10px">Слова из звука будут распознаны, как при загрузке аудио.</div>' : '') + '</div>';
  };
  paint();
  m.onclick = async ev => {
    if (ev.target === m || ev.target.closest('[data-x]')) { m.hidden = true; return; }
    const t = ev.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; paint(); return; }
    const th = ev.target.closest('.cw-th'); if (!th) return;
    const it = LIB.find(x => x.id === th.dataset.id); if (!it) return;
    try {
      if (tab === 'img') { await agAttachFile(await libToFile(it)); toast('Изображение добавлена в чат'); }
      else {
        toast('Берём звук из видео…');
        const buf = await sharedAudioCtx().decodeAudioData(await (await fetch(it.url)).arrayBuffer());
        if (buf.duration > 120) toast('Длинное аудио: берём первые 2 минуты.');
        const d = Math.min(buf.duration, 120);
        await setChatAudio(wavSlice(buf, 0, d), (it.label || it.sub || 'видео из Библиотеки'), d);
      }
      m.hidden = true;
    } catch { toast(tab === 'img' ? 'Не удалось взять файл' : 'В этом видео нет звука или его не удалось прочитать'); }
  };
};
$('#agFromLip').onclick = () => {
  if (!L.dur0) return;
  setChatAudio(wavSlice(abuf, L.start, L.end), 'фрагмент из «Клипа»', L.len());
};
$('#agAudioText').oninput = e => { if (AG.audio) AG.audio.text = e.target.value; };
$('#agAttX').onclick = e => { e.preventDefault();   // the same cross as on the audio fold - and it too must not open the fold
  if (!AG.att.length) { toast('Картинки и кадры из сообщения уже убраны'); return; }
  AG.att = []; renderAtt(); agCtx(); toast('Все картинки и кадры убраны из сообщения');
};
$('#agAudioX').onclick = e => { e.preventDefault();        // the cross stands on the heading: without this it would also open the fold
  AG.audios = []; AG.audio = null; showAudioBox(); };   // and it clears the whole list, not one line

/* Голосовой ввод чата: запись, распознавание, вставка в поле чата. Сама запись живёт в
   ui/mic.js - такая же кнопка стоит под полями «Сценарий» в режимах. */
$('#agMic').onclick = () => micToggle($('#agMic'), {
  guard: () => speechReady(),
  hint: 'Голосовой ввод: нажмите, говорите, нажмите ещё раз',
  busy: text => { const ta = $('#agIn'), was = ta.placeholder; ta.placeholder = text; return () => { ta.placeholder = was; }; },
  onText: text => { const ta = $('#agIn'); ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + text; ta.focus(); }
});

/* The words whisper heard live in the chat's list together with the place they came from; a scene's
   song is found there by its name and length, so the same words can be put back into its prompt. */
/* A reference audio carries a timbre, not a lyric: unless the words stand in the text, the model
   invents its own and the person hears a different song. The known line is added to what goes out -
   the field keeps the author's text - and it is said out loud, so nobody has to guess. */
export function wordsIntoPrompt(text, auds, extra) {
  const add = [];
  const push = (words, lang) => {
    const t = String(words || '').trim();
    if (!t) return;
    if (String(text).toLowerCase().indexOf(t.slice(0, 24).toLowerCase()) >= 0) return;
    if (add.some(a => a.indexOf(t) >= 0)) return;
    add.push('<d>[' + (lang || 'язык аудио') + '] ' + t + '</d>');
  };
  (auds || []).filter(Boolean).forEach(f => {
    let x = null;
    try { x = agWords(f, 0); } catch (e) { }
    if (x) push(x.words, x.lang || x.langName);
  });
  (extra || []).forEach(x => x && push(x.words || x.text, x.lang || x.langName));
  if (!add.length) return text;
  toast('Слова песни добавлены в текст для модели: в промпте их не было');
  return String(text).trim() + '\n' + add.join('\n');
}

/* A card's own words (the person typed or re-listened) come first, the machine's second. */
window.audioKey = async f => {
  // подпись куска: его длительность и его байты; имя песни не отличает один куплет от другого
  try {
    if (f.__key) return f.__key;
    const buf = await (f.arrayBuffer ? f.arrayBuffer() : new Response(f).arrayBuffer());
    const v = new DataView(buf), n = Math.min(buf.byteLength, 1 << 20);
    let h1 = 0x811c9dc5, h2 = 0x2654435761;
    for (let o = 0; o + 4 <= n; o += 4) {
      const x = v.getUint32(o);
      h1 = Math.imul(h1 ^ x, 16777619) >>> 0;
      h2 = Math.imul((h2 + x) >>> 0, 2246822519) >>> 0;
    }
    const d = Math.round((+f._dur || 0) * 10) / 10;
    return (f.__key = d + '#' + h1.toString(36) + h2.toString(36));
  } catch (e) { return ''; }
};
export function agWordsFor(c, j) {
  const own = (c && c._audWords || [])[j];
  if (own && String(own).trim()) return String(own).trim();
  const f = c && c._auds && c._auds[j]; if (!f) return '';
  const bs = c._baseFixed || c._base || 10 * ($$('.sc', (c.closest('.view') || document)).indexOf(c) + 1);
  const no = Math.max(1, Math.round(bs / 10));
  return (agWords(f, no) || {}).words || '';
}
export function agWords(f, sceneNo) {
  const list = AG.audios || [];
  /* Опознать кусок по имени нельзя: два разных куска одной песни носят одно имя, и
     сцена получала слова соседней сцены - в промпте две сцены пели одну строку.
     Сначала точная подпись байтов, потом длительность; по одному имени больше никогда. */
  const mine = a => {
    const wh = a.where || '';
    // подпись без номера сцены - это общее аудио ролика: его слова подходят любой сцене,
    // которая этим звуком пользуется; чужую сцену подменять нельзя
    if (!wh.trim() || !/сцен\w*\s*\d/.test(wh)) return true;
    return new RegExp('сцен\\w*\\s*' + sceneNo + '(?![0-9])').test(wh);
  };
  const hit = (f.__key ? list.find(a => a.key === f.__key && a.text) : null)
    || list.find(a => a.name === f.name && Math.abs((a.dur || 0) - (f._dur || 0)) < .2 && a.text && mine(a))
    || null;
  return hit ? { name: hit.name, sec: Math.round(hit.dur || 0), words: String(hit.text || '').trim(), lang: hit.langName || hit.lang || '' } : null;
}
export async function agSend() {
  let text = $('#agIn').value.trim();
  if (AG.busy) {
    /* Pressing send while the agent is still writing used to kill that answer in silence: the person
       got «Остановлено» for a reply that was a second away, and the same abort was then reported by
       both waiters. Sending something new is not a way to stop: stopping has its own empty field. */
    if (text || AG.att.length || (AG.audios || []).length) { toast('Сценарист ещё пишет: дождитесь ответа, а остановить - пустым полем или кнопкой «Стоп»'); return; }
    AG.ctrl?.abort(); return;
  }
  const AUD = AG.audios || (AG.audio ? [AG.audio] : []);
  if (AUD.some(a => a.busy)) { toast('Подождите, слова из аудио ещё распознаются'); return; }
  if (!text && !AG.att.length && !AUD.length) return;
  if (!AG.status?.installed) { toast('Сначала скачайте модель сценариста: раздел «Сценарист», строчка «Модель сценариста»'); return; }
  if (AUD.length) {
    text += '\n\n[Аудио в проекте: ' + AUD.length + '. Нумерация тегов: <Audio 1> - фон всего ролика, у сцены '
      + 'свои номера десятками: сцена 1 - <Audio 10>, <Audio 11>, <Audio 12>, сцена 2 - <Audio 20> и т.д. '
      + 'Аудио применяется там, где его тег назван в тексте сцены; без тега в этой сцене звук делает модель. '
      + 'Сколько можно: фон - один файл на весь ролик, в сцене - не больше трёх аудио.]';
    AUD.forEach((au, i) => {
      text += `\n[Аудио ${i + 1}: ${au.name}, ${au.dur.toFixed(1)} с` + (au.where ? `, ${au.where}` : '') + '. ' + (au.text.trim()
        ? `Слова из аудио${au.langName ? ` (язык: ${au.langName})` : ''}: «${au.text.trim()}»]` : 'Слов в аудио нет (музыка или голос не распознан).]');
    });
    text = text.trim();
  }
  const pics = AG.att.filter(a => !a.frame), frs = AG.att.filter(a => a.frame);   // frames go last, so Picture 1, 2… stay the heroes
  const byVid = [];
  frs.forEach(a => { const g = byVid.find(x => x.name === a.vname); if (g) g.at.push(a); else byVid.push({ name: a.vname, dur: a.vdur, at: [a], file: a.vfile }); });
  if (frs.length) {
    const desc = byVid.map((g, i) => '«' + g.name + '», ' + (g.dur ? g.dur.toFixed(1) + ' с' : 'длительность неизвестна') + ' (это <Video ' + (i + 1) + '>), ' + (g.at.length === 1 ? 'кадр в момент ' : 'кадры в моменты ') + g.at.map(a => a.label).join(', ')).join('; ');
    text += '\n\n[К сообщению ' + (frs.length === 1 ? 'приложен ' + desc : 'приложены последние ' + frs.length + ' изображений — это кадры '
      + (byVid.length > 1 ? 'из ' + byVid.length + ' видео' : 'одного видео') + ': ' + desc)
      + '. Это ' + (frs.length === 1 ? 'кадр' : 'кадры') + ' ' + (byVid.length > 1 ? 'исходных видео' : 'исходного видео')
        + ', а не ' + (frs.length === 1 ? 'изображение героя' : 'изображения героев') + ': в Picture N '
        + (frs.length === 1 ? 'он не входит' : 'они не входят') + '.]';
    text = text.trim();
  }
  // the files themselves travel with the message: a section takes the video, not its frames
  AG.msgs.push({ role: 'user', content: text, images: [...pics, ...frs].map(a => a.url), files: pics.map(a => a.file), nframes: frs.length, videos: byVid.map(g => g.file).filter(Boolean), videoFile: byVid[0]?.file || null, vimg: frs[0]?.url || null, vname: byVid[0]?.name || '', vdur: byVid[0]?.dur ? byVid[0].dur.toFixed(1) : '', audioFile: AUD[0]?.file });
  // the tray keeps the pictures and the video on purpose: the next question often needs the same hero
  $('#agIn').value = ''; AG.audio = null;
  // the songs stay in the chat, the same way the pictures stay in the tray: the next question needs
  // the same voice, and a list that vanished at every send made «Все тексты к сценаристу» lose the music
  showAudioBox();
  const reply = { role: 'assistant', content: '', status: 'Отправляем…', edit: AG.edit, to: AG.target };   // перенос в раздел потом поступит по тому же смыслу
  AG.msgs.push(reply); renderMsgs();
  const el = $('#agMsgs .msg:last-child');
  AG.busy = true; $('#agSend').textContent = 'Стоп'; AG.ctrl = new AbortController();
  // «Правка картинки» делается и на Qwen, и на FLUX klein, а теги картинок у них разные: сценаристу нужен движок раздела
  const qwBtn = $('.qw-eng button.on', $('#view-qwen'));
  const ctx = { cont: AG.target === 'long' && (AG.att.some(a => a.frame) || !!RM.long.root._src) ? 1 : 0, model: AG.target === 'qwen' ? ((qwBtn && qwBtn.dataset.e) || 'qwen') : (AG.storyFrames && AG.storyModel === 'krea' ? 'flux' : AG.storyModel), frames: AG.target === 'story' && AG.storyFrames, duration: AG_IMG.includes(AG.target) ? null : AG.target === 'video' ? V.dur : AG.target === 'lipsync' ? (L.dur0 ? L.len() : null) : RM[AG.target].S.dur };
  if (AG.target === 'actor') ctx.voice = RM.actor.voice() ? 1 : 0;
  if (AG.target === 'long') { const lr = RM.long.root; ctx.long = { sound: lr._snd, secs: $$('.sc input[type=range]', RM.long.root).map(r => +r.value),
      music: lr._snd === 'own' ? { loop: lr._loop !== false, sec: Math.round((lr._adur || 0) * 10) / 10 } : null,
      // the songs of the scenes are told apart from the model's own sound: without this the agent was
      // told "there is no audio of yours", wrote non_diegetic_music: N/A and left the lyrics out
      scene_audios: $$('.sc', lr).map((c, i) => {
        const bs = c._baseFixed || 10 * (i + 1);
        const items = (c._auds || []).map((f, j) => { const words = agWordsFor(c, j); if (!f || !words) return null; const base = agWords(f, i + 1) || {}; return Object.assign({ tag: '<Audio ' + (bs + j) + '>', name: f.name, sec: Math.round(base.sec || 0), lang: base.lang || '' }, { words }); }).filter(Boolean);
        return items.length ? { scene: i + 1, audios: items } : null;
      }).filter(Boolean) }; }
  try {
    const r = await fetch('/api/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AG.ctrl.signal,
      body: JSON.stringify({ target: AG.target, ctx, think: AG.think, editing: AG.edit, messages: AG.msgs.slice(0, -1).map(m => ({ role: m.role, content: m.content, images: m.images, frames: m.nframes || 0 })) }),
    });
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'status') reply.status = ev.text;
        else if (ev.type === 'skills') reply.skills = ev.names;
        else if (ev.type === 'delta') reply.content += ev.text;
        else if (ev.type === 'error') reply.error = ev.message;
        renderAssistant(el, reply); $('#agMsgs').scrollTop = 1e9;
      }
    }
  } catch (e) { if (e.name !== 'AbortError') reply.error = e.message; }
  AG.busy = false; $('#agSend').textContent = 'Создать промт'; reply.status = null;
  if (!reply.content && !reply.error) reply.error = 'Остановлено';
  renderAssistant(el, reply); agStatus(); saveChat();
}
$('#agSend').onclick = agSend;

/* chat history */
export async function saveChat() {
  if (!API || !AG.msgs.length) return;
  AG.id = AG.id || Math.random().toString(36).slice(2, 14).replace(/[^a-z0-9]/g, 'x');
  /* Лоток и песни сцен лежат рядом с чатом. Раньше в чат писался только текст с
     уменьшенными показами картинок: возвращённая переписка выглядела целой, но файлов
     у неё не было, и кнопка переноса в раздел не могла положить фото в свою сцену.
     Файлы пишутся целиком, поэтому вернувшаяся картинка остаётся того же качества. */
  const raw = f => new Promise(res => {
    try {
      if (!f) return res('');
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => res('');
      fr.readAsDataURL(f);
    } catch (e) { res(''); }
  });
  const att = [];
  for (const a of (AG.att || [])) {
    if (!a) continue;
    if (a.__u === undefined) a.__u = a.file ? await raw(a.file) : '';
    const du = a.__u || a.url || '';
    if (!du) continue;
    att.push({ url: du, note: a.note || '', frame: !!a.frame, label: a.label || '', vname: a.vname || '', name: (a.file && a.file.name) || '', kind: (a.file && a.file.type) || '' });
  }
  const auds = [];
  for (const a of (AG.audios || [])) {
    if (!a) continue;
    if (a.__u === undefined) a.__u = a.file ? await raw(a.file) : '';
    if (!a.__u) continue;
    auds.push({ url: a.__u, name: a.name || '', dur: a.dur || 0, where: a.where || '', text: a.text || '', lang: a.lang || '', langName: a.langName || '' });
  }
  await fetch(`/api/agent/chats/${AG.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: AG.target, messages: AG.msgs.map(({ files, status, audioFile, ...m }) => m), att, auds }) });
  loadChats();
}
export async function loadChats() {
  if (!API) return;
  const list = await (await fetch('/api/agent/chats')).json();
  $('#agHist').innerHTML = list.length ? list.map(c => `<div class="ag-h${c.id === AG.id ? ' on' : ''}" data-id="${c.id}">
      <div><b title="${esc(c.title)}">${esc(c.title)}</b><small>${fmtShort(c.updated)}</small></div>
      <button title="Удалить чат">✕</button></div>`).join('')
    : '<div class="ag-hempty">Здесь будут ваши переписки с сценаристом</div>';
}
export function newChat() {
  if (AG.busy) AG.ctrl?.abort();
  AG.id = null; AG.msgs = []; AG.att = []; AG.audios = []; AG.audio = null; AG.draft = null;
  $('#agIn').value = '';   // в новом чате пусто всё, и начатый текст старого там оставаться не должен
  renderAtt(); showAudioBox(); renderMsgs(); agCtx(); loadChats(); $('#agIn').focus();
}
export async function openChat(id) {
  if (AG.busy) AG.ctrl?.abort();
  const c = await (await fetch(`/api/agent/chats/${id}`)).json();
  AG.id = id; AG.msgs = c.messages || [];
  AG.att = [];
  for (const a of (c.att || [])) {
    if (!a || !a.url) continue;
    let f = null;
    try { f = window.dataUrlToFile(a.url, a.name || 'картинка', a.kind || 'image/png'); } catch (e) { continue; }
    AG.att.push({ file: f, url: a.url, note: a.note || '', frame: !!a.frame, label: a.label || '', vname: a.vname || '', __u: a.url });
  }
  AG.audios = [];
  for (const a of (c.auds || [])) {
    if (!a || !a.url) continue;
    let f = null;
    try { f = window.dataUrlToFile(a.url, a.name || 'аудио', 'audio/wav'); } catch (e) { continue; }
    AG.audios.push({ name: a.name || 'аудио', dur: +a.dur || 0, where: a.where || '', text: a.text || '', lang: a.lang || '', langName: a.langName || '', file: f, busy: false, __u: a.url });
  }
  const tgOf = s => { const m = /<\s*Audio\s*(\d+)\s*>/i.exec(s || ''); return m ? +m[1] : 0; };
  const lastPerTag = new Set();
  for (let x = AG.audios.length - 1; x >= 0; x--) {
    const t = tgOf(AG.audios[x].where);
    if (!t || !lastPerTag.has(t)) { if (t) lastPerTag.add(t); continue; }
    AG.audios.splice(x, 1);   // в старых чатах под одним тегом лежало по два-четыре исполнения
  }
  AG.audio = AG.audios[0] || null;
  renderAtt(); showAudioBox();
  const b = $(`#agTarget button[data-t="${c.target}"], #agTarget2 button[data-t="${c.target}"]`); if (b) b.click();
  renderMsgs(); agCtx(); loadChats();
  if (AG.att.length || AG.audios.length) toast('В чат вернулись его файлы: картинок ' + AG.att.length + ', аудио ' + AG.audios.length);
  else if ((AG.msgs || []).length && !(c.att || []).length && !(c.auds || []).length) toast('В этом чате файлы не сохранялись: они лежат только в тексте');
}
/* "Правка" or "Продолжить сюжет": a fix replaces what was written, a continuation remembers the whole chat */
/* в режимах со списком «продолжить» реально что-то добавляет, и переключатель называется по-месту */
export const EDIT_LABELS = {
  long: { btn: ['Правка сцен', 'Добавить сцены'], on: 'Перепишет весь список сцен, заменив нужное; готовые не тронет', off: 'Оставит готовые сцены и допишет новые после них' },
  plist: { btn: ['Правка списка', 'Добавить пункты'], on: 'Вернёт весь список с исправленным пунктом', off: 'Оставит готовые пункты и допишет новые' },
  story: { btn: ['Правка', 'Добавить кадры'], on: 'Вернёт все строки с правкой', off: 'Оставит прежние кадры и добавит новые' },
};
export const EDIT_DEFAULT = { btn: ['Правка', 'Новый промпт'], on: 'Вернёт весь промпт с заменой; «Picture 1, 2…» — картинки этого сообщения', off: 'Напишет новый промпт, помня персонажей, свет и стиль из чата' };
export function agEditLabels() {
  const l = (AG.target === 'story' && !AG.storyFrames) ? EDIT_DEFAULT : (EDIT_LABELS[AG.target] || EDIT_DEFAULT);
  $$('#agEdit button').forEach((b, i) => { b.textContent = l.btn[i]; });
  $('#agEditHint').textContent = AG.edit ? l.on : l.off;
}
$('#agEdit').onclick = e => {
  const b = e.target.closest('button[data-edit]'); if (!b) return;
  AG.edit = b.dataset.edit === '1';
  $$('#agEdit button').forEach(x => x.classList.toggle('on', x === b));
  agEditLabels();
  agCtx();
};
$('#agHist').addEventListener('click', e => {
  const row = e.target.closest('.ag-h'); if (!row) return;
  if (e.target.closest('button')) {
    confirmBox('Удалить чат?', `«${$('b', row).textContent}» будет удалён без возможности восстановления.`, 'Удалить', async () => {
      await fetch(`/api/agent/chats/${row.dataset.id}`, { method: 'DELETE' });
      if (row.dataset.id === AG.id) newChat(); else loadChats();
      toast('Чат удалён');
    });
    return;
  }
  openChat(row.dataset.id);
});
$('#agWipe').onclick = () => confirmBox('Очистить всю историю?', 'Все переписки с сценаристом будут удалены, восстановить нельзя. Видео и картинки в Библиотеке останутся.', 'Очистить', async () => {
  await fetch('/api/agent/chats', { method: 'DELETE' }); newChat(); toast('История очищена');
});
  $('#agNew2').onclick = newChat;
export let SP_MENU = null;
export const spClose = () => { if (SP_MENU) { SP_MENU.remove(); SP_MENU = null; } };
export const spItem = (menu, html, fn, note, disabled) => {
  const b = document.createElement('button'); b.type = 'button';
  b.innerHTML = html + (note ? '<small>' + note + '</small>' : '');
  if (disabled) b.disabled = true; else b.onclick = () => { spClose(); fn(); };
  menu.append(b); return b;
};
export const spWordAround = (v, pos) => {
  const isCh = ch => /[A-Za-zА-Яа-яЁё'\u2019\u0451\u0401-]/.test(ch);
  let a = pos, b = pos;
  while (a > 0 && isCh(v[a - 1])) a--;
  while (b < v.length && isCh(v[b])) b++;
  return { a, b, word: v.slice(a, b) };
};
/* Меню по правой кнопке обязано помещаться в окне программы целиком. Раньше его граница
   считалась по координатам мыши напрямую, но интерфейс живёт с масштабом UI_Z.ui:
   координаты мыши и координаты разметки различаются в этот раз, и при увеличенном
   интерфейсе меню уезжало за нижний край. Ставилось оно строго вниз от курсора, хотя
   под курсором места могло не быть вовсе. Теперь позиция считается в координатах
   разметки, при нехватке места внизу меню встаёт вверх от курсора, а когда меню
   вырастает (подоспели варианты слов) - пересчитывается само. */
window.menuZoom = () => {
  // масштаб интерфейса задаётся свойством zoom у корня; переменная UI_Z живёт в области
  // видимости скрипта и в window её нет, поэтому надежнее один раз измерить фактический
  // размер: стопиксельная планка показывает, во сколько раз пикселы разметки крупнее
  try {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:8px;visibility:hidden;pointer-events:none';
    document.body.append(t);
    const got = (t.getBoundingClientRect().width || 100) / 100;
    t.remove();
    if (got > 0.2) return got;
  } catch (e) { }
  try { return (typeof UI_Z !== 'undefined' && +UI_Z.ui) || 1; } catch (e) { return 1; }
};
window.placeAtCursor = (el, x, y) => {
  if (x != null) { el.__x = x; el.__y = y; }
  const z = window.menuZoom();
  const W = (window.innerWidth || 1200) / z, H = (window.innerHeight || 800) / z;
  const cx = (+el.__x || 0) / z, cy = (+el.__y || 0) / z;
  const wid = el.offsetWidth || 240;
  el.style.maxHeight = Math.max(120, H - 12) + 'px';   // длинное меню прокручивается внутри, а не растёт за край
  const hei = Math.min(el.offsetHeight || 170, H - 12);
  let ly = cy + 2;                                     // вниз от курсора, как привычно
  if (ly + hei + 8 > H) ly = Math.max(4, Math.min(cy - hei - 6, H - hei - 8));
  el.style.left = Math.max(4, Math.min(cx, W - wid - 6)) + 'px';
  el.style.top = Math.max(4, ly) + 'px';
};
window.watchMenu = el => {
  const again = () => { try { window.placeAtCursor(el); } catch (e) { } };
  try { new ResizeObserver(again).observe(el); } catch (e) { }
  // варианты слов приходят ответом модели: меню меняется и до того, как наблюдатель успевает
  [60, 260, 700, 1400].forEach(ms => setTimeout(again, ms));
};

document.addEventListener('contextmenu', e => {
  const ta = e.target.closest && e.target.closest('textarea');
  if (!ta || ta.getAttribute('spellcheck') === 'false' || ta.disabled) return;
  e.preventDefault(); spClose();
  document.querySelectorAll('.ctxm').forEach(x => x.remove());   // старое меню не должно остаться под новым
  const v = ta.value, pos = ta.selectionStart == null ? v.length : ta.selectionStart;
  const cur = spWordAround(v, pos);
  const menu = document.createElement('div'); menu.className = 'sp-menu'; SP_MENU = menu;   // without this the menu cannot be closed
  const head = document.createElement('div'); head.className = 'sp-head';
  head.textContent = cur.word ? 'Слово: ' + cur.word : 'Орфография';
  menu.append(head);
  if (cur.word.length > 2) {
    const waiting = spItem(menu, 'Подбираю варианты…', null, 'локальная модель', true);
    postJSON('/api/agent/spell', {
      word: cur.word,
      text: v.slice(Math.max(0, cur.a - 140), Math.min(v.length, cur.b + 140)),
    }).then(j => {
      waiting.remove();
      const list = (j.variants || []).filter(Boolean);
      if (!list.length) { spItem(menu, j.clean ? 'Написание верное' : 'Вариантов нет', null, '', true); return; }
      list.forEach(c => spItem(menu, 'Заменить на <b>' + c.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch])) + '</b>', () => {
        ta.focus(); ta.setSelectionRange(cur.a, cur.b);
        if (!document.execCommand('insertText', false, c)) { ta.value = v.slice(0, cur.a) + c + v.slice(cur.b); }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (ta._undo == null) ta._undo = [];
      }, 'модель'));
    }).catch(err => { waiting.remove(); spItem(menu, 'Модель не ответила', null, (err && err.message || '').slice(0, 28), true); });
  }
  spItem(menu, 'Поправить весь текст', () => {
    const whole = ta.value;
    if (!whole.trim()) { toast('Поле пустое'); return; }
    toast('Читаю текст и правлю написания…');
    postJSON('/api/agent/spell', { text: whole }).then(j => {
      const fixed = (j.text || '').trim();
      if (!fixed) { toast(j.error || 'Модель не ответила'); return; }
      if (fixed === whole.trim()) { toast('Ошибок написания модель не нашла'); return; }
      ta.focus(); ta.select();
      if (!document.execCommand('insertText', false, fixed)) ta.value = fixed;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      toast('Написание поправлено: текст заменён целиком');
    }).catch(err => toast('Не вышло: ' + (err && err.message || err)));
  }, 'всем текстом');
  const sep = document.createElement('i'); sep.className = 'sp-sep'; menu.append(sep);
  const sel = () => ta.value.slice(ta.selectionStart, ta.selectionEnd);
  spItem(menu, 'Вырезать', () => { const t = sel(); if (t) { copyText(t); ta.setRangeText('', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); } });
  spItem(menu, 'Скопировать', () => { const t = sel() || ta.value; if (t) copyText(t, 'Скопировано'); });
  spItem(menu, 'Вставить', async () => {
    try {
      const t = await (navigator.clipboard?.readText() || Promise.resolve(''));
      if (!t) { toast('Буфер обмена пуст или недоступен'); return; }
      ta.focus();
      if (!document.execCommand('insertText', false, t)) ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) { toast('Буфер обмена недоступен: разрешите его в Windows'); }
  });
  spItem(menu, 'Выделить всё', () => { ta.focus(); ta.select(); });
  document.body.append(menu);
  window.placeAtCursor(menu, e.clientX, e.clientY);
  window.watchMenu(menu);   // варианты слов доходят позже и меню растёт в длину
});
document.addEventListener('pointerdown', e => { if (SP_MENU && !SP_MENU.contains(e.target)) spClose(); }, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') spClose(); });
window.addEventListener('blur', spClose);

// the finished prompt can be edited in place; the edit is kept when the chat is redrawn
$('#agMsgs').addEventListener('input', e => {
  const pre = e.target.closest?.('pre[data-b]'); if (!pre) return;
  const m = AG.msgs[+pre.closest('.msg')?.dataset.i];
  if (m) { (m.edits = m.edits || {})[pre.dataset.b] = pre.textContent; }
  const n = $('.pb-n', pre.closest('.pblock')); if (n) n.textContent = pre.textContent.length + ' симв.';
});
$('#agMsgs').addEventListener('mousedown', e => { if (e.target.closest('[data-paste]')) e.preventDefault(); });  // keep the selection in the prompt
$('#agMsgs').addEventListener('click', async e => {
  const blk = e.target.closest('.pblock'); if (!blk) return;
  if (e.target.closest('[data-paste]')) {
    const pre = $('pre', blk), t = await clipText();
    if (!t) { toast('Буфер обмена пуст: сначала скопируйте текст'); return; }
    const sel = getSelection();
    if (!sel.rangeCount || !pre.contains(sel.anchorNode)) { const r = document.createRange(); r.selectNodeContents(pre); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    pre.focus();
    if (!document.execCommand('insertText', false, t)) { pre.textContent += t; }
    pre.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (e.target.closest('[data-copy-ru]')) {
    const m = AG.msgs[+blk.closest('.msg')?.dataset.i], t = m?.ru?.[$('pre', blk).dataset.b];
    if (t) { copyText(t, 'Русский текст скопирован'); }
    return;
  }
  const ruBtn = e.target.closest('[data-ru]');
  if (ruBtn) {
    const pre = $('pre', blk), m = AG.msgs[+blk.closest('.msg')?.dataset.i], bi = pre.dataset.b;
    if (!m) return;
    if (m.ru?.[bi]) { delete m.ru[bi]; renderAssistant(blk.closest('.msg'), m); return; }   // second click hides it
    ruBtn.disabled = true; ruBtn.textContent = 'Переводим… (первый раз до минуты)';
    try {
      const r = await postJSON('/api/agent/translate', { text: pre.textContent });
      (m.ru = m.ru || {})[bi] = r.text || '(пустой ответ)';
    } catch (err) { toast(err.message); }
    renderAssistant(blk.closest('.msg'), m); return;
  }
  if (e.target.closest('[data-copy]')) { copyText($('pre', blk).textContent, 'Промпт скопирован'); return; }
  const to = e.target.closest('[data-send]')?.dataset.send;
  /* Режим, у которого есть окно «Сценарий», получает текст в это окно: человек остаётся
     хозяином своих картинок и песен и привязывает их там же. Остальные цели идут прежним
     путём, который заодно раскладывает по полкам файлы ответа. */
  if (to) { if (scenarioWindowOf(to)) putScenario(to, $('pre', blk).textContent); else sendPrompt(blk, to); }
});
$('#agMsgs').addEventListener('change', e => {
  const s = e.target.closest('.pb-other'); if (s && s.value) { sendPrompt(s.closest('.pblock'), s.value); s.value = ''; }
});

export async function clipText() {
  try { const t = await navigator.clipboard.readText(); if (t) return t; } catch {}
  try { return (await (await fetch('/api/clipboard', { method: 'POST' })).json()).text || ''; } catch { return ''; }
}
$('#agClear').onclick = () => { const ta = $('#agIn'); ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); };
  /* The context size is a choice between "everything fits" and "the card has room to breathe", so
     it is the person's dial, not a hidden constant. Changing it unloads the model: the next request
     pays the loading time once, and a long dialogue stops dying with a 400 error. */
  const CTX = [16384, 32768, 49152, 65536, 98304, 131072, 196608];
  const selCtx = $('#agCtxSel');
  if (selCtx && !selCtx._filled) {
    selCtx._filled = 1;
    selCtx.innerHTML = CTX.map(v => `<option value="${v}">${(v / 1024).toFixed(0)} тысяч</option>`).join('');
  const ctxLast = window._ctxLast || (AG.status && AG.status.ctx);
  if (ctxLast) selCtx.value = String(ctxLast);
    selCtx.onchange = async () => {
      try {
        const r = await postJSON('/api/agent/ctx', { ctx: +selCtx.value });
        toast(`Контекст ${r.ctx} токенов (это ${(r.ctx / 1024).toFixed(0)} тысяч). Модель выгружена: следующий запрос поднимет её с новым размером.` + (r.ctx >= 98304 ? ' Большой контекст ест память: генерация может идти медленнее.' : ''));
        agStatus();
      } catch (e) { toast('Не вышло: ' + (e && e.message ? e.message : e)); agStatus(); }
    };
  }
  /* Освобождение памяти - одно на все кнопки: в Сценаристе, в шапке предпросмотра студии и в
     панели Нагрузки, откуда оно видно в любом разделе. Три копии одного запроса и трёх
     разных объяснений - это три шанса соврать; теперь объяснение одно. */
  window.kadrFreeMem = async (btn) => {
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Освобождаю…';
    try {
      const r = await (await fetch('/api/comfy/free', { method: 'POST' })).json();
      toast(r && r.error ? ('Не вышло: ' + r.error)
        : ('Освободил модель сценариста и кэш ComfyUI' + (r && r.used != null ? ' · занято осталось ' + r.used + ' ГБ' : '')));
    } catch (e) { toast('Не вышло: ' + (e && e.message ? e.message : e)); }
    btn.disabled = false; btn.textContent = was;
    try { if (typeof agStatus === 'function') agStatus(); } catch (e) { }
  };
  [['#freeMemBtn', 'fm'], ['#agFreeMem', 'fmA']].forEach(pair => {
    const btn = $(pair[0]);
    if (btn && !btn._wired) { btn._wired = 1; btn.onclick = () => window.kadrFreeMem(btn); }
  });


// right-click menu: copy / cut / paste / select all in every text field, copy on any selectable text
(() => {
  let menu = null;
  const close = () => { menu?.remove(); menu = null; };
  const isField = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|url|number|password|email|)$/.test(el.type)));
  document.addEventListener('contextmenu', e => {
    const f = isField(e.target) ? e.target : null;
    const selText = String(getSelection());
    const inMsg = e.target.closest?.('.msg, .pblock');
    /* Поля, где пишут текст, обслуживает меню с проверкой написания: оно умеет то же самое плюс
       варианты слова. Два меню поверх одного слова - вот этот старый, меньший: для таких полей
       он молчит. Полям без проверки (поле слов песни) и сообщениям остаётся он. */
    if (f && f.tagName === 'TEXTAREA' && f.getAttribute('spellcheck') !== 'false' && !f.disabled) return;
    if (!f && !inMsg && !selText) return;
    e.preventDefault(); close();
    const has = f ? f.selectionStart !== f.selectionEnd : !!selText;
    const items = [['Копировать', !has, async () => {
      const t = f ? f.value.slice(f.selectionStart, f.selectionEnd) : selText;
      try { await navigator.clipboard.writeText(t); toast('Скопировано'); } catch { copyText(t, 'Скопировано'); }
    }]];
    if (!f && inMsg) {
      const blk = e.target.closest('.pblock');
      const whole = (blk ? $('pre', blk) : e.target.closest('.msg'))?.innerText || '';
      items.push([blk ? 'Копировать весь промпт' : 'Копировать всё сообщение', !whole, async () => {
        try { await navigator.clipboard.writeText(whole); toast('Скопировано'); } catch { copyText(whole, 'Скопировано'); }
      }]);
    }
    const ed = !f && e.target.closest?.('pre[data-b]');
    if (ed) {
      items.push(['Вырезать', !has, async () => {
        try { await navigator.clipboard.writeText(selText); } catch { copyText(selText); }
        ed.focus(); document.execCommand('delete');
      }]);
      items.push(['Вставить', false, async () => {
        const t = await clipText(); if (!t) { toast('Буфер обмена пуст'); return; }
        ed.focus(); document.execCommand('insertText', false, t);
      }]);
      items.push(['Выделить всё', false, () => { ed.focus(); getSelection().selectAllChildren(ed); }]);
    }
    if (f) {
      const ro = f.readOnly || f.disabled;
      items.push(['Вырезать', !has || ro, async () => {
        try { await navigator.clipboard.writeText(f.value.slice(f.selectionStart, f.selectionEnd)); } catch { copyText(f.value.slice(f.selectionStart, f.selectionEnd)); }
        f.focus(); document.execCommand('delete');
      }]);
      items.push(['Вставить', ro, async () => {
        f.focus();
        try {
          const t = await clipText();
          if (!document.execCommand('insertText', false, t)) {
            const s = f.selectionStart; f.value = f.value.slice(0, s) + t + f.value.slice(f.selectionEnd);
            f.selectionStart = f.selectionEnd = s + t.length; f.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } catch { toast('Не получилось вставить кнопкой — нажмите Ctrl+V'); }
      }]);
      items.push(['Выделить всё', false, () => { f.focus(); f.select(); }]);
    }
    menu = document.createElement('div'); menu.className = 'ctxm';
    items.forEach(([label, off, fn]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.disabled = !!off;
      b.onmousedown = ev => ev.preventDefault();  // keep the selection / focus of the field
      b.onclick = () => { close(); fn(); };
      menu.append(b);
    });
    document.body.append(menu);
    window.placeAtCursor(menu, e.clientX, e.clientY);
    window.watchMenu(menu);
  });
  addEventListener('mousedown', e => { if (menu && !menu.contains(e.target)) close(); }, true);
  addEventListener('blur', close); addEventListener('scroll', close, true); addEventListener('resize', close);
  addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();

// model status / download
export async function agStatus() {
  if (!API) return;
  const s = AG.status = await (await fetch('/api/agent/status')).json();
  const st = s.installing ? ['weak', 'скачивается'] : !s.installed ? ['unsupported', 'не скачана'] : s.running ? ['ok', 'в памяти'] : ['ok', 'готова'];
  $('#agState').className = 'verdict ' + st[0]; $('#agState').textContent = st[1];
  const big = $('#agBig'), curName = s.custom ? s.title : ((s.variants || []).find(o => o.current) || {}).title || s.title;
  big.className = 'agbig ' + (s.installing ? 'wait' : s.installed ? 'ok' : 'bad');
  const curVar = (s.variants || []).find(o => o.current);
  const light = s.custom ? 'своя модель' : curVar ? (/лёгк|e4b|light|mini|small/i.test(curVar.title || '') ? 'облегчённая' : 'полная') : '—';
  const cenz = s.custom ? 'по файлу вашей модели' : curVar ? (curVar.uncensored ? 'нет (без цензуры)' : 'есть') : '—';
  big.innerHTML = `<div class="h">Подключенная модель сценариста</div>
    <div class="r"><span>Модель</span><b>${esc(curName || '—')}</b></div>
    <div class="r"><span>Исполнение</span><b>${light}</b></div>
    <div class="r"><span>Цензура</span><b>${cenz}</b></div>
    <div class="t">${s.installing ? '⏳ Скачивается…' : s.installed ? '✓ Скачана' + (s.running ? ', работает сейчас' : ', запустится, когда понадобится') : '✗ Не скачана — нажмите «Скачать» ниже'}</div>`;
  $('#agModel').innerHTML = s.custom
    ? `<b style="color:var(--text)">${esc(s.title)}</b> — ваша модель<br><span style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(s.custom.model)}</span><br>`
      + (s.vision ? 'Изображения видит (найден mmproj). ' : '<span class="warn-t">Файла mmproj нет — изображения сценарист не увидит.</span> ')
      + (s.installed ? '' : 'Осталось скачать движок llama.cpp (37 МБ).')
    : `<b style="color:var(--text)">${esc(s.title)}</b> — бесплатная локальная модель (Apache 2.0), понимает русский и изображения. `
      + (s.installed ? 'Пока сценарист работает, генерация видео ждёт: обе модели вместе не помещаются в видеопамять — приложение переключает их само.' : `Нужно скачать один раз: ~${(s.size / 1e9).toFixed(1)} ГБ.`);
  const nReady = (s.variants || []).filter(o => o.have).length + (s.my_model ? 1 : 0);
  $('#agVarBox > summary').textContent = `Выбор моделей сценариста (скачано: ${nReady} из ${(s.variants || []).length + (s.my_model ? 1 : 0)})`;
  $('#agVariants').innerHTML = (s.my_model ? `<button class="agv${s.my_model.current ? ' on' : ''}" type="button" data-my="1"><b>Моя модель: ${esc(s.my_model.title)}</b><span class="tg">ваша</span><span class="rd ok">✓ скачано${s.my_model.current ? ' · выбрана' : ''}</span></button>` : '')
    + (s.variants || []).map(o => `<button class="agv${o.current ? ' on' : ''}" type="button" data-v="${o.key}"><b>${esc(o.title)}</b>`
      + `<span class="tg${o.uncensored ? ' unc' : ''}">${o.uncensored ? 'без цензуры' : 'обычная'}</span>`
      + `<span class="rd ${o.have ? 'ok' : 'no'}">${o.have ? '✓ скачано' : `Нужно скачать · ${(o.size / 1e9).toFixed(1)} ГБ`}${o.current ? ' · ВЫБРАНА' : ''}</span>`
      + (o.min_vram && !o.fits ? `<small>⚠ нужно от ${o.min_vram} ГБ видеопамяти: у вас может быть медленно</small>` : '') + `</button>`).join('')
    + ((s.variants || []).some(o => o.current && o.uncensored) ? `<div class="hint" style="margin-top:8px">Эта модель не отказывается писать любые описания. Вы отвечаете за содержание: не используйте её для запрещённого и для людей без их согласия. Сам MiniMax H3 часть запросов всё равно может отклонить.</div>` : '');
  const cs = $('#agCtxSel');
  if (cs && s.ctx) {
    if (!Array.prototype.some.call(cs.options, o => +o.value === +s.ctx)) cs.insertAdjacentHTML('beforeend', '<option value="' + s.ctx + '">' + (s.ctx / 1024).toFixed(0) + ' тысяч</option>');
    cs.value = String(s.ctx); window._ctxLast = s.ctx;   // список перелистовывается позже: без этого он стартует с первого значения
  }
  const needModel = !s.installed;
  $('#agInstall').hidden = s.installing || (s.custom && !s.has_model) || (!needModel && s.speech_ready);
  $('#agInstall').textContent = !needModel ? `Докачать распознавание речи (~${Math.round(s.speech_size / 1e6)} МБ)`
    : s.custom ? 'Скачать движок llama.cpp (37 МБ) и распознавание речи' : `Скачать модель (~${((s.size + s.speech_size) / 1e9).toFixed(1)} ГБ, вместе с распознаванием речи)`;
  $('#agFromLip').hidden = !L.dur0;
  const sp = s.speech || {};
  $('#agWhReset').hidden = !sp.custom;
  if (sp.custom && !$('#agWhDir').value) $('#agWhDir').value = sp.custom;
  $('#agWhInfo').innerHTML = sp.ready
    ? `<span class="ok-t">✓ Программа и модель найдены${sp.model ? ': ' + esc(sp.model) : ''}</span>`
    : sp.custom ? `<span class="warn-t">Не найдено: ${esc(sp.missing.join(', '))} — откройте строчку «Модель сценариста» выше и нажмите «Докачать», скачается только это.</span>` : '';
  /* Which recognition file is in use decides whether a song's words come out sense or nonsense:
     the little model mangles singing. The program always takes the best file it can see, so the
     button below only has to bring that file here - switching happens by itself. */
  const bt = sp.better || {};
  if (sp.model) {
    $('#agWhInfo').innerHTML += '<br><span class="hint" style="font-size:12px">Файл '
      + (sp.model_size ? Math.round(sp.model_size / 1048576) + ' МБ' : 'неизвестного размера')
      + (bt.present ? ' · это точная модель: она разбирает пение' : ' · модель маленькая: песни она слышит плохо') + '</span>';
  }
  if (!bt.present && !bt.custom) {
    $('#agWhInfo').innerHTML += '<br><button class="btn mini" type="button" id="agWhBetter" style="margin-top:6px" title="'
      + 'Скачать ggml-large-v3-turbo-q5_0.bin: он разбирает пение там, где маленькая модель придумывает слова' + '">Скачать точную модель распознавания (~'
      + Math.round((bt.size || 0) / 1048576) + ' МБ)</button>';
  } else if (!bt.present && bt.custom) {
    $('#agWhInfo').innerHTML += '<br><span class="hint" style="font-size:12px">Вы подключили свою папку whisper: чтобы слышать точнее, положите ggml-large-v3-turbo-q5_0.bin в неё - программа возьмёт лучший файл сама.</span>';
  }
  /* A person looking for this goes to the settings page, and nobody unfolds a fold to find out
     what is already working: so the file name sits in the fold's own line, and the full sentence
     lives on the settings page under the version. */
  $('#agWhich').textContent = curName || 'не скачана';   // the name in the line, not only inside
  const absp = $('#abSpeech');
  if (absp) absp.textContent = sp.ready
    ? 'Распознавание речи (им читаются слова песен): ' + (sp.model || '?') + (sp.model_size ? ' · ' + Math.round(sp.model_size / 1048576) + ' МБ' : '')
      + (bt.present ? ' · точная модель, она разбирает пение' : ' · модель маленькая: песни слышит плохо')
      + '. Выбрать другую или докачать - раздел «Сценарист», строчка «Модель сценариста».'
    : 'Распознавание речи не скачано: раздел «Сценарист», строчка «Модель сценариста», кнопка «Докачать».';
  const bb = $('#agWhBetter');
  if (bb) bb.onclick = async () => {
    bb.disabled = true; bb.textContent = 'Скачиваю… полоса сверху карточки';
    try {
      const r = await postJSON('/api/speech/model', {});
      toast('Начали: ' + r.name + ' · ' + Math.round((r.size || 0) / 1048576) + ' МБ. Как только файл ляжет в папку, программа сама перейдёт на него.');
    } catch (e) { toast('Не вышло: ' + (e && e.message ? e.message : e)); bb.disabled = false; bb.textContent = 'Скачать точную модель распознавания'; }
  };
  $('#agModel').insertAdjacentHTML('beforeend', s.speech_ready
    ? '<br><span class="ok-t">✓ Распознавание речи готово: можно приложить аудио и говорить в микрофон.</span>'
    : '<br><span class="warn-t">Распознавание речи не скачано: без него нельзя приложить аудио и говорить голосом.</span>');
  $('#agOwnReset').hidden = !s.custom;
  // own ComfyUI: the folder is always shown before a download, so it can be changed; an empty field keeps the current one
  $('#agDirWrap').hidden = s.managed || s.installed || s.installing;
  if (s.dir_chosen && !s.managed) {
    const m = /^(.*)[\\/]MinimaxH3_assistant$/.exec(s.dir || '');
    if (m && !$('#agDir').value) $('#agDir').value = m[1];
    $('#agDirHint').innerHTML = `Сейчас скачается в: <b style="word-break:break-all">${esc(s.dir)}</b>. Чтобы скачать в другое место, поменяйте папку (внутри создастся MinimaxH3_assistant).`;
  }
  $('#agModel').insertAdjacentHTML('beforeend', s.dir_chosen || s.installed ? `<br><span style="font-size:11px;word-break:break-all">Папка помощника: ${esc(s.dir)}</span>` : '');
  const cands = s.candidates || [];
  $('#agOwnPickWrap').hidden = cands.length < 2;
  $('#agOwnPick').innerHTML = cands.map(c =>
    `<option value="${esc(c.path)}" ${c.current ? 'selected' : ''}>${esc(c.name)} · ${c.gb} ГБ${c.fits ? '' : ' · ⚠ может не поместиться в видеопамять'}</option>`).join('');
  if (s.custom && cands.some(c => c.current && !c.fits)) {
    $('#agModel').insertAdjacentHTML('beforeend', `<br><span class="warn-t">Эта модель крупная для вашей видеокарты (${s.vram} ГБ): она может работать медленно или не запуститься. Лучше Gemma 4 12B Q4 (~7 ГБ).</span>`);
  }
  if (s.custom && !$('#agOwnDir').value) $('#agOwnDir').value = s.custom.model.replace(/[\\/][^\\/]+$/, '');
  $('#agDl').hidden = !s.installing;
  renderSkills(s.skills);
}
$('#agVariants').onclick = async e => {
  const b = e.target.closest('.agv'); if (!b || b.classList.contains('on')) return;
  if (b.dataset.my) { try { await postJSON('/api/agent/model', { restore: true }); agStatus(); } catch (err) { toast(err.message); } return; }
  try { await postJSON('/api/agent/variant', { variant: b.dataset.v }); agStatus(); } catch (err) { toast(err.message); }
};
$('#agOwnUse').onclick = async () => {
  try { await postJSON('/api/agent/model', { dir: $('#agOwnDir').value }); toast('Модель подключена'); agStatus(); }
  catch (e) { toast(e.message); }
};
$('#agWhUse').onclick = async () => {
  try { await postJSON('/api/speech/folder', { dir: $('#agWhDir').value }); toast('Папка whisper подключена'); agStatus(); }
  catch (e) { toast(e.message); }
};
$('#agWhReset').onclick = async () => { await postJSON('/api/speech/folder', { reset: true }); $('#agWhDir').value = ''; toast('Снова встроенный whisper'); agStatus(); };
$('#agOwnPick').onchange = async e => {
  try { await postJSON('/api/agent/model', { dir: $('#agOwnDir').value, model: e.target.value }); toast('Модель выбрана'); agStatus(); }
  catch (err) { toast(err.message); }
};
$('#agOwnReset').onclick = async () => { await postJSON('/api/agent/model', { reset: true }); $('#agOwnDir').value = ''; toast('Снова встроенная Gemma'); agStatus(); };
$('#agInstall').onclick = async () => {
  const dir = $('#agDir').value.trim(), s = AG.status || {};
  if (!s.managed && !s.installed && !s.dir_chosen && !dir) { toast('Сначала укажите папку, куда скачать'); $('#agDir').focus(); return; }
  try { await postJSON('/api/agent/install', { dir }); agStatus(); } catch (e) { toast(e.message); }
};
$('#agDlStop').onclick = () => postJSON('/api/agent/install/cancel');
export const agProg = { t: 0, b: 0 };
export function onAgentSetup(ev) {
  $('#agDl').hidden = ev.state !== 'progress'; $('#agInstall').hidden = true;
  if (ev.state === 'progress' && ev.done != null && ev.total) {
    $('#agBar').style.width = (ev.done / ev.total * 100) + '%';
    const now = performance.now(); let sp = '';
    if (agProg.t && now > agProg.t && ev.done >= agProg.b) sp = ` · ${((ev.done - agProg.b) / ((now - agProg.t) / 1000) / 1e6).toFixed(1)} МБ/с`;
    agProg.t = now; agProg.b = ev.done;
    $('#agDlTxt').textContent = `${ev.label.split(': ').pop()} — ${GB(ev.done)} из ${GB(ev.total)}${sp}`;
  } else if (ev.state !== 'progress') { if (ev.state !== 'done') toast(ev.label); agStatus(); }
}

// skills
export const SK_MODES = { always: 'Всегда', auto: 'Авто', off: 'Выкл' };
export const AG_SK_IMG = { 'storyboard': 'Раскадровка', 'krea-2': 'Изображение по тексту', 'flux2-klein': 'Изображение: FLUX klein', 'qwen-image-2-1-director-prompt': 'Изменение изображения', 'karta-personazha': 'Лист персонажа' };
export function renderSkills(list) {
  $('#skCnt').textContent = `(${list.length})`;
  $('#skList').innerHTML = list.map(s => `<div class="sk" data-id="${esc(s.id)}">
    <div class="sk-top"><b title="${esc(s.name)}">${esc(s.name)}</b><span class="sk-mode">
      ${AG_SK_IMG[s.id] ? `<span class="hint" title="Подключается сама, когда выбрана кнопка «${AG_SK_IMG[s.id]}» в «Промпт для»">${AG_SK_IMG[s.id]}</span>` : `<select>${Object.entries(SK_MODES).map(([k, v]) => `<option value="${k}" ${k === s.mode ? 'selected' : ''}>${v}</option>`).join('')}</select>`}
      ${s.builtin ? '' : '<button class="x" title="Удалить скилл">✕</button>'}</span></div>
    <p title="${esc(s.description)}">${esc(s.description)}</p>
    <div class="sk-foot">${s.mode === 'auto' && !AG_SK_IMG[s.id] ? `<input value="${esc(s.keywords.join(', '))}" placeholder="слова через запятую">` : ''}
      ${s.refs.length ? `<small class="hint">+ справочники: ${s.refs.length}</small>` : ''}</div></div>`).join('');
}
export function skShow(on) { $('#skList').hidden = !on; $('#skArr').textContent = on ? '▾' : '▸'; try { localStorage.setItem('h3-sk-open', on ? '1' : ''); } catch {} }
$('#skToggle').onclick = () => skShow($('#skList').hidden);
try { skShow(localStorage.getItem('h3-sk-open') === '1'); } catch {}
$('#skList').addEventListener('change', async e => {
  const card = e.target.closest('.sk'); if (!card) return;
  const body = e.target.tagName === 'SELECT' ? { mode: e.target.value } : { keywords: e.target.value.split(',') };
  await fetch(`/api/agent/skills/${encodeURIComponent(card.dataset.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  agStatus();
});
$('#skList').addEventListener('click', async e => {
  if (!e.target.closest('.x')) return;
  const card = e.target.closest('.sk');
  await fetch(`/api/agent/skills/${encodeURIComponent(card.dataset.id)}`, { method: 'DELETE' });
  toast('Скилл удалён'); agStatus();
});
$('#skUp').onchange = async e => {
  const fd = new FormData();
  for (const f of e.target.files) if (/\.(md|txt)$/i.test(f.name)) fd.append('f', f, f.webkitRelativePath || f.name);
  e.target.value = '';
  try { const r = await fetch('/api/agent/skills', { method: 'POST', body: fd }); const j = await r.json(); if (!r.ok) throw new Error(j.error); toast('Скилл загружен'); agStatus(); }
  catch (err) { toast(err.message); }
};
onNav('agent', () => { agStatus(); agCtx(); loadChats(); });

/* A grip under a row of pictures: drag it down to look at a face closely, double-click to put the row
   back. It used to exist only under the frames of «Видео», although the same rows in the studios, in
   the Clip and in the edit window are just as small. Every row keeps its own size: looking closely at
   one section does not blow up the tiles of another. */
export function hGrip(bar, host, key, o) {
  if (!bar || !host || host._hGrip) return;
  host._hGrip = 1;
  const min = o.min || 96, max = o.max || 460, base = o.base || 0, tgt = o.host || host;
  let last = 0;
  // base: the drag is written in pixels of one tile, but stored as one scale for the whole section,
  // so the video and audio squares next to the pictures grow along with them
  const set = h => {
    last = h;
    if (base) { tgt.style.setProperty(o.h, (h / base).toFixed(4)); return; }
    tgt.style.setProperty(o.h, Math.round(h) + 'px');
    if (o.w) tgt.style.setProperty(o.w, Math.round(h * (o.ratio || 1)) + 'px');   // the tile keeps its shape
  };
  try {
    const v = +localStorage.getItem(key) || (o.old ? +localStorage.getItem(o.old) : 0);
    if (v >= min && v <= max) set(v);
  } catch (e) { }
  bar.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch (e) { }
    bar.classList.add('drag');
  });
  bar.addEventListener('pointermove', e => {
    if (!bar.hasPointerCapture(e.pointerId)) return;
    set(Math.min(Math.max(e.clientY - host.getBoundingClientRect().top, min), max));
  });
  bar.addEventListener('pointerup', e => {
    try { bar.releasePointerCapture(e.pointerId); } catch (e) { }
    bar.classList.remove('drag');
    try { localStorage.setItem(key, Math.round(last) || 0); } catch (e) { }
  });
  bar.addEventListener('dblclick', () => {
    tgt.style.removeProperty(o.h);
    if (o.w) tgt.style.removeProperty(o.w);
    last = 0;
    try { localStorage.removeItem(key); } catch (e) { }
  });
}
// the bar of «Видео» stands in the markup; the others are made by code, one per row
hGrip($('#frameResize'), $('#view-video .frames'), 'h3.fh.video', { h: '--fh', min: 80, max: 520, old: 'h3.fh' });
export function hGripAfter(host, key, o) {
  if (!host) return;
  const bar = document.createElement('div');
  bar.className = 'hresize';
  host.after(bar);
  hGrip(bar, host, key, o);
}

/* a divider before the right-hand column: drag to resize, double-click to reset (width is remembered) */
(() => {
  const root = document.documentElement;
  // [grid, css variable, storage key, half the gap, space the rest must keep]
  const attach = (g, VAR, KEY, half, keep) => {
    {
      if ($(':scope > .gresize', g)) return;
      const h = document.createElement('div');
      h.className = 'gresize'; h.title = 'Потяните, чтобы изменить ширину. Двойной клик — вернуть как было';
      g.append(h);
      h.addEventListener('pointerdown', e => { e.preventDefault(); h.setPointerCapture(e.pointerId); g.classList.add('resizing'); });
      h.addEventListener('pointermove', e => {
        if (!h.hasPointerCapture(e.pointerId)) return;
        const r = g.getBoundingClientRect();
        root.style.setProperty(VAR, Math.round(Math.min(Math.max(r.right - e.clientX - half, 260), r.width - keep)) + 'px');
      });
      h.addEventListener('pointerup', e => {
        h.releasePointerCapture(e.pointerId); g.classList.remove('resizing');
        try { localStorage.setItem(KEY, parseInt(root.style.getPropertyValue(VAR))); } catch {}
      });
      h.addEventListener('dblclick', () => { root.style.removeProperty(VAR); try { localStorage.removeItem(KEY); } catch {} });
    }
  };
  [['.grid', '--pw', 'h3.pw', 11, 440], ['.ag-grid', '--aw', 'h3.aw', 8, 700]].forEach(([sel, VAR, KEY, half, keep]) => {
    $$(sel).forEach(g => attach(g, VAR, KEY, half, keep));
  });
  window.gridResize = g => attach(g, '--pw', 'h3.pw', 11, 440);  // for sections built later (the picture sections)
  // a width dragged in a wide window must not push the middle column out of a narrow one: the page
  // grew a horizontal scrollbar while nothing had reached any reasonable minimum yet
  const fitVars = () => {
    [['--pw', 'h3.pw', 440], ['--aw', 'h3.aw', 700]].forEach(([VAR, KEY, keep]) => {
      let v = 0;
      try { v = +localStorage.getItem(KEY); } catch { }
      if (!(v >= 260)) return;                       // nobody dragged it: let CSS decide
      const cap = Math.max(260, Math.round(innerWidth - keep - 40));
      root.style.setProperty(VAR, Math.min(v, cap) + 'px');
    });
  };
  let fitTimer; addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitVars, 150); });
  fitVars();
})();


// download page / file name of a model
$('#mlist').addEventListener('click', async e => {
  const dn = e.target.closest('[data-dlnow]'); if (dn) { mdStart([dn.dataset.dlnow]); return; }
  const cu = e.target.closest('[data-copyurl]');
  if (cu) { const u = cu.dataset.copyurl; copyText(u, 'Ссылка скопирована: вставьте её в менеджер загрузок'); return; }
  const d = e.target.closest('[data-dlmodel]'), c = e.target.closest('[data-copyname]'), f = e.target.closest('.mf');
  if (d) { try { await postJSON('/api/models/open', { role: d.dataset.dlmodel }); toast('Страница скачивания открыта в браузере'); } catch (err) { toast(err.message); } return; }
  const name = c ? c.dataset.copyname : f ? f.textContent : ''; if (!name) return;
  copyText(name, 'Имя файла скопировано');
});
// a model file with another name than the app expects: pick it from what ComfyUI sees
$('#mlist').addEventListener('click', async e => {
  const b = e.target.closest('[data-pickmodel]'); if (!b) return;
  const row = b.closest('.m'), role = b.dataset.pickmodel;
  try {
    const r = await (await fetch('/api/models/files?role=' + role)).json();
    if (!r.files?.length) { toast(`ComfyUI не видит файлов в папке ${r.folder}`); return; }
    b.hidden = true;
    row.insertAdjacentHTML('beforeend', `<div class="pm"><input type="search" class="pm-q" placeholder="Поиск по имени…" spellcheck="false"><select><option value="">как по умолчанию</option>${r.files.map(f => `<option>${esc(f)}</option>`).join('')}</select><button class="btn mini pri" type="button">Выбрать</button></div>`);
    $('.pm-q', row).oninput = e => {  // only the files whose name contains the typed words
      const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      $$('.pm select option', row).forEach(o => { o.hidden = !!o.value && !words.every(w => o.textContent.toLowerCase().includes(w)); });
      const first = $$('.pm select option', row).find(o => !o.hidden && o.value); if (words.length && first) first.selected = true;
    };
    $('.pm .pri', row).onclick = async () => {
      const name = $('.pm select', row).value;
      const r = await postJSON('/api/models/pick', { role, name });
      if (r && r.warn) { confirmBox('Это точно тот файл?', r.warn, 'Всё равно выбрать', async () => { await postJSON('/api/models/pick', { role, name, force: true }); await loadStatus(); toast('Файл выбран'); }); return; }
      await loadStatus(); toast('Файл выбран');
    };
  } catch { toast('ComfyUI не отвечает'); }
});

// another version of the same model: lighter, newer... only versions that replace this very file are offered
$('#mlist').addEventListener('click', async e => {
  const b = e.target.closest('[data-variant]'); if (!b) return;
  const row = b.closest('.m'), role = b.dataset.variant;
  const s = await (await fetch('/api/status')).json(), m = (s.models || []).find(x => x.role === role); if (!m) return;
  $('.pv', row)?.remove(); b.hidden = true;
  row.insertAdjacentHTML('beforeend', `<div class="pm pv"><select>${m.variants.map(v => `<option value="${v.key}"${v.current ? ' selected' : ''}>${esc(v.label)} · ${GB(v.size)}${v.have ? ' · есть на диске' : ''}${v.lic ? ' · ' + ({ nc: 'НЕЛЬЗЯ в коммерцию', unknown: 'лицензия не указана', mixed: 'ролик можно, модель нельзя', h3: 'условия MiniMax H3' })[v.lic] : ''}</option>`).join('')}</select><button class="btn mini pri" type="button" data-ok>Выбрать</button><button class="btn mini" type="button" data-no>Отмена</button><div class="hint" style="flex-basis:100%">Подходят только версии этой же модели: они заменяют друг друга. Остальные файлы не затрагиваются.</div></div>`);
  const pv = $('.pv', row);
  $('[data-no]', pv).onclick = () => { pv.remove(); b.hidden = false; };
  $('[data-ok]', pv).onclick = async () => {
    const key = $('select', pv).value, v = m.variants.find(x => x.key === key);
    if (v.current) { pv.remove(); b.hidden = false; return; }
    let r;
    try { r = await postJSON('/api/models/variant', { role, variant: key }); } catch (err) { toast(err.message); return; }
    await loadStatus();
    if (r.have) { toast('Версия выбрана'); return; }
    if (MD_ENGINE !== 'managed') { toast(`Версия выбрана. Положите файл ${r.file} в папку моделей вашего ComfyUI или укажите его кнопкой «Указать файл…»`); return; }
    toast(`Версия выбрана. Нужно скачать ${r.file} (${GB(r.size)}): нажмите «Докачать недостающие» вверху списка`);
  };
});

/* ---------- improve quality of a finished video (SeedVR2) ---------- */
$('#vwUp').onclick = () => openUpscale((byId(openId) || openItem));
export const agKreaMode = () => { const b = $('.kr-eng button.on', $('#view-krea')); return ({ kreareal: 'krea', flux: 'fluxt', h3img: 'h3t', qwen: 'qwent' }[((b && b.dataset.e) || 'krea')]) || 'krea'; };
export const agQwenMode = () => { const b = $('.qw-eng button.on', $('#view-qwen')); return ((b && b.dataset.e) === 'h3img') ? 'h3e' : 'qwen'; };
/* Кнопку «Генерация промта» больше не развешивают по полям: окно «Сценарий» (ui/scenario.js)
   ставит её сам, и перевод своего же текста из окна убран - он нужен только под готовым
   промптом сценариста (data-ru в блоке ответа). */

/* width of the left menu: drag the thin line on its edge */
(() => {
  const app = $('.app'), rs = $('#sbRs'), KEY = 'h3-sbw';
  const root = document.documentElement, set = w => root.style.setProperty('--sbw', w + 'px');
  try { const w = +localStorage.getItem(KEY); if (w >= 200 && w <= 520) set(w); } catch {}
  rs.addEventListener('pointerdown', e => {
    e.preventDefault(); rs.setPointerCapture(e.pointerId); document.body.classList.add('sb-drag');
    const side = $('.side'), ratio = () => side.offsetWidth / (side.getBoundingClientRect().width || 1);
    const move = ev => { const w = Math.round(Math.min(520, Math.max(200, (ev.clientX - side.getBoundingClientRect().left) * ratio()))); set(w); try { localStorage.setItem(KEY, w); } catch {} };
    const up = () => { document.body.classList.remove('sb-drag'); rs.removeEventListener('pointermove', move); rs.removeEventListener('pointerup', up); };
    rs.addEventListener('pointermove', move); rs.addEventListener('pointerup', up);
  });
  rs.addEventListener('dblclick', () => { root.style.removeProperty('--sbw'); try { localStorage.removeItem(KEY); } catch {} });
})();
// An own main model in the mode itself: pick a file ComfyUI sees; the app says whether it fits the rest of the mode (speed-up LoRAs, format, video card)
(() => {
  // роль основной модели на раздел: без неё строка «своя модель» в разделе молчит (role=undefined),
    // поэтому список должен покрывать ВСЕ режимы - раньше в нём не было реализма, FLUX, H3 Image и обоих увеличений
    const MAIN = { video: 'fast_unet', lipsync: 'lipsync_unet', refs: 'lipsync_unet', actor: 'lipsync_unet', swap: 'lipsync_unet', long: 'lipsync_unet', actionsc: 'action_unet', action: 'action_unet', krea: 'krea_unet', kreareal: 'kreareal_unet', qwen: 'qwen_unet', flux: 'flux_unet', h3img: 'h3img_unet', upscale: 'seedvr_unet', relayvsr: 'relayvsr_unet' };
  const refresh = async box => {
    const { mode, role } = box.dataset;
    try {
      const r = await (await fetch(`/api/models/compat?role=${role}&mode=${mode}`)).json();
      $('.mp-cur', box).textContent = (r.name || '').split(/[\\/]/).pop() || 'не найдена';
      const src = $('.mp-src', box); src.textContent = r.picked ? 'СВОЯ МОДЕЛЬ' : 'встроенная'; src.className = 'mp-src ' + (r.picked ? 'own' : 'std');
      box.classList.toggle('own', !!r.picked);
      $('.mp-reset', box).hidden = !r.picked;
      if (r.unknown) { box._tries = (box._tries || 0) + 1; setTimeout(async () => { try { await loadStatus(); } catch { } refresh(box); }, 3000); } else { box._tries = 0; }
      const std = (r.loras || []).filter(l => !l.custom), own = (r.loras || []).filter(l => l.custom);
      $('.mp-loras', box).innerHTML = r.unknown
        ? '<span class="hint">LoRA: ComfyUI занят (обычно это загрузка модели) — список появится сам.</span>'
        : ((std.length ? '<span class="hint">LoRA режима:</span>' + std.map(l => `<span class="mp-l${l.have ? '' : (l.must ? ' no' : ' opt')}${l.mine ? ' mine' : ''}" title="${esc(l.must ? 'Нужна этому режиму' : 'Подключается по желанию')}">${esc(l.title)}${l.have ? '' : (l.must ? ' — файла нет' : ' — не скачана, по желанию')}${(l.have || !l.role) ? ''
  : ` <button type="button" class="mp-dl" data-dlrole="${esc(l.role)}" title="${l.must ? 'Скачать нужный этому режиму файл' : 'Скачать сейчас, файл не обязателен'}">Скачать</button>`}</span>`).join('') : '')
          + (own.length ? '<span class="hint">Ваши LoRA:</span>' + own.map(l => `<button type="button" class="mp-l mine tgl${l.off ? ' off' : ''}" data-file="${esc(l.name)}" title="${l.fits === false ? 'По названию эта LoRA сделана для другого раздела (' + (l.family || 'другая семья') + '), поэтому здесь она по умолчанию не участвует: видео-модель от картинной LoRA может испортиться. Нажмите, чтобы включить её здесь назло.' : 'Нажмите, чтобы ' + (l.off ? 'включить' : 'выключить') + ' эту LoRA только в этом разделе; в других она останется как есть'}">${esc(String(l.name).split(/[\\/]/).pop())} · ${l.fits === false ? (l.off ? 'для этого раздела не участвует — включить назло' : 'включена здесь вручную') : (l.off ? 'выключена здесь — включить' : 'работает здесь — выключить')}</button>`).join('') : ''))
          || '<span class="hint">LoRA в этом режиме не нужны</span>';
      $('.mp-notes', box).innerHTML = r.picked ? r.notes.map(n => `<div class="${n.level}">${n.level === 'bad' ? '✕ ' : n.level === 'warn' ? '⚠ ' : 'ⓘ '}${esc(n.text)}</div>`).join('') : '';
    } catch {
      box._tries = (box._tries || 0) + 1; setTimeout(() => refresh(box), 3000);
      $('.mp-loras', box).innerHTML = '<span class="hint">ComfyUI ещё не ответил — это не ошибка, список появится сам.</span>';
    }
  };
  const ensure = view => {
    const mode = view.id.replace('view-', ''), role = MAIN[mode];
    if (!role || $('.mdl-pick', view)) return;
    const head = $('.head', view); if (!head) return;
    head.insertAdjacentHTML('afterend', `<div class="mdl-pick card" data-mode="${mode}" data-role="${role}"><span>Модель:</span><span class="mp-cur">…</span><span class="mp-src"></span><button class="btn mini mp-change" type="button" title="Выбрать другой файл модели из папки вашего ComfyUI">Выбрать свою…</button><button class="btn mini mp-reset" type="button" hidden>Вернуть встроенную</button><div class="pm" hidden><input type="search" class="pm-q" placeholder="Поиск по имени…" spellcheck="false"><select></select><button class="btn mini pri mp-ok" type="button">Выбрать</button><button class="btn mini mp-no" type="button">Отмена</button></div><div class="mp-loras"></div><div class="mp-notes"></div></div>`);
    const box = $('.mdl-pick', view), pm = $('.pm', box), sel = $('select', pm);
    refresh(box);
    $('.mp-change', box).onclick = async () => {
      try {
        const r = await (await fetch('/api/models/files?role=' + role)).json();
        if (!r.files?.length) { toast(`ComfyUI не видит файлов в папке ${r.folder}`); return; }
        sel.innerHTML = r.files.map(f => `<option value="${esc(f)}" title="${esc(f)}">${esc(String(f).split(/[\\/]/).pop())}</option>`).join(''); pm.hidden = false;
      } catch { toast('ComfyUI не отвечает'); }
    };
    $('.pm-q', box).oninput = e => {
      const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      $$('option', sel).forEach(o => { o.hidden = !words.every(w => o.textContent.toLowerCase().includes(w)); });
      const first = $$('option', sel).find(o => !o.hidden); if (words.length && first) first.selected = true;
    };
    $('.mp-no', box).onclick = () => { pm.hidden = true; };
    $('.mp-loras', box).onclick = async e => {
      const dl = e.target.closest('[data-dlrole]');
      if (dl) { mdStart([dl.dataset.dlrole]); return; }   // the file is offered right where its absence is written
      const b = e.target.closest('.tgl'); if (!b) return;
      try { await postJSON('/api/loras/custom/mode', { file: b.dataset.file, mode, on: b.classList.contains('off') }); refresh(box); } catch (err) { toast(err.message); }
    };
    $('.mp-ok', box).onclick = async () => {
      const name = sel.value; if (!name) return;
      const done = async () => { pm.hidden = true; await loadStatus(); $$('.mdl-pick').forEach(refresh); toast('Модель выбрана'); };
      try {
        const r = await postJSON('/api/models/pick', { role, name });
        if (r && r.warn) { confirmBox('Это точно тот файл?', r.warn, 'Всё равно выбрать', async () => { await postJSON('/api/models/pick', { role, name, force: true }); await done(); }); return; }
        await done();
      } catch (e) { toast(e.message); }
    };
    $('.mp-reset', box).onclick = async () => { try { await postJSON('/api/models/pick', { role, name: '' }); await loadStatus(); $$('.mdl-pick').forEach(refresh); toast('Снова встроенная модель'); } catch (e) { toast(e.message); } };
  };
  window.refreshMdl = () => $$('.mdl-pick').forEach(refresh);
  const watch = view => { new MutationObserver(() => { if (view.classList.contains('active')) ensure(view); }).observe(view, { attributes: true, attributeFilter: ['class'] }); if (view.classList.contains('active')) ensure(view); };
  $$('.view').forEach(watch);
})();


/* ---------- one place for instructions: the ? next to a page title ----------
   Every page has one ? button and nothing else. The texts say only how to work here:
   what a button does, what a field answers for, what is saved and what it affects. */
(function () {
  const escq = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const H = t => '<div class="hint mh-h">' + t + '</div>';
  const B = (name, what) => '<li><b>' + name + '</b> - ' + what + '</li>';
  const UL = items => '<ul class="mh-ul">' + items.join('') + '</ul>';

  // what stands on almost every page
  const SHARED = () => H('<b>Общее для всех режимов</b>') + UL([
    B('Кнопки вверху и слева', 'открывают режимы; наведение на верхнюю подсказывает, что откроется.'),
    B('Карточка с номером', 'сворачивается и разворачивается щелчком по её заголовку; свернуть всё разом - кнопка «Свернуть всё».'),
    B('Кнопка «Старт» внизу', 'запускает задание; во время работы она превращается в «Остановить».'),
    B('Очередь', 'все запущенные задания стоят там; можно дождаться, остановить или убрать из списка.'),
    B('Библиотека', 'сюда попадают все готовые работы; нажмите на неё, чтобы открыть просмотр, «★» - пометить, «Удалить» - убрать файл в корзину.'),
    B('Панель «Библиотека» справа', 'открывается кнопкой у правого края: Фото, Видео и Аудио тремя группами. Файл можно перетащить из неё в любое место любого режима, а щелчок открывает просмотр.'),
    B('Звук', 'его не надо включать. Положите аудио - ролик строится под него. Не положили - звук сделает модель.'),
    B('Куда что попадает', 'готовые видео и фото - в Библиотеку и в папку data/outputs; кадры и звук, сохранённые кнопками, - в папку data/keeps.'),
  ]);

  const BENCH = () => H('<b>Верстак видео: «✂ Монтаж»</b>') + UL([
    B('Лента', 'показывает кадры вашего видео. Ползунок «Шире лента - точнее кадр» растягивает ленту: чем шире, тем легче попасть в нужный кадр.'),
    B('Жёлтая линия', 'это метка реза. Схватите её мышью и поставьте куда нужно; она же стоит там, когда вы листаете кадры.'),
    B('Стрелки над меткой', 'шаг на один кадр (1/24 секунды).'),
    B('Ножницы у метки', 'левая убирает всё до метки, правая - всё после.'),
    B('Слева вверху на ленте', 'секунды метки и номер кадра: «маркер 3,25 с · кадр 78».'),
    B('Клик по ленте', 'играет видео: левее метки - от начала куска до метки, правее - от метки до конца.'),
    B('Ручки по краям синей рамки', 'задают начало и конец куска; поля «с» и «до» ниже - то же самое числами.'),
    B('«Оставить выбранное»', 'отрезает кусок и кладёт в ленту его одного. Ваш файл не меняется.'),
    B('«Вернуть целый»', 'возвращает в ленту исходный файл целиком.'),
    B('Двойной щелчок по ленте', 'то же: снять обрезку.'),
    B('«📷 Сделать кадр»', 'сохраняет кадр под меткой: он встаёт в свободное место картинок этого режима и копией уходит в Библиотеку.'),
    B('«🤖 К сценаристу»', 'отправляет отрезанный кусок в «Сценарист»: он слушает звук и пишет промпт по тому, что видит.'),
  ]);

  const TAGS = () => H('<b>Теги в тексте</b>') + UL([
    B('&lt;Picture 1&gt;, &lt;Picture 2&gt;…', 'ваши загруженные картинки по порядку. Нажмите на плашку под текстом - тег встанет туда, где курсор.'),
    B('&lt;Video 1&gt; …', 'референс-видео этого режима.'),
    B('&lt;Audio 1&gt; …', 'аудио этого режима.'),
    B('Номера в режимах со сценами', 'свои медиа сцены занимают десятки: первая сцена - 10-19, вторая - 20-29. Номер сам говорит, из какой он сцены.'),
    B('Если тег не написан', 'модель файл не использует, даже если он загружен.'),
  ]);

  const PER = {
    video: () => H('<b>Видео из картинки</b>') + UL([
      B('Промпт', 'опишите, что происходит. Одна фраза - одно действие, так стабильнее.'),
      B('Изображения', 'первая картинка - стартовый кадр; если хотите конкретный конец, положите последний кадр в специальное место.'),
      B('Длительность', 'сколько секунд ролика получить.'),
      B('Что влияет на сходство', 'чем меньше изменений в кадре нужно, тем короче и проще должен быть текст.'),
    ]),
    refs: () => H('<b>Видеостудия - видео по вашим референсам</b>') + UL([
      B('Картинки (до 9)', 'герои, одежда, предметы, пространство. Каждый вызов в тексте - &lt;Picture №&gt;.'),
      B('Видео (до 3, до 25 секунд)', 'задаёт движение и камеру. Обрежьте лишнее в верстаке - в расчёт пойдёт только отмеренное время.'),
      B('Аудио (до 3)', 'определяет звук и длину. Аудио длиннее - ролик тянется под него.'),
      B('Длительность', 'если аудио нет, длину задаёте вы.'),
      B('Промпт', 'что делают герои и куда смотрит камера; вставляйте теги вместо слов «он», «она», «это».'),
    ]),
    long: () => H('<b>Киностудия - фильм по сценам</b>') + UL([
      B('«Новые сцены»', 'вы пишете список сцен; каждая - отдельный клип до 15 секунд, следующая продолжает последнюю картинку предыдущей.'),
      B('«Продолжить видео»', 'берёт ваше готовое видео и дописывает сцены после него.'),
      B('Плюс под сценой', 'добавляет ещё одну сцену; номер карточки слева - это и есть её место.'),
      B('Картинки сцены', 'до 9 на каждую сцену; свои медиа нумеруются десятками по номеру сцены.'),
      B('Аудио сцены', 'до трёх файлов на сцену: это образцы - голос, ритм, атмосфера. Модель слушает их и звук создаёт сама; в тексте сцены они значатся как &lt;Audio 10&gt;, &lt;Audio 11&gt;, &lt;Audio 12&gt; (во второй сцене - 20, 21, 22).'),
      B('Аудио на весь ролик', 'до трёх файлов в карточке «Аудио»: первый - звук ролика (&lt;Audio 1&gt;): без галочки про голос модель сочиняет звук сама, а ваш трек играет в ролике фоном тише; с галочкой модель держит ваш голос, и музыка тоже фоном тише. Второй и третий - образцы (&lt;Audio 2&gt;, &lt;Audio 3&gt;): голос, ритм, атмосфера. Обрезать и глушить лесенкой можно каждый, длина не ограничена.'),
      B('Три тега - и хватит', 'модель за раз слушает не больше трёх аудио, поэтому в сцене работает три тега: вставили три - остальные чипи гаснут. Что лежит в сцене, но не упомянуто тегом, в этот раз не участвует; четвёртый тег программа уберёт и скажет об этом.'),
      B('Затухание', 'в редакторе аудио есть режим «Затухание»: <b>внутри выделенного</b> появляются две лесенки. Правая - звук плавно стихает от левого маркера до правого, левая - наоборот, набирает силу; <b>за краями выделенного звук остаётся как был</b>. Кнопка «Откат» возвращает аудио ровно таким, каким оно было загружено, - все спуски и разрезы разом. Загруженный файл не переписывается: в сцену, в модель и в Сценарист уходит изменённый кусок, а оригинал остаётся при себе. В «Монтаже» кнопка «Затухание аудио» делает из ножниц две лесенки: метка - где начинать стихать, <b>левая лесенка - к началу клипа, правая - к его концу</b>. Стороны переключаются <b>независимо, можно держать обе сразу</b>; включённая горит, повторное нажатие выключает только её, на блоке видно направление: где спуск, где набор. Спуск ложится на собранный звук и на сохранённый ролик - сами клипы не меняются.'),
      B('Склейка', 'сцены соединяются подряд в один файл; длина ролика - сумма сцен.'),
    ]),
    action: () => H('<b>Экшн-видео - одно динамичное видео</b>') + UL([
      B('Картинки', 'герой и пространство; первым ставьте то, что должно узнаваться.'),
      B('Промпт', 'движение и удары глаголами: «бежит», «прыгает», «отбивает».'),
      B('Длительность', 'для драки хватает 6-8 секунд; длиннее - движение начинает плыть.'),
      B('Быстрый и точный проход', 'программа делает черновой кадр и уточняет его; это уже встроено.'),
    ]),
    actionsc: () => H('<b>Экшн-студия - динамичные сцены подряд</b>') + UL([
      B('Сцены', 'пишутся списком, каждая до 15 секунд: погоня - это несколько сцен, а не одна длинная.'),
      B('Картинки сцены', 'до 5: герой, место, нужный ракурс.'),
      B('Преемственность', 'следующая сцена начинается с последнего кадра предыдущей, поэтому герой не меняет лицо от сцены к сцене.'),
      B('Звук', 'создаёт сама модель, но им можно управлять: до трёх общих аудио на весь ролик (теги &lt;Audio 1&gt;, &lt;Audio 2&gt;, &lt;Audio 3&gt;) и до трёх своих в каждой сцене (&lt;Audio 10&gt;, &lt;Audio 11&gt;, &lt;Audio 12&gt;). Общее подходит, когда голос или ритм нужны во всём ролике, а не в одной сцене. Ваш общий трек играет в готовом ролике фоном тише звука модели, чтобы речь была слышна; с галочкой «модель слушает только голос» в ролике остаётся ваш голос, а музыка - так же фоном тише.'),
      B('Три тега - и хватит', 'модель слушает не больше трёх аудио за раз: вставили три тега в сцену - остальные чипи гаснут, а лишний тег программа уберёт и предупредит.'),
    ]),
    lipsync: () => H('<b>Клип - герой говорит или поёт под ваше аудио</b>') + UL([
      B('Аудио', 'обязательно: из него берутся слова, ритм и длительность ролика.'),
      B('Лицо', 'одна картинка с лицом; лучше крупно и анфас.'),
      B('Длительность', 'её задаёт аудио; менять смысла нет.'),
      B('Ускорение черновика', 'быстрее, но губы чуть грубее; снимите галочку для точной синхронизации.'),
    ]),
    actor: () => H('<b>Актёр - диалог и эмоции</b>') + UL([
      B('Картинка (до 3)', 'герой и окружение; первой - та, где лицо хорошо видно.'),
      B('Аудио', 'образец голоса: берутся тембр и манера, а слова произносятся из вашего текста.'),
      B('Текст', 'что герой говорит и что чувствует: «спокойно», «с угрозой», «сквозь слёзы».'),
      B('Длительность', 'до 14 секунд; подлиннее - мимика начинает сползать.'),
    ]),
    swap: () => H('<b>Замена - меняем человека в вашем видео</b>') + UL([
      B('Видео', 'до 25 секунд, один непрерывный план лучше. Обрежьте лишнее кнопкой «✂ Монтаж».'),
      B('Персонаж 1', 'тот, кого ставим вместо вашего героя. Одна картинка - одна замена.'),
      B('Персонаж 2', 'второй герой, если в кадре двое.'),
      B('«📷 Сделать кадр»', 'сохраняет кадр из вашего видео как картинку - её можно поставить вместо героя или взять в другой режим.'),
      B('Длительность', 'по умолчанию берётся длина видео; уменьшить - быстрее.'),
    ]),
    krea: () => H('<b>Изображение по тексту</b>') + UL([
      B('Текст', 'что нарисовать; стиль и свет пишите отдельными словами в конце.'),
      B('Формат', 'горизонт, вертикаль, квадрат; размер выбирается под формат.'),
      B('Детализация', 'больше мегапикселей - дольше и чище детали.'),
      B('«Увеличить изображение»', 'поднимает разрешение и добавляет резкости готовой картинке.'),
    ]),
    qwen: () => H('<b>Правка - изменение готового изображения</b>') + UL([
      B('Изображение', 'обязательно: что правим.'),
      B('Текст', 'что изменить: «убери фон», «сделай куртку красной», «добавь очки».'),
      B('Много правок', 'лучше по одной: так лицо и одежда не уплывают.'),
    ]),
    upfile: () => H('<b>Апскейлинг - увеличение разрешения и чёткости видео или фото</b>') + UL([
      B('Файл', 'перетащите видео или фото в верхнее окно (до 300 МБ). Под ним появится карточка с именем, размером и длиной - крестик «✕ Убрать» возвращает всё назад, файл при этом не тронут.'),
      B('Параметры', 'появляются под файлом и зависят от него: для фото - «До 2К, мягко», «Чёткость» и увеличение в 1,5 или 2 раза; для видео - «Быстро (RelayVSR)» и «Качественнее (SeedVR2)».'),
      B('«Детали» (у быстрого видео)', 'меньше - мягче и без пересвеченных лиц, больше - резче. Обычно 70%.'),
      B('«Чёткость»', 'меньше - ближе к обычному увеличению, 100 - как есть.'),
      B('Кнопка способа', 'отправляет задание в очередь; рядом написано, сколько примерно это займёт. Скорость считана на RTX 4060 Ti, на более слабой карте будет дольше.'),
      B('Результат', 'новый файл в Библиотеке; ваш исходный файл не меняется.'),
    ]),
    montage: () => H('<b>Монтаж - склейка готовых клипов</b>') + UL([
      B('Клик по клипу сверху', 'кладёт его в ленту; повторный клик убирает.'),
      B('Стрелки ◀ ▶ под клипом или перетаскивание', 'меняют порядок склейки.'),
      B('Лента', 'показывает кадры каждого клипа; жёлтая линия - метка реза, стрелки листают по кадру, ножницы режут у метки.'),
      B('Поля «с» и «до»', 'обрезка выбранного клипа; «Вернуть целый» снимает её.'),
      B('Клик по ленте', 'играет с этого места.'),
      B('Ползунок «1 секунда»', 'масштаб ленты: шире - точнее режешь.'),
      B('Треугольник под лентой', 'тяните вверх-вниз, чтобы сделать ленту выше; двойной щелчок возвращает обычную высоту.'),
      B('«📷 Сделать кадр»', 'кадр под меткой уходит в Библиотеку.'),
      B('«🎧 Сделать звук»', 'собирает звук всей ленты после обрезки в один файл и кладёт в Библиотеку.'),
      B('Кнопка запуска', 'складывает клипы в один ролик; «Очистить ленту» убирает их из монтажа, сами файлы остаются в Библиотеке.'),
    ]),
    library: () => H('<b>Библиотека - всё, что программа сделала</b>') + UL([
      B('Полоса сверху', 'фильтр: все, только видео, только картинки, по режиму, избранное.'),
      B('Щелчок по карточке', 'открывает просмотр; галочки слева включают режим выбора, чтобы убрать несколько сразу.'),
      B('«★»', 'помечает, чтобы не lostлось в общем списке.'),
      B('"В монтаж"', 'кладёт клип в ленту монтажа.'),
      B('"Использовать в…"', 'переносит файл в нужный режим одним нажатием.'),
      B('«Удалить»', 'убирает запись и файл в корзину; «Сохранить копии старых файлов» держит второй экземпляр в папке программы.'),
    ]),
    models: () => H('<b>Настройки - движок, модели, файлы</b>') + UL([
      B('Движок', 'показывает, подключён ли ComfyUI; кнопка запускает его, если он не запущен.'),
      B('Модели', 'что скачано и что можно докачать; отмечены только нужные - остальное докачивается позже.'),
      B('Свои модели', 'папка, откуда программа берёт файлы; туда же кладите свои safetensors.'),
      B('Ваши LoRA', 'ускорение и стили, которые вы положили сами; включаются по одному на режим.'),
      B('Интерфейс', 'тема и размер; размер нужен, когда экран маленький и карточки не влезают.'),
      B('Резервные копии', 'копии готовых файлов в папке программы: включают, если боитесь потерять результат.'),
    ]),
    presets: () => H('<b>Главная - с чего начать</b>') + UL([
      B('Карточка режима', 'открывает нужный режим; под названием написано, что ему нужно загрузить.'),
      B('Отметить режимы', 'если включить несколько, в «Промпт для» и вверху останутся только они - так экран чище.'),
      B('Первый запуск', 'достаточно настроить движок и выбрать один режим; остальное программа спросит сама.'),
    ]),
    queue: () => H('<b>Очередь - что сейчас делается</b>') + UL([
      B('Строка задания', 'режим, промпт и прогресс; нажмите, чтобы развернуть подробности.'),
      B('«Остановить»', 'прерывает одно задание, остальные идут дальше.'),
      B('«Убрать»', 'вычёркивает из списка; готовый файл остаётся в Библиотеке.'),
      B('После закрытия программы', 'недоделанные задания сохраняются, и при следующем запуске программа спросит, продолжить ли их.'),
    ]),
    agent: () => H('<b>Сценарист - думает и собирает задание</b>') + UL([
      B('Режим', 'то, что в итоге будет сниматься; от него зависит, какие места доступны.'),
      B('Вложение', 'картинка или файл из панели Библиотеки: перетащите в чат.'),
      B('«Быстро» / «Думать глубже»', 'короткий ответ или длинное размышление для сложной истории.'),
      B('Ответ сценариста', 'можно отправить прямо в работу - кнопки под сообщением.'),
    ]),
  };

  function open(view, name) {
    let m = document.getElementById('modeHelpM');
    if (!m) {
      m = document.createElement('div'); m.className = 'modal'; m.id = 'modeHelpM';
      document.body.append(m);
      m.addEventListener('click', e => { if (e.target === m || e.target.closest('[data-x]')) m.hidden = true; });
    }
    const key = (view.id || '').replace('view-', '');
    const body = ((PER[key] ? PER[key]() : '') + TAGS() + (PER[key] === PER.refs || PER[key] === PER.swap ? BENCH() : '') +
      (key === 'montage' ? '' : '') + SHARED());
    m.hidden = false;
    m.innerHTML = '<div class="box"><div class="card-h"><h3>' + escq(name) + '</h3>' +
      '<button class="x" type="button" data-x aria-label="Закрыть">✕</button></div>' +
      '<div class="mh-body">' + body + '</div>' +
      '<div class="mh-foot"><button class="btn mini" type="button" data-x>Закрыть</button></div></div>';
  }

  const style = document.createElement('style');
  style.textContent = '.h3q{width:22px;height:22px;flex:none;border-radius:50%;border:1px solid var(--line-2);' +
    'background:var(--card,#222);color:var(--muted);font-size:12.5px;font-weight:800;line-height:1;cursor:pointer;' +
    'display:inline-grid;place-items:center;padding:0;transition:.15s}' +
    '.h3q:hover{background:var(--accent,#c0405a);color:#fff;border-color:transparent;transform:scale(1.08)}' +
    'h1.h1q{display:flex;align-items:center;gap:9px}' +
    '#modeHelpM .box{padding:22px;max-width:760px;max-height:calc(var(--vh,1vh)*86);overflow:auto}' +
    '#modeHelpM .mh-h{font-size:12.5px;margin-top:4px}' +
    '#modeHelpM .mh-ul{margin:6px 0 10px;padding-left:18px;font-size:12.5px;line-height:1.6;color:var(--text)}' +
    '#modeHelpM .mh-ul li{margin:3px 0}' +
    '#modeHelpM .mh-foot{margin-top:14px}' +
    '.how-hidden{display:none!important}';
  document.head.append(style);

  // any other way to open instructions is off: the ? is the only one
  const OFF = /как работает|как пользоваться|советы|справка|подсказк/i;
  function hideOthers(root) {
    root.querySelectorAll('details.agvar, .btn, summary, button').forEach(el => {
      const t = (el.textContent || '').trim();
      if (t.length > 60 || !OFF.test(t)) return;
      if (el.closest('.mh-body') || el.classList.contains('h3q')) return;
      // a fold with fields inside is a control, not an instruction: leaving it alone
      if (el.matches('details') ? el.querySelector('input,select,textarea,button:not([data-x])')
                               : el.tagName === 'BUTTON' ? false : el.querySelector('input,select,textarea')) return;
      el.classList.add('how-hidden');
    });
  }
  function plant() {
    document.querySelectorAll('.view').forEach(v => {
      const h = v.querySelector('.head h1, h1');
      if (h && !h.querySelector('.h3q')) {
        const name = (h.textContent || '').trim();
        h.classList.add('h1q');
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'h3q'; b.textContent = '?';
        b.title = 'Как пользоваться этим режимом';
        b.onclick = () => open(v, name);
        h.append(b);
      }
      hideOthers(v);
    });
    hideOthers(document.body);
  }
  plant();
  let queue = 0;
  new MutationObserver(() => {
    if (queue) return;
    queue = setTimeout(() => { queue = 0; plant(); }, 500);
  }).observe(document.body, { childList: true, subtree: true });
})();

/* ---------- hints where none existed ----------
   A button that does not say what it does is a button a person is afraid to press.
   These are set after the page is built, so they follow controls that pages create
   themselves; a title written in the markup always wins and is never overwritten. */
(function () {
  const T = {
    '#libFilter .chip[data-f="all"]': 'Показать всё, что делала программа',
    '#libFilter .chip[data-f="videos"]': 'Только готовые видео, из любого режима',
    '#libFilter .chip[data-f="images"]': 'Только готовые картинки, из любого режима',
    '#libFilter .chip[data-f="upscale"]': 'Файлы, увеличенные в «Ретуши»',
    '#libFilter .chip[data-f="custom"]': 'Задания, собранные в разделе «Свои workflow»',
    '#libFilter .chip[data-f="fav"]': 'Помеченные звёздочкой',
    '#resKeep': 'Держать копию каждого готового файла в папке программы: если основную папку переполнят очистки, копия останется',
    '#resApply': 'Сохранить новую папку для копий',
    '#resBackfill': 'Скопировать в папку копий то, что уже сделано, но без копии',
    '#resClean': 'Убрать из списка записи, у которых файл на диске пропал; сами файлы не удаляются',
    '#agNew2': 'Начать новый разговор: старые переписки останутся в списке слева',
      '#agWipe': 'Удалить все сохранённые переписки. Отменить нельзя',
    '#agThinkHint': '',
    '#coreLogBtn': 'Журнал программы: что запускалось, что скачивалось, какие ошибки',
    '#clAdd': 'Добавить папку, откуда программа берёт ваши LoRA',
  };
  const GO = 'Запускает задание в очередь. Готовое появится в Библиотеке, ваши файлы не меняются. ' +
    'Пока работа идёт, кнопка превращается в «Остановить».';
  const SCENE = 'Делает эту сцену и ставит её видео под карточку. Остальные сцены не трогаются. ' +
    'Готовый ролик появится в Библиотеке, а целиком фильм собирается кнопкой «Собрать фильм».';
  function paint() {
    for (const sel in T) {
      if (!T[sel]) continue;
      document.querySelectorAll(sel).forEach(b => { if (!b.getAttribute('title')) b.title = T[sel]; });
    }
    // chips and filter buttons pages build themselves
    document.querySelectorAll('#libFilter .chip').forEach(b => {
      if (b.getAttribute('title')) return;
      const t = (b.textContent || '').trim();
      if (t && !/^[on✓]+$/.test(t)) b.title = 'Показывать только: ' + t.toLowerCase();
    });
    document.querySelectorAll('button.go').forEach(b => {
      const txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
      b.title = /Сцена|сцену/i.test(txt) ? SCENE : GO;
    });
    document.querySelectorAll('.cw-acts [data-a]').forEach(b => {
      if (b.getAttribute('title')) return;
      const a = b.dataset.a;
      b.title = a === 'save' ? 'Сохранить этот файл в выбранную папку'
        : a === 'lib' ? 'Положить в Библиотеку'
        : a === 'up' ? 'Увеличить и сделать чётче: новый файл в Библиотеке, этот останется'
        : a === 'mont' ? 'Добавить этот клип в ленту монтажа'
        : a === 'use' ? 'Взять этот файл в другой режим' : '';
    });
    // most switches carry their explanation as a small line under the label: that line IS the hint
    document.querySelectorAll('button').forEach(b => {
      if (b.getAttribute('title') || b.classList.contains('h3q')) return;
      const s = b.querySelector(':scope > small') || b.querySelector('small'); if (!s) return;
      const head = (b.firstChild && b.firstChild.nodeType === 3 ? b.firstChild.textContent : '').replace(/\s+/g, ' ').trim();
      const foot = s.textContent.replace(/\s+/g, ' ').trim();
      if (!foot || foot.length < 4) return;
      b.title = (head && head !== foot ? head + ' · ' : '') + foot;
    });
    document.querySelectorAll('[data-pick]').forEach(b => { if (!b.getAttribute('title')) b.title = 'Показать окна с папками на компьютере и выбрать нужную'; });
    // switches whose meaning is a pair: the word on the button is not enough
    document.querySelectorAll('#view-agent [data-edit]').forEach(b => {
      if (b.getAttribute('title')) return;
      b.title = b.dataset.edit === '1'
        ? 'Правка: сценарист меняет ваш готовый промпт - добавляет детали, убирает лишнее'
        : 'Продолжить сюжет: сценарист пишет следующую сцену по тому, что уже есть';
    });
    document.querySelectorAll('#view-agent [data-k]').forEach(b => {
      if (b.getAttribute('title')) return;
      b.title = b.dataset.k === 'deep'
        ? 'Модель думает дольше и рассуждает: лучше для длинной истории и нескольких героев'
        : 'Модель отвечает сразу: быстрее, хватает для простой сцены';
    });
    const conn = document.querySelector('#view-agent .wz-go .btn.pri');
    if (conn && !conn.getAttribute('title')) conn.title = 'Проверить, отвечает ли выбранная модель, и начать с ней разговаривать';
    document.querySelectorAll('#view-models #mdGpuUiCb, #mdGpuUiCb').forEach(b => {
      if (!b.getAttribute('title')) b.title = 'Следить за загрузкой видеопамяти во время работы: полоска внизу окна';
    });
    document.querySelectorAll('#view-models [data-x], #view-models .btn').forEach(b => {
      if (b.getAttribute('title')) return;
      const x = (b.textContent || '').trim();
      if (x === 'Как это работает') b.title = 'Объяснение раздела: что скачивается, где лежит и как это связано с работой';
      else if (/арендованн/i.test(x)) b.title = 'Работать не на этом компьютере, а на арендованном: вписать адрес и ключ';
      else if (/своем ComfyUI|настройк/i.test(x)) b.title = 'Программа будет слать задания в тот ComfyUI, который вы уже запустили сами';
      else if (x === 'включена' || x === 'выключена') b.title = 'Нажмите, чтобы включить или выключить эту LoRA для раздела';
    });
    const rb = document.getElementById('agOwnReset');
    if (rb && !rb.getAttribute('title')) rb.title = 'Убрать свою модель разговора и вернуться к той, что идёт с программой';
    document.querySelectorAll('#view-library .btn, #view-queue .btn').forEach(b => {
      if (b.getAttribute('title')) return;
      const x = (b.textContent || '').trim();
      if (x === '−' || x === '–') b.title = 'Сделать плитки меньше - влезает больше';
      else if (x === '+') b.title = 'Сделать плитки крупнее';
      else if (/^Выбрать/.test(x)) b.title = 'Отметить или снять отметку со всех, что видно в этом фильтре';
    });
  }
  paint();
  let q = 0;
  new MutationObserver(() => { if (q) return; q = setTimeout(() => { q = 0; paint(); }, 700); })
    .observe(document.body, { childList: true, subtree: true });
})();

/* A closed fold hides the only place where the choice is visible, so the chosen thing is repeated
   in the heading of the fold itself. */
(() => {
  const now = document.getElementById('agNow');
  if (!now) return;
  const paint = () => {
    const on = document.querySelector('#agTarget button.on, #agTarget2 button.on');
    now.textContent = on ? on.textContent.trim() : '';
    now.hidden = !now.textContent;
  };
  ['agTarget', 'agTarget2'].forEach(id => {
    const box = document.getElementById(id);
    if (box) box.addEventListener('click', () => setTimeout(paint, 0));
  });
  paint();
})();

/* ── «Всё к сценаристу» там, где окно собрано не общей схемой: «Клип», «Видео», «Изменение изображения».
   Одно правило на всю программу: каждая карточка, в которой лежат файлы, предлагает их сценаристу -
   сколько бы файлов там ни было, хоть одно видео. Иконка говорит, что за вид; кнопка спит, пока
   брать нечего, и просыпается, как только файл появился. */
/* Hoisted on purpose: the rebuilt cards of a mode are created while the mode is still being
   assembled, long before the wiring at the end of this file runs. */
/* A video is only useful to the modes that watch it. If the Agent is set to write for another one,
   a press on «Всё к сценаристу» above a video moves the Agent to the mode of this card - that is what the
   person meant - instead of refusing with a lecture. */
/* The button was pressed inside a mode, so the Agent must write for that mode: without this the chat
   keeps the target it had (usually «Видео») and answers for another section than the one holding the
   files that just arrived. */
export function agPickTarget(mode) {
  if (!mode) return '';
  const b = $('#agTarget [data-t="' + mode + '"]') || $('#agTarget2 [data-t="' + mode + '"]');
  if (!b || b.classList.contains('on')) return '';
  b.click();
  return ' · «Промт для» переключено на «' + b.textContent.trim() + '»';
}
export function agMakeBtn(host, icon, what) {
  if (!host) return null;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn mini agall-h';
  b.textContent = icon + ' Всё к сценаристу';
  b.title = 'Сложить в чат сценариста ' + what + ' - он допишет к тому, что уже лежит, и ничего не очистит';
  b.addEventListener('click', e => e.stopPropagation());   // a press here must not fold the card
  host.append(b);
  return b;
}
/* Carrying a text a person already wrote into the Agent: the field gets it, «Промт для» switches to
   the engine that is actually chosen in this window, and the cursor lands where the work continues. */
/* Черновик, написанный в режиме, уходит сценаристу как есть: теги в нём указывают на файлы
   ИМЕННО этого режима, и они должны пережить перенос. Сценарист отвечает, и ответ ждётся
   обратно в том же поле - режим запоминается как адрес возврата, его файлы не трогаются. */
/* Переход на страницу сценариста. Прежний флаг «не переходить» в настройках убран: он берег
   человека от перелётов туда-сюда, когда кнопок переноса было несколько на каждой странице.
   Сама программа, нажимая кнопку внутри себя, человека никуда не уводит. */
export function agGo() {
  if (window.__agQuiet) return false;   // кнопку нажала сама программа: остаёмся на месте
  goTo('agent');
  return true;
}
export function agDraftOut(text, target, what) {
  const ta = $('#agIn');
  let t = ''; try { t = typeof target === 'function' ? target() : target; } catch (e) { t = ''; }
  const btn = t && ($('#agTarget [data-t="' + t + '"]') || ($('#agTarget2') && $('#agTarget2 [data-t="' + t + '"]')));
  if (btn && !btn.classList.contains('on')) btn.click();   // the Agent starts writing for this mode
  const body = String(text == null ? '' : text);
  const has = !!body.trim();
  let replaced = false;
  if (ta) {
    replaced = has && !!ta.value.trim() && ta.value.trim() !== body.trim();
    if (has) ta.value = body;                              // the draft replaces what was in the field
  }
  if (has && t) AG.draft = { to: t, at: Date.now() };      // where the finished text has to come back
  goTo('agent');
  setTimeout(() => { if (ta) { try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { } } }, 260);
  const where = btn ? btn.textContent.trim() : 'этот режим';
  toast(has
    ? ('Черновик передан сценаристу, цель «' + where + '»' + (replaced ? ' (текст в поле чата заменён)' : '')
      + ' · правьте и жмите «Создать промт», ответ вернётся в раздел кнопкой «В ' + where + '»')
    : 'Здесь ещё нет черновика: напишите ' + (what || 'текст') + ' в разделе, потом нажмите эту кнопку');
}
export function agPromptButton(host, what, get, target) {
  if (!host || typeof get !== 'function') return null;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn mini agall-h';
  b.textContent = '🤖 Текст к сценаристу';
  b.title = 'Перенести ' + what + ' в чат сценариста целиком, с тегами, включить нужное «Промт для»; ответ вернётся в это же поле';
  b.addEventListener('click', e => e.stopPropagation());   // a press here must not fold the card
  b.onclick = () => {
    agDraftOut(get(), typeof target === 'function' ? target() : target, what);
  };
  host.append(b);
  return b;
}
/* The scenes of a studio, in their real order and numbering: the Agent gets the same "SCENE N |
   seconds" sheet the studio itself speaks, so its answer can be poured back into the same cards. */
export function agScenesText(root) {
  const cards = (typeof $$ === 'function' ? $$('.sc', root) : []);
  const parts = [];
  cards.forEach((c, i) => {
    const ta = c.querySelector('textarea');
    const rg = c.querySelector('input[type=range]');
    const fresh = c.querySelector('.sc-fresh');
    const txt = ((ta && ta.value) || '').trim();
    if (!txt) return;
    parts.push('SCENE ' + (i + 1) + ' | ' + (+(rg && rg.value) || 10) + (fresh && fresh.checked ? ' | new' : '') + '\n' + txt);
  });
  return parts.join('\n\n');
}
export function agWireOtherWindows() {
  if (window._agWired) return;      // called once now and once later: the windows are wired once
  window._agWired = 1;
  const fileOf = el => {
    if (!el) return null;
    if (el._file) return el._file;
    if (el._src) return el._src;
    const i = el.querySelector && el.querySelector('input[type=file]');
    return (i && i.files && i.files[0]) || null;
  };
  const mk = (host, icon, what, count, run) => {
    if (!host) return null;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn mini agall-h';
    b.textContent = icon + ' Всё к сценаристу';
    b.title = 'Сложить в чат сценариста ' + what + ' - он допишет к тому, что уже лежит, и ничего не очистит';
    b._agCount = count;
    b.addEventListener('click', e => e.stopPropagation());   // a press here must not fold the card
    b.onclick = async () => { try { await run(); } catch (err) { toast('Не удалось передать файлы сценаристу: ' + (err && err.message ? err.message : err)); } };
    host.append(b);
    return b;
  };
  const goBtn = (card, target, label, get) => {
    if (!card) return;
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'btn mini agall-h';
    go.textContent = '🤖 Текст к сценаристу';
    go.title = 'Перенести текст раздела «' + label + '» в чат сценариста целиком, с тегами; ответ вернётся в это же поле';
    go.onclick = () => agDraftOut(get ? get() : '', target, 'черновик промпта');
    card.querySelector('.card-h').append(go);
  };
  const say = (what, added, again, tail) => toast(added ? ('В чат сценариста добавлено ' + what + ': ' + added + (again ? ' · ' + again + ' уже лежало' : '') + (tail || ''))
    : ('Всё это ' + what + ' уже лежит в чате сценариста' + (tail || '')));
  const sendPics = async (list, mode) => {
    if (!list.length) { toast('Файлов нет - сначала добавьте их'); return; }
    let added = 0, again = 0;
    for (const it of list) {
      if (AG.att.some(a => a.file && a.file.name === it.f.name && a.file.size === it.f.size)) { again++; continue; }
      if (await agAttachFile(it.f, it.note)) added++; else again++;
    }
    const moved = agPickTarget(mode);
    agGo(); say('файлов', added, again, moved);
  };

  // ···· «Видео из картинки»: кадры, из которых делают ролик (их может быть один или два)
  {
    const v = $('#view-video');
    if (v) {
      const drops = [$('#dFirst', v), $('#dLast', v)].filter(Boolean);
      const card = drops.length ? drops[0].closest('.card') : null;
      mk(card && card.querySelector('.card-h'), '🖼', 'кадры этого ролика - первый и последний',
        () => drops.filter(d => fileOf(d)).length,
        () => sendPics(drops.map((d, j) => ({ f: fileOf(d), note: (j ? 'последний' : 'первый') + ' кадр видео, тег <Picture ' + (j + 1) + '>' })).filter(x => x.f), 'video'));
      goBtn($('#vPrompt', v) && $('#vPrompt', v).closest('.card'), 'video', 'Видео', () => ($('#vPrompt') || {}).value);
    }
  }

  // ···· «Клип»: аудио, под которое герой говорит, и референсы лица
  {
    const lv = $('#view-lipsync');
    if (lv) {
      const aCard = $('#aDrop', lv) && $('#aDrop', lv).closest('.card');
      mk(aCard && aCard.querySelector('.card-h'), '🎧',
        'аудио этого Клипа - тот кусок, который пойдёт в ролик; Сценарист послушает слова',
        () => (typeof L !== 'undefined' && L.dur0) ? 1 : 0,
        async () => {
          if (!L.dur0) { toast('Сначала загрузите аудио'); return; }
          if (await speechReady()) return;
          const piece = wavSlice(abuf, L.start, L.end), dur = Math.max(0.1, L.len());
          const ok = await setChatAudio(piece, (typeof audioName === 'string' ? audioName : 'аудио из Клипа').replace(/\.[^.]+$/, ''), dur, 'аудио из «Клипа», тег <Audio 1>');
          const moved = agPickTarget('lipsync');
          agGo();
          say('аудио', ok ? 1 : 0, ok ? 0 : 1, moved);
        });
      const rCard = $('#refs', lv) && $('#refs', lv).closest('.card');
      mk(rCard && rCard.querySelector('.card-h'), '🖼', 'все референсы этого Клипа',
        () => $$('#refs label.ref', lv).filter(el => fileOf(el)).length,
        () => sendPics($$('#refs label.ref', lv).map((el, j) => ({ f: fileOf(el), note: 'референс персонажа, тег <Picture ' + (j + 1) + '>' })).filter(x => x.f), 'lipsync'));
      goBtn($('#lPrompt', lv) && $('#lPrompt', lv).closest('.card'), 'lipsync', 'Клип', () => ($('#lPrompt') || {}).value);
    }
  }

  // ···· «Изменение изображения»: картинка, которую правят, и референсы к ней
  {
    const qv = $('#view-qwen');
    if (qv) {
      const slots = $$('.qw-slots .drop', qv);
      const card = slots.length ? slots[0].closest('.card') : null;
      mk(card && card.querySelector('.card-h'), '🖼', 'все картинки этой правки',
        () => slots.filter(s => fileOf(s)).length,
        () => sendPics(slots.map((s, j) => ({ f: fileOf(s), note: 'картинка для правки, тег <Picture ' + (j + 1) + '>' })).filter(x => x.f), agQwenMode()));
    }
  }

  // ···· каждая такая кнопка спит, пока в её карточке нечего брать
  const btns = $$('.agall-h').filter(b => typeof b._agCount === 'function');
  if (!btns.length) return;
  // dragging a marker changes styles on every frame: check at most a few times a second, the button
  // does not need to wake in the same millisecond the file lands
  let last = 0, timer = null;
  const tick = () => {
    last = Date.now();
    btns.forEach(b => {
      let c = 0; try { c = b._agCount(); } catch (e) { c = 0; }
      b.disabled = !c;
    });
  };
  const sync = () => {
    const gap = Date.now() - last;
    if (gap >= 180) { if (timer) { clearTimeout(timer); timer = null; } tick(); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; tick(); }, 180 - gap);
  };
  const mo = new MutationObserver(sync);
  $$('.view').forEach(v => mo.observe(v, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'src', 'style'] }));
  document.addEventListener('change', sync, true);
  document.addEventListener('input', sync, true);
  window._agSync = sync;
  sync();
}
   // a second pass for a window built later
/* Общий хаб не импортирует разделы: сообщаем ему о своих значениях сами (core/state.js).
   Через них ui/audio.js дотягивается до сценариста, не импортируя этот раздел. */
registerViews({ AG, agGenerate, agGo, agStatus, needSpeech, setChatAudio, speechReady });
