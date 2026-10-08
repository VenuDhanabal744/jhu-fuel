// Shared by the browser and the server. Keys match the Nutrislice
// `rounded_nutrition_info` fields so menu data can be stored as-is.

export const NUTRIENTS = [
  { key: 'calories', label: 'Calories', unit: 'kcal', decimals: 0 },
  { key: 'g_protein', label: 'Protein', unit: 'g', decimals: 0 },
  { key: 'g_carbs', label: 'Carbs', unit: 'g', decimals: 0 },
  { key: 'g_fat', label: 'Fat', unit: 'g', decimals: 0 },
  { key: 'g_fiber', label: 'Fiber', unit: 'g', decimals: 1 },
  { key: 'g_sugar', label: 'Total sugar', unit: 'g', decimals: 0 },
  { key: 'g_added_sugar', label: 'Added sugar', unit: 'g', decimals: 0 },
  { key: 'g_saturated_fat', label: 'Saturated fat', unit: 'g', decimals: 1 },
  { key: 'g_trans_fat', label: 'Trans fat', unit: 'g', decimals: 1 },
  { key: 'mg_cholesterol', label: 'Cholesterol', unit: 'mg', decimals: 0 },
  { key: 'mg_sodium', label: 'Sodium', unit: 'mg', decimals: 0 },
  { key: 'mg_potassium', label: 'Potassium', unit: 'mg', decimals: 0 },
  { key: 'mg_calcium', label: 'Calcium', unit: 'mg', decimals: 0 },
  { key: 'mg_iron', label: 'Iron', unit: 'mg', decimals: 1 },
  { key: 'mg_vitamin_c', label: 'Vitamin C', unit: 'mg', decimals: 0 },
  { key: 'mcg_vitamin_a', label: 'Vitamin A', unit: 'mcg', decimals: 0 },
  { key: 'mcg_vitamin_d', label: 'Vitamin D', unit: 'mcg', decimals: 1 },
];

export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);
export const NUTRIENT_BY_KEY = Object.fromEntries(NUTRIENTS.map((n) => [n.key, n]));

export const MACROS = ['g_protein', 'g_carbs', 'g_fat'];
export const MICROS = NUTRIENT_KEYS.filter((k) => k !== 'calories' && !MACROS.includes(k));

/** Keep only known nutrient keys; non-numeric values become null. */
export function cleanNutrients(src = {}) {
  const out = {};
  for (const key of NUTRIENT_KEYS) {
    const v = src[key];
    const num = v == null || v === '' ? NaN : Number(v);
    out[key] = Number.isFinite(num) ? num : null;
  }
  return out;
}

export function scaleNutrients(n, factor) {
  const out = {};
  for (const key of NUTRIENT_KEYS) out[key] = n?.[key] == null ? null : n[key] * factor;
  return out;
}

/** Sum a list of nutrient objects; null + null stays null so "unknown" is distinguishable from 0. */
export function sumNutrients(list) {
  const out = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null]));
  for (const n of list) {
    for (const key of NUTRIENT_KEYS) {
      if (n?.[key] != null) out[key] = (out[key] ?? 0) + n[key];
    }
  }
  return out;
}

export function fmt(value, key, { unit = true } = {}) {
  const meta = NUTRIENT_BY_KEY[key];
  if (value == null) return '—';
  const d = meta?.decimals ?? 0;
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : +value.toFixed(d);
  const str = rounded.toLocaleString();
  return unit && meta ? `${str}${meta.unit === 'kcal' ? '' : ' ' + meta.unit}` : str;
}
