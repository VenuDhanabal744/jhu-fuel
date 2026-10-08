// Read a photographed US "Nutrition Facts" panel with free, on-device OCR (Tesseract,
// running in the browser) and pull out every nutrient the tracker uses. OCR is
// imperfect, so the result is shown in an editable form before anything is logged.

import { cleanNutrients } from './nutrients.js';
import { loadImage, toCanvas } from './image.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js';

let workerPromise = null;
function getWorker() {
  // First use downloads the English model (~10 MB); the browser caches it.
  workerPromise ??= import(TESSERACT_URL)
    .then((T) => (T.createWorker ?? T.default.createWorker)('eng', 1))
    .catch((err) => {
      workerPromise = null;
      throw err;
    });
  return workerPromise;
}

/** Grayscale, stretch contrast and upscale - Tesseract likes big, high-contrast text. */
function preprocess(img, angle = 0) {
  const width = Math.max(1600, Math.min(img.width, 2400));
  const canvas = toCanvas(img, { width, angle, background: '#ffffff' });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  // Luminance histogram -> stretch the 1st..99th percentile to full range.
  const lum = new Uint8ClampedArray(px.length / 4);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    lum[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    hist[lum[j]]++;
  }
  const pct = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= lum.length * p) return v;
    return 255;
  };
  const lo = pct(0.01);
  const hi = Math.max(lo + 1, pct(0.99));
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = ((lum[j] - lo) * 255) / (hi - lo);
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

// Daily Values used to convert "%DV"-only lines (common for vitamins) into amounts.
const DV = { mg_calcium: 1300, mg_iron: 18, mg_potassium: 4700, mcg_vitamin_a: 900, mg_vitamin_c: 90, mcg_vitamin_d: 20 };

// A number as OCR tends to print it: "O" and "o" for 0, "l"/"I" for 1, comma decimals.
const NUM = String.raw`([0-9OoIl]{1,4}(?:[.,][0-9Oo]{1,2})?)`;

function toNumber(raw) {
  return +raw.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(',', '.');
}

/** Normalize common OCR confusions so the regexes below stay simple. */
function normalize(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[|]/g, ' ')
    .replace(/\brng\b|(?<=\d)rng\b/g, 'mg')
    .replace(/(?<=\d)\s*(?:meg|mcq|mgc)\b/g, 'mcg')
    .replace(/(?<=\d)\s*(?:µg|ug|pg)\b/g, 'mcg')
    .replace(/(?<=[A-Za-z\s])[il](?=\d)/g, '1') // "Sodiumi60mg" -> "Sodium160mg"
    .replace(/(\d)9(?=\s+\d{1,3}\s*%)/g, '$1g') // "37g 13%" read as "379 13%": labels always print a unit
    .replace(/[ \t]+/g, ' ');
}

function grab(text, label, units = 'g') {
  const re = new RegExp(`${label}[^0-9OoIl\\n]{0,12}${NUM}\\s*(${units})\\b`, 'i');
  const m = re.exec(text);
  return m ? { value: toNumber(m[1]), unit: m[2].toLowerCase() } : null;
}

function grabPercent(text, label) {
  const m = new RegExp(`${label}[^\\n%]{0,20}?${NUM}\\s*%`, 'i').exec(text);
  return m ? toNumber(m[1]) : null;
}

