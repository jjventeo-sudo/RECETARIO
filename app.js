/* =========================================================================
   Recetario — lógica de la app
   Estructura:
     1. Utilidades          6. Router
     2. Base de datos       7. Vistas: inicio, receta, editor, cocina, ajustes
     3. Fotos               8. Editor de foto
     4. Almacén de recetas  9. Copias (exportar / importar)
     5. Interfaz común     10. Arranque (service worker, persistencia)
   Todo se guarda en el propio dispositivo (IndexedDB). Nada sale a internet.
   ========================================================================= */
'use strict';

const APP_VERSION = '1.7.0';

/* =========================================================================
   1. Utilidades
   ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escapa texto para insertarlo de forma segura en HTML. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

/** Quita tildes y pasa a minúsculas para buscar sin importar acentos. */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const UNITS = [
  { v: '', l: '—' }, { v: 'g', l: 'g' }, { v: 'kg', l: 'kg' }, { v: 'ml', l: 'ml' }, { v: 'l', l: 'l' },
  { v: 'cda', l: 'cda' }, { v: 'cdta', l: 'cdta' }, { v: 'taza', l: 'taza' }, { v: 'ud', l: 'ud' },
  { v: 'diente', l: 'diente' }, { v: 'pizca', l: 'pizca' }, { v: 'al gusto', l: 'al gusto' },
];
const NO_SCALE_UNITS = new Set(['pizca', 'al gusto']);
const PLURALS = { diente: 'dientes', taza: 'tazas', pizca: 'pizcas' };

/** Texto de cantidad + unidad listo para mostrar: "2 dientes", "½ taza", "al gusto". */
function qtyLabel(q, unit) {
  if (unit === 'al gusto') return q == null ? 'al gusto' : `${formatQty(q, unit)} al gusto`;
  const n = formatQty(q, unit);
  const u = unit && q != null && q > 1 && PLURALS[unit] ? PLURALS[unit] : unit;
  return [n, u].filter(Boolean).join(' ');
}

const CATEGORY_SUGGESTIONS = ['Entrantes', 'Arroces', 'Pastas', 'Carnes', 'Pescados', 'Verduras', 'Guisos', 'Postres', 'Panes y masas', 'Salsas', 'Bebidas'];

/** Convierte "1/2", "1 1/2", "1,5" o "½" en número. Devuelve null si está vacío. */
function parseQty(input) {
  const s = String(input ?? '').trim().replace(',', '.')
    .replace('½', ' 1/2').replace('¼', ' 1/4').replace('¾', ' 3/4').replace('⅓', ' 1/3').replace('⅔', ' 2/3').trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  let total = 0;
  for (const p of parts) {
    if (p.includes('/')) {
      const [a, b] = p.split('/').map(Number);
      if (!b || Number.isNaN(a) || Number.isNaN(b)) return null;
      total += a / b;
    } else {
      const n = Number(p);
      if (Number.isNaN(n)) return null;
      total += n;
    }
  }
  return total;
}

const FRACTIONS = [[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']];
const nf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });

/** Muestra cantidades de forma natural para cocinar: 1½, 250, 0,3… */
function formatQty(n, unit) {
  if (n == null) return '';
  if (['g', 'ml'].includes(unit) && n >= 10) return nf.format(Math.round(n));
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  if (frac < 0.02) return String(whole);
  if (frac > 0.98) return String(whole + 1);
  if (!['g', 'ml', 'kg', 'l'].includes(unit)) {
    for (const [v, sym] of FRACTIONS) if (Math.abs(frac - v) < 0.03) return (whole || '') + sym;
  }
  return nf.format(Math.round(n * 100) / 100);
}

/** Cantidad para el campo de edición: fracciones de cocina si encajan (¼, 1½…), si no decimales. */
function editQty(n) {
  if (n == null) return '';
  const whole = Math.floor(n + 1e-9), frac = n - whole;
  if (frac < 0.005) return String(whole);
  for (const [v, sym] of FRACTIONS) if (Math.abs(frac - v) < 0.005) return (whole || '') + sym;
  return nf.format(n);
}

function formatMinutes(min) {
  const m = Number(min) || 0;
  if (!m) return '';
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function formatClock(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatBytes(b) {
  if (!b) return '0 MB';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${nf.format(Math.round(b / 1024 / 1024 * 10) / 10)} MB`;
  return `${nf.format(Math.round(b / 1024 ** 3 * 10) / 10)} GB`;
}

/* =========================================================================
   2. Base de datos (IndexedDB)
   ========================================================================= */

const DB = (() => {
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('recetario', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        const make = (name, key) => { if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: key }); };
        make('recipes', 'id');
        make('images', 'id');
        make('tombstones', 'id'); // recetas borradas (para sincronizar)
        make('meta', 'key');
        make('trash', 'id');      // v2: papelera de 30 días (solo en este dispositivo)
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transacción cancelada'));
    });
  }

  return {
    get: (store, key) => tx(store, 'readonly', (t) => wrap(t.objectStore(store).get(key))),
    all: (store) => tx(store, 'readonly', (t) => wrap(t.objectStore(store).getAll())),
    keys: (store) => tx(store, 'readonly', (t) => wrap(t.objectStore(store).getAllKeys())),
    put: (store, value) => tx(store, 'readwrite', (t) => wrap(t.objectStore(store).put(value))),
    del: (store, key) => tx(store, 'readwrite', (t) => wrap(t.objectStore(store).delete(key))),
    tx,
    wrap,
  };
})();

const Meta = {
  async get(key, fallback = null) { const r = await DB.get('meta', key); return r ? r.value : fallback; },
  set(key, value) { return DB.put('meta', { key, value }); },
};

/* =========================================================================
   3. Fotos
   ========================================================================= */

const Images = (() => {
  const urlCache = new Map();

  async function url(id) {
    if (!id) return null;
    if (urlCache.has(id)) return urlCache.get(id);
    const rec = await DB.get('images', id);
    if (!rec) return null;
    const u = URL.createObjectURL(rec.blob);
    urlCache.set(id, u);
    return u;
  }

  async function save(blob) {
    const id = uid();
    await DB.put('images', { id, blob, createdAt: Date.now() });
    return id;
  }

  function forget(id) {
    const u = urlCache.get(id);
    if (u) URL.revokeObjectURL(u);
    urlCache.delete(id);
  }

  /** Precarga las URLs de una lista de ids (para pintar sin parpadeos). */
  async function preload(ids) {
    await Promise.all([...new Set(ids.filter(Boolean))].map(url));
  }

  const cached = (id) => (id ? urlCache.get(id) || null : null);

  /**
   * Oscurece a negro puro los tonos casi negros (el fondo que la IA no clava).
   * threshold: 0–60. Transición suave de 14 niveles para no crear escalones.
   */
  function cleanBackground(ctx, w, h, threshold) {
    if (!threshold) return;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const soft = 14;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(d[i], d[i + 1], d[i + 2]);
      if (m <= threshold) { d[i] = d[i + 1] = d[i + 2] = 0; }
      else if (m < threshold + soft) {
        const k = (m - threshold) / soft;
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /**
   * Dibuja la foto en un canvas: recorte cuadrado centrado (portadas) o
   * proporción original (pasos), limitado a maxSide píxeles.
   */
  function render(bitmap, { square, maxSide, threshold }) {
    let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
    if (square) {
      const side = Math.min(sw, sh);
      sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
    }
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
    cleanBackground(ctx, w, h, threshold);
    return canvas;
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b && b.type === 'image/webp') return resolve(b);
        // Si el navegador no sabe hacer WebP, JPEG de alta calidad
        canvas.toBlob((j) => (j ? resolve(j) : reject(new Error('No se pudo procesar la foto'))), 'image/jpeg', 0.9);
      }, 'image/webp', 0.86);
    });
  }

  /** Borra fotos que ya no usa ninguna receta. */
  async function collectGarbage() {
    // Las fotos de las recetas de la papelera también se conservan, para poder restaurarlas
    const recipes = [...(await DB.all('recipes')), ...(await DB.all('trash')).map((t) => t.recipe)];
    const used = new Set();
    for (const r of recipes) {
      if (r.coverImageId) used.add(r.coverImageId);
      for (const v of r.versions) for (const s of [...v.prep, ...v.cook]) if (s.imageId) used.add(s.imageId);
    }
    // Solo fotos huérfanas de más de 1 hora: así nunca se borra la foto
    // que acabas de añadir a una receta que todavía estás editando.
    const images = await DB.all('images');
    const limit = Date.now() - 3600e3;
    const orphan = images.filter((i) => !used.has(i.id) && (i.createdAt || 0) < limit).map((i) => i.id);
    if (!orphan.length) return;
    await DB.tx('images', 'readwrite', (t) => { orphan.forEach((id) => t.objectStore('images').delete(id)); });
    orphan.forEach(forget);
  }

  return { url, save, preload, cached, render, toBlob, collectGarbage, forget, cleanBackground };
})();

/* =========================================================================
   4. Almacén de recetas
   ========================================================================= */

/* Modelo:
   Recipe  { id, name, category, favorite, coverImageId, createdAt, updatedAt, lastCookedAt, versions: [Version] }
   Version { id, name, servings, minutes, ingredients: [{id, qty, unit, name}], prep: [Step], cook: [Step], notes }
   Step    { id, text, imageId, timerMin }
   Cada versión es completa e independiente (ingredientes y pasos propios). */

const Store = {
  async list() {
    const all = await DB.all('recipes');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get: (id) => DB.get('recipes', id),

  async save(recipe) {
    recipe.updatedAt = Date.now();
    await DB.put('recipes', recipe);
    await Meta.set('lastChange', Date.now());
    requestPersistence();
    Images.collectGarbage().catch(() => {});
    Sync.schedule();
    return recipe;
  },

  /** Marcas que no cambian el contenido (favorito, cocinada): no cuentan como edición. */
  async touch(recipe) { recipe.updatedAt = Date.now(); await DB.put('recipes', recipe); Sync.schedule(); return recipe; },

  /** Borrar = mover a la papelera (30 días). El borrado se sincroniza; la papelera es de este dispositivo. */
  async remove(id) {
    const recipe = await DB.get('recipes', id);
    await DB.tx(['recipes', 'tombstones', 'trash'], 'readwrite', (t) => {
      t.objectStore('recipes').delete(id);
      t.objectStore('tombstones').put({ id, deletedAt: Date.now() });
      if (recipe) t.objectStore('trash').put({ id, recipe, deletedAt: Date.now() });
    });
    await Meta.set('lastChange', Date.now());
    Images.collectGarbage().catch(() => {});
    Sync.schedule();
  },

  /** Sacar de la papelera: vuelve con fecha nueva, así gana al borrado en los demás dispositivos. */
  async restore(id) {
    const item = await DB.get('trash', id);
    if (!item) return null;
    const recipe = { ...item.recipe, updatedAt: Date.now() };
    await DB.tx(['recipes', 'tombstones', 'trash'], 'readwrite', (t) => {
      t.objectStore('recipes').put(recipe);
      t.objectStore('tombstones').delete(id);
      t.objectStore('trash').delete(id);
    });
    await Meta.set('lastChange', Date.now());
    Sync.schedule();
    return recipe;
  },
  trash: async () => (await DB.all('trash')).sort((a, b) => b.deletedAt - a.deletedAt),
  async purge(id) { await DB.del('trash', id); Images.collectGarbage().catch(() => {}); },
  /** Lo que lleva más de 30 días en la papelera se borra de verdad. */
  async purgeOld() {
    const limit = Date.now() - 30 * 864e5;
    const old = (await DB.all('trash')).filter((t) => t.deletedAt < limit);
    for (const t of old) await DB.del('trash', t.id);
  },

  newVersion(name = 'Original') {
    return { id: uid(), name, servings: 4, minutes: 0, ingredients: [], prep: [], cook: [], notes: '' };
  },

  newRecipe() {
    const now = Date.now();
    return { id: uid(), name: '', category: '', favorite: false, coverImageId: null, createdAt: now, updatedAt: now, lastCookedAt: null, versions: [Store.newVersion()] };
  },

  /** Copia una versión con ids nuevos (las fotos se comparten, no se duplican). */
  duplicateVersion(v, name) {
    const c = clone(v);
    c.id = uid(); c.name = name;
    c.ingredients.forEach((i) => { i.id = uid(); });
    [...c.prep, ...c.cook].forEach((s) => { s.id = uid(); });
    return c;
  },
};

/* =========================================================================
   4b. Documentos sincronizables: menú semanal y lista de la compra
   Cada documento es un mapa clave → entrada con su propia fecha de cambio.
   Al sincronizar gana, clave a clave, la entrada más reciente; así puedes
   tachar en el móvil mientras añades cosas en la tablet sin pisarte.
   Las entradas borradas se guardan como { removed: true } para que el borrado viaje.
   ========================================================================= */

const Docs = (() => {
  const NAMES = ['plan', 'shopRecipes', 'shopManual', 'shopChecks', 'categories', 'pantry'];
  const listeners = new Set();

  const get = async (name) => (await Meta.get(`doc:${name}`)) || {};
  const live = (map) => Object.fromEntries(Object.entries(map).filter(([, v]) => !v.removed));

  async function put(name, key, value, { quiet = false } = {}) {
    const map = await get(name);
    map[key] = { ...value, updatedAt: Date.now() };
    await Meta.set(`doc:${name}`, map);
    if (!quiet) listeners.forEach((fn) => fn(name));
    Sync.schedule();
  }
  const remove = (name, key, opts) => put(name, key, { removed: true }, opts);

  /** Borra muchas claves de golpe (p. ej. "vaciar lista"). */
  async function removeMany(name, keys) {
    if (!keys.length) return;
    const map = await get(name);
    const now = Date.now();
    keys.forEach((k) => { map[k] = { removed: true, updatedAt: now }; });
    await Meta.set(`doc:${name}`, map);
    listeners.forEach((fn) => fn(name));
    Sync.schedule();
  }

  /** Combina lo que llega de fuera. Devuelve true si ha cambiado algo aquí. */
  async function merge(remoteDocs = {}) {
    let changed = false;
    for (const name of NAMES) {
      const remote = remoteDocs[name];
      if (!remote) continue;
      const local = await get(name);
      let touched = false;
      for (const [k, v] of Object.entries(remote)) {
        if (!local[k] || (v.updatedAt || 0) > (local[k].updatedAt || 0)) { local[k] = v; touched = true; }
      }
      if (touched) { await Meta.set(`doc:${name}`, local); changed = true; }
    }
    if (changed) listeners.forEach((fn) => fn('*'));
    return changed;
  }

  async function all() {
    const out = {};
    for (const name of NAMES) out[name] = await get(name);
    return out;
  }

  return { get, live, put, remove, removeMany, merge, all, on(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
})();

/* ---------- Categorías ----------
   Se guardan con clave = nombre normalizado, así "Postres" creada en el móvil y en
   la tablet es la misma. Las de serie se escriben con fecha 0: cualquier cambio
   tuyo (borrarla, renombrarla) siempre gana al sincronizar. */

const Categories = {
  async ensureDefaults() {
    if (await Meta.get('categoriesSeeded')) return;
    const map = await Docs.get('categories');
    for (const name of CATEGORY_SUGGESTIONS) { const k = norm(name); if (!map[k]) map[k] = { name, updatedAt: 0 }; }
    await Meta.set('doc:categories', map);
    await Meta.set('categoriesSeeded', true);
  },
  /** Todas las categorías: las guardadas más las que ya usan tus recetas. */
  async list(recipes) {
    await Categories.ensureDefaults();
    const live = Docs.live(await Docs.get('categories'));
    const names = new Map(Object.values(live).map((c) => [norm(c.name), c.name]));
    for (const r of recipes || []) if (r.category && !names.has(norm(r.category))) names.set(norm(r.category), r.category);
    return [...names.values()].sort((a, b) => a.localeCompare(b, 'es'));
  },
  async add(name) {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return null;
    const pretty = clean.charAt(0).toUpperCase() + clean.slice(1);
    await Docs.put('categories', norm(pretty), { name: pretty });
    return pretty;
  },
  async rename(oldName, newName) {
    const pretty = await Categories.add(newName);
    if (!pretty || norm(pretty) === norm(oldName)) return pretty;
    await Docs.remove('categories', norm(oldName));
    for (const r of await Store.list()) if (norm(r.category) === norm(oldName)) { r.category = pretty; await Store.save(r); }
    return pretty;
  },
  async remove(name) {
    await Docs.remove('categories', norm(name));
    for (const r of await Store.list()) if (norm(r.category) === norm(name)) { r.category = ''; await Store.save(r); }
  },
};

/* ---------- Información nutricional (aproximada) ----------
   Valores por 100 g de USDA FoodData Central (SR Legacy, dominio público), tomados del
   conjunto de datos TempoLife (CC-BY-4.0) y emparejados con nombres en español.
   Los pesos por unidad ("1 pimiento ≈ 150 g") son medias orientativas.
   Formato de cada fila: [nombres, kcal, proteína, hidratos, grasa, gramos por unidad] */

const NUTRI_ROWS = [[["arroz","arroz bomba","arroz redondo","arroz largo","arroz blanco"],360.0,6.6,79.3,0.6,null],[["arroz integral"],367.0,7.5,76.3,3.2,null],[["pasta","espaguetis","espagueti","macarrones","fideos","tallarines"],371.0,13.0,74.7,1.5,null],[["pasta integral"],352.0,13.9,73.4,2.9,null],[["harina","harina de trigo"],364.0,10.3,76.3,1.0,null],[["harina de avena","avena","copos de avena"],379.0,13.2,67.7,6.5,null],[["pan","pan de molde","barra de pan","baguette"],266.0,8.9,49.4,3.3,30],[["pan integral"],278.0,8.4,51.4,5.4,30],[["pan rallado"],395.0,13.4,72.0,5.3,null],[["azucar","azúcar"],387.0,0,100.0,0,null],[["miel"],304.0,0.3,82.4,0,null],[["aceite","aceite de oliva","aceite de oliva virgen extra","aove"],884.0,0,0,100.0,null],[["aceite de girasol"],884.0,0,0,100.0,null],[["mantequilla"],717.0,0.9,0.1,81.1,null],[["sal"],0,0,0,0,null],[["pimienta","pimienta negra"],251.0,10.4,64.0,3.3,null],[["pimenton","pimentón","pimentón dulce"],282.0,14.1,54.0,12.9,null],[["comino"],375.0,17.8,44.2,22.3,null],[["canela"],247.0,4.0,80.6,1.2,null],[["oregano","orégano"],265.0,9.0,68.9,4.3,null],[["azafran","azafrán"],310.0,11.4,65.4,5.9,null],[["curry"],325.0,14.3,55.8,14.0,null],[["vinagre"],21.0,0,0.9,0,null],[["salsa de soja","soja"],53.0,8.1,4.9,0.6,null],[["mostaza"],60.0,3.7,5.8,3.3,null],[["mayonesa"],680.0,1.0,0.6,74.9,null],[["ketchup","kétchup"],101.0,1.0,27.4,0.1,null],[["tomate","tomates","tomate pera","tomate rama"],18.0,0.9,3.9,0.2,120],[["tomate triturado","tomate natural triturado"],32.0,1.6,7.3,0.3,null],[["tomate frito","salsa de tomate"],50.0,1.4,7.4,1.6,null],[["tomate cherry","tomates cherry"],18.0,0.9,3.9,0.2,15],[["cebolla","cebollas"],40.0,1.1,9.3,0.1,150],[["cebolleta","cebolletas"],32.0,1.8,7.3,0.2,30],[["ajo","ajos","diente de ajo"],149.0,6.4,33.1,0.5,5],[["pimiento","pimiento rojo"],26.0,1.0,6.0,0.3,150],[["pimiento verde"],20.0,0.9,4.6,0.2,150],[["pimiento amarillo"],27.0,1.0,6.3,0.2,150],[["patata","patatas"],77.0,2.1,17.5,0.1,170],[["boniato","batata"],86.0,1.6,20.1,0.1,180],[["zanahoria","zanahorias"],41.0,0.9,9.6,0.2,70],[["calabacin","calabacín","calabacines"],17.0,1.2,3.1,0.3,200],[["berenjena","berenjenas"],25.0,1.0,5.9,0.2,250],[["calabaza"],26.0,1.0,6.5,0.1,null],[["puerro","puerros"],61.0,1.5,14.2,0.3,90],[["lechuga"],17.0,1.2,3.3,0.3,300],[["espinacas","espinaca"],23.0,2.9,3.6,0.4,null],[["acelgas","acelga"],19.0,1.8,3.7,0.2,null],[["brocoli","brócoli"],34.0,2.8,6.6,0.4,300],[["coliflor"],25.0,1.9,5.0,0.3,500],[["col","repollo"],25.0,1.3,5.8,0.1,null],[["champiñones","champiñon","champinones","setas"],22.0,3.1,3.3,0.3,20],[["judias verdes","judías verdes"],31.0,1.8,7.0,0.2,null],[["guisantes"],81.0,5.4,14.5,0.4,null],[["pepino"],15.0,0.7,3.6,0.1,250],[["apio"],14.0,0.7,3.0,0.2,40],[["esparragos","espárragos","espárragos verdes"],20.0,2.2,3.9,0.1,16],[["alcachofa","alcachofas"],47.0,3.3,10.5,0.2,120],[["maiz","maíz"],86.0,3.3,18.7,1.4,null],[["aguacate","aguacates"],160.0,2.0,8.5,14.7,170],[["limon","limón","limones"],29.0,1.1,9.3,0.3,100],[["zumo de limon","zumo de limón"],22.0,0.4,6.9,0.2,null],[["lima"],30.0,0.7,10.5,0.2,65],[["naranja","naranjas"],47.0,0.9,11.8,0.1,180],[["manzana","manzanas"],52.0,0.3,13.8,0.2,180],[["pera","peras"],57.0,0.4,15.2,0.1,180],[["platano","plátano","platanos","plátanos","banana"],89.0,1.1,22.8,0.3,120],[["fresas","fresa"],32.0,0.7,7.7,0.3,12],[["arandanos","arándanos"],57.0,0.7,14.5,0.3,null],[["frambuesas"],52.0,1.2,11.9,0.7,null],[["uvas"],69.0,0.7,18.1,0.2,null],[["piña"],50.0,0.5,13.1,0.1,null],[["mango"],60.0,0.8,15.0,0.4,300],[["kiwi"],61.0,1.1,14.7,0.5,75],[["melon","melón"],34.0,0.8,8.2,0.2,null],[["sandia","sandía"],30.0,0.6,7.6,0.2,null],[["perejil"],36.0,3.0,6.3,0.8,null],[["cilantro"],23.0,2.1,3.7,0.5,null],[["albahaca"],23.0,3.2,2.7,0.6,null],[["jengibre"],80.0,1.8,17.8,0.8,null],[["huevo","huevos"],143.0,12.6,0.7,9.5,55],[["clara de huevo","claras","claras de huevo"],52.0,10.9,0.7,0.2,33],[["yema","yemas"],322.0,15.9,3.6,26.5,17],[["leche entera"],61.0,3.2,4.8,3.3,null],[["leche desnatada"],34.0,3.4,5.0,0.1,null],[["leche","leche semidesnatada"],46.0,3.3,4.8,1.6,null],[["bebida de almendras","leche de almendras"],15.0,0.4,1.3,1.0,null],[["yogur","yogur natural"],61.0,3.5,4.7,3.3,125],[["yogur griego","yogur griego natural"],97.0,9.0,4.0,5.0,125],[["yogur griego 0%","yogur 0%","yogur desnatado"],59.0,10.2,3.6,0.4,125],[["nata","nata para montar","nata liquida","nata líquida"],340.0,2.8,2.8,36.1,null],[["nata para cocinar","nata ligera","nata para cocinar ligera"],195.0,2.5,3.5,18.0,null],[["queso","queso curado","queso manchego"],392.0,35.8,3.2,25.0,null],[["queso rallado","parmesano"],420.0,28.4,13.9,27.8,null],[["queso fresco","queso de burgos"],138.0,11.4,5.1,7.9,null],[["mozzarella"],254.0,24.3,2.8,15.9,125],[["queso crema","queso untable"],350.0,6.2,5.5,34.4,null],[["requeson","requesón","queso cottage"],81.0,10.5,4.8,2.3,null],[["pollo","pechuga de pollo","pechugas de pollo"],120,22.5,0,2.6,200],[["muslo de pollo","contramuslo","contramuslos"],121.0,19.7,0,4.1,100],[["pavo","pechuga de pavo"],114.0,23.3,0,2.3,null],[["carne picada de pavo","pavo picado"],150.0,18.7,0,8.3,null],[["carne picada","carne picada de ternera","ternera picada"],215.0,18.6,0,15.0,null],[["ternera","filete de ternera"],173.0,22.2,0,8.7,null],[["cerdo","lomo de cerdo","lomo"],198.0,19.7,0,12.6,null],[["solomillo de cerdo"],109.0,21.0,0,2.2,null],[["bacon","panceta","beicon"],393.0,13.7,0,37.1,null],[["jamon serrano","jamón serrano","jamon","jamón"],164.0,16.6,3.6,8.8,null],[["jamon york","jamón york","jamón cocido"],107.0,16.9,0.7,4.0,null],[["chorizo"],296.0,13.6,3.8,25.1,null],[["salmon","salmón"],208.0,20.4,0,13.4,null],[["atun","atún","atún en lata","atun en lata"],86.0,19.4,0,1.0,null],[["merluza","bacalao","pescado blanco"],82.0,17.8,0,0.7,null],[["gambas","gamba","langostinos","langostino"],85.0,20.1,0,0.5,15],[["mejillones","mejillon","mejillón"],86.0,11.9,3.7,2.2,null],[["almejas","almeja"],86.0,14.7,3.6,1.0,null],[["calamar","calamares","sepia"],92.0,15.6,3.1,1.4,null],[["pulpo"],82.0,14.9,2.2,1.0,null],[["sardinas","sardina"],208.0,24.6,0,11.5,null],[["garbanzos","garbanzo"],378.0,20.5,63.0,6.0,null],[["garbanzos cocidos"],139.0,7.1,22.5,2.8,null],[["lentejas","lenteja"],352.0,24.6,63.4,1.1,null],[["alubias","judias blancas","judías blancas","alubias blancas"],333.0,23.4,60.3,0.9,null],[["alubias rojas"],333.0,23.6,60.0,0.8,null],[["tofu"],144.0,17.3,2.8,8.7,null],[["almendras","almendra"],579.0,21.2,21.6,49.9,null],[["nueces","nuez"],654.0,15.2,13.7,65.2,null],[["avellanas"],628.0,15.0,16.7,60.8,null],[["cacahuetes"],567.0,25.8,16.1,49.2,null],[["crema de cacahuete","mantequilla de cacahuete"],598.0,22.2,22.3,51.4,null],[["pipas","semillas de girasol"],584.0,20.8,20.0,51.5,null],[["chia","semillas de chia","semillas de chía"],486.0,16.5,42.1,30.7,null],[["sesamo","sésamo"],573.0,17.7,23.5,49.7,null],[["cacao","cacao en polvo","cacao puro"],228.0,19.6,57.9,13.7,null],[["chocolate negro","chocolate"],598.0,7.8,45.9,42.6,null],[["levadura"],325.0,40.4,41.2,7.6,null],[["levadura quimica","levadura química","polvo de hornear"],51.0,0.1,24.1,0,null],[["maicena","almidon de maiz","almidón de maíz"],381.0,0.3,91.3,0.1,null],[["caldo","caldo de pollo"],6.0,0.6,0.4,0.2,null],[["caldo de verduras"],5.0,0.2,0.9,0.1,null],[["fumet","fumet de pescado","caldo de pescado"],16.0,2.0,0.4,0.6,null],[["vino blanco","vino"],82.0,0.1,2.6,0,null],[["vino tinto"],85.0,0.1,2.6,0,null],[["cerveza"],43.0,0.5,3.6,0,null],[["agua"],0,0,0,0,null],[["proteina en polvo","proteína en polvo","whey"],352.0,78.1,6.3,1.6,null],[["aceitunas"],116.0,0.8,6.0,10.9,4],[["tortilla de trigo","wrap","tortillas de trigo"],306.0,8.2,49.4,8.0,45],[["quinoa","quinoa"],368.0,14.1,64.2,6.1,null],[["cuscus","cuscús"],376.0,12.8,77.4,0.6,null],[["pan de hamburguesa"],279.0,9.8,50.1,3.9,50],[["edulcorante","eritritol","stevia"],0,0,0,0,null],[["gelatina"],335.0,85.6,0,0.1,null],[["coco rallado"],660.0,6.9,23.7,64.5,null],[["leche de coco"],197.0,2.0,2.8,21.3,null]];

// Añadidos tras la auditoría: variantes 0 %, bebidas vegetales y básicos fit que se confundían con otros alimentos
NUTRI_ROWS.push(
  [['bebida de avena', 'leche de avena'], 45, 1, 7, 1.5, null],
  [['bebida de soja', 'leche de soja'], 40, 3.3, 2.5, 1.8, null],
  [['bebida de arroz', 'leche de arroz'], 50, 0.3, 10, 1, null],
  [['queso fresco batido', 'queso batido', 'queso fresco batido 0%', 'queso batido 0%'], 46, 8, 4, 0.1, null],
  [['yogur proteico', 'skyr', 'yogur alto en proteinas'], 60, 10, 4, 0.2, 125],
  [['queso fresco 0%', 'queso de burgos 0%', 'queso fresco light'], 70, 12, 4, 0.5, null],
  [['queso crema light', 'queso untable light'], 160, 8, 5, 12, null],
  [['pimientos del piquillo', 'pimiento del piquillo'], 22, 1, 4, 0.3, 30],
  [['hummus'], 166, 8, 14, 10, null],
  [['salsa barbacoa'], 172, 0.8, 41, 0.6, null],
  [['pesto'], 450, 5, 6, 45, null],
  [['pan integral de hamburguesa', 'pan de hamburguesa integral'], 250, 11, 43, 3.5, 60],
  [['arroz cocido'], 130, 2.7, 28, 0.3, null],
  [['pasta cocida'], 158, 5.8, 31, 0.9, null],
  [['lentejas cocidas'], 116, 9, 20, 0.4, null],
  [['alubias cocidas'], 110, 7, 20, 0.5, null],
  [['semillas de lino', 'lino'], 534, 18, 29, 42, null],
  [['datiles', 'dátiles', 'datil', 'dátil'], 282, 2.5, 75, 0.4, 8],
  [['sirope de agave', 'sirope'], 300, 0, 75, 0, null],
);

const Nutrition = (() => {
  const clean = (t) => ' ' + norm(t).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const index = [];
  NUTRI_ROWS.forEach((row) => row[0].forEach((a) => index.push({ a: clean(a).trim(), row })));
  index.sort((x, y) => y.a.length - x.a.length); // primero lo más concreto: "carne picada de pavo" antes que "pavo"
  const byKey = new Map(NUTRI_ROWS.map((r) => [r[0][0], r]));

  function match(ing) {
    if (ing.nutriKey === 'none') return null;
    if (ing.nutriKey && byKey.has(ing.nutriKey)) return byKey.get(ing.nutriKey);
    const n = clean(ing.name);
    for (const { a, row } of index) if (n.includes(' ' + a + ' ')) return row;
    // plural sencillo: "tomates" -> "tomate", "limones" -> "limon"
    for (const sing of [n.replace(/(\w{3,})s\b/g, '$1'), n.replace(/(\w{3,})es\b/g, '$1')]) {
      for (const { a, row } of index) if (sing.includes(' ' + a + ' ')) return row;
    }
    return null;
  }

  /** Gramos de un ingrediente. Devuelve { g } o { reason } si no se puede saber. */
  function grams(q, unit, row) {
    const oil = row[0][0].startsWith('aceite');
    switch (unit) {
      case 'g': return { g: q };
      case 'kg': return { g: q * 1000 };
      case 'ml': return { g: q * (oil ? 0.92 : 1) };
      case 'l': return { g: q * 1000 * (oil ? 0.92 : 1) };
      case 'cda': return { g: q * (oil ? 13.5 : 15) };
      case 'cdta': return { g: q * (oil ? 4.5 : 5) };
      case 'taza': return { g: q * 240 };
      case 'pizca': return { g: (q || 1) * 0.5 };
      case 'al gusto': return { g: 0, ignore: true };
      default: return row[5] ? { g: q * row[5] } : { reason: 'falta el peso' };
    }
  }

  /** Totales de una versión completa (todas sus raciones) y detalle por ingrediente. */
  function forVersion(recipe, version, recipesById, depth = 0) {
    const tot = { kcal: 0, p: 0, c: 0, f: 0 };
    const items = [];
    let counted = 0, total = 0;
    for (const ing of version.ingredients) {
      if (!ing.name.trim()) continue;
      const sub = ing.recipeId && recipesById?.get(ing.recipeId);
      if (sub && depth < 3) {
        const st = forVersion(sub, sub.versions[0], recipesById, depth + 1);
        tot.kcal += st.kcal; tot.p += st.p; tot.c += st.c; tot.f += st.f;
        items.push({ ing, status: 'recipe', label: `Receta: ${sub.name}`, kcal: st.kcal });
        counted++; total++;
        continue;
      }
      if (ing.unit === 'al gusto' || (ing.qty == null && ing.unit !== 'pizca')) { items.push({ ing, status: 'ignored' }); continue; }
      total++;
      const row = match(ing);
      if (!row) { items.push({ ing, status: ing.nutriKey === 'none' ? 'excluded' : 'nomatch' }); continue; }
      const gr = grams(ing.qty, ing.unit, row);
      if (gr.ignore) { total--; items.push({ ing, status: 'ignored' }); continue; }
      if (gr.g == null) { items.push({ ing, status: 'noweight', row }); continue; }
      const k = gr.g / 100;
      const it = { kcal: row[1] * k, p: row[2] * k, c: row[3] * k, f: row[4] * k };
      tot.kcal += it.kcal; tot.p += it.p; tot.c += it.c; tot.f += it.f;
      counted++;
      items.push({ ing, status: 'ok', row, g: gr.g, ...it });
    }
    return { ...tot, items, counted, total };
  }

  function perServing(recipe, version, recipesById) {
    const t = forVersion(recipe, version, recipesById);
    const s = version.servings || 1;
    return { kcal: t.kcal / s, p: t.p / s, c: t.c / s, f: t.f / s, counted: t.counted, total: t.total, items: t.items };
  }

  const foods = () => NUTRI_ROWS.map((r) => r[0][0]).sort((a, b) => a.localeCompare(b, 'es'));
  const label = (key) => key.charAt(0).toUpperCase() + key.slice(1);

  return { perServing, forVersion, match, foods, label, byKey };
})();

/* ---------- Lista de la compra: suma y agrupación de ingredientes ---------- */

const Shopping = (() => {
  // Pasillos del súper, en el orden en que sueles recorrerlo
  const SECTIONS = [
    ['Frutas y verduras', 'tomate cebolla ajo pimiento patata zanahoria calabacin berenjena puerro lechuga espinaca acelga col coliflor brocoli judia guisante alcachofa champinon seta pepino apio calabaza limon lima naranja manzana pera platano fresa uva melon sandia aguacate perejil cilantro albahaca hierbabuena romero tomillo laurel jengibre fruta verdura'],
    ['Carnes', 'pollo pavo ternera cerdo cordero conejo carne picada lomo solomillo costilla chuleta panceta bacon chorizo morcilla salchicha jamon butifarra hamburguesa muslo pechuga contramuslo'],
    ['Pescados y mariscos', 'pescado merluza bacalao salmon atun sardina boqueron dorada lubina rape gamba langostino calamar sepia pulpo mejillon almeja chirla navaja marisco cigala bogavante fumet'],
    ['Lácteos y huevos', 'leche nata mantequilla queso yogur huevo huevos crema'],
    ['Panadería', 'pan baguette hogaza pan rallado tostada brioche'],
    ['Despensa', 'arroz pasta espagueti macarron fideo harina azucar sal pimienta aceite vinagre garbanzo lenteja alubia judion legumbre tomate frito tomate triturado caldo pastilla levadura cacao chocolate especia pimenton comino azafran canela oregano curry nuez almendra pinon avellana pasas miel mostaza mayonesa ketchup salsa soja conserva maicena'],
    ['Bebidas', 'vino cerveza agua zumo refresco brandy cognac licor'],
    ['Congelados', 'congelado helado hielo'],
  ];
  const SECTION_WORDS = SECTIONS.map(([name, words]) => [name, words.split(' ')]);

  function sectionFor(name) {
    const n = ' ' + norm(name) + ' ';
    // "tomate frito" antes que "tomate": se buscan primero las coincidencias más largas
    let best = null, bestLen = 0;
    for (const [sec, words] of SECTION_WORDS) {
      for (const w of words) {
        if (w.length > bestLen && (n.includes(' ' + w + ' ') || n.includes(' ' + w + 's ') || n.includes(' ' + w + 'es '))) { best = sec; bestLen = w.length; }
      }
    }
    return best || 'Otros';
  }
  const ORDER = [...SECTIONS.map(([s]) => s), 'Otros'];

  // Unidades que se pueden sumar entre sí
  const BASE = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000] };

  // En la compra se redondea hacia arriba: no se compran 2¼ pimientos
  const up = (n, step) => Math.ceil(n / step - 1e-9) * step;
  function display(qty, unit) {
    if (qty == null) return unit === 'al gusto' ? 'al gusto' : unit === 'pizca' ? 'una pizca' : '';
    if (unit === 'g' && qty >= 1000) return `${formatQty(up(qty / 1000, 0.1), 'kg')} kg`;
    if (unit === 'ml' && qty >= 1000) return `${formatQty(up(qty / 1000, 0.1), 'l')} l`;
    if (['ud', 'diente', ''].includes(unit)) return qtyLabel(up(qty, 1), unit);
    if (['g', 'ml'].includes(unit)) return qtyLabel(up(qty, qty >= 100 ? 10 : 1), unit);
    return qtyLabel(up(qty, 0.25), unit);
  }

  /**
   * Suma los ingredientes de las recetas elegidas.
   * selections: [{ recipeId, versionId, servings }]
   * Devuelve [{ key, name, label, section, from: [nombres de receta] }]
   */
  function aggregate(selections, recipesById) {
    const acc = new Map();
    // Una receta vinculada (la salsa de la hamburguesa) no se compra: se compran sus ingredientes.
    // Se cuenta una tanda de la salsa por cada tanda de la receta principal.
    const queue = selections.map((s) => ({ ...s, depth: 0 }));
    while (queue.length) {
      const sel = queue.shift();
      const r = recipesById.get(sel.recipeId);
      if (!r) continue;
      const v = r.versions.find((x) => x.id === sel.versionId) || r.versions[0];
      const factor = (sel.servings || v.servings || 1) / (v.servings || 1);
      for (const i of v.ingredients) {
        if (!i.name.trim()) continue;
        const sub = i.recipeId && recipesById.get(i.recipeId);
        if (sub && sel.depth < 3) {
          const sv = sub.versions[0];
          queue.push({ recipeId: sub.id, versionId: sv.id, servings: (sv.servings || 1) * factor, depth: sel.depth + 1, via: r.name });
          continue;
        }
        const [baseUnit, mult] = BASE[i.unit] || [i.unit, 1];
        const key = `${norm(i.name)}|${baseUnit}`;
        const cur = acc.get(key) || { key, name: i.name.trim(), unit: baseUnit, qty: null, from: new Set() };
        if (i.qty != null) {
          const q = NO_SCALE_UNITS.has(i.unit) ? i.qty : i.qty * factor;
          cur.qty = (cur.qty || 0) + q * mult;
        }
        cur.from.add(r.name);
        acc.set(key, cur);
      }
    }
    return [...acc.values()].map((x) => ({
      key: x.key, name: x.name, label: display(x.qty, x.unit), section: sectionFor(x.name), from: [...x.from],
    }));
  }

  return { aggregate, sectionFor, ORDER };
})();

/* =========================================================================
   5. Interfaz común: avisos, hojas, confirmaciones
   ========================================================================= */

function toast(message, action) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  host.append(el);
  const close = () => el.remove();
  if (action) el.querySelector('button').onclick = () => { close(); action.run(); };
  setTimeout(close, action ? 8000 : 3200);
}

/* Las hojas se integran con el botón "atrás" de Android: atrás cierra la hoja. */
const Sheets = (() => {
  const stack = [];
  let ownPops = 0; // retrocesos que provoca la propia hoja al cerrarse

  window.addEventListener('popstate', () => {
    if (ownPops > 0) { ownPops--; return; }
    const top = stack[stack.length - 1];
    if (top && !top.closing) top.dismiss(true);
  });

  /**
   * Abre una hoja inferior. build(el, close) rellena el contenido.
   * Devuelve una promesa que se resuelve con el valor pasado a close().
   */
  function open(build, { label = 'Diálogo' } = {}) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="sheet-grip" aria-hidden="true"></div><div class="sheet-body"></div></div>`;
      const sheet = $('.sheet', scrim);
      const lastFocus = document.activeElement;
      const entry = { closing: false, dismiss: null };

      function finish(value, fromPop) {
        if (entry.closing) return;
        entry.closing = true;
        stack.splice(stack.indexOf(entry), 1);
        scrim.remove();
        document.removeEventListener('keydown', onKey);
        lastFocus?.focus?.();
        if (fromPop) { resolve(value); return; }
        // Esperamos a que termine el "atrás" antes de seguir, para que la
        // siguiente navegación no se cruce con él.
        ownPops++;
        const done = () => { window.removeEventListener('popstate', done); resolve(value); };
        window.addEventListener('popstate', done);
        history.back();
      }
      entry.dismiss = (fromPop) => finish(undefined, fromPop);
      const close = (value) => finish(value, false);

      const onKey = (e) => { if (e.key === 'Escape' && stack[stack.length - 1] === entry) close(); };
      document.addEventListener('keydown', onKey);
      scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

      build($('.sheet-body', sheet), close);
      document.body.append(scrim);
      stack.push(entry);
      history.pushState({ sheet: true }, '');
      setTimeout(() => (sheet.querySelector('[autofocus]') || sheet.querySelector('button, input, textarea, select'))?.focus(), 30);
    });
  }

  return { open, isOpen: () => stack.length > 0 };
})();

