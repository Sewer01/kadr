import './core/net.js';
import './core/util.js';
import './ui/slots.js';
import './core/tabs.js';
import './ui/scenario.js';
import './views/system.js';
import './ui/params.js';
import './ui/preview.js';
import './core/modes.js';
import './views/modes.js';
import './ui/audio.js';
import './views/setup.js';
import './views/agent.js';
import './views/models.js';
import './core/state.js';
import './views/library.js';
import './views/queue.js';
import './views/presets.js';
import './views/images.js';
import './views/workflows.js';
import './views/montage.js';

import { H3_TOKEN } from './core/net.js';
import { PIC_EXT, clipboardHasImage, toast } from './core/util.js';
import { QUEUE, earlyEvents } from './core/state.js';
import { previewHandlers, promptHandlers } from './ui/scenario.js';
import { handleDrop, routeFiles } from './ui/slots.js';
import { agWireOtherWindows, onAgentSetup } from './views/agent.js';
import { loadCloud, onMdl } from './views/models.js';
import { qHandle } from './views/queue.js';
import { onSetupEvent } from './views/setup.js';
import { loadStatus, pollSystem, setEngine } from './views/system.js';
async function pasteFromClipboard() {
  try {
    const r = await fetch('/api/clipboard/image', { cache: 'no-store' });
    if (!r.ok) return null;
    const blob = await r.blob(), type = blob.type || 'image/png';
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    return new File([blob], `картинка-из-буфера-${stamp}.${PIC_EXT[type] || 'png'}`, { type });
  } catch { return null; }
}
let PASTE_AT = 0;   // when the browser hands the paste over itself, the key handler below stays out of the way
document.addEventListener('paste', async e => {   // Ctrl+V: a picture goes into the open section, text stays text
  PASTE_AT = Date.now();
  const dt = e.clipboardData;
  const direct = [...((dt && dt.files) || [])].filter(f => (f.type || '').startsWith('image/'));
  if (direct.length) { e.preventDefault(); await routeFiles(direct); return; }
  if (!(await clipboardHasImage())) return;
  const el = e.target || {};
  const inText = el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && el.type !== 'file');
  if (inText && dt && [...((dt.types) || [])].includes('text/plain') && (dt.getData('text/plain') || '').trim()) return;
  e.preventDefault();
  const f = await pasteFromClipboard();
  if (!f) { toast('Картинку из буфера обмена не удалось прочитать'); return; }
  await routeFiles([f]);
});

/* WebView2 does not always hand a bare bitmap over as a paste (a screenshot, a copy from a viewer),
   so if the browser stayed silent for a moment, the program reads the clipboard itself */
addEventListener('keydown', e => {
  if (!((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'v') || e.altKey) return;
  const mark = Date.now();
  setTimeout(async () => {
    if (PASTE_AT >= mark) return;                       // the page already pasted what the browser gave
    if (!(await clipboardHasImage())) return;           // plain text: the usual text paste has happened
    const f = await pasteFromClipboard();
    if (f) await routeFiles([f]);
  }, 260);
});

/* F5 and Ctrl+R: the page reloads without restarting the program. The window has the browser's own
   keys turned off, so the app catches them itself; the section you were working in comes back by the saved one */
addEventListener('keydown', e => {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'r')) {
    e.preventDefault(); location.reload();
  }
});

document.addEventListener('dragover', e => {
  const dt = e.dataTransfer; if (!dt || ![...(dt.types || [])].includes('Files')) return;
  if (e.target.closest('label.drop, label.ref, label.slot, #agAtt, #upDrop, #aDrop, .audio-empty')) return;   // эти зоны принимают файл сами
  e.preventDefault(); dt.dropEffect = 'copy';
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', e => {
  document.body.classList.remove('dropping');
  const dt = e.dataTransfer; if (!dt || ![...(dt.types || [])].includes('Files')) return;
  if (e.defaultPrevented) return;                     // файл бросили ровно в слот — он сам всё сделал
  e.preventDefault();
  handleDrop(e);
});

/* Dragging a video into the chat splits the screen in two: left means "cut it into frames", right
   means "keep it a file".

   This code only LOOKS at the drag. It never calls preventDefault and never stops the event - once
   it did, and the program stayed in the "a file is being dragged" state after the drop: dashed
   frames hung over the whole window and the top buttons stopped answering. Where the file lands is
   remembered from the cursor position and read later by the ordinary unpacking below. */
(() => {
  // The screen used to split in half during a drag, offering frames on the left and the whole file on
  // the right. The agent cannot read a video file, so the choice only misled: a video is always cut
  // into frames now. What is kept here is the safety net that wipes the dashed outline after a drag.
  const off = () => document.body.classList.remove('dropping');
  ['dragend', 'dragexit'].forEach(ev => document.addEventListener(ev, off, true));
  document.addEventListener('drop', off, true);          // does not touch the event: the program unpacks it itself
  addEventListener('blur', off);
  addEventListener('keyup', e => { if (e.key === 'Escape') off(); });
})();

function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/api/events?token=${H3_TOKEN}`);   // the key is hex only
  ws.binaryType = 'blob';
  ws.onmessage = e => {
    if (typeof e.data !== 'string') { const rj = QUEUE.find(x => x.state === 'running'); if (rj) rj.lastEv = performance.now(); previewHandlers.forEach(f => f(e.data)); return; }
    const m = JSON.parse(e.data);
    if (m.type === 'engine') { setEngine(m.online); if (m.online) loadStatus(); return; }
    if (m.type === 'notice') { toast(m.text); return; }
    if (m.type === 'setup') { onSetupEvent(m); return; }
    if (m.type === 'agent_setup') { onAgentSetup(m); return; }
    if (m.type === 'mdl') { onMdl(m); return; }
    qHandle(m);
    const fn = promptHandlers.get(m.prompt_id);
    if (fn) fn(m);
    else if (m.prompt_id) earlyEvents.set(m.prompt_id, [...(earlyEvents.get(m.prompt_id) || []), m].slice(-50));
  };
  ws.onclose = () => { setEngine(false); setTimeout(connectEvents, 2000); };
}
connectEvents(); loadStatus(); loadCloud(); pollSystem();
if (document.readyState === 'complete') agWireOtherWindows();
else window.addEventListener('load', agWireOtherWindows);
setTimeout(agWireOtherWindows, 2500);
