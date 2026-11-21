// Прогон графа модулей НАСТОЯЩИМ движком ESM с заглушками браузера.
// Даёт тот же порядок исполнения тел, что браузер, и настоящий стек на первом
// падении: видно, какой модуль в каком теле прочитал чужое значение раньше,
// чем тот доинициализировался.
// Запуск: node --experimental-vm-modules esmrun.mjs <папка js> [точка входа]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(process.argv[2]);
const entry = process.argv[3] ? path.resolve(root, process.argv[3]) : path.resolve(root, 'app.js');

// ---------- браузер, которого хватит на тела модулей ----------
const ANY = () => stub;
function stub() { return ANY(); }
const timers = [];                       // отложенное: копим, не исполняем сами
const intervals = [];
function makeAny(name) {
  const target = [];                     // массив: тогда map/forEach/join работают по-настоящему
  const fn = function () { return any; };
  const any = new Proxy(target, {
    get(t, p) {
      if (p === Symbol.iterator) return [][Symbol.iterator].bind([]);
      if (p === 'length') return 0;
      if (p === 'toString') return () => '';
      if (p === 'then' || p === Symbol.toPrimitive) return undefined;   // не притворяться промисом
      if (p in t) return Reflect.get(t, p);
      return anyFn;
    },
    set(t, p, v) { t[p] = v; return true; },
    has() { return true; },
  });
  const anyFn = new Proxy(fn, {
    get(t, p) { return p === 'prototype' ? any : (p in any ? Reflect.get(any, p) : anyFn); },
    apply() { return any; },
    construct() { return any; },
  });
  return anyFn;
}
const any = makeAny('any');
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const document = new Proxy({
  readyState: 'complete',
  documentElement: any,
  head: any, body: any,
  createElement: () => any,
  createTextNode: () => any,
  querySelector: () => any,
  querySelectorAll: () => [any],
  getElementById: () => any,
  addEventListener: () => {},
  removeEventListener: () => {},
  hidden: false, visibilityState: 'visible',
  activeElement: null,
  fonts: { ready: Promise.resolve() },
}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'style' || p === 'classList') return any;
    return any;
  },
  set(t, p, v) { t[p] = v; return true; },
  has() { return true; },
});
const sandbox = {
  window: null, self: null, globalThis: null, document, localStorage, sessionStorage: localStorage,
  navigator: { userAgent: 'node', clipboard: { read: () => Promise.reject(new Error('нет буфера')) },
               clipboardItems: null, permissions: { query: () => Promise.resolve({ state: 'denied' }) } },
  location: { href: 'http://127.0.0.1:8765/', origin: 'http://127.0.0.1:8765', protocol: 'http:', host: '127.0.0.1:8765', pathname: '/' },
  fetch: (u) => Promise.resolve({ ok: false, status: 200, json: async () => [], text: async () => '', blob: async () => any, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } }),
  setTimeout: (f) => { timers.push(f); return timers.length; },
  setInterval: (f) => { intervals.push(f); return intervals.length; },
  clearTimeout: () => {}, clearInterval: () => {},
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  queueMicrotask: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, addListener: () => {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  indexedDB: { open: () => { throw new Error('нет indexedDB'); } },
  IDBKeyRange: { only: () => any, bound: () => any },
  console, performance: { now: () => 0 },
  Image: function () { return any; }, Audio: function () { return any; },
  AudioContext: function () { return any; }, webkitAudioContext: function () { return any; },
  WebSocket: function () { return { readyState: 0, onmessage: null, onclose: null, onerror: null, close: () => {}, send: () => {} }; },
  Worker: function () { return { postMessage: () => {}, terminate: () => {}, onmessage: null }; },
  URL, URLSearchParams, Blob: function () { return any; }, File: function (parts, name, opt) { return Object.assign({ name: (opt && opt.name) || name || 'f', size: 0, type: (opt && opt.type) || '', text: async () => '', arrayBuffer: async () => new ArrayBuffer(0), stream: () => any, slice: () => any }, {}); },
  FileReader: function () { return { readAsDataURL: () => {}, onload: null, onerror: null, result: 'data:,' }; },
  Uint8Array, Float32Array, ArrayBuffer, DataView, Intl, Path2D: function () { return any; },
  OffscreenCanvas: function () { return { getContext: () => any, width: 0, height: 0, transferToImageBitmap: () => any, convertToBlob: () => Promise.resolve(any) }; },
  DOMParser: function () { return { parseFromString: () => any }; },
  TextEncoder, TextDecoder, AbortController, Event: function () { return {}; },
  CustomEvent: function (t, o) { return { type: t, ...(o || {}) }; },
  MutationObserver: function () { return { observe: () => {}, disconnect: () => {} }; },
  ResizeObserver: function () { return { observe: () => {}, disconnect: () => {} }; },
  IntersectionObserver: function () { return { observe: () => {}, disconnect: () => {}, takeRecords: () => [] }; },
  structuredClone: (x) => JSON.parse(JSON.stringify(x === undefined ? null : x)),
  alert: () => {}, confirm: () => true, prompt: () => '',
  HTMLElement: function () { return any; }, Element: function () { return any; }, Node: function () { return any; },
  crypto: { randomUUID: () => 'x' },
  screen: { width: 1420, height: 980 }, devicePixelRatio: 1, innerWidth: 1420, innerHeight: 980,
  __H3_TOKEN: 'stub',
  __T: [],
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
// неизвестные браузерные имена (HTMLInputElement, MediaRecorder и прочее) не должны
// ронять прогон: наружу отдаём заглушку. Но только имена вида MutationObserver -
// собственные имена модулей (API, LIB, QUEUE, V) заглушкой не подменяются, иначе
// прогон перестал бы видеть настоящий «API is not defined».
const GLOBAL_SHAPE = /^[A-Z][a-z]/;
const globalProxy = new Proxy(sandbox, {
  has: (t, p) => p in t || (typeof p === 'string' && GLOBAL_SHAPE.test(p)),
  get(t, p) {
    if (p in t) return t[p];
    if (typeof p === 'symbol') return undefined;
    return makeAny(p);
  },
  set(t, p, v) { t[p] = v; return true; },
  defineProperty(t, p, d) { return Reflect.defineProperty(t, p, d); },
  getOwnPropertyDescriptor(t, p) { return Reflect.getOwnPropertyDescriptor(t, p); },
  ownKeys(t) { return Reflect.ownKeys(t); },
});
const context = vm.createContext(globalProxy);
vm.runInContext('Error.stackTraceLimit = 100', context);

// ---------- граф модулей: тот же порядок, что у браузера ----------
const cache = new Map();
const order = [];
const compile = abs => {
  if (!cache.has(abs)) {
    // метка в самое начало строки: номера строк не съезжают, и по __T видно,
    // чьё тело исполнялось в момент падения и в каком порядке тела вообще шли
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const src = "__T.push('" + rel + "');" + fs.readFileSync(abs, 'utf8') + "\n;__T.push('| готово ' + '" + rel + "');";
    const m = new vm.SourceTextModule(src, { identifier: abs, context });
    m.__file = abs;
    cache.set(abs, m);
  }
  return cache.get(abs);
};
const link = (spec, ref) => {
  const from = ref && ref.__file ? path.dirname(ref.__file) : path.dirname(entry);
  let t = path.resolve(from, spec);
  if (!fs.existsSync(t) && fs.existsSync(t + '.js')) t += '.js';
  if (!fs.existsSync(t)) throw new Error('нет файла модуля ' + spec);
  return compile(t);
};
let linkError = null;
try {
  await compile(entry).link(link);
} catch (e) {
  linkError = e;
}
if (linkError) {
  // граф не собрался: отсутствующий экспорт или битый путь - это и есть падение
  console.log('ПАДЕНИЕ: ' + (linkError.message || linkError));
  console.log('===ВСЁ===');
  process.exit(0);
}

// порядок исполнения тел: список импортов у связанного модуля появляется не во всех
// версиях node, поэтому пробуем и молча пропускаем, если его нет
try {
  (function trace(m, seen = new Set()) {
    if (seen.has(m)) return;
    seen.add(m);
    const deps = m.importedModules;
    if (deps) for (const dep of deps) trace(dep, seen);
    order.push(path.relative(root, m.__file).split(path.sep).join('/'));
  })(compile(entry));
} catch { order.push('(порядок недоступен)'); }

let failed = null;
try {
  await compile(entry).evaluate();
} catch (e) {
  failed = e;
}
console.log('порядок тел: ' + order.join(' -> '));
if (failed) {
  console.log('ПАДЕНИЕ: ' + (failed && failed.message || failed));
  console.log('--- стек ---');
  console.log(String((failed && failed.stack) || '(стека нет)'));
  console.log('--- тела успели исполниться (в порядке): ' + JSON.stringify(sandbox.__T) );
  const last = sandbox.__T[sandbox.__T.length - 1];
  console.log('--- тело, на котором упало: ' + last + ' (оно ещё не кончилось)');
} else {
  console.log('порядок тел: ' + JSON.stringify(sandbox.__T));
  console.log('тела всех модулей исполнились без падения');
}
console.log('таймеров накоплено: setTimeout ' + timers.length + ', setInterval ' + intervals.length);
console.log('===ВСЁ===');