function confirmSheet({ title, text = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false }) {
  return Sheets.open((el, close) => {
    el.innerHTML = `<h2 class="serif">${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="actions"><button class="btn btn-ghost" data-v="0">${esc(cancel)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-v="1">${esc(ok)}</button></div>`;
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) close(b.dataset.v === '1'); });
  }, { label: title }).then(Boolean);
}

function promptSheet({ title, label, value = '', placeholder = '', ok = 'Guardar' }) {
  return Sheets.open((el, close) => {
    el.innerHTML = `<h2 class="serif">${esc(title)}</h2>
      <label class="field"><span class="label">${esc(label)}</span>
      <input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="40" autofocus></label>
      <div class="actions"><button class="btn btn-ghost" data-v="0">Cancelar</button><button class="btn btn-primary" data-v="1">${esc(ok)}</button></div>`;
    const input = $('input', el);
    const submit = () => { const v = input.value.trim(); if (v) close(v); else input.focus(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; b.dataset.v === '1' ? submit() : close(null); });
  }, { label: title });
}

function menuSheet(title, items) {
  return Sheets.open((el, close) => {
    el.innerHTML = `<h2 class="serif sr-only">${esc(title)}</h2><div class="menu">${items.map((it, i) =>
      `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}${esc(it.label)}</button>`).join('')}</div>`;
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) close(items[+b.dataset.i].value); });
  }, { label: title });
}

/** Ilustración para recetas sin foto: un plato sobre el negro. */
const PLATE_SVG = `<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" aria-hidden="true">
  <circle cx="50" cy="50" r="40" stroke-width="1.2"/><circle cx="50" cy="50" r="28" stroke-width=".8"/>
  <path d="M50 38c-5 0-8 4-8 8s4 7 8 7 8-3 8-7-3-8-8-8Z" stroke-width=".8"/></svg>`;

function photoHTML(imageId, { alt = '', natural = false, hero = false } = {}) {
  const src = Images.cached(imageId);
  const inner = src
    ? `<img src="${src}" alt="${esc(alt)}" decoding="async" ${hero ? 'style="view-transition-name:hero"' : ''}>`
    : `<div class="placeholder">${PLATE_SVG}</div>`;
  return `<div class="float ${natural && src ? 'natural' : ''}">${inner}</div>`;
}

/* =========================================================================
   6. Router (rutas con # para funcionar en GitHub Pages sin configuración)
   ========================================================================= */

