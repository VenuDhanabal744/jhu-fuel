// Barcodes: decode from a photo on-device (ZXing, WebAssembly), then look the product
// up in free databases - Open Food Facts first, USDA FoodData Central as a fallback.

import { cacheGet, cacheSet, getAllByIndex } from './store.js';
import { cleanNutrients } from './nutrients.js';
import { loadImage, toCanvas } from './image.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.5/dist/es/reader/index.js';
const FORMATS = ['EAN-13', 'UPC-A', 'UPC-E', 'EAN-8'];
const DAY = 86_400_000;
// The USDA's shared demo key works for light personal use (30 lookups/hour per device).
const FDC_API_KEY = 'DEMO_KEY';

let zxing = null;

export async function decodeBarcode(dataUrl) {
  zxing ??= await import(ZXING_URL);
  const img = await loadImage(dataUrl);
  const original = toCanvas(img);
  const enhanced = toCanvas(img, { width: Math.max(1600, img.naturalWidth) });
  const ctx = enhanced.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'grayscale(1) contrast(1.6)';
  ctx.drawImage(enhanced, 0, 0);
  for (const canvas of [original, enhanced]) {
    const imageData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const results = await zxing.readBarcodes(imageData, { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
    const hit = results.find((r) => r.isValid && /^\d{6,14}$/.test(r.text));
    if (hit) return hit.text;
  }
  return null;
}

/** UPC-A (12) and EAN-13 are the same code with/without a leading 0. */
function variants(code) {
  const digits = code.replace(/\D/g, '');
  const bare = digits.replace(/^0+/, '');
  return [...new Set([digits, bare.padStart(13, '0'), bare.padStart(12, '0')])];
}

// ---------- Open Food Facts ----------

const OFF_MAP = {
  calories: ['energy-kcal', 1],
  g_protein: ['proteins', 1],
  g_carbs: ['carbohydrates', 1],
  g_fat: ['fat', 1],
  g_fiber: ['fiber', 1],
  g_sugar: ['sugars', 1],
  g_added_sugar: ['added-sugars', 1],
  g_saturated_fat: ['saturated-fat', 1],
  g_trans_fat: ['trans-fat', 1],
  // OFF stores minerals/vitamins in grams.
  mg_cholesterol: ['cholesterol', 1e3],
  mg_sodium: ['sodium', 1e3],
  mg_potassium: ['potassium', 1e3],
  mg_calcium: ['calcium', 1e3],
  mg_iron: ['iron', 1e3],
  mg_vitamin_c: ['vitamin-c', 1e3],
  mcg_vitamin_a: ['vitamin-a', 1e6],
  mcg_vitamin_d: ['vitamin-d', 1e6],
};

function fromOpenFoodFacts(p) {
  const n = p.nutriments ?? {};
  const hasServing = n['energy-kcal_serving'] != null || n.energy_serving != null;
  const per100Factor = !hasServing && p.serving_quantity ? +p.serving_quantity / 100 : 1;
  const suffix = hasServing ? '_serving' : '_100g';
  const out = {};
  for (const [key, [field, mult]] of Object.entries(OFF_MAP)) {
    const v = n[field + suffix];
    if (v != null && v !== '') out[key] = +v * mult * per100Factor;
  }
  if (out.calories == null) {
    const kj = n[`energy-kj${suffix}`] ?? n[`energy${suffix}`];
    if (kj != null) out.calories = (+kj / 4.184) * per100Factor;
  }
  if (out.calories == null) return null;
  return {
    name: withBrand(p.product_name, p.brands?.split(',')[0]) || 'Unnamed product',
    serving: hasServing || per100Factor !== 1 ? p.serving_size || `${p.serving_quantity} g` : '100 g',
    nutrients: cleanNutrients(out),
    image: p.image_front_small_url ?? null,
    database: 'Open Food Facts',
  };
}

async function openFoodFacts(code) {
  for (const c of variants(code)) {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${c}.json?fields=product_name,brands,serving_size,serving_quantity,nutriments,image_front_small_url`,
      { signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === 1 && data.product) {
      const product = fromOpenFoodFacts(data.product);
      if (product) return product;
    }
  }
  return null;
}

// ---------- USDA FoodData Central (branded foods) ----------

const FDC_MAP = {
  208: ['calories', 1],
  203: ['g_protein', 1],
  205: ['g_carbs', 1],
  204: ['g_fat', 1],
  291: ['g_fiber', 1],
  269: ['g_sugar', 1],
  539: ['g_added_sugar', 1],
  606: ['g_saturated_fat', 1],
  605: ['g_trans_fat', 1],
  601: ['mg_cholesterol', 1],
  307: ['mg_sodium', 1],
  306: ['mg_potassium', 1],
  301: ['mg_calcium', 1],
  303: ['mg_iron', 1],
  401: ['mg_vitamin_c', 1],
  320: ['mcg_vitamin_a', 1],
  318: ['mcg_vitamin_a', 0.3], // IU -> mcg RAE (approx.)
  328: ['mcg_vitamin_d', 1],
  324: ['mcg_vitamin_d', 1 / 40], // IU -> mcg
};

async function usda(code) {
  const key = FDC_API_KEY;
  const bare = code.replace(/^0+/, '');
  const res = await fetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${key}&dataType=Branded&pageSize=5&query=${bare.padStart(14, '0')}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  if (!res.ok) return null;
  const food = (await res.json()).foods?.find((f) => (f.gtinUpc ?? '').replace(/^0+/, '') === bare);
  if (!food) return null;
  // Branded nutrient values are per 100 g/ml; scale to the label serving.
  const unit = (food.servingSizeUnit ?? '').toLowerCase();
  const perServing = food.servingSize && /^(g|grm|ml|mlt)$/.test(unit) ? food.servingSize / 100 : 1;
  const out = {};
  for (const n of food.foodNutrients ?? []) {
    const map = FDC_MAP[n.nutrientNumber];
    if (map && out[map[0]] == null && n.value != null) out[map[0]] = n.value * map[1] * perServing;
  }
  if (out.calories == null) return null;
  const brand = food.brandName || food.brandOwner;
  return {
    name: withBrand(titleCase(food.description), brand && titleCase(brand)),
    serving: perServing !== 1 ? food.householdServingFullText || `${food.servingSize} ${unit.startsWith('m') ? 'ml' : 'g'}` : '100 g',
    nutrients: cleanNutrients(out),
    image: null,
    database: 'USDA FoodData Central',
  };
}

function withBrand(name, brand) {
  if (!brand || name?.toLowerCase().includes(brand.toLowerCase())) return name;
  return [name, brand].filter(Boolean).join(' — ');
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Look up a barcode: your saved foods first, then the cache, then the public databases. */
export async function lookupBarcode(code) {
  const digits = code.replace(/\D/g, '');
  if (!/^\d{6,14}$/.test(digits) || digits.replace(/^0+/, '').length < 6) return null;
  for (const v of variants(digits)) {
    const [saved] = (await getAllByIndex('foods', 'barcode', v)).slice(-1);
    if (saved) return { name: saved.name, serving: saved.serving_desc, nutrients: saved.nutrients, image: null, database: 'My foods', savedId: saved.id };
  }

  const cacheKey = `barcode:${digits.replace(/^0+/, '')}`;
  const hit = await cacheGet(cacheKey);
  if (hit && (hit.data || Date.now() - hit.at < DAY)) return hit.data;

  let product = null;
  try {
    product = (await openFoodFacts(digits)) ?? (await usda(digits));
  } catch (err) {
    if (hit) return hit.data;
    throw new Error('Couldn’t reach the food databases. Check your internet connection.', { cause: err });
  }
  await cacheSet(cacheKey, product);
  return product;
}
