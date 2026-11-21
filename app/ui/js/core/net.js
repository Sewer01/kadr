export const H3_TOKEN = window.__H3_TOKEN || '';
export const rawFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const path = typeof input === 'string' ? input : (input && input.url) || '';
  if (path.startsWith('/api/')) {
    const o = Object.assign({}, init || {});
    o.headers = new Headers(o.headers || {});
    o.headers.set('X-H3-Token', H3_TOKEN);
    return rawFetch(input, o);
  }
  return rawFetch(input, init);
};

/* ---------- local server (real ComfyUI) or offline demo ---------- */
export const API = location.protocol.startsWith('http');
export async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { error: txt }; }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
/* У FreeVideo в результатах работы отдельной строчкой пишут «карту держит другая программа» и
   «перегрев ограничил скорость». Мы говорим то же самое прямо в очереди, пока идёт расчёт:
   так человек видит, что тормозит не модель, а что-то рядом с ней. */