const Router = (() => {
  const routes = [];
  let current = null;       // { destroy, canLeave }
  let currentHash = null;
  let ignoreNext = false;
  let renders = 0;

  function add(pattern, view) { routes.push({ pattern, view }); }

  function parse(hash) {
    const [path, query = ''] = hash.replace(/^#/, '').split('?');
    const params = Object.fromEntries(new URLSearchParams(query));
    for (const r of routes) {
      const m = path.match(r.pattern);
      if (m) return { view: r.view, args: m.slice(1).map(decodeURIComponent), params };
    }
    return { view: routes[0].view, args: [], params };
  }

  async function render() {
    if (ignoreNext) { ignoreNext = false; return; }
    const hash = location.hash || '#/';
    if (current?.canLeave && !(await current.canLeave())) {
      ignoreNext = true;
      location.hash = currentHash; // volvemos a donde estábamos
      return;
    }
    let target = hash;
    if (UI.redirect) { target = UI.redirect; UI.redirect = null; history.replaceState(null, '', target); }
    const { view, args, params } = parse(target);
    const app = $('#app');
    const swap = async () => {
      current?.destroy?.();
      const ctl = (await view(app, ...args, params)) || {};
      current = ctl;
      currentHash = target;
      renders++;
      if (!ctl.keepScroll) window.scrollTo(0, 0);
    };
    if (document.startViewTransition && !reducedMotion() && currentHash) {
      await document.startViewTransition(swap).updateCallbackDone.catch(() => {});
    } else {
      await swap();
    }
  }

  const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

  window.addEventListener('hashchange', render);
  /** Vuelve atrás si venimos de otra pantalla de la app; si no, va a la ruta indicada. */
  const back = (fallback = '#/') => { if (renders > 1) history.back(); else location.replace(fallback); };

  return { add, render, go, back, get currentHash() { return currentHash; } };
})();

/* =========================================================================
   7. Vistas
   ========================================================================= */

const UI = { homeFilter: 'all', homeQuery: '', homeTime: 0, lastRecipeId: null };
const TIME_FILTERS = [[0, 'Cualquier tiempo'], [15, 'Hasta 15 min'], [30, 'Hasta 30 min'], [60, 'Hasta 1 h']];

/* ---------- 7.1 Inicio ---------- */

async function HomeView(app) {
  const recipes = await Store.list();
  await Images.preload(recipes.map((r) => r.coverImageId));
  const banner = await backupReminder(recipes.length);

  const categories = [...new Set(recipes.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  if (UI.homeFilter !== 'all' && UI.homeFilter !== 'fav' && !categories.includes(UI.homeFilter)) UI.homeFilter = 'all';

  const todayRaw = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const today = todayRaw.charAt(0).toUpperCase() + todayRaw.slice(1);

  app.innerHTML = `<div class="page has-tabbar">
    <header class="home-head">
      <div class="topbar">
        <p class="home-date">${esc(today)}</p>
        <div style="display:flex;gap:4px">
          <span id="sync-slot">${Sync.state !== 'off' ? syncButtonHTML(Sync.state) : ''}</span>
        </div>
      </div>
      <h1 class="home-title serif">Recetario<span class="home-sub">del chef JJ</span></h1>
    </header>
    <section class="chef-hero" aria-label="Cocinando fit con JJ">
      <img src="chef.webp" alt="El chef JJ con su chaqueta blanca, sonriendo y de brazos cruzados" width="1000" height="1140" decoding="async">
      <p class="chef-tagline serif">Cocinando fit con JJ</p>
    </section>
    ${banner}
    ${recipes.length ? `
      <div class="home-tools">
        <label class="search"><span class="sr-only">Buscar</span>${icon('search', 'ic-sm')}
          <input class="input" type="search" id="q" placeholder="Buscar plato o ingrediente" value="${esc(UI.homeQuery)}" autocomplete="off"></label>
        <div class="chips text-tabs" role="toolbar" aria-label="Filtrar recetas">
          <button class="chip" data-filter="all" aria-pressed="${UI.homeFilter === 'all'}">Todas</button>
          <button class="chip" data-filter="fav" aria-pressed="${UI.homeFilter === 'fav'}">Favoritas</button>
          ${categories.map((c) => `<button class="chip" data-filter="${esc(c)}" aria-pressed="${UI.homeFilter === c}">${esc(c)}</button>`).join('')}
        </div>
        <div class="chips text-tabs time-tabs" role="toolbar" aria-label="Filtrar por tiempo">
          ${TIME_FILTERS.map(([m, l]) => `<button class="chip" data-time="${m}" aria-pressed="${UI.homeTime === m}">${m ? icon('clock', 'ic-sm') : ''}${l}</button>`).join('')}
        </div>
      </div>
      <div id="results"></div>` : emptyHome()}
  </div>
  ${tabbarHTML('home')}`;

  const results = $('#results', app);
  const paint = () => { if (results) results.innerHTML = homeResults(recipes); };
  paint();

  const onClick = (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      $$('img', app).forEach((i) => { i.style.viewTransitionName = ''; });
      const img = go.querySelector('img');
      if (img) img.style.viewTransitionName = 'hero';
      Router.go(go.dataset.go);
      return;
    }
    const tm = e.target.closest('[data-time]');
    if (tm) {
      UI.homeTime = +tm.dataset.time;
      $$('[data-time]', app).forEach((b) => b.setAttribute('aria-pressed', String(b === tm)));
      paint();
      return;
    }
    const f = e.target.closest('[data-filter]');
    if (f) {
      UI.homeFilter = f.dataset.filter;
      $$('[data-filter]', app).forEach((b) => b.setAttribute('aria-pressed', String(b === f)));
      paint();
      return;
    }
    if (e.target.closest('[data-act="sync"]')) { Sync.sync({ interactive: true }).catch(() => {}); return; }
    const act = e.target.closest('[data-banner]');
    if (act) {
      if (act.dataset.banner === 'backup') Router.go('#/ajustes');
      else { Meta.set('reminderSnoozeUntil', Date.now() + 3 * 864e5); act.closest('.banner').remove(); }
    }
  };
  app.addEventListener('click', onClick);
  const q = $('#q', app);
  q?.addEventListener('input', () => { UI.homeQuery = q.value; paint(); });

  const offSync = Sync.on((st) => { const slot = $('#sync-slot', app); if (slot) slot.innerHTML = st !== 'off' ? syncButtonHTML(st) : ''; });
  return { destroy: () => { app.removeEventListener('click', onClick); offSync(); } };
}

function emptyHome() {
  return `<div class="empty" style="padding-top:12px">
    <h2 class="serif">Tu primera receta</h2>
    <p>Pulsa «Nueva receta» y añade la foto del plato, los ingredientes y los pasos.</p>
  </div>`;
}

function matchesQuery(r, q) {
  if (!q) return true;
  const hay = norm([r.name, r.category, ...r.versions.flatMap((v) => [v.name, ...v.ingredients.map((i) => i.name)])].join(' '));
  return norm(q).split(/\s+/).every((w) => hay.includes(w));
}

function homeResults(recipes) {
  const q = UI.homeQuery.trim();
  let list = recipes.filter((r) => matchesQuery(r, q));
  if (UI.homeFilter === 'fav') list = list.filter((r) => r.favorite);
  else if (UI.homeFilter !== 'all') list = list.filter((r) => r.category === UI.homeFilter);
  // Vale cualquier versión que entre en el tiempo (p. ej. la versión "Rápida")
  if (UI.homeTime) list = list.filter((r) => r.versions.some((v) => v.minutes && v.minutes <= UI.homeTime));

  if (!list.length) {
    return `<p class="muted-empty" style="margin-top:28px">${q ? `No hay recetas con “${esc(q)}”.` : UI.homeTime ? 'Ninguna receta entra en ese tiempo. Recuerda poner el tiempo total al editar cada receta.' : 'No hay recetas en este filtro.'}</p>`;
  }

  const card = (r) => {
    const v = r.versions[0];
    const hero = r.id === UI.lastRecipeId;
    return `<button class="card" data-go="#/receta/${r.id}" ${hero ? 'data-hero="1"' : ''}>
      ${photoHTML(r.coverImageId, { alt: r.name, hero })}
      ${r.category ? `<p class="card-kicker">${esc(r.category)}</p>` : ''}
      <h3 class="card-name serif">${esc(r.name || 'Sin nombre')}</h3>
      <div class="card-meta meta">
        ${v.minutes ? `<span>${icon('clock', 'ic-sm')}${formatMinutes(v.minutes)}</span>` : ''}
        ${r.versions.length > 1 ? `<span>${r.versions.length} versiones</span>` : ''}
        ${r.favorite ? `<span class="card-fav" aria-label="Favorita">${icon('heart', 'ic-sm ic-fill')}</span>` : ''}
      </div>
    </button>`;
  };

  let out = !q && UI.homeFilter === 'all' && !UI.homeTime ? `<h2 class="section-title serif">Todas las recetas</h2>` : '<div style="height:14px"></div>';
  out += `<div class="grid">${list.map(card).join('')}</div>`;
  return out;
}

async function backupReminder(count) {
  if (!count || (await Meta.get('driveConnected'))) return ''; // con Drive, la copia ya está en la nube
  const [lastExport, lastChange, snooze] = await Promise.all([Meta.get('lastExport'), Meta.get('lastChange'), Meta.get('reminderSnoozeUntil', 0)]);
  if (!lastChange || Date.now() < snooze) return '';
  if (lastExport && lastExport >= lastChange) return '';
  const age = Date.now() - (lastExport || 0);
  if (lastExport && age < 7 * 864e5) return '';
  if (!lastExport && Date.now() - lastChange < 864e5) return '';
  return `<div class="banner">${icon('hard-drive')}<div>
    <p><strong>Haz una copia de tu recetario.</strong> ${lastExport ? `La última fue el ${formatDate(lastExport)}.` : 'Aún no has hecho ninguna.'} Si se borran los datos de Chrome, se pierden las recetas de este dispositivo.</p>
    <div class="banner-actions"><button class="btn btn-primary" data-banner="backup">Hacer copia</button><button class="btn btn-ghost" data-banner="later">Más tarde</button></div>
  </div></div>`;
}

/* ---------- 7.2 Receta ---------- */

const Session = { checks: new Map() }; // ingredientes y pasos marcados (solo mientras la app está abierta)
const checksFor = (vid) => { if (!Session.checks.has(vid)) Session.checks.set(vid, new Set()); return Session.checks.get(vid); };

async function RecipeView(app, id, params) {
  const recipe = await Store.get(id);
  if (!recipe) { toast('Esa receta ya no existe'); Router.go('#/'); return; }
  UI.lastRecipeId = id;
  const all = await Store.list();
  const allById = new Map(all.map((r) => [r.id, r]));
  // Recetas que usan esta como ingrediente (p. ej. la hamburguesa que lleva esta salsa)
  const usedIn = all.filter((r) => r.id !== id && r.versions.some((v) => v.ingredients.some((i) => i.recipeId === id)));
  const linkedOf = (v) => [...new Map(v.ingredients.filter((i) => i.recipeId && allById.has(i.recipeId)).map((i) => [i.recipeId, allById.get(i.recipeId)])).values()];

  let version = recipe.versions.find((v) => v.id === params.v) || recipe.versions[0];
  let servings = version.servings || 1;
  let tab = version.prep.length ? 'prep' : 'cook';

  await Images.preload([recipe.coverImageId, ...recipe.versions.flatMap((v) => [...v.prep, ...v.cook].map((s) => s.imageId)), ...all.map((r) => r.coverImageId)]);

  function ingredientsHTML() {
    if (!version.ingredients.length) return `<p class="muted-empty">Esta versión no tiene ingredientes.</p>`;
    const factor = servings / (version.servings || 1);
    const checks = checksFor(version.id);
    return `<ul class="menu-ings">${version.ingredients.map((i) => {
      const q = i.qty == null ? null : (NO_SCALE_UNITS.has(i.unit) ? i.qty : i.qty * factor);
      const qty = qtyLabel(q, i.unit);
      const done = checks.has(i.id);
      const sub = i.recipeId && allById.get(i.recipeId);
      return `<li class="menu-ing ${done ? 'is-done' : ''}" data-check="${i.id}" role="checkbox" aria-checked="${done}" tabindex="0">
        <span class="name">${esc(i.name)}</span>
        ${sub ? `<button class="ing-open" data-open="${sub.id}" aria-label="Ver la receta de ${esc(sub.name)}">${icon('book-open', 'ic-sm')}Receta</button>` : ''}
        <span class="leader" aria-hidden="true"></span><span class="qty">${esc(qty)}</span></li>`;
    }).join('')}</ul>
    <p class="hint ing-hint">Toca un ingrediente para tacharlo.</p>`;
  }

  function nutriHTML() {
    const n = Nutrition.perServing(recipe, version, allById);
    if (!n.total) return '';
    const g = (x) => nf.format(Math.round(x));
    const kc = n.p * 4 + n.c * 4 + n.f * 9 || 1;
    const bar = (label, val, kcal) => `<div class="macro"><span class="macro-l">${label}</span>
      <span class="macro-bar"><i style="width:${Math.round((kcal / kc) * 100)}%"></i></span><span class="macro-v">${g(val)} g</span></div>`;
    return `<div class="block-head"><h2 class="block-title serif">Por ración</h2>
        <button class="btn btn-ghost btn-sm" data-act="nutri-detail">Detalle${icon('chevron-right', 'ic-sm')}</button></div>
      <div class="nutri">
        <div class="nutri-kcal"><span class="serif">${g(n.kcal)}</span><span>kcal</span></div>
        <div class="macros">${bar('Proteína', n.p, n.p * 4)}${bar('Hidratos', n.c, n.c * 4)}${bar('Grasa', n.f, n.f * 9)}</div>
      </div>
      <p class="hint nutri-note">${n.counted < n.total ? `${icon('info', 'ic-sm')}Calculado con ${n.counted} de ${n.total} ingredientes. Toca «Detalle» para completarlo.` : 'Valores aproximados a partir de tablas de composición de alimentos.'}</p>`;
  }

  async function nutriDetail() {
    const n = Nutrition.perServing(recipe, version, allById);
    const choice = await Sheets.open((el, close) => {
      const row = (it) => {
        const i = it.ing;
        const q = qtyLabel(i.qty, i.unit);
        let right = '', note = '';
        if (it.status === 'ok') { note = `${Nutrition.label(it.row[0][0])} · ${nf.format(Math.round(it.g))} g`; right = `${nf.format(Math.round(it.kcal))} kcal`; }
        else if (it.status === 'recipe') { note = it.label; right = `${nf.format(Math.round(it.kcal))} kcal`; }
        else if (it.status === 'nomatch') note = '<span class="warn">No lo encuentro en la tabla</span>';
        else if (it.status === 'noweight') note = '<span class="warn">Pon la cantidad en gramos para contarlo</span>';
        else if (it.status === 'excluded') note = 'No se cuenta';
        else note = 'Cantidad «al gusto»: no se cuenta';
        const canPick = ['ok', 'nomatch', 'excluded', 'noweight'].includes(it.status);
        return `<li class="nd-row"><div><span class="nd-name">${esc(i.name)}</span> <span class="nd-q">${esc(q)}</span><div class="nd-note">${note}</div></div>
          <div class="nd-right">${right}${canPick ? `<button class="btn btn-ghost btn-sm" data-pick="${i.id}">Cambiar</button>` : ''}</div></li>`;
      };
      el.innerHTML = `<h2 class="serif">Cómo se calcula</h2>
        <p>Total de la receta para ${version.servings || 1} ${version.servings === 1 ? 'ración' : 'raciones'}, a partir de valores medios por 100 g. Es orientativo.</p>
        <ul class="nd-list">${n.items.map(row).join('')}</ul>
        <p class="hint">Datos: USDA FoodData Central (SR Legacy) vía TempoLife, CC-BY-4.0.</p>
        <div class="actions"><button class="btn" data-close>Cerrar</button></div>`;
      el.addEventListener('click', (e) => {
        const p = e.target.closest('[data-pick]'); if (p) close({ pick: p.dataset.pick });
        if (e.target.closest('[data-close]')) close();
      });
    }, { label: 'Detalle nutricional' });
    if (!choice?.pick) return;
    const ing = version.ingredients.find((x) => x.id === choice.pick);
    const key = await pickFood(ing);
    if (key === undefined) return;
    if (key === null) delete ing.nutriKey; else ing.nutriKey = key;
    await Store.save(recipe);
    $('#nutri', app).innerHTML = nutriHTML();
    toast('Cálculo actualizado');
  }

  function statsHTML() {
    const stat = (n, label) => `<div class="stat"><span class="stat-n serif">${n}</span><span class="stat-l">${label}</span></div>`;
    const steps = version.prep.length + version.cook.length;
    const m = version.minutes || 0;
    const time = !m ? stat('—', 'minutos') : m < 60 ? stat(m, 'minutos') : stat(formatMinutes(m).replace(' min', '′').replace(' h', 'h'), 'tiempo');
    return `<div class="stats">${time}${stat(version.servings || '—', (version.servings || 0) === 1 ? 'ración' : 'raciones')}${stat(steps || '—', steps === 1 ? 'paso' : 'pasos')}</div>`;
  }

  function stepsHTML() {
    const steps = version[tab];
    if (!steps.length) return `<p class="muted-empty">Sin pasos de ${tab === 'prep' ? 'preparación' : 'elaboración'}.</p>`;
    const checks = checksFor(version.id);
    return `<ol class="steps">${steps.map((s, n) => {
      const done = checks.has(s.id);
      return `<li class="step ${done ? 'is-done' : ''}" data-check="${s.id}" role="checkbox" aria-checked="${done}" tabindex="0">
        <span class="step-num serif">${String(n + 1).padStart(2, '0')}</span>
        <div><p class="step-text">${esc(s.text)}</p>
          ${s.imageId && Images.cached(s.imageId) ? photoHTML(s.imageId, { natural: true }) : ''}
          ${s.timerMin ? `<span class="step-timer">${icon('timer', 'ic-sm')}${formatMinutes(s.timerMin)}</span>` : ''}</div></li>`;
    }).join('')}</ol>`;
  }

  function paint() {
    const hasSteps = version.prep.length + version.cook.length > 0;
    app.innerHTML = `<div class="page">
      <div class="recipe-top">
        <button class="icon-btn glass" data-act="back" aria-label="Volver">${icon('arrow-left')}</button>
        <div class="row">
          <button class="icon-btn glass ${recipe.favorite ? 'is-on' : ''}" data-act="fav" aria-pressed="${recipe.favorite}" aria-label="Favorita">${icon('heart')}</button>
          <button class="icon-btn glass" data-act="card" aria-label="Compartir tarjeta de la receta">${icon('share-2')}</button>
          <button class="icon-btn glass" data-act="menu" aria-label="Más opciones">${icon('ellipsis-vertical')}</button>
        </div>
      </div>
      <div class="recipe-layout">
        <div class="recipe-aside">
          <section class="recipe-hero">
            ${photoHTML(recipe.coverImageId, { alt: recipe.name, hero: true })}
            ${recipe.category ? `<p class="recipe-kicker">${esc(recipe.category)}</p>` : ''}
            <h1 class="recipe-name serif">${esc(recipe.name || 'Sin nombre')}</h1>
            ${statsHTML()}
          </section>
        </div>
        <div>
          <section class="block versions-block" aria-label="Versiones">
            <div class="chips text-tabs">
              ${recipe.versions.map((v) => `<button class="chip ${v.id === version.id ? 'is-on' : ''}" data-version="${v.id}" aria-pressed="${v.id === version.id}">${esc(v.name)}</button>`).join('')}
              <button class="chip text-tab-add" data-act="new-version">${icon('plus', 'ic-sm')}Versión</button>
            </div>
          </section>
          <section class="block">
            <div class="block-head">
              <h2 class="block-title serif">Ingredientes</h2>
              <div class="stepper" aria-label="Raciones">
                <button class="icon-btn" data-act="less" aria-label="Menos raciones">${icon('minus', 'ic-sm')}</button>
                <output aria-live="polite">${servings} ${servings === 1 ? 'ración' : 'raciones'}</output>
                <button class="icon-btn" data-act="more" aria-label="Más raciones">${icon('plus', 'ic-sm')}</button>
              </div>
            </div>
            <div id="ings">${ingredientsHTML()}</div>
            ${version.ingredients.length ? `<button class="btn add-row" data-act="to-shop" style="margin-top:14px">${icon('shopping-cart', 'ic-sm')}Añadir a la lista de la compra</button>` : ''}
          </section>
          <section class="block" id="nutri">${nutriHTML()}</section>
          <section class="block">
            <div class="block-head"><h2 class="block-title serif">Pasos</h2></div>
            <div class="segmented" role="tablist">
              <button role="tab" data-tab="prep" aria-selected="${tab === 'prep'}">Preparación<span class="count">${version.prep.length}</span></button>
              <button role="tab" data-tab="cook" aria-selected="${tab === 'cook'}">Elaboración<span class="count">${version.cook.length}</span></button>
            </div>
            <div id="steps" role="tabpanel">${stepsHTML()}</div>
          </section>
          ${usedIn.length ? `<section class="block"><h2 class="block-title serif" style="margin-bottom:10px">Se usa en</h2>
            <div class="chips">${usedIn.map((r) => `<button class="chip" data-open="${r.id}">${icon('book-open', 'ic-sm')}${esc(r.name)}</button>`).join('')}</div></section>` : ''}
          ${version.notes ? `<section class="block"><h2 class="block-title serif" style="margin-bottom:10px">Notas</h2><p class="notes">${esc(version.notes)}</p></section>` : ''}
        </div>
      </div>
    </div>
    ${hasSteps ? `<div class="cta-bar"><button class="btn btn-primary" data-act="cook">${icon('chef-hat')}Empezar a cocinar</button></div>` : ''}`;
  }

  paint();

  const setVersion = (v) => {
    version = v; servings = v.servings || 1; tab = v.prep.length ? 'prep' : 'cook';
    history.replaceState(null, '', `#/receta/${recipe.id}?v=${v.id}`);
    paint();
  };

  const onClick = async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { e.stopPropagation(); Router.go(`#/receta/${open.dataset.open}`); return; }
    const check = e.target.closest('[data-check]');
    if (check) { toggleCheck(check); return; }
    const vb = e.target.closest('[data-version]');
    if (vb) { setVersion(recipe.versions.find((v) => v.id === vb.dataset.version)); return; }
    const tb = e.target.closest('[data-tab]');
    if (tb) { tab = tb.dataset.tab; $$('[data-tab]', app).forEach((b) => b.setAttribute('aria-selected', String(b === tb))); $('#steps', app).innerHTML = stepsHTML(); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    switch (a.dataset.act) {
      case 'back': Router.back('#/'); break;
      case 'fav':
        recipe.favorite = !recipe.favorite;
        await Store.touch(recipe);
        a.classList.toggle('is-on', recipe.favorite); a.setAttribute('aria-pressed', String(recipe.favorite));
        toast(recipe.favorite ? 'Añadida a favoritas' : 'Quitada de favoritas');
        break;
      case 'less': case 'more':
        servings = Math.max(1, Math.min(99, servings + (a.dataset.act === 'more' ? 1 : -1)));
        $('.stepper output', app).textContent = `${servings} ${servings === 1 ? 'ración' : 'raciones'}`;
        $('#ings', app).innerHTML = ingredientsHTML();
        break;
      case 'cook': {
        const subs = linkedOf(version);
        if (subs.length) {
          // Antes de empezar: las elaboraciones vinculadas (salsas, masas…) suelen hacerse primero
          const go = await Sheets.open((el, close) => {
            el.innerHTML = `<h2 class="serif">Antes de empezar</h2>
              <p>Esta receta lleva ${subs.length === 1 ? 'otra receta' : 'otras recetas'} que conviene tener lista${subs.length === 1 ? '' : 's'}:</p>
              <div class="pick-list">${subs.map((r) => `<button class="pick-row" data-sub="${r.id}">${thumbHTML(r.coverImageId)}
                <span><span class="pick-name serif">${esc(r.name)}</span><span class="pick-meta">Ver receta y cocinarla</span></span></button>`).join('')}</div>
              <div class="actions"><button class="btn btn-primary" data-c="main">${icon('chef-hat', 'ic-sm')}Ya la tengo: empezar</button></div>`;
            el.addEventListener('click', (ev) => {
              const sb = ev.target.closest('[data-sub]'); if (sb) close({ sub: sb.dataset.sub });
              const c = ev.target.closest('[data-c]'); if (c) close({ main: true });
            });
          }, { label: 'Antes de empezar' });
          if (go?.sub) Router.go(`#/receta/${go.sub}`);
          if (go?.main) Router.go(`#/cocinar/${recipe.id}?v=${version.id}&r=${servings}`);
          break;
        }
        Router.go(`#/cocinar/${recipe.id}?v=${version.id}&r=${servings}`);
        break;
      }
      case 'new-version': newVersionFlow(recipe, version); break;
      case 'to-shop': addToShopping(recipe.id, version.id, servings); break;
      case 'nutri-detail': nutriDetail(); break;
      case 'card':
        a.disabled = true;
        try { await shareCardFlow(recipe, version, servings); } catch { toast('No se pudo crear la tarjeta'); }
        a.disabled = false;
        break;
      case 'menu': recipeMenu(recipe, version, setVersion); break;
    }
  };

  function toggleCheck(el) {
    const checks = checksFor(version.id);
    const key = el.dataset.check;
    checks.has(key) ? checks.delete(key) : checks.add(key);
    const done = checks.has(key);
    el.classList.toggle('is-done', done);
    el.setAttribute('aria-checked', String(done));

  }

  const onKey = (e) => { if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-check]')) { e.preventDefault(); toggleCheck(e.target); } };
  app.addEventListener('click', onClick);
  app.addEventListener('keydown', onKey);
  return { destroy: () => { app.removeEventListener('click', onClick); app.removeEventListener('keydown', onKey); } };
}

async function newVersionFlow(recipe, from) {
  const name = await promptSheet({ title: 'Nueva versión', label: `Se copia “${from.name}” y cambias solo lo que difiera`, placeholder: 'De la abuela, Rápida, Sin gluten…', ok: 'Crear y editar' });
  if (!name) return;
  Router.go(`#/editar/${recipe.id}?v=nueva&desde=${from.id}&nombre=${encodeURIComponent(name)}`);
}

async function recipeMenu(recipe, version, setVersion) {
  const multi = recipe.versions.length > 1;
  const choice = await menuSheet('Opciones de la receta', [
    { icon: 'pencil', label: multi ? `Editar versión “${version.name}”` : 'Editar receta', value: 'edit' },
    { icon: 'calendar-days', label: 'Añadir al menú de la semana', value: 'plan' },
    { icon: 'copy', label: 'Duplicar esta versión', value: 'dup' },
    ...(multi ? [{ icon: 'trash-2', label: `Eliminar versión “${version.name}”`, value: 'del-version', danger: true }] : []),
    { icon: 'trash-2', label: 'Eliminar receta completa', value: 'del', danger: true },
  ]);
  if (choice === 'edit') Router.go(`#/editar/${recipe.id}?v=${version.id}`);
  if (choice === 'dup') newVersionFlow(recipe, version);
  if (choice === 'plan') addToPlanFlow(recipe, version);
  if (choice === 'del-version') {
    if (!(await confirmSheet({ title: `¿Eliminar “${version.name}”?`, text: 'Se borra solo esta versión. El resto de la receta se mantiene.', ok: 'Eliminar versión', danger: true }))) return;
    const before = clone(recipe.versions);
    recipe.versions = recipe.versions.filter((v) => v.id !== version.id);
    await Store.save(recipe);
    setVersion(recipe.versions[0]);
    toast('Versión eliminada', { label: 'Deshacer', run: async () => {
      recipe.versions = before; await Store.save(recipe);
      setVersion(recipe.versions.find((v) => v.id === version.id) || recipe.versions[0]);
      toast('Versión recuperada');
    } });
  }
  if (choice === 'del') {
    if (!(await confirmSheet({ title: `¿Eliminar “${recipe.name}”?`, text: 'Irá a la papelera durante 30 días (Ajustes → Papelera), por si te arrepientes.', ok: 'Eliminar receta', danger: true }))) return;
    await Store.remove(recipe.id);
    UI.lastRecipeId = null;
    Router.go('#/');
    toast('Receta movida a la papelera', { label: 'Deshacer', run: async () => {
      const r = await Store.restore(recipe.id);
      if (r) { toast('Receta recuperada'); Router.go(`#/receta/${r.id}`); }
    } });
  }
}

/** Hoja para elegir día y comida/cena y apuntar la receta en el menú. */
async function addToPlanFlow(recipe, version) {
  const days = Array.from({ length: 14 }, (_, i) => Dates.addDays(new Date(), i));
  let day = Dates.key(days[0]);
  let slot = new Date().getHours() < 16 ? 'comida' : 'cena';
  const plan = Docs.live(await Docs.get('plan'));
  const label = (d, i) => (i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : `${Dates.weekday(d).slice(0, 3)} ${d.getDate()}`);
  const ok = await Sheets.open((el, close) => {
    const paint = () => {
      const taken = plan[`${day}|${slot}`];
      el.innerHTML = `<h2 class="serif">Añadir al menú</h2><p>${esc(recipe.name)}</p>
        <div class="chips" style="margin-bottom:12px">${days.map((d, i) => `<button class="chip ${Dates.key(d) === day ? 'is-on' : ''}" data-d="${Dates.key(d)}">${label(d, i)}</button>`).join('')}</div>
        <div class="segmented">${SLOTS.map(([k, l]) => `<button data-s="${k}" aria-selected="${k === slot}">${l}</button>`).join('')}</div>
        ${taken ? `<p class="hint">Ese hueco ya tiene receta: se sustituirá.</p>` : ''}
        <div class="actions"><button class="btn btn-ghost" data-c="0">Cancelar</button><button class="btn btn-primary" data-c="1">Añadir</button></div>`;
    };
    paint();
    el.addEventListener('click', (e) => {
      const d = e.target.closest('[data-d]'); if (d) { day = d.dataset.d; paint(); return; }
      const sl = e.target.closest('[data-s]'); if (sl) { slot = sl.dataset.s; paint(); return; }
      const c = e.target.closest('[data-c]'); if (c) close(c.dataset.c === '1');
    });
  }, { label: 'Añadir al menú' });
  if (!ok) return;
  await Docs.put('plan', `${day}|${slot}`, { recipeId: recipe.id, versionId: version.id, servings: version.servings || 2 });
  toast('Añadida al menú', { label: 'Ver menú', run: () => Router.go('#/menu') });
}

/* ---------- Pegar una receta de texto ----------
   Separa título, ingredientes y pasos de un texto copiado de una web o un mensaje.
   Es una ayuda: siempre hay que revisar el resultado. */

const RecipeText = (() => {
  const H_ING = /^(ingredientes?|necesitas|lista de ingredientes)\b/i;
  const H_PREP = /^(preparaci[oó]n previa|preparaci[oó]n|antes de empezar|mise en place)\b/i;
  const H_COOK = /^(elaboraci[oó]n|pasos|instrucciones|modo de (preparaci[oó]n|hacerlo)|procedimiento|c[oó]mo (se )?hac(e|erlo))\b/i;
  const H_OTHER = /^(notas?|consejos?|trucos?)\b/i;
  const WORDNUM = { un: 1, una: 1, uno: 1, medio: 0.5, media: 0.5, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
  const UNIT_RE = /^(kg|kilos?|kilogramos?|g|gr|grs|gramos?|ml|mililitros?|cl|l|litros?|cucharadas?|cdas?|cucharaditas?|cdtas?|tazas?|vasos?|dientes?|pizcas?|unidades?|uds?)\b\.?\s*/i;
  const unitOf = (u) => {
    u = norm(u).replace(/\.$/, '');
    if (/^(kg|kilo|kilos|kilogramo|kilogramos)$/.test(u)) return ['kg', 1];
    if (/^(g|gr|grs|gramo|gramos)$/.test(u)) return ['g', 1];
    if (/^(ml|mililitro|mililitros)$/.test(u)) return ['ml', 1];
    if (u === 'cl') return ['ml', 10];
    if (/^(l|litro|litros)$/.test(u)) return ['l', 1];
    if (/^(cucharada|cucharadas|cda|cdas)$/.test(u)) return ['cda', 1];
    if (/^(cucharadita|cucharaditas|cdta|cdtas)$/.test(u)) return ['cdta', 1];
    if (/^(taza|tazas)$/.test(u)) return ['taza', 1];
    if (/^(vaso|vasos)$/.test(u)) return ['ml', 200];
    if (/^(diente|dientes)$/.test(u)) return ['diente', 1];
    if (/^(pizca|pizcas)$/.test(u)) return ['pizca', 1];
    return ['ud', 1];
  };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const stripBullet = (l) => l.replace(/^\s*(?:[-•*·–]|\d+\s*[.)-](?!\d)|paso\s*\d+\s*[:.)-]?)\s*/i, '').trim();

  function parseIngredient(line) {
    let l = line.replace(/^\s*[-•*·–]\s*/, '').trim();
    let unit = '', qty = null;
    if (/\bal gusto\b/i.test(l)) { unit = 'al gusto'; l = l.replace(/\s*,?\s*al gusto\b/i, '').trim(); }
    // "Arroz: 400 g" o "Arroz (400 g)"
    const tail = l.match(/^(.*?)[\s:,(–-]+(\d+(?:[.,]\d+)?|\d+\/\d+)\s*(kg|g|gr|gramos|ml|l|litros?)?\)?\.?$/i);
    if (tail && !/^\d/.test(l) && tail[1].trim()) {
      const [u, mult] = tail[3] ? unitOf(tail[3]) : ['ud', 1];
      return { id: uid(), qty: parseQty(tail[2]) * mult, unit: unit === 'al gusto' ? unit : u, name: cap(tail[1].trim()) };
    }
    const m = l.match(/^((?:\d+\s+)?\d+\/\d+|\d+(?:[.,]\d+)?|[½¼¾⅓⅔]|\d+\s*[½¼¾⅓⅔])\s*/) || l.match(/^(una?|uno|medio|media|dos|tres|cuatro|cinco|seis)\s+/i);
    if (m) {
      const raw = m[1];
      qty = WORDNUM[norm(raw)] ?? parseQty(raw);
      l = l.slice(m[0].length);
      const um = l.match(UNIT_RE);
      if (um) { const [u, mult] = unitOf(um[1]); unit = unit === 'al gusto' ? unit : u; if (qty != null) qty *= mult; l = l.slice(um[0].length); }
      else if (unit !== 'al gusto') unit = 'ud';
      l = l.replace(/^de\s+/i, '');
    }
    return { id: uid(), qty, unit, name: cap(l.replace(/[.;]$/, '').trim()) };
  }

  const looksLikeIngredient = (l) => l.length < 90 && (/^\s*[-•*·–]/.test(l) || /^(\d|½|¼|¾|⅓|⅔)/.test(l) || /^(una?|medio|media|dos|tres|cuatro)\s/i.test(l) || /\bal gusto\b/i.test(l)) && !/^\d+\s*[.)]\s+\S+\s+\S+\s+\S+/.test(l);

  function parse(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = { name: '', servings: 0, minutes: 0, ingredients: [], prep: [], cook: [], notes: [] };
    let section = null;
    const process = (line, n) => {
      const bare = line.replace(/[:.]$/, '').replace(/^#+\s*/, '');
      const sv = line.match(/(\d+)\s*(raciones|personas|comensales)/i); if (sv && !out.servings) out.servings = +sv[1];
      // El tiempo total solo se toma de líneas de datos ("25 minutos", "Tiempo: 40 min"), no de los pasos
      const tm = line.match(/(\d+)\s*(min\b|minutos)/i);
      if (tm && !out.minutes && line.length < 60 && (!section || /tiempo|total|duraci/i.test(line)) && !/^\d+\s*[.)]/.test(line)) out.minutes = +tm[1];
      // Cabeceras ("Ingredientes:"), también con texto detrás ("Notas: se congela bien")
      for (const [re, sec] of [[H_ING, 'ing'], [H_PREP, 'prep'], [H_COOK, 'cook'], [H_OTHER, 'notes']]) {
        const m = bare.match(re);
        if (!m) continue;
        const rest = line.slice(line.indexOf(m[0]) + m[0].length).replace(/^\s*[:.-]\s*/, '').trim();
        if (rest.length && !/^[:.]/.test(line.slice(line.indexOf(m[0]) + m[0].length).trim()) && bare.length >= 40) break; // es una frase normal
        section = sec;
        if (rest) process(rest, -1);
        return;
      }
      if (n === 0 && !section && line.length < 70 && !looksLikeIngredient(line)) { out.name = cap(bare); return; }
      if (sv && line.length < 40) return;   // "Para 4 personas"
      const target = section || (looksLikeIngredient(line) ? 'ing' : 'cook');
      if (target === 'ing') out.ingredients.push(parseIngredient(line));
      else if (target === 'notes') out.notes.push(line);
      else {
        const t = stripBullet(line);
        const tmr = t.match(/(\d+)\s*(min\b|minutos)/i);
        if (t) out[target].push({ id: uid(), text: cap(t), imageId: null, timerMin: tmr ? +tmr[1] : 0 });
      }
    };
    lines.forEach(process);
    return out;
  }
  return { parse, parseIngredient };
})();

