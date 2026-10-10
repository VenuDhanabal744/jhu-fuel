// Free, on-device food recognition. A CLIP model (runs in the browser via
// transformers.js - no server, no API key) scores how well a photo matches each item
// on that day's JHU dining menu. Because it only has to choose among ~150-500 menu
// items instead of "any food", a small model is accurate enough. Several crops of the
// photo are scored so multiple foods on one plate can be found.

import { flatItems, servingText, findRestaurantInText } from './menus.js';
import { cacheGet, cacheSet } from './store.js';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/+esm';
const MODEL_ID = 'Xenova/clip-vit-base-patch32';

let state = 'idle'; // idle | loading | ready | error
let loadError = null;
let progress = 0; // 0-1 while downloading
let T = null; // transformers.js module
let visionPromise = null;
let textPromise = null;
let precomputedPromise = null;
const textCache = new Map(); // prompt -> Float32Array (unit length); also persisted in IndexedDB

export function recognizerStatus() {
  return { state, error: loadError, model: MODEL_ID, progress };
}

function trackProgress() {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      const [loaded, total] = [...files.values()].reduce((a, [l, t]) => [a[0] + l, a[1] + t], [0, 0]);
      progress = total ? loaded / total : 0;
    }
  };
}

/** Load the image half of the model (first time: downloads ~90 MB, then cached by the browser). */
export function loadModels() {
  visionPromise ??= (async () => {
    state = 'loading';
    T ??= await import(TRANSFORMERS_URL);
    const progress_callback = trackProgress();
    const [processor, vision] = await Promise.all([
      T.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
      T.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8', progress_callback }),
    ]);
    state = 'ready';
    progress = 1;
    return { processor, vision };
  })().catch((err) => {
    state = 'error';
    loadError = err.message;
    visionPromise = null;
    throw err;
  });
  return visionPromise;
}

/** The text half - only needed for typed descriptions and dishes missing from the precomputed file. */
function loadTextModel() {
  textPromise ??= (async () => {
    T ??= await import(TRANSFORMERS_URL);
    const [tokenizer, text] = await Promise.all([
      T.AutoTokenizer.from_pretrained(MODEL_ID),
      T.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'q8' }),
    ]);
    return { tokenizer, text };
  })().catch((err) => {
    textPromise = null;
    throw err;
  });
  return textPromise;
}

/** Dish-name embeddings computed daily by scripts/build-embeddings.mjs (int8, per-row scale). */
function loadPrecomputed() {
  precomputedPromise ??= (async () => {
    const [meta, bin] = await Promise.all([
      fetch('data/embeddings.json').then((r) => (r.ok ? r.json() : null)),
      fetch('data/embeddings.bin').then((r) => (r.ok ? r.arrayBuffer() : null)),
    ]);
    if (!meta || !bin || meta.model !== MODEL_ID) return;
    const all = new Int8Array(bin);
    meta.names.forEach((name, i) => {
      const v = Float32Array.from(all.subarray(i * meta.dim, (i + 1) * meta.dim), (x) => x * meta.scales[i]);
      const norm = Math.hypot(...v);
      textCache.set(prompt(name), v.map((x) => x / norm));
    });
  })().catch(() => {
    precomputedPromise = null;
  });
  return precomputedPromise;
}

function unitRows(tensor) {
  const [rows, dim] = tensor.dims;
  const out = [];
  for (let r = 0; r < rows; r++) {
    const v = tensor.data.slice(r * dim, (r + 1) * dim);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    for (let i = 0; i < dim; i++) v[i] /= norm;
    out.push(v);
  }
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const prompt = (name) => `a photo of ${name}, a type of food.`;

async function embedTexts(texts) {
  await loadPrecomputed();
  const unique = [...new Set(texts)];
  await Promise.all(
    unique
      .filter((t) => !textCache.has(t))
      .map(async (t) => {
        const hit = await cacheGet(`emb:${MODEL_ID}:${t}`);
        if (hit) textCache.set(t, hit.data);
      }),
  );
  const missing = unique.filter((t) => !textCache.has(t));
  if (missing.length) {
    const m = await loadTextModel();
    for (let i = 0; i < missing.length; i += 32) {
      const batch = missing.slice(i, i + 32);
      const { text_embeds } = await m.text(m.tokenizer(batch, { padding: true, truncation: true }));
      unitRows(text_embeds).forEach((v, j) => {
        textCache.set(batch[j], v);
        cacheSet(`emb:${MODEL_ID}:${batch[j]}`, v);
      });
    }
  }
  return texts.map((t) => textCache.get(t));
}

async function embedImages(images) {
  const m = await loadModels();
  const out = [];
  for (const img of images) {
    const { image_embeds } = await m.vision(await m.processor(img));
    out.push(unitRows(image_embeds)[0]);
  }
  return out;
}

/** Full image + center + four overlapping quadrants, so separate foods get their own view. */
async function crops(image) {
  const { width: w, height: hgt } = image;
  const cw = Math.round(w * 0.6);
  const ch = Math.round(hgt * 0.6);
  const boxes = [
    [Math.round(w * 0.15), Math.round(hgt * 0.15), Math.round(w * 0.85), Math.round(hgt * 0.85)],
    [0, 0, cw, ch],
    [w - cw, 0, w - 1, ch],
    [0, hgt - ch, cw, hgt - 1],
    [w - cw, hgt - ch, w - 1, hgt - 1],
  ];
  return [image, ...(await Promise.all(boxes.map((b) => image.crop(b))))];
}

/** Softmax over CLIP similarities (CLIP's learned logit scale is ~100). */
function softmax(sims) {
  const logits = sims.map((s) => 100 * s);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function menuEntry(it) {
  return {
    source: 'menu',
    foodId: it.foodId,
    name: it.name,
    location: it.locationName,
    station: `${it.menuName} · ${it.station}`,
    serving: servingText(it.serving),
    nutrients: it.nutrients,
    hasNutrition: it.hasNutrition,
  };
}

/** Candidate menu items grouped by name (the same dish can be served at several locations). */
async function candidateGroups(date, meal, location) {
  let items = await flatItems(date, { location, meal });
  if (!items.length && location && location !== 'any') items = await flatItems(date, { meal });
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.name)) groups.set(it.name, []);
    groups.get(it.name).push(it);
  }
  return { items, names: [...groups.keys()], groups };
}

