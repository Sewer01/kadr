import { $, $$, confirmBox, fileKind, isImage, toast } from '../core/util.js';
import { MODE_NAME } from '../core/modes.js';
import { activeView, goTo } from '../core/tabs.js';
import { ASPECTS } from './params.js';
import { agFramesFromFile } from '../views/agent.js';
import { RM } from '../views/modes.js';

export const KIND_WORD = { image: 'картинки', video: 'видео', audio: 'звук' };
export const dropBox = view => view === 'video' ? $('#view-video') : view === 'lipsync' ? $('#view-lipsync')
  : view === 'upscale' ? $('#view-upfile') : view === 'qwen' ? $('#view-qwen')
  : view === 'krea' ? $('#view-krea') : view === 'agent' ? $('#view-agent') : (RM[view] && RM[view].root) || null;
export const dropAccepts = view => view === 'upscale' ? ['video'] : view === 'lipsync' ? ['image', 'audio']
  : view === 'video' || view === 'qwen' || view === 'krea' ? ['image']
  : view === 'agent' ? ['image', 'video', 'audio'] : ['image', 'video', 'audio'];
export let DROP_IN_SCENES = false;   // a drop on the scenes card feeds the scene's own places, not the common ones
export const dropSlots = (view, kind) => {
  const box = dropBox(view); if (!box) return [];
  if (view === 'agent') return [$(kind === 'image' ? '#agFile' : kind === 'audio' ? '#agAudioFile' : '#agVidFile', box)].filter(Boolean);
  if (view === 'video') return $$('label.drop:not(.filled) input', box);
  if (view === 'upscale') return kind === 'video' ? $$('input', $('#upDrop')) : [];
  if (view === 'qwen') return kind === 'image' ? $$('#qwDrop, #qwDrop2, #qwDrop3').filter(d => !d.classList.contains('filled')).map(d => $('input', d)) : [];
  if (view === 'lipsync') {
    if (kind === 'image') return $$('#refs label.ref:not(.filled) input', box);
    return kind === 'audio' && !$('.audio-ed.on', box) ? [$('#aFile')].filter(Boolean) : [];
  }
  if (view === 'long' && kind === 'image' && DROP_IN_SCENES) {
    const sc = $('.sc.sel', box) || $('.sc', box);
    return sc ? $$('.ref.own:not(.filled) input', sc) : [];
  }
  const sel = { image: '.rm-imgs label.ref:not(.filled) input', video: '.rm-vids label:not(.filled) input', audio: '.rm-auds label:not(.filled) input' }[kind];
  return sel ? $$(sel, box) : [];
};
/* The program keeps a copy of the pictures a result was made from; "repeat with these settings"
   puts them back into the places, so the texts of the prompt still point at real pictures. */