/* ---------- 7.3 Editor ---------- */

async function EditorView(app, id, params) {
  const isNew = id === 'nueva';
  const original = isNew ? Store.newRecipe() : await Store.get(id);
  if (!original) { toast('Esa receta ya no existe'); Router.go('#/'); return; }

  const draft = clone(original);
  let version;
  let isNewVersion = false;
  if (!isNew && params.v === 'nueva') {
    const from = draft.versions.find((v) => v.id === params.desde) || draft.versions[0];
    version = Store.duplicateVersion(from, params.nombre || 'Nueva versión');
    isNewVersion = true;
  } else {
    version = draft.versions.find((v) => v.id === params.v) || draft.versions[0];
  }

  let dirty = false;
  let saved = false;
  const markDirty = () => { dirty = true; };
  const allRecipes = await Store.list();
  const allById = new Map(allRecipes.filter((r) => r.id !== draft.id).map((r) => [r.id, r]));
  const categories = await Categories.list(allRecipes);
  if (draft.category && !categories.some((c) => norm(c) === norm(draft.category))) categories.push(draft.category);

  await Images.preload([draft.coverImageId, ...[...version.prep, ...version.cook].map((s) => s.imageId)]);

  const title = isNew ? 'Nueva receta' : isNewVersion ? 'Nueva versión' : 'Editar receta';

  function categoryChips() {
    const off = isNewVersion ? 'disabled' : '';
    return categories.map((c) => `<button type="button" class="chip ${norm(c) === norm(draft.category) ? 'is-on' : ''}" data-cat="${esc(c)}" aria-pressed="${norm(c) === norm(draft.category)}" ${off}>${esc(c)}</button>`).join('')
      + `<button type="button" class="chip chip-add" data-act="new-cat" ${off}>${icon('plus', 'ic-sm')}Nueva</button>`;
  }

  function unitOptions(sel) {
    return UNITS.map((u) => `<option value="${esc(u.v)}" ${u.v === sel ? 'selected' : ''}>${esc(u.l)}</option>`).join('');
  }

  function ingRow(i) {
    const linked = i.recipeId && allById.get(i.recipeId);
    return `<div class="ing-row" data-ing="${i.id}">
      <input class="input" data-f="qty" inputmode="decimal" placeholder="Cant." value="${esc(editQty(i.qty))}" aria-label="Cantidad">
      <select class="select" data-f="unit" aria-label="Unidad">${unitOptions(i.unit)}</select>
      <input class="input" data-f="name" placeholder="Ingrediente" value="${esc(i.name)}" aria-label="Ingrediente">
      <button class="icon-btn ${linked ? 'is-linked' : ''}" data-act="link-ing" aria-label="${linked ? 'Cambiar receta vinculada' : 'Vincular una receta (p. ej. una salsa)'}">${icon('link', 'ic-sm')}</button>
      <button class="icon-btn" data-act="del-ing" aria-label="Quitar ingrediente">${icon('x', 'ic-sm')}</button>
      <button type="button" class="icon-btn mv-up" data-act="ing-up" aria-label="Subir ingrediente">${icon('arrow-up', 'ic-sm')}</button>
      <button type="button" class="icon-btn mv-down" data-act="ing-down" aria-label="Bajar ingrediente">${icon('arrow-down', 'ic-sm')}</button>
      <div class="frac-bar" aria-label="Fracciones">${FRACTIONS.map(([, sym]) => `<button type="button" data-frac="${sym}" aria-label="Añadir ${sym}">${sym}</button>`).join('')}</div>
      ${linked ? `<div class="ing-link">${icon('book-open', 'ic-sm')}<span>Receta vinculada: <strong>${esc(linked.name)}</strong></span>
        <button type="button" class="icon-btn" data-act="unlink-ing" aria-label="Quitar vínculo">${icon('x', 'ic-sm')}</button></div>` : ''}
    </div>`;
  }

  function stepCard(s, n, phase, total) {
    return `<div class="step-edit" data-step="${s.id}" data-phase="${phase}">
      <div class="step-edit-head"><span class="label">Paso ${n + 1}</span>
        <div class="tools">
          <button class="icon-btn" data-act="up" ${n === 0 ? 'disabled' : ''} aria-label="Subir paso">${icon('arrow-up', 'ic-sm')}</button>
          <button class="icon-btn" data-act="down" ${n === total - 1 ? 'disabled' : ''} aria-label="Bajar paso">${icon('arrow-down', 'ic-sm')}</button>
          <button class="icon-btn" data-act="del-step" aria-label="Eliminar paso">${icon('trash-2', 'ic-sm')}</button>
        </div></div>
      <textarea class="textarea" data-f="text" rows="3" placeholder="Qué hay que hacer en este paso" aria-label="Texto del paso ${n + 1}">${esc(s.text)}</textarea>
      <div class="step-edit-foot">
        ${s.imageId && Images.cached(s.imageId)
          ? `<div class="step-thumb">${photoHTML(s.imageId, { natural: true })}<button class="icon-btn glass" data-act="del-step-photo" aria-label="Quitar foto del paso">${icon('x', 'ic-sm')}</button></div>`
          : `<button class="btn" data-act="step-photo">${icon('camera', 'ic-sm')}Foto</button>`}
        <label class="timer-in">${icon('timer', 'ic-sm')}<input class="input" data-f="timerMin" inputmode="numeric" placeholder="0" value="${s.timerMin || ''}" aria-label="Temporizador en minutos">min</label>
      </div>
    </div>`;
  }

  function stepsBlock(phase) {
    const list = version[phase];
    return `${list.map((s, n) => stepCard(s, n, phase, list.length)).join('')}
      <button class="btn add-row" data-act="add-step" data-phase="${phase}">${icon('plus', 'ic-sm')}Añadir paso</button>`;
  }

  function coverHTML() {
    const has = draft.coverImageId && Images.cached(draft.coverImageId);
    return `<button class="photo-pick ${has ? 'has-photo' : ''}" data-act="cover" aria-label="${has ? 'Cambiar foto del plato' : 'Añadir foto del plato'}">
      ${has ? photoHTML(draft.coverImageId, { alt: 'Foto del plato' }) : `<span class="photo-pick-label">${icon('image-plus')}Añadir foto del plato</span>`}
    </button>
    ${has ? `<div class="photo-actions"><button class="btn" data-act="cover">${icon('camera', 'ic-sm')}Cambiar foto</button><button class="btn btn-ghost" data-act="del-cover">Quitar</button></div>` : ''}`;
  }

  function paint() {
    const y = window.scrollY;
    app.innerHTML = `<div class="page"><form class="editor" novalidate>
      <div class="topbar">
        <button type="button" class="icon-btn" data-act="cancel" aria-label="Cancelar">${icon('x')}</button>
        <h1 class="serif grow" style="text-align:center">${title}</h1>
        <span style="width:48px"></span>
      </div>

      ${!isNewVersion ? `<button type="button" class="btn paste-btn" data-act="paste">${icon('clipboard-paste', 'ic-sm')}Pegar receta de texto</button>` : ''}
      <div class="editor-group" id="cover">${coverHTML()}</div>

      <div class="editor-group">
        <label class="field"><span class="label">Nombre del plato</span>
          <input class="input" data-r="name" value="${esc(draft.name)}" placeholder="Paella de marisco" maxlength="80" ${isNewVersion ? 'disabled' : ''}></label>
        <div class="field"><span class="label">Categoría</span>
          <div class="cat-picker" id="cat-picker" role="group" aria-label="Categoría">${categoryChips()}</div></div>
      </div>

      <div class="editor-group">
        <h2 class="serif">Versión</h2>
        <label class="field"><span class="label">Nombre de la versión</span>
          <input class="input" data-v="name" value="${esc(version.name)}" placeholder="Original" maxlength="40"></label>
        <div class="row2">
          <label class="field"><span class="label">Raciones</span><input class="input" data-v="servings" inputmode="numeric" value="${version.servings || ''}" placeholder="4"></label>
          <label class="field"><span class="label">Tiempo total (min)</span><input class="input" data-v="minutes" inputmode="numeric" value="${version.minutes || ''}" placeholder="45"></label>
        </div>
      </div>

      <div class="editor-group">
        <h2 class="serif">Ingredientes</h2>
        <p class="hint">Cantidades para las raciones indicadas. Se recalculan solas al cambiarlas.</p>
        <div id="ing-list" style="display:grid;gap:8px">${version.ingredients.map(ingRow).join('')}</div>
        <button type="button" class="btn add-row" data-act="add-ing">${icon('plus', 'ic-sm')}Añadir ingrediente</button>
      </div>

      <div class="editor-group"><h2 class="serif">Preparación</h2><p class="hint">Lo que dejas listo antes de cocinar: lavar, cortar, marinar…</p><div style="display:grid;gap:12px">${stepsBlock('prep')}</div></div>
      <div class="editor-group"><h2 class="serif">Elaboración</h2><p class="hint">El cocinado, paso a paso.</p><div style="display:grid;gap:12px">${stepsBlock('cook')}</div></div>

      <div class="editor-group"><h2 class="serif">Notas</h2>
        <textarea class="textarea" data-v="notes" rows="3" placeholder="Trucos, variantes, de dónde viene la receta…">${esc(version.notes)}</textarea></div>

      <div class="editor-bar">
        <button type="button" class="btn btn-ghost" data-act="cancel">Cancelar</button>
        <button type="submit" class="btn btn-primary">${icon('check', 'ic-sm')}Guardar</button>
      </div>
    </form></div>`;
    window.scrollTo(0, y);
    $$('textarea', app).forEach(autosize);
  }

  function autosize(t) { t.style.height = 'auto'; t.style.height = Math.max(88, t.scrollHeight + 2) + 'px'; }

  const findStep = (el) => {
    const card = el.closest('[data-step]');
    const list = version[card.dataset.phase];
    return { list, idx: list.findIndex((s) => s.id === card.dataset.step), card };
  };

  const onInput = (e) => {
    const t = e.target;
    markDirty();
    if (t.matches('textarea')) autosize(t);
    if (t.dataset.r) { draft[t.dataset.r] = t.value; return; }
    if (t.dataset.v) {
      const k = t.dataset.v;
      version[k] = ['servings', 'minutes'].includes(k) ? Math.max(0, parseInt(t.value, 10) || 0) : t.value;
      return;
    }
    const row = t.closest('[data-ing]');
    if (row) {
      const ing = version.ingredients.find((i) => i.id === row.dataset.ing);
      if (t.dataset.f === 'qty') ing.qty = parseQty(t.value);
      else ing[t.dataset.f] = t.value;
      return;
    }
    if (t.closest('[data-step]')) {
      const { list, idx } = findStep(t);
      if (t.dataset.f === 'timerMin') list[idx].timerMin = Math.max(0, parseInt(t.value, 10) || 0);
      else list[idx].text = t.value;
    }
  };

  const onClick = async (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      e.preventDefault();
      draft.category = norm(draft.category) === norm(cat.dataset.cat) ? '' : cat.dataset.cat; // tocar otra vez la quita
      markDirty();
      $('#cat-picker', app).innerHTML = categoryChips();
      return;
    }
    const fr = e.target.closest('[data-frac]');
    if (fr) {
      e.preventDefault();
      const input = fr.closest('[data-ing]').querySelector('[data-f="qty"]');
      const whole = (input.value.match(/^\s*(\d+)(?![\d.,\/])/) || [])[1] || '';
      input.value = (whole === '0' ? '' : whole) + fr.dataset.frac;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    e.preventDefault();
    switch (a.dataset.act) {
      case 'cancel': Router.back(isNew ? '#/' : `#/receta/${draft.id}`); break;
      case 'cover': {
        const idNew = await pickAndEditPhoto({ square: true, maxSide: 1600 });
        if (idNew) { draft.coverImageId = idNew; markDirty(); $('#cover', app).innerHTML = coverHTML(); }
        break;
      }
      case 'del-cover': draft.coverImageId = null; markDirty(); $('#cover', app).innerHTML = coverHTML(); break;
      case 'add-ing': {
        const ing = { id: uid(), qty: null, unit: '', name: '' };
        version.ingredients.push(ing); markDirty();
        $('#ing-list', app).insertAdjacentHTML('beforeend', ingRow(ing));
        $(`[data-ing="${ing.id}"] [data-f="qty"]`, app).focus();
        break;
      }
      case 'new-cat': {
        const name = await promptSheet({ title: 'Nueva categoría', label: 'Nombre', placeholder: 'Desayunos, Cenas ligeras, Sin gluten…', ok: 'Crear' });
        if (!name) return;
        const pretty = await Categories.add(name);
        if (!categories.some((c) => norm(c) === norm(pretty))) { categories.push(pretty); categories.sort((a, b) => a.localeCompare(b, 'es')); }
        draft.category = pretty; markDirty();
        $('#cat-picker', app).innerHTML = categoryChips();
        break;
      }
      case 'link-ing': {
        const row = a.closest('[data-ing]');
        const ing = version.ingredients.find((i) => i.id === row.dataset.ing);
        const r = await pickRecipe('Vincular receta', { exclude: draft.id });
        if (!r) return;
        ing.recipeId = r.id;
        if (!ing.name.trim()) ing.name = r.name;
        if (ing.qty == null && !ing.unit) ing.unit = '';
        markDirty();
        row.outerHTML = ingRow(ing);
        toast(`Vinculada: ${r.name}`);
        break;
      }
      case 'unlink-ing': {
        const row = a.closest('[data-ing]');
        const ing = version.ingredients.find((i) => i.id === row.dataset.ing);
        delete ing.recipeId; markDirty();
        row.outerHTML = ingRow(ing);
        break;
      }
      case 'paste': {
        const text = await Sheets.open((el, close) => {
          el.innerHTML = `<h2 class="serif">Pegar receta</h2>
            <p>Pega el texto de una web o un mensaje. Separaré el título, los ingredientes y los pasos; después lo revisas.</p>
            <textarea class="textarea" rows="10" placeholder="Tortilla de patatas&#10;&#10;Ingredientes:&#10;- 500 g de patatas&#10;- 5 huevos&#10;&#10;Elaboración:&#10;1. Pela y corta las patatas…" autofocus></textarea>
            <div class="actions"><button class="btn btn-ghost" data-c="0">Cancelar</button><button class="btn btn-primary" data-c="1">Separar</button></div>`;
          el.addEventListener('click', (e) => { const c = e.target.closest('[data-c]'); if (c) close(c.dataset.c === '1' ? $('textarea', el).value : null); });
        }, { label: 'Pegar receta' });
        if (!text || !text.trim()) return;
        const r = RecipeText.parse(text);
        if (r.name && !draft.name.trim()) draft.name = r.name;
        if (r.servings) version.servings = r.servings;
        if (r.minutes && !version.minutes) version.minutes = r.minutes;
        version.ingredients = [...version.ingredients.filter((i) => i.name.trim()), ...r.ingredients];
        version.prep = [...version.prep.filter((x) => x.text.trim()), ...r.prep];
        version.cook = [...version.cook.filter((x) => x.text.trim()), ...r.cook];
        if (r.notes.length) version.notes = [version.notes, ...r.notes].filter(Boolean).join('\n');
        markDirty(); paint();
        toast(`Separados ${r.ingredients.length} ingredientes y ${r.prep.length + r.cook.length} pasos. Revísalos antes de guardar.`);
        break;
      }
      case 'ing-up': case 'ing-down': {
        const id = a.closest('[data-ing]').dataset.ing;
        const list = version.ingredients;
        const i = list.findIndex((x) => x.id === id);
        const j = a.dataset.act === 'ing-up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]]; markDirty();
        $('#ing-list', app).innerHTML = list.map(ingRow).join('');
        $(`[data-ing="${id}"] [data-act="${a.dataset.act}"]`, app)?.focus();
        break;
      }
      case 'del-ing': {
        const row = a.closest('[data-ing]');
        version.ingredients = version.ingredients.filter((i) => i.id !== row.dataset.ing);
        row.remove(); markDirty();
        break;
      }
      case 'add-step': {
        const s = { id: uid(), text: '', imageId: null, timerMin: 0 };
        version[a.dataset.phase].push(s); markDirty(); paint();
        $(`[data-step="${s.id}"] textarea`, app)?.focus();
        break;
      }
      case 'del-step': {
        const { list, idx } = findStep(a);
        if (list[idx].text.trim() && !(await confirmSheet({ title: '¿Eliminar este paso?', ok: 'Eliminar', danger: true }))) return;
        list.splice(idx, 1); markDirty(); paint();
        break;
      }
      case 'up': case 'down': {
        const { list, idx } = findStep(a);
        const j = a.dataset.act === 'up' ? idx - 1 : idx + 1;
        if (j < 0 || j >= list.length) return;
        [list[idx], list[j]] = [list[j], list[idx]]; markDirty(); paint();
        break;
      }
      case 'step-photo': {
        const { list, idx } = findStep(a);
        const idNew = await pickAndEditPhoto({ square: false, maxSide: 1200 });
        if (idNew) { list[idx].imageId = idNew; markDirty(); paint(); }
        break;
      }
      case 'del-step-photo': { const { list, idx } = findStep(a); list[idx].imageId = null; markDirty(); paint(); break; }
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      toast('Ponle nombre al plato');
      const input = $('[data-r="name"]', app); input.focus(); input.scrollIntoView({ block: 'center' });
      return;
    }
    // Limpieza: fuera ingredientes y pasos vacíos
    version.name = version.name.trim() || 'Original';
    version.ingredients = version.ingredients.filter((i) => i.name.trim());
    version.prep = version.prep.filter((s) => s.text.trim() || s.imageId);
    version.cook = version.cook.filter((s) => s.text.trim() || s.imageId);
    draft.name = name;
    draft.category = draft.category.trim();
    if (isNewVersion) draft.versions.push(version);
    else draft.versions = draft.versions.map((v) => (v.id === version.id ? version : v));
    await Store.save(draft);
    saved = true;
    toast(isNew ? 'Receta guardada' : isNewVersion ? 'Versión creada' : 'Cambios guardados');
    UI.lastRecipeId = draft.id;
    const target = `#/receta/${draft.id}?v=${version.id}`;
    // Nueva: el editor se sustituye por la receta. Edición: volvemos a la receta (sin duplicar el historial).
    if (isNew || !Router.back) location.replace(target);
    else { UI.redirect = target; Router.back(target); }
  };

  paint();
  app.addEventListener('input', onInput);
  app.addEventListener('change', onInput);
  app.addEventListener('click', onClick);
  app.addEventListener('submit', onSubmit);
  const onEnter = (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault(); };
  app.addEventListener('keydown', onEnter);
  // Que tocar una fracción no quite el foco del campo de cantidad (si no, la barra se escondería)
  const keepFocus = (e) => { if (e.target.closest('[data-frac]')) e.preventDefault(); };
  app.addEventListener('pointerdown', keepFocus);
  const onUnload = (e) => { if (dirty && !saved) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);

  return {
    canLeave: async () => saved || !dirty || confirmSheet({ title: '¿Salir sin guardar?', text: 'Perderás los cambios de esta receta.', ok: 'Salir sin guardar', cancel: 'Seguir editando', danger: true }),
    destroy: () => {
      app.removeEventListener('input', onInput); app.removeEventListener('change', onInput);
      app.removeEventListener('click', onClick); app.removeEventListener('submit', onSubmit);
      app.removeEventListener('keydown', onEnter);
      app.removeEventListener('pointerdown', keepFocus);
      window.removeEventListener('beforeunload', onUnload);
    },
  };
}