/** Pick the version of each dish served at the location most of the plate points to. */
function resolveLocations(picks, groups) {
  const weight = new Map();
  for (const { name, p } of picks) {
    for (const it of groups.get(name)) weight.set(it.locationName, (weight.get(it.locationName) ?? 0) + p);
  }
  const likely = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const pick = (name) => {
    const versions = groups.get(name);
    return versions.find((it) => it.locationName === likely) ?? versions[0];
  };
  return { likely, pick };
}

function confidence(p) {
  return p >= 0.45 ? 'high' : p >= 0.2 ? 'medium' : 'low';
}

const MAX_DETECTED = 5;

export async function analyzePhoto({ image: dataUrl, date, meal, location }) {
  const { items, names, groups } = await candidateGroups(date, meal, location);
  if (!names.length) {
    return { summary: 'No JHU menu was published for this day, so there was nothing to match against.', notes: 'Add what you ate with Search or Custom food.', likelyLocation: null, candidateCount: 0, items: [], suggestions: [] };
  }

  await loadModels();
  const image = await T.RawImage.fromURL(dataUrl);
  const textVecs = await embedTexts(names.map(prompt));
  const imageVecs = await embedImages(await crops(image));

  // Per crop: probability of each menu item, ranked.
  const ranked = imageVecs.map((v) => {
    const probs = softmax(textVecs.map((t) => dot(t, v)));
    return names.map((name, i) => ({ name, p: probs[i] })).sort((a, b) => b.p - a.p);
  });

  // Detected: the whole-photo winner, plus any crop whose winner is confident AND is also
  // plausible for the photo as a whole (filters out e.g. "Pepsi" from a crop of a bowl rim).
  const fullRank = new Map(ranked[0].map((r, i) => [r.name, i]));
  const detected = new Map();
  const consider = (crop, i) => {
    const top = crop[0];
    if (detected.has(top.name)) {
      const d = detected.get(top.name);
      if (top.p > d.p) Object.assign(d, { p: top.p, crop: i });
      return;
    }
    if (i === 0 || (top.p >= 0.2 && fullRank.get(top.name) < 20)) detected.set(top.name, { name: top.name, p: top.p, crop: i });
  };
  ranked.forEach(consider);
  const picks = [...detected.values()].sort((a, b) => b.p - a.p).slice(0, MAX_DETECTED);

  // Suggestions: best score each item got in any view, excluding what's already picked.
  const best = new Map();
  for (const crop of ranked) for (const { name, p } of crop.slice(0, 15)) best.set(name, Math.max(best.get(name) ?? 0, p));
  const pickedNames = new Set(picks.map((d) => d.name));

  const { likely, pick } = resolveLocations(picks, groups);
  const resultItems = picks.map((d) => ({
    label: '',
    confidence: confidence(d.p),
    portion: '',
    servings: 1,
    match: menuEntry(pick(d.name)),
    alternatives: ranked[d.crop]
      .filter((r) => r.name !== d.name)
      .slice(0, 3)
      .map((r) => menuEntry(pick(r.name))),
  }));
  const suggestions = [...best]
    .filter(([name]) => !pickedNames.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => menuEntry(pick(name)));

  return {
    summary: `Matched your photo against ${names.length} items on the menu${likely ? ` — looks like ${likely}` : ''}.`,
    notes: 'Portions start at 1 menu serving — use − / + to match what you took, and tap anything else that’s on your plate below.',
    likelyLocation: likely,
    candidateCount: items.length,
    items: resultItems,
    suggestions,
  };
}