export const REF_KINDS = { image: ['label.ref', 'image/png'], video: ['.rm-vids label', 'video/mp4'], audio: ['.rm-auds label', 'audio/mpeg'] };
export async function repeatRefs(it) {
  const box = dropBox(it.mode); if (!box || !(it.refs || []).length || !it.ref_group) return 0;
  const used = {};
  let n = 0;
  for (const nm of it.refs) {
    const m = /^\d+_(image|video|audio)_/.exec(nm);
    const kind = m ? m[1] : 'image';
    const [sel, mime] = REF_KINDS[kind] || REF_KINDS.image;
    const labels = used[kind] || (used[kind] = $$(sel, box).filter(l => $('input[type=file]', l)));
    const lb = labels.find(l => !l.classList.contains('filled')); if (!lb) continue;
    try {
      const r = await fetch(`/api/refs/${it.ref_group}/${encodeURIComponent(nm)}`); if (!r.ok) continue;
      await setDropFile($('input[type=file]', lb), new File([await r.blob()], nm.replace(/^\d+_(image|video|audio)_/, ''), { type: r.headers.get('content-type') || mime }));
      n++;
    } catch { }
  }
  return n;
}
export async function spreadFiles(files, view) {
  const bad = [], left = [], nofit = [];
  const byKind = { image: [], video: [], audio: [] };
  files.forEach(f => { const k = fileKind(f); if (k && (k !== 'image' || isImage(f))) byKind[k].push(f); else bad.push(f.name); });
  let placed = 0;
  for (const kind of ['image', 'video', 'audio']) {
    const list = byKind[kind]; if (!list.length) continue;
    if (!dropAccepts(view).includes(kind)) { nofit.push({ kind, list }); continue; }
    if (view === 'agent' && kind === 'video') {   // the agent understands a video only as frames: that is what we cut
      for (const f of list) { if (await agFramesFromFile(f)) placed++; }
      continue;
    }
    const slots = dropSlots(view, kind);
    for (let i = 0; i < list.length; i++) {
      if (!slots[i]) { left.push(list[i].name); continue; }
      await setDropFile(slots[i], list[i]); placed++;
    }
  }
  return { placed, bad, left, nofit };
}
export function dropNotes(r) {
  const list = a => a.slice(0, 3).join(', ') + (a.length > 3 ? ` и ещё ${a.length - 3}` : '');
  const out = [];
  if (r.placed) out.push(`загружено: ${r.placed}`);
  if (r.left.length) out.push(`свободных мест не хватило на: ${list(r.left)}`);
  if (r.bad.length) out.push(`формат не подходит: ${list(r.bad)}`);
  r.nofit.forEach(n => out.push(`${KIND_WORD[n.kind]} в этот раздел не кладётся`));
  return out.join(' · ');
}
export const DROP_HOME = { audio: 'lipsync', video: 'swap', image: 'video' };   // куда предложить, если сейчас некуда
export async function handleDrop(e) {
  const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
  if (!files.length) return;
  const card = e.target && e.target.closest ? e.target.closest('.card') : null;
  DROP_IN_SCENES = !!(card && card.querySelector('.lm-scenes'));
  await routeFiles(files);
}
/* how a file gets into the section that is open now: used by a drag from Explorer and by a paste alike */
export async function routeFiles(files) {
  if (!files.length) return;
  const view = activeView();
  if (!view || !dropBox(view)) { toast('Бросьте файлы в раздел генерации, в чат Агента или в окно увеличения'); return; }
  const r = await spreadFiles(files, view);
  DROP_IN_SCENES = false;
  const text = dropNotes(r);
  if (r.placed) toast(text); else if (text) toast(text);
  if (!r.placed && r.nofit.length) {                 // раздел не для этого типа: предложим подходящий
    const kind = r.nofit[0].kind, home = DROP_HOME[kind];
    if (home && home !== view) confirmBox(`Положить в «${MODE_NAME[home] || home}»?`,
      `${KIND_WORD[kind]} в разделе «${MODE_NAME[view] || view}» не используется. Перейти в «${MODE_NAME[home] || home}» и загрузить туда?`, 'Перейти', async () => {
        goTo(home); await new Promise(res => setTimeout(res, 250));
        const r2 = await spreadFiles(r.nofit[0].list, home);
        toast(dropNotes(r2) || 'Не получилось: раздел ещё не готов');
      });
  }
}
/* ---------- pictures and the clipboard ----------
   Chromium does not let the page read or write the picture clipboard, so the program does it. */
// reference slots take the shape of the picture: 16:9 wide, 9:16 tall, square square
export function fitSlot(r, img) {
  const go = () => {
    const ratio = Math.min(16 / 9, Math.max(9 / 16, img.naturalWidth / img.naturalHeight));
    r.style.width = `calc(var(--refh, 148px) * ${ratio.toFixed(4)})`;   // the row keeps one height, the width follows the photo
    r.classList.toggle('wide', ratio > 1.2);
  };
  img.complete && img.naturalWidth ? go() : img.addEventListener('load', go, { once: true });
}
export function resetSlot(r) { r.style.aspectRatio = ''; r.style.width = ''; r.classList.remove('wide'); }