/* ---------- 7.4 Modo cocina ---------- */

const Timers = (() => {
  const map = new Map(); // stepId -> { total, remaining, endAt, running, done, label }
  let tick = null;
  let audio = null;
  const listeners = new Set();

  const emit = () => listeners.forEach((fn) => fn());

  function ensureTick() {
    if (tick) return;
    tick = setInterval(() => {
      let any = false;
      for (const [id, t] of map) {
        if (!t.running) continue;
        any = true;
        t.remaining = (t.endAt - Date.now()) / 1000;
        if (t.remaining <= 0) { t.remaining = 0; t.running = false; t.done = true; alarm(t.label); }
      }
      emit();
      if (!any) { clearInterval(tick); tick = null; }
    }, 250);
  }

  function alarm(label) {
    navigator.vibrate?.([400, 180, 400, 180, 700]);
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.45, 0.9].forEach((t) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.35);
        o.connect(g).connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.4);
      });
    } catch { /* sin sonido disponible */ }
    toast(`Tiempo: ${label}`);
  }

  return {
    get: (id) => map.get(id),
    start(id, minutes, label) {
      // El AudioContext se crea con el toque del usuario para que Android permita el sonido
      try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* */ }
      const t = map.get(id);
      if (t && !t.done) { t.endAt = Date.now() + t.remaining * 1000; t.running = true; }
      else map.set(id, { total: minutes * 60, remaining: minutes * 60, endAt: Date.now() + minutes * 60000, running: true, done: false, label });
      ensureTick(); emit();
    },
    pause(id) { const t = map.get(id); if (t?.running) { t.remaining = (t.endAt - Date.now()) / 1000; t.running = false; emit(); } },
    reset(id) { map.delete(id); emit(); },
    running: () => [...map.entries()].filter(([, t]) => t.running),
    clear() { map.clear(); emit(); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

async function CookView(app, id, params) {
  const recipe = await Store.get(id);
  if (!recipe) { Router.go('#/'); return; }
  const version = recipe.versions.find((v) => v.id === params.v) || recipe.versions[0];
  const servings = Math.max(1, parseInt(params.r, 10) || version.servings || 1);
  const steps = [...version.prep.map((s) => ({ ...s, phase: 'Preparación' })), ...version.cook.map((s) => ({ ...s, phase: 'Elaboración' }))];
  if (!steps.length) { Router.go(`#/receta/${id}`); return; }
  await Images.preload([recipe.coverImageId, ...steps.map((s) => s.imageId)]);

  let index = 0;
  let wakeLock = null;

  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { /* sin permiso */ }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') keepAwake(); };
  keepAwake();
  document.addEventListener('visibilitychange', onVisible);

  function timerHTML(s) {
    if (!s.timerMin) return '';
    const t = Timers.get(s.id);
    const remaining = t ? t.remaining : s.timerMin * 60;
    const state = t?.done ? 'is-done' : t?.running ? 'is-running' : '';
    return `<div class="timer-card ${state}" data-timer-card="${s.id}">
      <span class="label">Temporizador</span>
      <span class="timer-digits" data-digits>${formatClock(remaining)}</span>
      <div class="timer-controls">
        ${t?.running
          ? `<button class="btn" data-act="pause">${icon('pause', 'ic-sm')}Pausar</button>`
          : `<button class="btn btn-primary" data-act="start">${icon('play', 'ic-sm')}${t && !t.done ? 'Seguir' : 'Iniciar'}</button>`}
        ${t ? `<button class="icon-btn" data-act="reset" aria-label="Reiniciar temporizador">${icon('rotate-ccw', 'ic-sm')}</button>` : ''}
      </div></div>`;
  }

  function runningHTML() {
    const others = Timers.running().filter(([sid]) => sid !== steps[index].id);
    return others.map(([sid, t]) => {
      const n = steps.findIndex((s) => s.id === sid);
      return `<button data-jump="${n}" aria-label="Ir al paso ${n + 1}">${icon('timer', 'ic-sm')}Paso ${n + 1} · ${formatClock(t.remaining)}</button>`;
    }).join('');
  }

  function paint() {
    const s = steps[index];
    const last = index === steps.length - 1;
    const phaseN = steps.filter((x) => x.phase === s.phase).indexOf(s) + 1;
    const phaseTotal = steps.filter((x) => x.phase === s.phase).length;
    app.innerHTML = `<div class="cook">
      <header class="cook-head">
        <div class="topbar">
          <button class="icon-btn" data-act="close" aria-label="Salir del modo cocina">${icon('x')}</button>
          <span>Paso ${index + 1} de ${steps.length}</span>
          <div style="display:flex">
            ${Voice.supported.speak ? `<button class="icon-btn ${Voice.active ? 'is-on' : ''}" data-act="voice" aria-pressed="${Voice.active}" aria-label="${Voice.active ? 'Desactivar manos libres' : 'Activar manos libres'}">${icon(Voice.active ? 'mic' : 'mic-off')}</button>` : ''}
            <button class="icon-btn" data-act="ings" aria-label="Ver ingredientes">${icon('list')}</button>
          </div>
        </div>
        <div class="progress" aria-hidden="true">${steps.map((_, i) => `<i class="${i <= index ? 'on' : ''}"></i>`).join('')}</div>
        <div class="running-timers" id="running">${runningHTML()}</div>
        ${Voice.active ? `<p class="voice-hint">${icon('volume-2', 'ic-sm')}${Voice.supported.listen ? 'Di «siguiente», «anterior», «repite», «temporizador» o «ingredientes»' : 'Leyendo los pasos en voz alta'}</p>` : ''}
      </header>
      <section class="cook-body" aria-live="polite">
        ${s.imageId && Images.cached(s.imageId)
          ? photoHTML(s.imageId, { natural: true })
          : Images.cached(recipe.coverImageId) ? `<div class="cook-cover">${photoHTML(recipe.coverImageId, { alt: '' })}</div>` : ''}
        <p class="cook-phase">${s.phase} ${phaseN} de ${phaseTotal}</p>
        <p class="cook-text serif">${esc(s.text)}</p>
        <div id="timer">${timerHTML(s)}</div>
      </section>
      <nav class="cook-nav">
        <button class="btn" data-act="prev" ${index === 0 ? 'disabled' : ''} aria-label="Paso anterior">${icon('chevron-left')}</button>
        <button class="btn btn-primary" data-act="${last ? 'finish' : 'next'}">${last ? `${icon('check')}Terminar` : `Siguiente paso${icon('chevron-right')}`}</button>
      </nav>
    </div>`;
  }

  const update = () => {
    const s = steps[index];
    const card = $(`[data-timer-card="${s.id}"]`, app);
    const t = Timers.get(s.id);
    if (card) {
      const wantState = t?.done ? 'is-done' : t?.running ? 'is-running' : '';
      const hasState = card.classList.contains('is-done') ? 'is-done' : card.classList.contains('is-running') ? 'is-running' : '';
      if (wantState !== hasState || (!!t) !== !!card.querySelector('[data-act="reset"]')) $('#timer', app).innerHTML = timerHTML(s);
      else $('[data-digits]', card).textContent = formatClock(t ? t.remaining : s.timerMin * 60);
    }
    const r = $('#running', app);
    if (r) r.innerHTML = runningHTML();
  };
  const off = Timers.on(update);

  const readStep = () => {
    const s = steps[index];
    Voice.speak(`Paso ${index + 1}. ${s.text}${s.timerMin ? `. Temporizador de ${formatMinutes(s.timerMin).replace('min', 'minutos').replace(' h', ' horas')}.` : ''}`);
  };
  const move = (d) => { const n = index + d; if (n < 0 || n >= steps.length) return; index = n; paint(); readStep(); };
  const voiceHandlers = {
    next: () => { if (index === steps.length - 1) Voice.speak('Es el último paso. ¡Que aproveche!'); else move(1); },
    prev: () => move(-1),
    repeat: readStep,
    timer: () => { const s = steps[index]; if (s.timerMin) { Timers.start(s.id, s.timerMin, `paso ${index + 1}`); Voice.speak('Temporizador en marcha.'); } else Voice.speak('Este paso no tiene temporizador.'); },
    pause: () => { Timers.pause(steps[index].id); },
    ingredients: () => {
      const factor = servings / (version.servings || 1);
      Voice.speak('Ingredientes: ' + version.ingredients.map((i) => {
        const q = i.qty == null ? null : (NO_SCALE_UNITS.has(i.unit) ? i.qty : i.qty * factor);
        return `${qtyLabel(q, i.unit)} ${i.name}`.replace(/\bg\b/, 'gramos').replace(/\bml\b/, 'mililitros');
      }).join(', '));
    },
  };

  async function showIngredients() {
    const factor = servings / (version.servings || 1);
    await Sheets.open((el, close) => {
      el.innerHTML = `<h2 class="serif">Ingredientes</h2><p>${servings} ${servings === 1 ? 'ración' : 'raciones'}</p>
        <ul class="ingredients">${version.ingredients.map((i) => {
          const q = i.qty == null ? null : (NO_SCALE_UNITS.has(i.unit) ? i.qty : i.qty * factor);
          const qty = qtyLabel(q, i.unit);
          return `<li class="ing" style="grid-template-columns:96px 1fr;cursor:default"><span class="qty">${esc(qty)}</span><span class="name">${esc(i.name)}</span></li>`;
        }).join('') || '<li class="muted-empty">Sin ingredientes.</li>'}</ul>
        <div class="actions"><button class="btn" data-close>Cerrar</button></div>`;
      el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    }, { label: 'Ingredientes' });
  }

  const onClick = async (e) => {
    const j = e.target.closest('[data-jump]');
    if (j) { index = +j.dataset.jump; paint(); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const s = steps[index];
    switch (a.dataset.act) {
      case 'prev': move(-1); break;
      case 'next': move(1); break;
      case 'start': Timers.start(s.id, s.timerMin, `paso ${index + 1}`); break;
      case 'pause': Timers.pause(s.id); break;
      case 'reset': Timers.reset(s.id); $('#timer', app).innerHTML = timerHTML(s); break;
      case 'ings': showIngredients(); break;
      case 'voice':
        if (Voice.active) { Voice.stop(); toast('Manos libres desactivado'); }
        else {
          Voice.start(voiceHandlers, (st) => { if (st === 'denied') paint(); });
          if (!Voice.supported.listen) toast('Este navegador no reconoce la voz: solo leeré los pasos.');
          readStep();
        }
        paint();
        break;
      case 'close': Router.back(`#/receta/${id}?v=${version.id}`); break;
      case 'finish':
        recipe.lastCookedAt = Date.now();
        await Store.touch(recipe);
        Timers.clear();
        toast('Que aproveche');
        Router.back(`#/receta/${id}?v=${version.id}`);
        break;
    }
  };

  // Deslizar a izquierda/derecha para cambiar de paso
  let x0 = null, y0 = null;
  const onTouchStart = (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    if (x0 == null || Sheets.isOpen()) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) move(dx < 0 ? 1 : -1);
    x0 = null;
  };
  const onKey = (e) => { if (Sheets.isOpen()) return; if (e.key === 'ArrowRight') move(1); if (e.key === 'ArrowLeft') move(-1); };

  paint();
  app.addEventListener('click', onClick);
  app.addEventListener('touchstart', onTouchStart, { passive: true });
  app.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('keydown', onKey);

  return {
    canLeave: async () => {
      if (!Timers.running().length) return true;
      const ok = await confirmSheet({ title: '¿Salir del modo cocina?', text: 'Hay temporizadores en marcha y se pararán.', ok: 'Salir y pararlos', cancel: 'Seguir cocinando', danger: true });
      if (ok) Timers.clear();
      return ok;
    },
    destroy: () => {
      off();
      Voice.stop();
      wakeLock?.release?.().catch(() => {});
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('keydown', onKey);
      app.removeEventListener('click', onClick);
      app.removeEventListener('touchstart', onTouchStart);
      app.removeEventListener('touchend', onTouchEnd);
    },
  };
}

/* ---------- 7.6 Barra inferior y utilidades compartidas ---------- */

function tabbarHTML(active) {
  const tab = (href, ic, label, key) =>
    `<a class="tab ${active === key ? 'is-on' : ''}" href="${href}" ${active === key ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  return `<nav class="tabbar" aria-label="Secciones"><div class="tabbar-pill">
    ${tab('#/', 'book-open', 'Recetas', 'home')}${tab('#/menu', 'calendar-days', 'Menú', 'menu')}
    <a class="tab-add" href="#/editar/nueva" aria-label="Nueva receta">${icon('plus')}</a>
    ${tab('#/compra', 'shopping-cart', 'Compra', 'shop')}${tab('#/ajustes', 'settings-2', 'Ajustes', 'settings')}
  </div></nav>`;
}

/** Miniatura redonda para listas (menú, compra, selector). */
function thumbHTML(imageId) {
  const src = Images.cached(imageId);
  return `<span class="thumb">${src ? `<img src="${src}" alt="">` : PLATE_SVG}</span>`;
}

/** Elegir a qué alimento de la tabla corresponde un ingrediente.
    Devuelve la clave, null (volver a detección automática), 'none' (no contar) o undefined (cancelar). */
function pickFood(ing) {
  const foods = Nutrition.foods();
  return Sheets.open((el, close) => {
    el.innerHTML = `<h2 class="serif">¿Qué es «${esc(ing.name)}»?</h2>
      <label class="search" style="margin:4px 0 12px"><span class="sr-only">Buscar alimento</span>${icon('search', 'ic-sm')}
        <input class="input" type="search" placeholder="Buscar alimento" autocomplete="off"></label>
      <div class="actions" style="justify-content:flex-start;margin:0 0 10px"><button class="btn btn-sm" data-k="__auto">Automático</button><button class="btn btn-sm" data-k="none">No contar</button></div>
      <div class="pick-list"></div>`;
    const list = $('.pick-list', el), input = $('input', el);
    const paint = () => {
      const q = norm(input.value);
      list.innerHTML = foods.filter((f) => !q || norm(f).includes(q)).map((f) => {
        const r = Nutrition.byKey.get(f);
        return `<button class="pick-row" data-k="${esc(f)}"><span><span class="pick-name">${esc(Nutrition.label(f))}</span><span class="pick-meta">${Math.round(r[1])} kcal · ${nf.format(r[2])} g proteína por 100 g</span></span></button>`;
      }).join('') || '<p class="muted-empty">No hay alimentos con ese nombre.</p>';
    };
    paint();
    input.addEventListener('input', paint);
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) close(b.dataset.k === '__auto' ? null : b.dataset.k); });
  }, { label: 'Elegir alimento' });
}

/** Hoja para elegir una receta con buscador. Devuelve la receta o undefined. */
async function pickRecipe(title = 'Elige una receta', { exclude = null } = {}) {
  const recipes = (await Store.list()).filter((r) => r.id !== exclude).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  await Images.preload(recipes.map((r) => r.coverImageId));
  if (!recipes.length) { toast('Aún no tienes recetas'); return undefined; }
  return Sheets.open((el, close) => {
    el.innerHTML = `<h2 class="serif">${esc(title)}</h2>
      <label class="search" style="margin:4px 0 12px"><span class="sr-only">Buscar</span>${icon('search', 'ic-sm')}
        <input class="input" type="search" placeholder="Buscar receta" autocomplete="off"></label>
      <div class="pick-list"></div>`;
    const list = $('.pick-list', el);
    const input = $('input', el);
    const paint = () => {
      const found = recipes.filter((r) => matchesQuery(r, input.value));
      list.innerHTML = found.map((r) => `<button class="pick-row" data-id="${r.id}">${thumbHTML(r.coverImageId)}
        <span><span class="pick-name serif">${esc(r.name)}</span><span class="pick-meta">${esc([r.category, formatMinutes(r.versions[0].minutes)].filter(Boolean).join('   '))}</span></span></button>`).join('')
        || '<p class="muted-empty">No hay recetas con ese nombre.</p>';
    };
    paint();
    input.addEventListener('input', paint);
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) close(recipes.find((r) => r.id === b.dataset.id)); });
  }, { label: title });
}

/* ---------- Fechas del menú ---------- */

const Dates = {
  key: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  monday(offsetWeeks = 0) {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetWeeks * 7);
    return d;
  },
  addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
  short: (d) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }).replace('.', ''),
  weekday: (d) => { const w = d.toLocaleDateString('es-ES', { weekday: 'long' }); return w.charAt(0).toUpperCase() + w.slice(1); },
};
const SLOTS = [['comida', 'Comida'], ['cena', 'Cena']];

/* ---------- Añadir a la lista de la compra ---------- */

async function addToShopping(recipeId, versionId, servings, { silent = false } = {}) {
  const key = `${recipeId}|${versionId}`;
  const cur = Docs.live(await Docs.get('shopRecipes'))[key];
  await Docs.put('shopRecipes', key, { recipeId, versionId, servings: (cur?.servings || 0) + servings });
  if (!silent) toast('Añadida a la lista de la compra', { label: 'Ver lista', run: () => Router.go('#/compra') });
}

/* ---------- 7.7 Menú semanal ---------- */

async function MenuView(app) {
  UI.menuWeek ??= 0;
  const recipes = await Store.list();
  const byId = new Map(recipes.map((r) => [r.id, r]));
  await Images.preload(recipes.map((r) => r.coverImageId));
  let firstPaint = true;

  async function paint() {
    const plan = Docs.live(await Docs.get('plan'));
    const monday = Dates.monday(UI.menuWeek);
    const days = Array.from({ length: 7 }, (_, i) => Dates.addDays(monday, i));
    const todayKey = Dates.key(new Date());
    const weekEntries = days.flatMap((d) => SLOTS.map(([s]) => plan[`${Dates.key(d)}|${s}`]).filter((e) => e && byId.has(e.recipeId)));
    const y = window.scrollY;

    app.innerHTML = `<div class="page has-tabbar">
      <header class="home-head">
        <div class="topbar"><p class="home-date">${UI.menuWeek === 0 ? 'Esta semana' : UI.menuWeek === 1 ? 'La semana que viene' : UI.menuWeek === -1 ? 'La semana pasada' : ''}</p></div>
        <h1 class="home-title serif">Menú</h1>
      </header>
      <div class="week-nav">
        <button class="icon-btn" data-act="prev" aria-label="Semana anterior">${icon('chevron-left')}</button>
        <span class="week-range">${Dates.short(days[0])} – ${Dates.short(days[6])}</span>
        <button class="icon-btn" data-act="next" aria-label="Semana siguiente">${icon('chevron-right')}</button>
        ${UI.menuWeek !== 0 ? `<button class="chip" data-act="today">Hoy</button>` : ''}
      </div>
      <div class="week">
        ${days.map((d) => {
          const k = Dates.key(d);
          return `<section class="day ${k === todayKey ? 'is-today' : k < todayKey ? 'is-past' : ''}" aria-label="${Dates.weekday(d)} ${d.getDate()}">
            <h2 class="day-name"><span class="serif">${Dates.weekday(d)}</span><span>${d.getDate()}</span></h2>
            ${dayNutri(k, plan)}
            ${SLOTS.map(([s, label]) => {
              const e = plan[`${k}|${s}`];
              const r = e && byId.get(e.recipeId);
              return r
                ? `<button class="slot is-filled" data-slot="${k}|${s}"><span class="slot-label">${label}</span>${thumbHTML(r.coverImageId)}
                    <span class="slot-body"><span class="slot-name serif">${esc(r.name)}</span><span class="slot-meta">${e.servings} ${e.servings === 1 ? 'ración' : 'raciones'}</span></span></button>`
                : `<button class="slot" data-slot="${k}|${s}"><span class="slot-label">${label}</span><span class="slot-add">${icon('plus', 'ic-sm')}Añadir</span></button>`;
            }).join('')}
          </section>`;
        }).join('')}
      </div>
      ${weekEntries.length ? `<div class="week-cta">
        <button class="btn btn-primary btn-block" data-act="to-shop">${icon('shopping-cart', 'ic-sm')}Añadir la semana a la lista de la compra</button></div>` : ''}
    </div>
    ${tabbarHTML('menu')}`;
    if (firstPaint) {
      firstPaint = false;
      const today = UI.menuWeek === 0 && $('.day.is-today', app);
      window.scrollTo(0, today && today.offsetTop > innerHeight * 0.6 ? today.offsetTop - 90 : 0);
    } else window.scrollTo(0, y);
  }

  const nutriCache = new Map();
  function dayNutri(k, plan) {
    let kcal = 0, p = 0, any = false;
    for (const [s] of SLOTS) {
      const e = plan[`${k}|${s}`];
      const r = e && byId.get(e.recipeId);
      if (!r) continue;
      const v = r.versions.find((x) => x.id === e.versionId) || r.versions[0];
      const key = `${r.id}|${v.id}|${r.updatedAt}`;
      if (!nutriCache.has(key)) nutriCache.set(key, Nutrition.perServing(r, v, byId));
      const n = nutriCache.get(key);
      if (n.counted) { kcal += n.kcal; p += n.p; any = true; }
    }
    return any ? `<p class="day-kcal">${icon('flame', 'ic-sm')}≈ ${nf.format(Math.round(kcal))} kcal · ${Math.round(p)} g proteína <span>por persona</span></p>` : '';
  }

  async function editSlot(key) {
    const plan = Docs.live(await Docs.get('plan'));
    const e = plan[key];
    if (!e || !byId.has(e.recipeId)) {
      const r = await pickRecipe('¿Qué cocinas?');
      if (!r) return;
      await Docs.put('plan', key, { recipeId: r.id, versionId: r.versions[0].id, servings: r.versions[0].servings || 2 });
      return;
    }
    const r = byId.get(e.recipeId);
    let servings = e.servings;
    let versionId = e.versionId;
    const [day, slot] = key.split('|');
    const when = `${SLOTS.find(([k]) => k === slot)[1]} del ${Dates.weekday(new Date(day + 'T12:00')).toLowerCase()}`;
    const choice = await Sheets.open((el, close) => {
      const paintSheet = () => {
        el.innerHTML = `<p class="hint" style="margin:0 0 4px">${esc(when)}</p><h2 class="serif">${esc(r.name)}</h2>
          ${r.versions.length > 1 ? `<div class="chips" style="margin:10px 0 4px">${r.versions.map((v) => `<button class="chip ${v.id === versionId ? 'is-on' : ''}" data-v="${v.id}">${esc(v.name)}</button>`).join('')}</div>` : ''}
          <div class="block-head" style="margin:16px 0"><span class="label">Raciones</span>
            <div class="stepper"><button class="icon-btn" data-s="-1" aria-label="Menos raciones">${icon('minus', 'ic-sm')}</button>
            <output>${servings} ${servings === 1 ? 'ración' : 'raciones'}</output>
            <button class="icon-btn" data-s="1" aria-label="Más raciones">${icon('plus', 'ic-sm')}</button></div></div>
          <div class="actions" style="justify-content:space-between">
            <button class="btn btn-danger" data-c="remove">Quitar</button>
            <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-c="change">Cambiar</button><button class="btn" data-c="open">Ver receta</button><button class="btn btn-primary" data-c="save">Hecho</button></div>
          </div>`;
      };
      paintSheet();
      el.addEventListener('click', (ev) => {
        const v = ev.target.closest('[data-v]'); if (v) { versionId = v.dataset.v; paintSheet(); return; }
        const st = ev.target.closest('[data-s]'); if (st) { servings = Math.max(1, Math.min(99, servings + +st.dataset.s)); paintSheet(); return; }
        const c = ev.target.closest('[data-c]'); if (c) close(c.dataset.c);
      });
    }, { label: r.name });

    if (choice === 'remove') { await Docs.remove('plan', key); return; }
    if (choice === 'change') {
      const nr = await pickRecipe('¿Qué cocinas?');
      if (nr) await Docs.put('plan', key, { recipeId: nr.id, versionId: nr.versions[0].id, servings });
      return;
    }
    if (servings !== e.servings || versionId !== e.versionId) await Docs.put('plan', key, { ...e, servings, versionId });
    if (choice === 'open') Router.go(`#/receta/${r.id}?v=${versionId}`);
  }

  async function weekToShopping() {
    const plan = Docs.live(await Docs.get('plan'));
    const monday = Dates.monday(UI.menuWeek);
    const sum = new Map();
    for (let i = 0; i < 7; i++) {
      const k = Dates.key(Dates.addDays(monday, i));
      for (const [s] of SLOTS) {
        const e = plan[`${k}|${s}`];
        if (!e || !byId.has(e.recipeId)) continue;
        const id = `${e.recipeId}|${e.versionId}`;
        sum.set(id, { ...e, servings: (sum.get(id)?.servings || 0) + e.servings });
      }
    }
    const ok = await confirmSheet({ title: 'Añadir la semana a la compra', text: `Se añaden los ingredientes de ${sum.size} ${sum.size === 1 ? 'receta' : 'recetas'}, sumando las raciones de toda la semana.`, ok: 'Añadir' });
    if (!ok) return;
    for (const e of sum.values()) await addToShopping(e.recipeId, e.versionId, e.servings, { silent: true });
    toast('Semana añadida a la lista', { label: 'Ver lista', run: () => Router.go('#/compra') });
  }

  const onClick = async (e) => {
    const slot = e.target.closest('[data-slot]');
    if (slot) { editSlot(slot.dataset.slot); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'prev') { UI.menuWeek--; firstPaint = true; paint(); }
    if (a.dataset.act === 'next') { UI.menuWeek++; firstPaint = true; paint(); }
    if (a.dataset.act === 'today') { UI.menuWeek = 0; firstPaint = true; paint(); }
    if (a.dataset.act === 'to-shop') weekToShopping();
  };
  await paint();
  app.addEventListener('click', onClick);
  const off = Docs.on((name) => { if (name === 'plan' || name === '*') paint(); });
  return { keepScroll: true, destroy: () => { app.removeEventListener('click', onClick); off(); } };
}