export function parseLabel(rawText) {
  const text = normalize(rawText);
  const out = {};
  const found = [];
  const set = (key, value) => {
    if (value != null && Number.isFinite(value)) {
      out[key] = Math.round(value * 10) / 10;
      found.push(key);
    }
  };

  // Calories: the first "Calories N" that isn't "Calories from fat".
  const cal = /calor[il1]es(?!\s*from)[^0-9OoIl\n]{0,10}([0-9OoIl]{1,4})/i.exec(text) ?? /calor[il1]es[\s\S]{0,15}?([0-9]{2,4})/i.exec(text);
  if (cal) set('calories', toNumber(cal[1]));

  set('g_fat', grab(text, String.raw`total\s*fat`)?.value);
  set('g_saturated_fat', grab(text, String.raw`sat(?:urated|\.)?\s*fat`)?.value);
  set('g_trans_fat', grab(text, String.raw`trans\s*fat`)?.value);
  set('mg_cholesterol', grab(text, String.raw`cholest(?:erol|\.)?(?:\s*less\s*than)?`, 'mg')?.value);
  set('mg_sodium', grab(text, String.raw`sodium(?:\s*less\s*than)?`, 'mg')?.value);
  set('g_carbs', grab(text, String.raw`total\s*carb(?:ohydrate|s|\.)?`)?.value);
  set('g_fiber', grab(text, String.raw`(?:dietary\s*)?fib(?:er|re)`)?.value);
  const added = /incl(?:udes|\.)?\s*([0-9OoIl]{1,3}(?:[.,]\d)?)\s*g\s*(?:of\s*)?added/i.exec(text) ?? /added\s*sugars?[^0-9OoIl\n]{0,8}([0-9OoIl]{1,3}(?:[.,]\d)?)\s*g/i.exec(text);
  if (added) set('g_added_sugar', toNumber(added[1]));
  // Total sugars: a "sugars" line that isn't the "added sugars" one.
  const sugars = /(?<!added\s)(?:total\s*)?sugars?(?!\s*alcohol)[^0-9OoIl\n]{0,8}([0-9OoIl]{1,3}(?:[.,]\d)?)\s*g/i.exec(text.replace(/incl[^\n]*added[^\n]*/gi, ''));
  if (sugars) set('g_sugar', toNumber(sugars[1]));
  set('g_protein', grab(text, 'protein')?.value);

  // Vitamins & minerals: amount if printed, otherwise convert from %DV.
  const micro = (key, label, units) => {
    const amt = grab(text, label, units);
    if (amt) {
      let v = amt.value;
      if (key === 'mcg_vitamin_d' && amt.unit === 'iu') v /= 40;
      if (key === 'mcg_vitamin_a' && amt.unit === 'iu') v *= 0.3;
      return set(key, v);
    }
    const pct = grabPercent(text, label);
    if (pct != null) set(key, (pct / 100) * DV[key]);
  };
  micro('mcg_vitamin_d', String.raw`vit(?:amin|\.)?\s*d`, 'mcg|iu');
  micro('mg_calcium', 'calcium', 'mg');
  micro('mg_iron', 'iron', 'mg');
  micro('mg_potassium', 'potas(?:sium|\\.)?', 'mg');
  micro('mcg_vitamin_a', String.raw`vit(?:amin|\.)?\s*a\b`, 'mcg|iu');
  micro('mg_vitamin_c', String.raw`vit(?:amin|\.)?\s*c\b`, 'mg');

  const serving =
    /serving\s*size\s*:?\s*([^\n]{1,40})/i
      .exec(text)?.[1]
      ?.trim()
      .replace(/\s{2,}/g, ' ')
      .replace(/\((\d{1,4})\s?9\)/, '($1g)') ?? null; // "(55g)" often OCRs as "(559)"
  const perContainer = /(?:about\s*)?([0-9.]{1,4})\s*servings?\s*per\s*container/i.exec(text) ?? /servings?\s*per\s*container\s*(?:about\s*)?([0-9.]{1,4})/i.exec(text);

  const flagged = sanityCheck(out);

  return {
    nutrients: cleanNutrients(out),
    found,
    flagged,
    serving,
    servingsPerContainer: perContainer ? +perContainer[1] : null,
  };
}

/**
 * Macros can't supply more calories than the label lists. A "g" misread as "9"
 * turns 37g into 379g - if dropping that trailing 9 makes the number plausible, do it.
 * Returns the keys that were corrected or still look wrong, for the UI to highlight.
 */
function sanityCheck(out) {
  const flagged = [];
  if (!out.calories) return flagged;
  const limits = { g_carbs: out.calories / 4, g_protein: out.calories / 4, g_fat: out.calories / 9, g_sugar: out.calories / 4, g_added_sugar: out.calories / 4, g_fiber: out.calories / 2, g_saturated_fat: out.calories / 9 };
  for (const [key, max] of Object.entries(limits)) {
    const v = out[key];
    if (v == null || v <= max * 1.25 + 3) continue;
    const trimmed = Math.floor(v / 10);
    if (v % 10 === 9 && trimmed <= max * 1.25 + 3) out[key] = trimmed;
    flagged.push(key);
  }
  return flagged;
}

const RETRY_ANGLES = [-8, 8, -4, 4, -13, 13];
const CORE = ['calories', 'g_fat', 'g_carbs', 'g_protein'];
const coreCount = (r) => CORE.filter((k) => r.found.includes(k)).length;
const isComplete = (r) => coreCount(r) === CORE.length && r.found.length >= 10;
const isBetter = (a, b) => coreCount(a) > coreCount(b) || (coreCount(a) === coreCount(b) && a.found.length > b.found.length);

export async function scanLabel(dataUrl) {
  const [worker, img] = await Promise.all([getWorker(), loadImage(dataUrl)]);
  const read = async (angle) => {
    // rotateAuto fixes small skew; the explicit angle handles photos taken at a slant.
    const { data } = await worker.recognize(preprocess(img, angle), { rotateAuto: true });
    return { ...parseLabel(data.text), text: data.text, confidence: Math.round(data.confidence) };
  };
  let best = await read(0);
  for (const angle of RETRY_ANGLES) {
    if (isComplete(best)) break;
    const attempt = await read(angle);
    if (isBetter(attempt, best)) best = attempt;
  }
  return best;
}