// ---------- plain-text descriptions ("2 slices of pizza and a coke") ----------

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, half: 0.5, couple: 2, few: 3 };
const UNIT_WORDS = /\b(slices?|pieces?|cups?|bowls?|plates?|servings?|scoops?|glass(es)?|cans?|bottles?|helpings?|portions?|of|some|small|large|big|medium)\b/gi;
const LOCATION_HINTS = [
  [/\b(ffc|fresh food|hopkins caf[eé])\b/i, 'hopkins-cafe'],
  [/\bnolan'?s\b/i, 'nolans-on-33rd'],
  [/\blevering (caf[eé]|coffee)\b/i, 'levering-cafe'],
  [/\blevering\b/i, 'site-1'],
  [/\bpeabody\b/i, 'peabody-institute'],
];

function parseChunk(raw) {
  let text = raw.trim().toLowerCase().replace(/[.!?]+$/, '');
  let servings = 1;
  // A number followed by a size unit ("6 inch sub", "12 oz latte", "10 piece nuggets") is part of the item, not a count.
  const num = text.match(/^(\d+(?:\.\d+)?|\d+\/\d+)(?!\s*(?:inch|in\b|"|oz\b|ounce|fl\b|piece|pc\b|pcs\b|count|ct\b))\s+/);
  if (num) {
    servings = num[1].includes('/') ? num[1].split('/').reduce((a, b) => a / b) : +num[1];
    text = text.slice(num[0].length);
  } else {
    const word = text.match(/^(a couple of|a few|half an?|half|an?|one|two|three|four|five|six)\s+/);
    if (word) {
      const w = word[1].split(' ')[0] === 'half' ? 'half' : word[1].includes('couple') ? 'couple' : word[1].includes('few') ? 'few' : word[1];
      servings = NUMBER_WORDS[w] ?? 1;
      text = text.slice(word[0].length);
    }
  }
  text = text.replace(UNIT_WORDS, ' ').replace(/\s+/g, ' ').trim();
  return { text, servings };
}

function lexicalScore(query, name) {
  const q = new Set(query.split(/\W+/).filter((w) => w.length > 2));
  const n = name.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!q.size || !n.length) return 0;
  const hits = n.filter((w) => q.has(w) || q.has(w.replace(/s$/, '')) || q.has(`${w}s`)).length;
  // Mostly "how many of the words you typed are in this dish's name", a little "how much of the name you typed".
  return 0.7 * Math.min(1, hits / q.size) + 0.3 * (hits / n.length);
}

export async function analyzeText({ text, date, meal, location }) {
  let loc = location;
  let body = text;
  const chain = await findRestaurantInText(body);
  if (chain) {
    loc = `rest:${chain.place.id}`;
    body = body.replace(chain.pattern, ' ');
  }
  for (const [re, slug] of chain ? [] : LOCATION_HINTS) {
    if (re.test(body)) {
      loc = slug;
      body = body.replace(re, ' ');
      break;
    }
  }
  body = body.replace(/\b(from|at|in) the\b|\b(from|at)\b(?=\s*$)/gi, ' ');
  const { items, names, groups } = await candidateGroups(date, meal, loc);
  const chunks = body
    // At a chain, "with" is usually part of an item name ("McFlurry with Oreo"); elsewhere it joins two foods.
    .split(chain ? /,|;|\n|\+|&|\band\b|\bplus\b|\balso\b/i : /,|;|\n|\+|&|\band\b|\bwith\b|\bplus\b|\balso\b/i)
    .map(parseChunk)
    .filter((c) => c.text.length > 1);
  if (!names.length || !chunks.length) {
    return { summary: names.length ? 'I couldn’t find any foods in that description.' : 'No JHU menu was published for this day.', notes: 'Try listing foods separated by commas, or use Search.', likelyLocation: null, candidateCount: items.length, items: [], suggestions: [] };
  }

  const nameVecs = await embedTexts(names.map(prompt));
  const chunkVecs = await embedTexts(chunks.map((c) => prompt(c.text)));
  const results = chunks.map((c, i) => {
    const scored = names
      .map((name, j) => ({ name, score: dot(chunkVecs[i], nameVecs[j]) + 0.35 * lexicalScore(c.text, name) }))
      .sort((a, b) => b.score - a.score);
    const margin = scored[0].score - (scored[1]?.score ?? 0);
    return { chunk: c, scored, conf: margin > 0.05 ? 'high' : margin > 0.02 ? 'medium' : 'low' };
  });

  const { likely, pick } = resolveLocations(
    results.map((r) => ({ name: r.scored[0].name, p: 1 })),
    groups,
  );
  return {
    summary: `Matched ${results.length} item${results.length === 1 ? '' : 's'} against ${names.length} menu items${likely ? ` at ${likely}` : ''}.`,
    notes: 'Double-check each match and adjust servings if needed.',
    likelyLocation: likely,
    candidateCount: items.length,
    items: results.map((r) => ({
      label: r.chunk.text,
      confidence: r.conf,
      portion: '',
      servings: r.chunk.servings,
      match: menuEntry(pick(r.scored[0].name)),
      alternatives: r.scored.slice(1, 4).map((s) => menuEntry(pick(s.name))),
    })),
    suggestions: [],
  };
}