/* ---------- 7.8 Lista de la compra ---------- */

async function ShoppingView(app) {
  const recipes = await Store.list();
  const byId = new Map(recipes.map((r) => [r.id, r]));
  await Images.preload(recipes.map((r) => r.coverImageId));
  let showDone = false;
  let showPantry = false;

  async function build() {
    const [sel, manual, checks] = await Promise.all([Docs.get('shopRecipes'), Docs.get('shopManual'), Docs.get('shopChecks')]);
    const selections = Object.entries(Docs.live(sel)).map(([key, v]) => ({ key, ...v })).filter((x) => byId.has(x.recipeId));
    const items = Shopping.aggregate(selections, byId);
    for (const [id, m] of Object.entries(Docs.live(manual))) {
      items.push({ key: `m:${id}`, manualId: id, name: m.name, label: '', section: Shopping.sectionFor(m.name), from: [] });
    }
    const liveChecks = Docs.live(checks);
    const pantry = Docs.live(await Docs.get('pantry'));
    items.forEach((it) => { it.checked = !!liveChecks[it.key]?.checked; it.pantry = !it.manualId && !!pantry[norm(it.name)]; });
    items.sort((a, b) => Shopping.ORDER.indexOf(a.section) - Shopping.ORDER.indexOf(b.section) || a.name.localeCompare(b.name, 'es'));
    return { selections, items };
  }

  function itemHTML(it) {
    return `<li class="shop-item ${it.checked ? 'is-done' : ''}" data-item="${esc(it.key)}" role="checkbox" aria-checked="${it.checked}" tabindex="0">
      <span class="tick">${icon('check', 'ic-sm')}</span>
      <span class="shop-name">${esc(it.name)}${it.from.length > 1 ? `<span class="shop-from">${it.from.length} recetas</span>` : ''}</span>
      <span class="shop-qty">${esc(it.label)}</span>
      ${it.manualId ? `<button class="icon-btn" data-del="${it.manualId}" aria-label="Quitar ${esc(it.name)}">${icon('x', 'ic-sm')}</button>`
        : it.pantry ? `<button class="icon-btn" data-unpantry="${esc(norm(it.name))}" aria-label="Quitar ${esc(it.name)} de la despensa">${icon('x', 'ic-sm')}</button>`
        : `<button class="icon-btn pantry-btn" data-pantry="${esc(it.name)}" aria-label="${esc(it.name)}: lo tengo siempre en casa">${icon('house', 'ic-sm')}</button>`}
    </li>`;
  }

  async function paint() {
    const { selections, items } = await build();
    const inPantry = items.filter((i) => i.pantry);
    const pending = items.filter((i) => !i.checked && !i.pantry);
    const done = items.filter((i) => i.checked && !i.pantry);
    const sections = Shopping.ORDER.map((sec) => [sec, pending.filter((i) => i.section === sec)]).filter(([, l]) => l.length);
    const y = window.scrollY;
    const focused = document.activeElement?.id === 'add-item';

    app.innerHTML = `<div class="page has-tabbar"><div class="shop">
      <header class="home-head">
        <div class="topbar"><p class="home-date">${pending.length ? `${pending.length} ${pending.length === 1 ? 'cosa' : 'cosas'} por comprar` : items.length ? 'Todo en el carro' : ''}</p>
          <div style="display:flex;gap:4px">
            ${pending.length ? `<button class="icon-btn" data-act="share" aria-label="Enviar la lista">${icon('share-2')}</button>` : ''}
            ${items.length || selections.length ? `<button class="icon-btn" data-act="more" aria-label="Más opciones">${icon('ellipsis-vertical')}</button>` : ''}
          </div></div>
        <h1 class="home-title serif">Compra</h1>
      </header>

      <section class="block">
        <div class="block-head"><h2 class="block-title serif">Recetas</h2>
          <button class="btn add-row" data-act="add-recipe">${icon('plus', 'ic-sm')}Receta</button></div>
        ${selections.length ? `<ul class="shop-recipes">${selections.map((s) => {
          const r = byId.get(s.recipeId);
          const v = r.versions.find((x) => x.id === s.versionId);
          return `<li class="shop-recipe">${thumbHTML(r.coverImageId)}
            <span class="shop-recipe-body"><span class="serif">${esc(r.name)}</span><span class="pick-meta">${r.versions.length > 1 && v ? esc(v.name) + '   ' : ''}${s.servings} ${s.servings === 1 ? 'ración' : 'raciones'}</span></span>
            <div class="stepper"><button class="icon-btn" data-srv="${esc(s.key)}|-1" aria-label="Menos raciones">${icon('minus', 'ic-sm')}</button>
              <button class="icon-btn" data-srv="${esc(s.key)}|1" aria-label="Más raciones">${icon('plus', 'ic-sm')}</button></div>
            <button class="icon-btn" data-unsel="${esc(s.key)}" aria-label="Quitar ${esc(r.name)} de la lista">${icon('x', 'ic-sm')}</button></li>`;
        }).join('')}</ul>` : '<p class="hint">Añade recetas aquí, desde cada receta o desde el menú de la semana.</p>'}
      </section>

      <section class="block">
        <label class="add-item"><span class="sr-only">Añadir algo más</span>${icon('plus', 'ic-sm')}
          <input class="input" id="add-item" placeholder="Añadir algo más: papel de cocina, café…" autocomplete="off" enterkeyhint="done"></label>
      </section>

      ${sections.map(([sec, list]) => `<section class="block shop-section"><h2 class="shop-sec">${esc(sec)}</h2><ul class="shop-list">${list.map(itemHTML).join('')}</ul></section>`).join('')}
      ${!items.length ? `<div class="empty"><div class="placeholder">${PLATE_SVG}</div><h2 class="serif">Lista vacía</h2><p>Los ingredientes de las recetas que añadas aparecerán aquí sumados y ordenados por pasillos.</p></div>` : ''}

      ${inPantry.length ? `<section class="block shop-section">
        <button class="shop-done-toggle" data-act="toggle-pantry" aria-expanded="${showPantry}">${icon(showPantry ? 'chevron-left' : 'chevron-right', 'ic-sm')}${icon('house', 'ic-sm')}En tu despensa (${inPantry.length})</button>
        ${showPantry ? `<p class="hint" style="margin:0 0 6px">Lo tienes siempre en casa, así que no se pide. Toca la ✕ para volver a pedirlo.</p><ul class="shop-list">${inPantry.map(itemHTML).join('')}</ul>` : ''}</section>` : ''}
      ${done.length ? `<section class="block shop-section">
        <button class="shop-done-toggle" data-act="toggle-done" aria-expanded="${showDone}">${icon(showDone ? 'chevron-left' : 'chevron-right', 'ic-sm')}Ya en el carro (${done.length})</button>
        ${showDone ? `<ul class="shop-list">${done.map(itemHTML).join('')}</ul>` : ''}</section>` : ''}
    </div></div>
    ${tabbarHTML('shop')}`;
    window.scrollTo(0, y);
    if (focused) $('#add-item', app)?.focus();
  }

  async function shareList() {
    const { items } = await build();
    const pending = items.filter((i) => !i.checked);
    let text = 'Lista de la compra\n';
    for (const sec of Shopping.ORDER) {
      const l = pending.filter((i) => !i.pantry).filter((i) => i.section === sec);
      if (!l.length) continue;
      text += `\n${sec}\n` + l.map((i) => `• ${i.name}${i.label ? ` (${i.label})` : ''}`).join('\n') + '\n';
    }
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
    } catch (err) { if (err?.name === 'AbortError') return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  const onClick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { await Docs.remove('shopManual', del.dataset.del); return; }
    const pan = e.target.closest('[data-pantry]');
    if (pan) {
      const name = pan.dataset.pantry;
      await Docs.put('pantry', norm(name), { name });
      toast(`${name}: en tu despensa, ya no se pedirá`, { label: 'Deshacer', run: () => Docs.remove('pantry', norm(name)) });
      return;
    }
    const unp = e.target.closest('[data-unpantry]');
    if (unp) { await Docs.remove('pantry', unp.dataset.unpantry); return; }
    const item = e.target.closest('[data-item]');
    if (item) {
      const on = item.getAttribute('aria-checked') !== 'true';
      item.classList.toggle('is-done', on); item.setAttribute('aria-checked', String(on));
      navigator.vibrate?.(8);
      await Docs.put('shopChecks', item.dataset.item, { checked: on }, { quiet: true });
      setTimeout(paint, 260); // un instante para ver el tic antes de que baje al carro
      return;
    }
    const srv = e.target.closest('[data-srv]');
    if (srv) {
      const [rid, vid, d] = srv.dataset.srv.split('|');
      const cur = Docs.live(await Docs.get('shopRecipes'))[`${rid}|${vid}`];
      if (cur) await Docs.put('shopRecipes', `${rid}|${vid}`, { ...cur, servings: Math.max(1, Math.min(99, cur.servings + +d)) });
      return;
    }
    const un = e.target.closest('[data-unsel]');
    if (un) { await Docs.remove('shopRecipes', un.dataset.unsel); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    switch (a.dataset.act) {
      case 'add-recipe': {
        const r = await pickRecipe('Añadir a la compra');
        if (r) await addToShopping(r.id, r.versions[0].id, r.versions[0].servings || 2, { silent: true });
        break;
      }
      case 'toggle-done': showDone = !showDone; paint(); break;
      case 'toggle-pantry': showPantry = !showPantry; paint(); break;
      case 'share': shareList(); break;
      case 'more': {
        const c = await menuSheet('Opciones de la lista', [
          { icon: 'rotate-ccw', label: 'Desmarcar todo', value: 'uncheck' },
          { icon: 'trash-2', label: 'Vaciar la lista', value: 'clear', danger: true },
        ]);
        if (c === 'uncheck') await Docs.removeMany('shopChecks', Object.keys(Docs.live(await Docs.get('shopChecks'))));
        if (c === 'clear' && await confirmSheet({ title: '¿Vaciar la lista?', text: 'Se quitan todas las recetas y cosas añadidas.', ok: 'Vaciar', danger: true })) {
          await Docs.removeMany('shopRecipes', Object.keys(Docs.live(await Docs.get('shopRecipes'))));
          await Docs.removeMany('shopManual', Object.keys(Docs.live(await Docs.get('shopManual'))));
          await Docs.removeMany('shopChecks', Object.keys(Docs.live(await Docs.get('shopChecks'))));
        }
        break;
      }
    }
  };
  const onKey = async (e) => {
    if (e.key === 'Enter' && e.target.id === 'add-item') {
      const name = e.target.value.trim();
      if (!name) return;
      e.target.value = '';
      await Docs.put('shopManual', uid(), { name });
    } else if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-item]')) { e.preventDefault(); e.target.click(); }
  };

  await paint();
  app.addEventListener('click', onClick);
  app.addEventListener('keydown', onKey);
  const off = Docs.on((name) => { if (name !== 'plan') paint(); });
  return { destroy: () => { app.removeEventListener('click', onClick); app.removeEventListener('keydown', onKey); off(); } };
}

/* ---------- 7.5 Ajustes y copias ---------- */

function syncStatusText(lastSync) {
  const st = Sync.state;
  if (st === 'syncing') return 'Sincronizando…';
  if (st === 'needs-tap') return 'Hay cambios pendientes o el permiso de Google ha caducado. Pulsa “Sincronizar ahora”.';
  if (st === 'offline') return 'Sin conexión. Se sincronizará cuando vuelva internet.';
  if (st === 'error') return Sync.lastError;
  if (!lastSync) return 'Aún no se ha sincronizado.';
  const min = Math.round((Date.now() - lastSync) / 60000);
  return `Última sincronización: ${min < 1 ? 'hace un momento' : min < 60 ? `hace ${min} min` : formatDate(lastSync)}.`;
}

async function SettingsView(app) {
  const [recipes, lastExport, est, persisted, driveOn, lastSync] = await Promise.all([
    Store.list(), Meta.get('lastExport'),
    navigator.storage?.estimate?.().catch(() => null), navigator.storage?.persisted?.().catch(() => null),
    Meta.get('driveConnected'), Meta.get('lastSync'),
  ]);
  const cats = await Categories.list(recipes);
  const trash = await Store.trash();
  const used = est?.usage || 0, quota = est?.quota || 0;
  const pct = quota ? Math.max(1, Math.round((used / quota) * 100)) : 0;
  let canShare = false;
  try { canShare = !!navigator.canShare?.({ files: [new File(['x'], 'prueba.zip', { type: 'application/zip' })] }); } catch { /* */ }

  app.innerHTML = `<div class="page has-tabbar"><div class="settings">
    <h1 class="serif" style="margin-top:24px">Ajustes</h1>

    <section class="panel">
      <h2 class="serif">Sincronización con Google Drive</h2>
      ${driveOn ? `
        <p>Conectado. Las recetas y fotos se sincronizan solas entre tus dispositivos a través de una carpeta privada de tu Drive que solo ve esta app.</p>
        <p class="hint" id="sync-status">${syncStatusText(lastSync)}</p>
        <div class="actions">
          <button class="btn btn-primary" data-act="sync-now">${icon('refresh-cw', 'ic-sm')}Sincronizar ahora</button>
          <button class="btn btn-ghost" data-act="disconnect">Desconectar</button>
        </div>` : `
        <p>Conecta tu cuenta de Google para que las recetas pasen solas entre el móvil y la tablet. Se guardan en una carpeta privada de tu Drive que solo ve esta app; tus otros archivos no se tocan.</p>
        <p class="hint">Usa la misma cuenta de Google en todos tus dispositivos.</p>
        <div class="actions"><button class="btn btn-primary" data-act="connect">${icon('cloud', 'ic-sm')}Conectar con Google Drive</button></div>`}
    </section>

    <section class="panel">
      <h2 class="serif">Categorías</h2>
      <p>Crea las tuyas, cámbiales el nombre o bórralas. Al renombrar, las recetas se actualizan solas.</p>
      <ul class="cat-list">${cats.map((c) => {
        const n = recipes.filter((r) => norm(r.category) === norm(c)).length;
        return `<li><span>${esc(c)}<span class="hint"> ${n ? `${n} ${n === 1 ? 'receta' : 'recetas'}` : ''}</span></span>
          <button class="icon-btn" data-cat-edit="${esc(c)}" aria-label="Renombrar ${esc(c)}">${icon('pencil', 'ic-sm')}</button>
          <button class="icon-btn" data-cat-del="${esc(c)}" aria-label="Borrar ${esc(c)}">${icon('trash-2', 'ic-sm')}</button></li>`;
      }).join('')}</ul>
      <div class="actions"><button class="btn add-row" data-act="cat-add">${icon('plus', 'ic-sm')}Nueva categoría</button></div>
    </section>

    <section class="panel">
      <h2 class="serif">Libro de recetas en PDF</h2>
      <p>Crea un libro con portada, índice por categorías y una página por receta, con el mismo estilo de la app. Listo para imprimir o regalar.</p>
      <div class="actions"><button class="btn btn-primary" data-act="book">${icon('book', 'ic-sm')}Crear libro</button></div>
    </section>

    <section class="panel">
      <h2 class="serif">Papelera</h2>
      ${trash.length ? `<p>Las recetas borradas se guardan aquí 30 días.</p>
        <ul class="cat-list">${trash.map((t) => {
          const left = Math.max(1, 30 - Math.floor((Date.now() - t.deletedAt) / 864e5));
          return `<li><span>${esc(t.recipe.name || 'Sin nombre')}<span class="hint"> se borra en ${left} ${left === 1 ? 'día' : 'días'}</span></span>
            <button class="icon-btn" data-restore="${t.id}" aria-label="Recuperar ${esc(t.recipe.name)}">${icon('archive-restore', 'ic-sm')}</button>
            <button class="icon-btn" data-purge="${t.id}" aria-label="Borrar para siempre ${esc(t.recipe.name)}">${icon('trash-2', 'ic-sm')}</button></li>`;
        }).join('')}</ul>` : '<p>Vacía. Las recetas que borres se guardarán aquí 30 días.</p>'}
    </section>

    <section class="panel">
      <h2 class="serif">Copia en archivo</h2>
      <p>Guarda todo el recetario (${recipes.length} ${recipes.length === 1 ? 'receta' : 'recetas'}, con sus fotos) en un único archivo. Pásalo al otro dispositivo por Quick Share o WhatsApp y ábrelo allí con “Importar copia”.</p>
      <p class="hint">${lastExport ? `Última copia: ${formatDate(lastExport)}` : 'Aún no has hecho ninguna copia.'}</p>
      <div class="actions">
        ${canShare ? `<button class="btn ${driveOn ? '' : 'btn-primary'}" data-act="share">${icon('share-2', 'ic-sm')}Compartir copia</button>` : ''}
        <button class="btn ${canShare || driveOn ? '' : 'btn-primary'}" data-act="download">${icon('download', 'ic-sm')}Guardar archivo</button>
      </div>
    </section>

    <section class="panel">
      <h2 class="serif">Importar copia</h2>
      <p>Se combinan las recetas: añade las nuevas y, si una receta existe en los dos sitios, se queda la versión editada más recientemente. Las recetas que borraste también se borran aquí.</p>
      <div class="actions">
        <label class="btn">${icon('upload', 'ic-sm')}Importar copia<input type="file" hidden data-act="import"></label>
      </div>
    </section>

    <section class="panel">
      <h2 class="serif">Espacio</h2>
      ${quota ? `<div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div><p>Usas ${formatBytes(used)} de ${formatBytes(quota)} disponibles.</p>` : '<p>No se puede consultar el espacio en este navegador.</p>'}
      <p class="hint">${persisted ? 'Almacenamiento protegido: Chrome no borrará tus recetas para liberar espacio.' : 'Almacenamiento sin proteger todavía. Instala la app en la pantalla de inicio para que Chrome lo proteja.'}</p>
    </section>

    <section class="panel">
      <h2 class="serif">Acerca de</h2>
      <p>Recetario del chef JJ ${APP_VERSION}. Funciona sin conexión. ${driveOn ? 'Tus recetas se guardan en este dispositivo y se sincronizan con tu Google Drive.' : 'Todo se guarda solo en este dispositivo.'}</p>
      <p class="hint">Datos nutricionales orientativos: USDA FoodData Central (SR Legacy), a través del conjunto de datos de TempoLife (tempolife.app), CC-BY-4.0.</p>
    </section>
  </div></div>
  ${tabbarHTML('settings')}`;

  const onClick = async (e) => {
    const rs = e.target.closest('[data-restore]');
    if (rs) { const r = await Store.restore(rs.dataset.restore); if (r) { toast('Receta recuperada', { label: 'Ver', run: () => Router.go(`#/receta/${r.id}`) }); Router.render(); } return; }
    const pg = e.target.closest('[data-purge]');
    if (pg) {
      if (await confirmSheet({ title: '¿Borrar para siempre?', text: 'No se podrá recuperar.', ok: 'Borrar', danger: true })) { await Store.purge(pg.dataset.purge); Router.render(); }
      return;
    }
    if (e.target.closest('[data-act="book"]')) { bookFlow(e.target.closest('[data-act="book"]')); return; }
    const ce = e.target.closest('[data-cat-edit]');
    if (ce) {
      const old = ce.dataset.catEdit;
      const name = await promptSheet({ title: 'Renombrar categoría', label: 'Nuevo nombre', value: old, ok: 'Guardar' });
      if (name && name.trim() !== old) { await Categories.rename(old, name); toast('Categoría renombrada'); Router.render(); }
      return;
    }
    const cd = e.target.closest('[data-cat-del]');
    if (cd) {
      const name = cd.dataset.catDel;
      const n = recipes.filter((r) => norm(r.category) === norm(name)).length;
      const ok = await confirmSheet({ title: `¿Borrar “${name}”?`, text: n ? `${n === 1 ? 'La receta que la usa se queda' : `Las ${n} recetas que la usan se quedan`} sin categoría. No se borra ninguna receta.` : 'No la usa ninguna receta.', ok: 'Borrar', danger: true });
      if (ok) { await Categories.remove(name); toast('Categoría borrada'); Router.render(); }
      return;
    }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'back') { Router.back('#/'); return; }
    if (a.dataset.act === 'cat-add') {
      const name = await promptSheet({ title: 'Nueva categoría', label: 'Nombre', placeholder: 'Desayunos, Cenas ligeras, Sin gluten…', ok: 'Crear' });
      if (name) { await Categories.add(name); Router.render(); }
      return;
    }
    if (a.dataset.act === 'connect' || a.dataset.act === 'sync-now') {
      a.disabled = true;
      try {
        await Sync.sync({ interactive: true });
        if (a.dataset.act === 'connect') toast('Google Drive conectado');
        Router.render();
      } catch { a.disabled = false; }
      return;
    }
    if (a.dataset.act === 'disconnect') {
      const ok = await confirmSheet({ title: '¿Desconectar Google Drive?', text: 'Las recetas se quedan en este dispositivo y en tu Drive, pero dejarán de sincronizarse.', ok: 'Desconectar', danger: true });
      if (ok) { await Sync.disconnect(); toast('Google Drive desconectado'); Router.render(); }
      return;
    }
    if (a.dataset.act === 'share' || a.dataset.act === 'download') {
      if (!recipes.length) { toast('Aún no hay recetas que copiar'); return; }
      a.disabled = true;
      try { await Backup.export(a.dataset.act === 'share'); Router.render(); }
      catch (err) { if (err?.name !== 'AbortError') toast('No se pudo crear la copia. Vuelve a intentarlo.'); }
      finally { a.disabled = false; }
    }
  };
  const onChange = async (e) => {
    if (e.target.dataset.act !== 'import') return;
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const r = await Backup.import(file);
      await Sheets.open((el, close) => {
        el.innerHTML = `<h2 class="serif">Copia importada</h2>
          <p>${r.added} nuevas, ${r.updated} actualizadas, ${r.removed} eliminadas y ${r.same} sin cambios.</p>
          ${r.missingPhotos ? `<p>${r.missingPhotos === 1 ? 'Faltaba 1 foto' : `Faltaban ${r.missingPhotos} fotos`} en el archivo. Para que lleguen, envía el archivo .zip tal cual, sin abrirlo ni descomprimirlo en el móvil.</p>` : ''}
          <div class="actions"><button class="btn btn-primary" data-close>Ver recetario</button></div>`;
        el.addEventListener('click', (ev) => { if (ev.target.closest('[data-close]')) close(true); });
      }, { label: 'Copia importada' });
      Router.go('#/');
    } catch (err) {
      toast(err.userMessage || 'Ese archivo no es una copia del recetario.');
    }
  };
  app.addEventListener('click', onClick);
  app.addEventListener('change', onChange);
  const offSync = Sync.on(async () => { const el = $('#sync-status', app); if (el) el.textContent = syncStatusText(await Meta.get('lastSync')); });
  return { destroy: () => { app.removeEventListener('click', onClick); app.removeEventListener('change', onChange); offSync(); } };
}