/* ---------- cells of pictures ----------
   dragging a filled cell onto another swaps them: the order of the cells is the order of
   Picture 1, 2… in the prompt, and re-uploading a picture to change its place is annoying */
export function slotShow(r, src, file) {
  const img = $('img', r), plus = $('.plus', r), tag = $('.tag', r);
  if (!src) {
    if (img) img.remove();
    r._file = null; r.classList.remove('filled'); resetSlot(r);
    if (plus) plus.hidden = false;
    if (tag) tag.hidden = true;
    return;
  }
  const el = img || document.createElement('img');
  if (!img) r.prepend(el);
  el.src = src;
  if (file !== undefined) r._file = file;
  r.classList.add('filled');
  if (plus) plus.hidden = true;
  fitSlot(r, el);
}
export function wireSlotSwap(zones, after) {
  let from = null;
  zones.forEach(z => {
    z.draggable = true;
    z.addEventListener('dragstart', e => {
      if (!z._file) { e.preventDefault(); return; }
      from = z;
      try { e.dataTransfer.setData('text/plain', 'h3-slot'); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    z.addEventListener('dragend', () => { from = null; });
    z.addEventListener('dragover', e => { if (from && from !== z) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch {} } });
    z.addEventListener('drop', e => {
      if (!from || from === z) return;
      e.preventDefault(); e.stopPropagation();
      const a = from, b = z;
      const fa = a._file, pa = slotShowPicture(a), fb = b._file, pb = slotShowPicture(b);
      slotShow(b, pa, fa); slotShow(a, pb, fb);
      from = null;
      if (after) after();
    });
  });
}
export const slotShowPicture = r => ($('img', r) || {}).src || '';
export const clearSlots = zones => zones.forEach(z => { const x = $('.x', z); if (x) x.click(); });

// pick the format closest to a picture's proportions once it has loaded
export function fitAspect(st, img, upd, force) {
  if ((st.userAspect && !force) || (st.locked && st.locked())) return;
  const apply = () => {
    const r = img.naturalWidth / img.naturalHeight; if (!r) return;
    const best = ASPECTS.reduce((a, b) => Math.abs(Math.log(b.w / b.h / r)) < Math.abs(Math.log(a.w / a.h / r)) ? b : a);
    if (best.id === st.aspect) return;
    st.aspect = best.id; upd();
    toast(`Формат подстроен под изображение: ${best.name}${best.name !== best.id ? ' ' + best.id : ''}`);
  };
  img.complete && img.naturalWidth ? apply() : img.addEventListener('load', apply, { once: true });
}

export function wireDrop(zone, onFile) {
  const input = $('input', zone);
  const set = file => {
    if (!isImage(file)) return;
    zone._file = file;
    let img = $('img', zone); if (!img) { img = document.createElement('img'); zone.prepend(img); }
    img.onerror = () => { URL.revokeObjectURL(img.src); res(null); };   // иначе промис не завершается и чат зависает навсегда
    img.src = URL.createObjectURL(file);
    zone.classList.add('filled'); $('.ph', zone).hidden = true;
    const tag = $('.tag', zone); if (tag) tag.hidden = false;
    onFile(true, img);
  };
  input.onchange = () => set(input.files[0]);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); set(e.dataTransfer.files[0]); });
  const x = $('.x', zone);
  if (x) x.onclick = e => { e.preventDefault(); e.stopPropagation(); clear(); };
  function clear() {
    zone._file = null;
    $('img', zone)?.remove(); zone.classList.remove('filled'); $('.ph', zone).hidden = false;
    const tag = $('.tag', zone); if (tag) tag.hidden = true; input.value = ''; onFile(false);
  }
  return { clear };
}

// send a finished prompt into a generator, with the chat's pictures
export async function setDropFile(input, file) { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change')); }