/* =========================================================================
   8. Editor de foto: recorte, compresión y “Limpiar fondo”
   ========================================================================= */

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files[0] || null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Deja elegir una foto, ajustar el fondo y la guarda comprimida. Devuelve su id. */
async function pickAndEditPhoto({ square, maxSide }) {
  const file = await pickFile();
  if (!file) return null;
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { toast('No se pudo abrir esa imagen'); return null; }

  const threshold0 = await Meta.get('lastThreshold', 18);

  const result = await Sheets.open((el, close) => {
    el.innerHTML = `<h2 class="serif">Ajustar foto</h2>
      <p>Así se verá sobre el fondo de la app. Si notas el borde de la foto, sube “Limpiar fondo” hasta que desaparezca.</p>
      <div class="photo-editor">
        <div class="photo-stage masked"><canvas></canvas></div>
        <div class="range-row">
          <span class="label"><span>Limpiar fondo</span><output>${threshold0}</output></span>
          <input type="range" min="0" max="60" step="1" value="${threshold0}" aria-label="Intensidad de limpieza del fondo">
          <p class="hint">Súbelo con cuidado en platos oscuros: podría oscurecer también sus sombras.</p>
        </div>
        <label class="switch"><input type="checkbox" checked>Ver con bordes fundidos (como en la app)</label>
      </div>
      <div class="actions"><button class="btn btn-ghost" data-v="0">Cancelar</button><button class="btn btn-primary" data-v="1">${icon('check', 'ic-sm')}Usar foto</button></div>`;

    const canvas = $('canvas', el);
    const range = $('input[type=range]', el);
    const out = $('output', el);
    const stage = $('.photo-stage', el);

    // Vista previa a baja resolución para que el deslizador vaya fluido
    const preview = Images.render(bitmap, { square, maxSide: 520, threshold: 0 });
    const base = preview.getContext('2d').getImageData(0, 0, preview.width, preview.height);
    canvas.width = preview.width; canvas.height = preview.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let raf = 0;
    const draw = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        ctx.putImageData(base, 0, 0);
        const t = +range.value;
        Images.cleanBackground(ctx, canvas.width, canvas.height, t); // misma limpieza que al guardar
        out.textContent = t;
      });
    };
    draw();
    range.addEventListener('input', draw);
    $('input[type=checkbox]', el).addEventListener('change', (e) => stage.classList.toggle('masked', e.target.checked));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) close(b.dataset.v === '1' ? { threshold: +range.value } : null);
    });
  }, { label: 'Ajustar foto' });

  if (!result) { bitmap.close?.(); return null; }
  try {
    const canvas = Images.render(bitmap, { square, maxSide, threshold: result.threshold });
    const blob = await Images.toBlob(canvas);
    const id = await Images.save(blob);
    await Images.url(id);
    Meta.set('lastThreshold', result.threshold);
    return id;
  } catch {
    toast('No se pudo guardar la foto');
    return null;
  } finally {
    bitmap.close?.();
  }
}

/* =========================================================================
   8b. Modo manos libres: lee los pasos en voz alta y obedece a la voz
   ========================================================================= */

const Voice = (() => {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, active = false, speaking = false, handlers = null, onState = null;

  const supported = { speak: 'speechSynthesis' in window, listen: !!Rec };

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.lang === 'es-ES') || voices.find((v) => v.lang?.startsWith('es')) || null;
  }

  function speak(text) {
    if (!supported.speak || !active) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    const v = pickVoice(); if (v) u.voice = v;
    u.rate = 0.98;
    speaking = true;
    stopListening(); // que no se escuche a sí misma
    u.onend = u.onerror = () => { speaking = false; startListening(); };
    speechSynthesis.speak(u);
  }

  const COMMANDS = [
    [/\b(siguiente|sigue|adelante|vale|hecho|listo)\b/, 'next'],
    [/\b(anterior|atras|vuelve)\b/, 'prev'],
    [/\b(repite|otra vez|repetir)\b/, 'repeat'],
    [/\b(temporizador|empieza|inicia|arranca|cronometro)\b/, 'timer'],
    [/\b(para|pausa|detente|stop)\b/, 'pause'],
    [/\b(ingredientes)\b/, 'ingredients'],
  ];

  function startListening() {
    if (!active || !Rec || speaking || rec) return;
    rec = new Rec();
    rec.lang = 'es-ES';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = norm(e.results[e.results.length - 1][0].transcript);
      const hit = COMMANDS.find(([re]) => re.test(said));
      if (hit) handlers?.[hit[1]]?.();
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Sin permiso para el micrófono: solo leeré los pasos en voz alta.');
        supported.listen = false;
        onState?.('denied');
      }
    };
    rec.onend = () => { rec = null; if (active && !speaking && supported.listen) setTimeout(startListening, 250); };
    try { rec.start(); onState?.('listening'); } catch { rec = null; }
  }

  function stopListening() { const r = rec; rec = null; try { r?.abort(); } catch { /* */ } }

  return {
    supported,
    get active() { return active; },
    start(h, stateCb) { active = true; handlers = h; onState = stateCb; startListening(); },
    stop() { active = false; handlers = null; stopListening(); if (supported.speak) speechSynthesis.cancel(); onState?.('off'); },
    speak,
  };
})();

/* =========================================================================
   8c. Tarjeta para compartir (imagen cuadrada 1080 × 1080)
   ========================================================================= */

const Card = (() => {
  const S = 1080;
  const C = { bg: '#000000', text: '#EDE8E0', text2: '#A8A097', accent: '#E8A33D', line: '#2A2622' };

  function wrap(ctx, text, maxW) {
    const words = text.split(/\s+/); const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Dibuja la foto con los bordes fundidos a negro, igual que en la app. */
  function drawFloating(ctx, img, x, y, size) {
    const off = document.createElement('canvas'); off.width = off.height = size;
    const o = off.getContext('2d');
    const side = Math.min(img.width, img.height);
    o.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
    o.globalCompositeOperation = 'destination-in';
    const f = 0.11;
    let g = o.createLinearGradient(0, 0, size, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(f, '#000'); g.addColorStop(1 - f, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g; o.fillRect(0, 0, size, size);
    g = o.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(f, '#000'); g.addColorStop(1 - f, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g; o.fillRect(0, 0, size, size);
    ctx.drawImage(off, x, y);
  }

  function drawPlate(ctx, cx, cy, r) {
    ctx.strokeStyle = C.line; ctx.lineWidth = 3;
    [1, 0.7].forEach((k) => { ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, Math.PI * 2); ctx.stroke(); });
  }

  async function render(recipe, version, servings) {
    await Promise.all([document.fonts.load('400 80px Fraunces'), document.fonts.load('400 30px Fraunces')]).catch(() => {});
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, S, S);

    // Foto flotando a la izquierda
    const photo = 600, px = -30, py = (S - photo) / 2 - 20;
    const src = Images.cached(recipe.coverImageId);
    if (src) {
      const img = new Image(); img.src = src;
      await img.decode().catch(() => {});
      if (img.width) drawFloating(ctx, img, px, py, photo);
    } else drawPlate(ctx, px + photo / 2, py + photo / 2, photo * 0.36);

    // Texto a la derecha
    const x = 580, maxW = S - x - 70;
    let y = 150;
    ctx.fillStyle = C.accent; ctx.font = '500 26px system-ui, Roboto, sans-serif';
    ctx.fillText(recipe.category || 'Receta', x, y);
    y += 30;
    ctx.fillStyle = C.text; ctx.font = '400 62px Fraunces, Georgia, serif';
    const title = wrap(ctx, recipe.name, maxW).slice(0, 3);
    title.forEach((l) => { y += 70; ctx.fillText(l, x, y); });

    y += 58;
    ctx.fillStyle = C.text2; ctx.font = '400 26px system-ui, Roboto, sans-serif';
    const meta = [formatMinutes(version.minutes), `${servings} ${servings === 1 ? 'ración' : 'raciones'}`, recipe.versions.length > 1 ? version.name : ''].filter(Boolean).join('     ');
    ctx.fillText(meta, x, y);

    y += 38; ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(S - 70, y); ctx.stroke();

    // Ingredientes
    const factor = servings / (version.servings || 1);
    const ings = version.ingredients.filter((i) => i.name.trim());
    const room = Math.floor((S - 110 - (y + 20)) / 44);
    const shown = ings.length > room ? ings.slice(0, room - 1) : ings;
    y += 20;
    ctx.font = '400 27px system-ui, Roboto, sans-serif';
    const qtys = shown.map((i) => qtyLabel(i.qty == null ? null : (NO_SCALE_UNITS.has(i.unit) ? i.qty : i.qty * factor), i.unit));
    // Todas las cantidades en una columna y los nombres alineados a su derecha
    const nameX = x + Math.min(220, Math.max(110, ...qtys.map((q) => ctx.measureText(q).width)) + 22);
    for (const [n, i] of shown.entries()) {
      y += 44;
      ctx.fillStyle = C.accent; ctx.fillText(qtys[n], x, y);
      ctx.fillStyle = C.text;
      const name = wrap(ctx, i.name, S - 70 - nameX)[0];
      ctx.fillText(name, nameX, y);
    }
    if (shown.length < ings.length) { y += 44; ctx.fillStyle = C.text2; ctx.fillText(`y ${ings.length - shown.length} ingredientes más`, x, y); }

    // Firma
    ctx.fillStyle = '#5E5850'; ctx.font = '400 24px Fraunces, Georgia, serif';
    ctx.fillText('Recetario', x, S - 70);

    return new Promise((res) => canvas.toBlob(res, 'image/png'));
  }

  async function share(recipe, version, servings) {
    const blob = await render(recipe, version, servings);
    const name = `${norm(recipe.name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'receta'}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    return { blob, file };
  }

  return { render, share, drawFloating, wrap };
})();

/** Muestra la tarjeta y deja compartirla o guardarla. */
async function shareCardFlow(recipe, version, servings) {
  const { blob, file } = await Card.share(recipe, version, servings);
  const url = URL.createObjectURL(blob);
  await Sheets.open((el, close) => {
    const canShare = navigator.canShare?.({ files: [file] });
    el.innerHTML = `<h2 class="serif">Tarjeta de la receta</h2>
      <img class="card-preview" src="${url}" alt="Tarjeta de ${esc(recipe.name)}">
      <div class="actions">
        <button class="btn btn-ghost" data-c="save">${icon('download', 'ic-sm')}Guardar imagen</button>
        ${canShare ? `<button class="btn btn-primary" data-c="share">${icon('share-2', 'ic-sm')}Compartir</button>` : ''}
      </div>`;
    el.addEventListener('click', async (e) => {
      const c = e.target.closest('[data-c]');
      if (!c) return;
      if (c.dataset.c === 'share') {
        try { await navigator.share({ files: [file], title: recipe.name }); close(); }
        catch (err) { if (err?.name !== 'AbortError') toast('No se pudo compartir. Prueba con “Guardar imagen”.'); }
      } else {
        const a = document.createElement('a'); a.href = url; a.download = file.name;
        document.body.append(a); a.click(); a.remove();
        toast('Imagen guardada en Descargas');
      }
    });
  }, { label: 'Tarjeta de la receta' });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* =========================================================================
   8d. Libro de recetas en PDF
   Cada página se dibuja en un lienzo (mismo estilo negro que la app) y se
   guarda como imagen JPEG dentro de un PDF A4. Sin librerías externas.
   ========================================================================= */

const Book = (() => {
  const W = 1240, H = 1754, M = 96;          // A4 a 150 ppp
  const C = { bg: '#000', text: '#EDE8E0', text2: '#A8A097', text3: '#857E74', accent: '#E8A33D', line: '#2A2622', dim: '#5b4420' };
  const SERIF = 'Fraunces, Georgia, serif', SANS = 'system-ui, Roboto, sans-serif';

  const newPage = () => {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'); x.fillStyle = C.bg; x.fillRect(0, 0, W, H); x.textBaseline = 'alphabetic';
    return { c, x };
  };
  const loadImg = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

  function footer(x, n) {
    x.fillStyle = C.text3; x.font = `400 20px ${SANS}`; x.textAlign = 'center';
    x.fillText(`Recetario del chef JJ   ${n}`, W / 2, H - 50); x.textAlign = 'left';
  }

  async function cover(chef) {
    const { c, x } = newPage();
    if (chef) {
      const w = 900, h = w * chef.height / chef.width, top = 330;
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      const o = off.getContext('2d'); o.drawImage(chef, 0, 0, w, h);
      o.globalCompositeOperation = 'destination-in';
      const g = o.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#000'); g.addColorStop(.55, '#000'); g.addColorStop(.95, 'rgba(0,0,0,0)');
      o.fillStyle = g; o.fillRect(0, 0, w, h);
      x.drawImage(off, (W - w) / 2, top);
    }
    x.fillStyle = C.text; x.font = `400 150px ${SERIF}`; x.fillText('Recetario', M, 230);
    x.fillStyle = C.accent; x.font = `italic 400 64px ${SERIF}`; x.fillText('del chef JJ', M + 8, 310);
    x.fillStyle = C.accent; x.fillRect(W / 2 - 30, H - 330, 60, 3);
    x.fillStyle = C.text; x.font = `italic 400 76px ${SERIF}`; x.textAlign = 'center';
    x.fillText('Cocinando fit con JJ', W / 2, H - 230);
    x.fillStyle = C.text3; x.font = `400 26px ${SANS}`; x.fillText(String(new Date().getFullYear()), W / 2, H - 150);
    x.textAlign = 'left';
    return c;
  }

  /* --- Maquetación de una receta ---------------------------------------
     Estructura fija en todas las recetas, pase lo que pase con el espacio:
       1. Cabecera (solo en su primera página): foto, categoría, título, datos
       2. Ingredientes a dos columnas (se leen de arriba abajo, columna a columna)
       3. Preparación   4. Elaboración   5. Notas
     Todo a una sola columna de texto: si no cabe, sigue en la página siguiente
     con el mismo ancho y un rótulo "continuación". Nada se corta ni se pierde.
     dry = true: solo mide (para saber en qué página empieza cada receta). */

  const BODY = 24, LINE = 34;

  /** Parte un texto en líneas respetando los saltos de línea que escribiste. */
  function paragraphs(x, text, maxW) {
    return String(text || '').split(/\n+/).map((p) => p.trim()).filter(Boolean).flatMap((p) => breakLong(x, Card.wrap(x, p, maxW), maxW));
  }
  /** Palabras más largas que la línea (p. ej. una dirección web) se parten a trozos. */
  function breakLong(x, lines, maxW) {
    const out = [];
    for (const l of lines) {
      if (x.measureText(l).width <= maxW) { out.push(l); continue; }
      let cur = '';
      for (const ch of l) { if (x.measureText(cur + ch).width > maxW) { out.push(cur); cur = ch; } else cur += ch; }
      if (cur) out.push(cur);
    }
    return out;
  }

  /** Recorta un texto con "…" si no cabe en una línea. */
  function ellipsize(x, text, maxW) {
    if (x.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && x.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }

  let measureCtx = null;
  function measurer() {
    if (!measureCtx) { const c = document.createElement('canvas'); c.width = c.height = 8; measureCtx = c.getContext('2d'); }
    return measureCtx;
  }

  async function recipePages(r, byId, firstNumber, { dry = false, pageOf = null, onPage = null } = {}) {
    const v = r.versions[0];
    const TW = W - 2 * M, maxY = H - 130;
    let x = null, y = 0, count = 0, current = null;

    const finish = async () => {
      if (!current) return;
      footer(x, firstNumber + count - 1);
      if (!dry) await onPage(current);
      current = null;
    };
    const start = async (cont) => {
      await finish();
      count++;
      if (dry) { x = measurer(); } else { const p = newPage(); current = p.c; x = p.x; }
      y = M;
      if (cont) {
        x.textAlign = 'left'; x.fillStyle = C.text3; x.font = `italic 400 26px ${SERIF}`;
        x.fillText(ellipsize(x, `${r.name}, continuación`, TW), M, y + 6);
        x.fillStyle = C.line; x.fillRect(M, y + 26, TW, 2);
        y += 76;
      }
    };
    const ensure = async (h) => { if (y + h > maxY) { await start(true); return true; } return false; };

    await start(false);

    // 1. Cabecera
    const src = Images.cached(r.coverImageId);
    if (src) {
      if (!dry) { const img = await loadImg(src); if (img) Card.drawFloating(x, img, (W - 440) / 2, y - 24, 440); }
      y += 420;
    }
    x.textAlign = 'center';
    if (r.category) { y += 30; x.fillStyle = C.accent; x.font = `400 26px ${SANS}`; x.fillText(r.category, W / 2, y); y += 8; }
    let titleSize = 66;
    x.font = `400 ${titleSize}px ${SERIF}`;
    let title = Card.wrap(x, r.name, TW);
    if (title.length > 2) { titleSize = 52; x.font = `400 ${titleSize}px ${SERIF}`; title = Card.wrap(x, r.name, TW); }
    x.fillStyle = C.text;
    for (const l of title) { y += titleSize * 1.12; x.fillText(l, W / 2, y); }
    const n = Nutrition.perServing(r, v, byId);
    const steps = v.prep.length + v.cook.length;
    const meta = [v.minutes ? formatMinutes(v.minutes) : '', `${v.servings || 1} ${(v.servings || 1) === 1 ? 'ración' : 'raciones'}`, steps ? `${steps} ${steps === 1 ? 'paso' : 'pasos'}` : ''].filter(Boolean).join('       ');
    y += 52; x.fillStyle = C.text2; x.font = `400 25px ${SANS}`; x.fillText(meta, W / 2, y);
    if (n.counted) {
      y += 38; x.fillStyle = C.accent; x.font = `400 23px ${SANS}`;
      x.fillText(`Por ración, aprox.: ${Math.round(n.kcal)} kcal     ${Math.round(n.p)} g proteína     ${Math.round(n.c)} g hidratos     ${Math.round(n.f)} g grasa`, W / 2, y);
    }
    if (r.versions.length > 1) {
      y += 34; x.fillStyle = C.text3; x.font = `italic 400 21px ${SANS}`;
      x.fillText(`Versión «${v.name}». Otras versiones en la app: ${r.versions.slice(1).map((o) => o.name).join(', ')}`, W / 2, y);
    }
    x.textAlign = 'left';
    y += 36; x.fillStyle = C.line; x.fillRect(M, y, TW, 2); y += 30;

    const heading = async (text, next) => {
      await ensure(70 + next); // el título nunca se queda solo al pie de una página
      y += 50; x.fillStyle = C.text; x.font = `400 34px ${SERIF}`; x.fillText(text, M, y); y += 14;
    };

    // 2. Ingredientes a dos columnas
    const ings = v.ingredients.filter((z) => z.name.trim());
    if (ings.length) {
      const GAP = 56, colW = (TW - GAP) / 2;
      x.font = `400 ${BODY}px ${SANS}`;
      const items = ings.map((i) => {
        const q = qtyLabel(i.qty, i.unit);
        const qW = q ? x.measureText(q).width : 0;
        const sub = i.recipeId && byId.get(i.recipeId);
        const lines = breakLong(x, Card.wrap(x, i.name, colW - qW - 28), colW - qW - 28);
        const note = sub ? (pageOf?.get(sub.id) ? `Receta en la pág. ${pageOf.get(sub.id)}` : 'Receta aparte') : '';
        return { q, qW, lines, note, h: lines.length * 30 + (note ? 26 : 0) + 14 };
      });
      await heading('Ingredientes', items[0].h + 10);
      let i = 0;
      while (i < items.length) {
        const top = y + 18;
        const room = maxY - top;
        // ¿Cuánto cabe en esta página? Si cabe todo, se reparte a partes iguales entre las dos columnas
        let fitH = 0, fitN = 0;
        for (let k = i; k < items.length; k++) { if (fitH + items[k].h > room * 2) break; fitH += items[k].h; fitN++; }
        if (!fitN) { await start(true); continue; }
        const slice = items.slice(i, i + fitN);
        const allHere = i + fitN === items.length;
        // Columna izquierda primero; si todo cabe en esta página, se reparte a la mitad para que quede equilibrado
        const cols = [[], []]; let acc = 0, inRight = false;
        for (const it of slice) {
          const fitsLeft = acc + it.h <= room;
          const wantLeft = allHere ? acc + it.h / 2 <= fitH / 2 : true;
          if (!inRight && (!cols[0].length || (fitsLeft && wantLeft))) { cols[0].push(it); acc += it.h; }
          else { inRight = true; cols[1].push(it); }
        }
        // Ninguna columna puede pasar del pie: lo que no quepa en la derecha pasa a la página siguiente
        let rightH = cols[1].reduce((a, b) => a + b.h, 0);
        while (rightH > room && cols[1].length) { rightH -= cols[1].pop().h; fitN--; }
        let bottom = top;
        cols.forEach((col, ci) => {
          let cy = top;
          const cx = M + ci * (colW + GAP);
          for (const it of col) {
            cy += 30;
            x.font = `400 ${BODY}px ${SANS}`; x.fillStyle = C.text;
            it.lines.forEach((l, k) => x.fillText(l, cx, cy + k * 30));
            const ly = cy + (it.lines.length - 1) * 30;
            const lastW = x.measureText(it.lines[it.lines.length - 1]).width;
            x.fillStyle = C.dim;
            for (let d = cx + lastW + 10; d < cx + colW - it.qW - 10; d += 9) x.fillRect(d, ly - 6, 2.5, 2.5);
            if (it.q) { x.fillStyle = C.accent; x.fillText(it.q, cx + colW - it.qW, ly); }
            cy = ly;
            if (it.note) { cy += 26; x.fillStyle = C.accent; x.font = `italic 400 20px ${SERIF}`; x.fillText(it.note, cx, cy); }
            cy += 14;
          }
          bottom = Math.max(bottom, cy);
        });
        i += fitN;
        y = bottom;
        if (i < items.length) await start(true);
      }
    }

    if (!ings.length && !v.prep.length && !v.cook.length) {
      y += 60; x.fillStyle = C.text3; x.font = `italic 400 26px ${SERIF}`; x.textAlign = 'center';
      x.fillText('Receta pendiente de completar.', W / 2, y); x.textAlign = 'left';
    }

    // 3 y 4. Preparación y elaboración
    const section = async (title, list) => {
      if (!list.length) return;
      x.font = `400 ${BODY}px ${SANS}`;
      const blocks = list.map((st, k) => {
        const lines = paragraphs(x, st.text, TW - 80);
        const timer = st.timerMin ? `Temporizador: ${formatMinutes(st.timerMin)}` : '';
        return { num: String(k + 1).padStart(2, '0'), lines: lines.length ? lines : [''], timer };
      });
      const firstH = 26 + Math.min(blocks[0].lines.length, 3) * LINE;
      await heading(title, firstH);
      for (const b of blocks) {
        const h = 26 + b.lines.length * LINE + (b.timer ? 30 : 0);
        // Un paso corto nunca se parte; uno muy largo sí, pero línea a línea, sin perder nada
        if (h < (maxY - M) * 0.5) await ensure(h);
        else await ensure(26 + LINE * 2);
        y += 26;
        let first = true;
        for (let k = 0; k < b.lines.length; k++) {
          if (!first && y + LINE > maxY) await start(true);
          y += first ? 8 : LINE;
          if (first) { x.fillStyle = C.accent; x.font = `italic 400 34px ${SERIF}`; x.fillText(b.num, M, y + 4); }
          x.fillStyle = C.text; x.font = `400 ${BODY}px ${SANS}`; x.fillText(b.lines[k], M + 80, y);
          first = false;
        }
        if (b.timer) { y += 30; x.fillStyle = C.accent; x.font = `400 20px ${SANS}`; x.fillText(b.timer, M + 80, y); }
        y += 6;
      }
    };
    await section('Preparación', v.prep);
    await section('Elaboración', v.cook);

    // 5. Notas
    if (v.notes && v.notes.trim()) {
      x.font = `italic 400 ${BODY}px ${SERIF}`;
      const lines = paragraphs(x, v.notes, TW);
      await heading('Notas', 20 + Math.min(lines.length, 2) * LINE);
      y += 14;
      for (const l of lines) {
        if (y + LINE > maxY) await start(true);
        y += LINE; x.fillStyle = C.text2; x.font = `italic 400 ${BODY}px ${SERIF}`; x.fillText(l, M, y);
      }
    }
    await finish();
    return count;
  }

  function indexPages(groups, count) {
    const pages = [];
    let { c, x } = newPage(); pages.push(c);
    x.fillStyle = C.text; x.font = `400 90px ${SERIF}`; x.fillText('Índice', M, M + 60);
    let y = M + 130;
    const line = (h) => { if (y + h > H - 120) { ({ c, x } = newPage()); pages.push(c); y = M + 20; } };
    for (const [cat, list] of groups) {
      line(100);
      y += 62; x.fillStyle = C.accent; x.font = `400 26px ${SANS}`; x.fillText(cat, M, y); y += 10;
      for (const it of list) {
        line(46); y += 46;
        x.fillStyle = C.text; x.font = `400 30px ${SERIF}`;
        const name = ellipsize(x, it.name, W - 2 * M - 140);
        x.fillText(name, M, y);
        const num = String(it.page ?? '');
        x.font = `400 26px ${SANS}`; const nw = x.measureText(num).width;
        x.fillStyle = C.dim; for (let d = M + x.measureText(name).width + 30; d < W - M - nw - 16; d += 10) x.fillRect(d, y - 7, 2.5, 2.5);
        x.fillStyle = C.accent; x.fillText(num, W - M - nw, y);
      }
    }
    return count ? pages.length : pages;
  }

  /* --- PDF mínimo: una imagen JPEG por página --- */
  async function toPdf(pages) {
    const enc = new TextEncoder();
    const parts = []; const offsets = []; let size = 0;
    const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); size += b.length; };
    const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    push('%PDF-1.4\n');
    const n = pages.length;
    const kids = Array.from({ length: n }, (_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R /PageLayout /SinglePage >>'));
    obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));
    pages.forEach((pg, i) => {
      const p = 3 + i * 3, content = p + 1, img = p + 2;
      const cs = `q 595.28 0 0 841.89 0 0 cm /Im${i} Do Q`;
      obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im${i} ${img} 0 R >> >> /Contents ${content} 0 R >>`));
      obj(content, () => { push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`); });
      obj(img, () => { push(`<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`); push(pg.bytes); push('\nendstream'); });
    });
    const xref = size, totalObj = 3 + n * 3;
    let t = `xref\n0 ${totalObj}\n0000000000 65535 f \n`;
    for (let k = 1; k < totalObj; k++) t += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
    push(t + `trailer\n<< /Size ${totalObj} /Root 1 0 R /Info << /Title (Recetario del chef JJ) >> >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  async function build(onProgress) {
    await Promise.all([document.fonts.load(`400 60px Fraunces`), document.fonts.load(`italic 400 60px Fraunces`)]).catch(() => {});
    const recipes = (await Store.list()).filter((r) => r.name.trim());
    const byId = new Map(recipes.map((r) => [r.id, r]));
    await Images.preload(recipes.map((r) => r.coverImageId));
    const OTHER = 'Otras recetas';
    const cats = [...new Set(recipes.map((r) => r.category || OTHER))].sort((a, b) => (a === OTHER) - (b === OTHER) || a.localeCompare(b, 'es'));
    const groups = cats.map((cat) => [cat, recipes.filter((r) => (r.category || OTHER) === cat).sort((a, b) => a.name.localeCompare(b.name, 'es')).map((r) => ({ r, name: r.name }))]);

    // Pasada 1: medir cuántas páginas ocupa cada receta, para numerar el índice y las referencias
    onProgress?.('Calculando páginas…');
    const idxCount = indexPages(groups, true);
    const pageOf = new Map();
    let pageNo = 1 + idxCount + 1;
    for (const [, list] of groups) for (const it of list) {
      it.page = pageNo; pageOf.set(it.r.id, pageNo);
      pageNo += await recipePages(it.r, byId, pageNo, { dry: true });
    }
    const total = pageNo - 1;

    // Pasada 2: dibujar. Cada página se convierte a JPEG en cuanto se termina y el lienzo se libera,
    // así el móvil no se queda sin memoria con libros largos.
    const pages = [];
    let done = 0;
    const toJpeg = async (canvas) => {
      const bytes = new Uint8Array(await (await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.86))).arrayBuffer());
      pages.push({ bytes, w: canvas.width, h: canvas.height });
      canvas.width = canvas.height = 0;
      onProgress?.(`Página ${pages.length} de ${total}`);
      await new Promise((r) => setTimeout(r, 0));
    };
    await toJpeg(await cover(await loadImg('chef.webp')));
    for (const p of indexPages(groups, false)) await toJpeg(p);
    for (const [, list] of groups) for (const it of list) {
      await recipePages(it.r, byId, it.page, { pageOf, onPage: toJpeg });
      done++;
    }
    return toPdf(pages);
  }

  return { build };
})();

async function bookFlow(btn) {
  if (!(await Store.list()).length) { toast('Aún no hay recetas para el libro'); return; }
  btn.disabled = true;
  const label = btn.innerHTML;
  try {
    const blob = await Book.build((msg) => { btn.textContent = msg; });
    const file = new File([blob], `Recetario del chef JJ ${new Date().toISOString().slice(0, 10)}.pdf`, { type: 'application/pdf' });
    let shared = false;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Recetario del chef JJ' }); shared = true; }
      catch (err) { if (err?.name === 'AbortError') shared = true; }
    }
    if (!shared) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast('Libro guardado en Descargas');
    }
  } catch (err) {
    console.error(err); toast('No se pudo crear el libro. Vuelve a intentarlo.');
  } finally { btn.disabled = false; btn.innerHTML = label; }
}

/* =========================================================================
   9. Copias: exportar e importar (.zip con datos + fotos)
   ========================================================================= */

/**
 * Combina recetas que llegan de fuera (copia o Google Drive) con las de este dispositivo.
 * Reglas: gana la versión editada más recientemente; una receta borrada después
 * de su última edición se borra en todas partes.
 * getImage(id) devuelve la foto que falta aquí (o null si no la tiene).
 */
async function mergeRemote(data, getImage) {
  const [localRecipes, localTombs, localImageIds] = await Promise.all([DB.all('recipes'), DB.all('tombstones'), DB.keys('images')]);
  const local = new Map(localRecipes.map((r) => [r.id, r]));
  const tombs = new Map(localTombs.map((t) => [t.id, t]));
  const haveImages = new Set(localImageIds);
  const result = { added: 0, updated: 0, removed: 0, same: 0, missingPhotos: 0 };
  const toPut = [], toDelete = [], newTombs = [];

  for (const t of data.tombstones || []) {
    const l = local.get(t.id);
    if (l && l.updatedAt <= t.deletedAt) { toDelete.push(t.id); local.delete(t.id); result.removed++; }
    const lt = tombs.get(t.id);
    if (!lt || lt.deletedAt < t.deletedAt) newTombs.push(t);
  }
  for (const r of data.recipes || []) {
    const tomb = tombs.get(r.id);
    if (tomb && tomb.deletedAt >= r.updatedAt) continue; // la borraste aquí después
    const l = local.get(r.id);
    if (!l) { toPut.push(r); result.added++; }
    else if (r.updatedAt > l.updatedAt) { toPut.push(r); result.updated++; }
    else result.same++;
  }

  // Las fotos se consiguen antes de escribir: una transacción de la base de datos no puede esperar a la red
  const images = [];
  for (const id of referencedImages(toPut)) {
    if (haveImages.has(id)) continue;
    const blob = await getImage(id);
    if (blob) images.push({ id, blob, createdAt: Date.now() });
    else result.missingPhotos++;
  }

  if (toPut.length || toDelete.length || newTombs.length || images.length) {
    await DB.tx(['recipes', 'images', 'tombstones'], 'readwrite', (t) => {
      images.forEach((i) => t.objectStore('images').put(i));
      toPut.forEach((r) => t.objectStore('recipes').put(r));
      toDelete.forEach((id) => t.objectStore('recipes').delete(id));
      newTombs.forEach((x) => t.objectStore('tombstones').put(x));
    });
    images.forEach((i) => Images.forget(i.id));
  }
  if (toPut.length || toDelete.length) await Meta.set('lastChange', Date.now());
  requestPersistence();
  result.changed = toPut.length + toDelete.length > 0;
  return result;
}

/** Ids de todas las fotos que usan unas recetas. */
function referencedImages(recipes) {
  const ids = new Set();
  for (const r of recipes) {
    if (r.coverImageId) ids.add(r.coverImageId);
    r.versions.forEach((v) => [...v.prep, ...v.cook].forEach((s) => s.imageId && ids.add(s.imageId)));
  }
  return ids;
}

const Backup = {
  FORMAT: 'recetario',

  async export(share) {
    const { zipSync, strToU8 } = window.fflate;
    const [recipes, tombstones] = await Promise.all([DB.all('recipes'), DB.all('tombstones')]);
    const imageIds = new Set();
    for (const r of recipes) {
      if (r.coverImageId) imageIds.add(r.coverImageId);
      r.versions.forEach((v) => [...v.prep, ...v.cook].forEach((s) => s.imageId && imageIds.add(s.imageId)));
    }
    const files = {};
    const imageTypes = {};
    for (const id of imageIds) {
      const rec = await DB.get('images', id);
      if (!rec) continue;
      files[`fotos/${id}`] = [new Uint8Array(await rec.blob.arrayBuffer()), { level: 0 }]; // ya van comprimidas
      imageTypes[id] = rec.blob.type;
    }
    const data = { format: Backup.FORMAT, formatVersion: 1, appVersion: APP_VERSION, exportedAt: Date.now(), recipes, tombstones, imageTypes, docs: await Docs.all() };
    files['recetario.json'] = strToU8(JSON.stringify(data));
    const zipped = zipSync(files);
    const stamp = new Date().toISOString().slice(0, 10);
    const file = new File([zipped], `recetario-${stamp}.zip`, { type: 'application/zip' });

    let sharedOk = false;
    if (share && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Copia del recetario' }); sharedOk = true; }
      catch (err) { if (err?.name === 'AbortError') throw err; share = false; } // si Android no deja compartir, se guarda
    }
    if (!sharedOk) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    await Meta.set('lastExport', Date.now());
    toast(sharedOk ? 'Copia lista para enviar' : `Copia guardada: ${file.name}`);
  },

  async import(file) {
    const { unzipSync, strFromU8 } = window.fflate;
    // Se admite la copia completa (.zip con fotos) y también el recetario.json suelto
    // (pasa si el móvil descomprime el .zip al abrirlo): en ese caso llegan las recetas sin fotos.
    let entries = {}, data;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // los .zip empiezan por "PK"
      if (isZip) {
        entries = unzipSync(bytes);
        data = JSON.parse(strFromU8(entries['recetario.json']));
      } else {
        data = JSON.parse(strFromU8(bytes));
      }
    } catch { throw Object.assign(new Error('bad'), { userMessage: 'Ese archivo no es una copia del recetario.' }); }
    if (data?.format !== Backup.FORMAT || !Array.isArray(data.recipes)) throw Object.assign(new Error('bad'), { userMessage: 'Ese archivo no es una copia del recetario.' });
    if (data.formatVersion > 1) throw Object.assign(new Error('new'), { userMessage: 'Esa copia es de una versión más nueva de la app. Actualiza la app en este dispositivo.' });

    const result = await mergeRemote(data, async (id) => {
      const bytes = entries[`fotos/${id}`];
      return bytes ? new Blob([bytes], { type: data.imageTypes?.[id] || 'image/webp' }) : null;
    });
    await Docs.merge(data.docs);
    Sync.schedule();
    return result;
  },
};

/* =========================================================================
   9b. Sincronización con Google Drive
   Las recetas se guardan en la carpeta privada y oculta de la app en tu Drive
   (appDataFolder): solo esta app puede verla y no toca el resto de tu Drive.
   Cada dispositivo sigue guardando todo en local; Drive solo sirve para
   intercambiar cambios.
   ========================================================================= */

const Sync = (() => {
  const CLIENT_ID = '124450345824-86oe6g0bgsn255o6m8pp83ijq5c1u6j9.apps.googleusercontent.com';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const FILES = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const INDEX_NAME = 'recetario-index.json';

  // Estados: off (no conectado) · ok · syncing · needs-tap (hay que tocar para renovar permiso) · offline · error
  let state = 'off';
  let lastError = '';
  let running = null;
  let timer = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(state));
  const setState = (s, err = '') => { state = s; lastError = err; emit(); };

  /* ---------- Inicio de sesión con Google (Google Identity Services) ---------- */

  let gisPromise = null;
  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    gisPromise ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(Object.assign(new Error('gis'), { offline: true })); };
      document.head.append(s);
    });
    return gisPromise;
  }

  /** Devuelve un permiso válido. Si ha caducado, solo lo pide si el usuario acaba de tocar un botón. */
  async function getToken(interactive) {
    const saved = await Meta.get('driveToken');
    if (saved && saved.expiresAt > Date.now() + 60e3) return saved.value;
    if (!interactive) return null;
    await loadGis();
    const firstTime = !(await Meta.get('driveConnected'));
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: async (r) => {
          if (r.error) return reject(Object.assign(new Error(r.error), { cancelled: true }));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            return reject(Object.assign(new Error('scope'), { userMessage: 'Falta el permiso de Drive. Vuelve a conectar y marca la casilla de Google Drive.' }));
          }
          await Meta.set('driveToken', { value: r.access_token, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000 });
          await Meta.set('driveConnected', true);
          resolve(r.access_token);
        },
        error_callback: (e) => {
          const msg = e?.type === 'popup_failed_to_open'
            ? 'Chrome no dejó abrir la ventana de Google. Vuelve a pulsar el botón.'
            : '';
          reject(Object.assign(new Error(e?.type || 'popup'), { cancelled: !msg, userMessage: msg }));
        },
      });
      client.requestAccessToken({ prompt: firstTime ? 'consent' : '' });
    });
  }

  /* ---------- Llamadas a Drive ---------- */

  async function api(token, url, opts = {}) {
    let r;
    try { r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } }); }
    catch { throw Object.assign(new Error('net'), { offline: true }); }
    if (r.status === 401) { await Meta.set('driveToken', null); throw Object.assign(new Error('auth'), { auth: true }); }
    if (!r.ok) throw new Error(`Drive ${r.status}`);
    return r;
  }

  async function listFiles(token) {
    const out = [];
    let page = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,createdTime)' });
      if (page) q.set('pageToken', page);
      const data = await (await api(token, `${FILES}?${q}`)).json();
      out.push(...(data.files || []));
      page = data.nextPageToken || '';
    } while (page);
    return out;
  }

  /** Sube un archivo nuevo (multipart) o reemplaza el contenido de uno existente. */
  async function upload(token, { id, name, blob }) {
    if (id) {
      await api(token, `${UPLOAD}/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
      return;
    }
    const boundary = 'recetario' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob,
      `\r\n--${boundary}--`,
    ]);
    await api(token, `${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }

  /** Ejecuta tareas con un máximo de n a la vez (para no saturar la conexión del móvil). */
  async function pool(items, n, fn) {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
  }

  /** JSON con las claves ordenadas: así dos dispositivos con los mismos datos generan el mismo texto. */
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
  }

  /* ---------- Sincronizar ---------- */

  async function run(interactive) {
    if (!(await Meta.get('driveConnected')) && !interactive) { setState('off'); return null; }
    setState('syncing');
    try {
      const token = await getToken(interactive);
      if (!token) { setState('needs-tap'); return null; }

      // 1. Qué hay en Drive
      const files = await listFiles(token);
      const indexFile = files.find((f) => f.name === INDEX_NAME);
      const remoteImages = new Map(files.filter((f) => f.name.startsWith('img-')).map((f) => [f.name.slice(4), f]));
      const remoteText = indexFile ? await (await api(token, `${FILES}/${indexFile.id}?alt=media`)).text() : '';
      let remote = { recipes: [], tombstones: [] };
      if (remoteText) { try { remote = JSON.parse(remoteText); } catch { /* índice dañado: se reescribe */ } }

      // 2. Traer cambios de Drive a este dispositivo
      const download = async (id) => {
        const f = remoteImages.get(id);
        return f ? (await api(token, `${FILES}/${f.id}?alt=media`)).blob() : null;
      };
      const result = await mergeRemote(remote, download);
      if (await Docs.merge(remote.docs)) result.docsChanged = true;

      // 3. Fotos que faltan aquí aunque la receta ya estuviera (p. ej. subida a medias)
      const [recipes, tombstones, localIds] = await Promise.all([DB.all('recipes'), DB.all('tombstones'), DB.keys('images')]);
      const have = new Set(localIds);
      const used = referencedImages(recipes);
      const missingHere = [...used].filter((id) => !have.has(id) && remoteImages.has(id));
      let fetched = 0;
      await pool(missingHere, 3, async (id) => {
        const blob = await download(id);
        if (blob) { await DB.put('images', { id, blob, createdAt: Date.now() }); fetched++; }
      });

      // 4. Subir a Drive las fotos que solo están aquí (siempre antes que el índice)
      const toUpload = [...used].filter((id) => have.has(id) && !remoteImages.has(id));
      await pool(toUpload, 3, async (id) => {
        const rec = await DB.get('images', id);
        if (rec) await upload(token, { name: `img-${id}`, blob: rec.blob });
      });

      // 5. Subir el índice de recetas si ha cambiado
      const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const indexText = canonical({ format: 'recetario', formatVersion: 1, recipes: [...recipes].sort(byId), tombstones: [...tombstones].sort(byId), docs: await Docs.all() });
      if (indexText !== remoteText) {
        await upload(token, { id: indexFile?.id, name: INDEX_NAME, blob: new Blob([indexText], { type: 'application/json' }) });
      }

      // 6. Limpieza: fotos de Drive que ya no usa ninguna receta (con un día de margen
      //    por si otro dispositivo está a mitad de subir una receta nueva)
      const dayAgo = Date.now() - 864e5;
      const orphans = [...remoteImages.entries()].filter(([id, f]) => !used.has(id) && Date.parse(f.createdTime) < dayAgo);
      await pool(orphans, 3, async ([, f]) => { await api(token, `${FILES}/${f.id}`, { method: 'DELETE' }).catch(() => {}); });

      await Meta.set('lastSync', Date.now());
      await Meta.set('syncPending', false);
      setState('ok');
      result.fetched = fetched;
      return result;
    } catch (err) {
      if (err.auth) setState('needs-tap');
      else if (err.offline) setState('offline');
      else if (err.cancelled) setState((await Meta.get('driveConnected')) ? 'needs-tap' : 'off');
      else { console.error(err); setState('error', err.userMessage || 'No se pudo sincronizar. Vuelve a intentarlo en un momento.'); }
      if (err.userMessage) toast(err.userMessage);
      throw err;
    }
  }

  /** Sincroniza (una sola a la vez). interactive: el usuario ha tocado un botón y se puede abrir Google. */
  function sync({ interactive = false } = {}) {
    if (running) return running;
    running = run(interactive).then(async (result) => {
      if (result && (result.changed || result.fetched)) {
        const n = result.added + result.updated + result.removed;
        toast(n ? `Recetario sincronizado: ${n} ${n === 1 ? 'cambio' : 'cambios'}` : 'Fotos sincronizadas');
        refreshView();
      }
      return result;
    }).finally(() => { running = null; });
    return running;
  }

  /** Vuelve a pintar la pantalla con los datos nuevos, salvo si estás editando o cocinando. */
  function refreshView() {
    const h = location.hash || '#/';
    if (Sheets.isOpen()) return;
    if (/^#\/?$|^#\/receta\/|^#\/ajustes|^#\/menu|^#\/compra/.test(h)) Router.render();
  }

  /** Tras guardar o borrar: sincroniza en unos segundos si hay permiso; si no, queda pendiente. */
  async function schedule() {
    if (!(await Meta.get('driveConnected'))) return;
    await Meta.set('syncPending', true);
    clearTimeout(timer);
    timer = setTimeout(() => sync().catch(() => {}), 1500);
  }

  async function disconnect() {
    const saved = await Meta.get('driveToken');
    try { if (saved?.value && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(saved.value, () => {}); } catch { /* */ }
    await Meta.set('driveToken', null);
    await Meta.set('driveConnected', false);
    setState('off');
  }

  async function init() {
    if (!(await Meta.get('driveConnected'))) { setState('off'); return; }
    setState((await Meta.get('syncPending')) ? 'needs-tap' : 'ok');
    loadGis().catch(() => {}); // precargar para que el botón responda al instante
    sync().catch(() => {});
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      const last = await Meta.get('lastSync', 0);
      if (Date.now() - last > 30e3) sync().catch(() => {});
    });
  }

  return {
    sync, schedule, disconnect, init,
    get state() { return state; },
    get lastError() { return lastError; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

/** Botón de nube de la pantalla de inicio: muestra el estado y sincroniza al tocarlo. */
function syncButtonHTML(state) {
  const map = {
    ok: ['cloud-check', 'Sincronizado con Google Drive. Toca para sincronizar ahora', ''],
    syncing: ['refresh-cw', 'Sincronizando…', 'is-spinning'],
    'needs-tap': ['cloud', 'Toca para sincronizar con Google Drive', 'has-dot'],
    offline: ['cloud-off', 'Sin conexión. Se sincronizará al volver internet', ''],
    error: ['cloud-alert', 'Error al sincronizar. Toca para reintentar', 'has-dot'],
  };
  const [ic, label, cls] = map[state] || map.ok;
  return `<button class="icon-btn sync-btn ${cls}" data-act="sync" aria-label="${label}" title="${label}">${icon(ic)}</button>`;
}

/* =========================================================================
   10. Arranque
   ========================================================================= */

/** Pide a Chrome que no borre los datos para liberar espacio. */
let persistAsked = false;
function requestPersistence() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); }).catch(() => {});
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => toast('Hay una versión nueva de la app', { label: 'Actualizar', run: () => worker.postMessage('SKIP_WAITING') });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

Router.add(/^\/?$/, HomeView);
Router.add(/^\/receta\/([^/]+)$/, RecipeView);
Router.add(/^\/editar\/([^/]+)$/, EditorView);
Router.add(/^\/cocinar\/([^/]+)$/, CookView);
Router.add(/^\/ajustes$/, SettingsView);
Router.add(/^\/menu$/, MenuView);
Router.add(/^\/compra$/, ShoppingView);

(async function start() {
  if (!('indexedDB' in window)) { $('#app').innerHTML = '<p style="padding:24px">Este navegador no puede guardar recetas. Usa Chrome actualizado.</p>'; return; }
  try {
    await Router.render();
  } catch (err) {
    console.error(err);
    $('#app').innerHTML = '<div class="page"><p>No se pudo abrir el recetario. Cierra la app y vuelve a abrirla.</p></div>';
  }
  registerServiceWorker();
  Sync.init().catch(() => {});
  Store.purgeOld().catch(() => {});
  setTimeout(() => Images.collectGarbage().catch(() => {}), 4000);
})();
