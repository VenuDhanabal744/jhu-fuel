// Daily nutrient targets derived from the profile. Shared by browser and server.
//
// kind: 'target' = aim to land near it, 'min' = aim to reach at least, 'max' = stay under,
//       'none' = tracked but no recommendation.

export const ACTIVITY_LEVELS = {
  sedentary: { label: 'Sedentary (little exercise)', factor: 1.2 },
  light: { label: 'Light (1–3 workouts/week)', factor: 1.375 },
  moderate: { label: 'Moderate (3–5 workouts/week)', factor: 1.55 },
  active: { label: 'Very active (6–7 workouts/week)', factor: 1.725 },
  athlete: { label: 'Athlete (2x/day training)', factor: 1.9 },
};

export const GOALS = {
  lose: 'Lose weight',
  maintain: 'Maintain weight',
  gain: 'Gain weight / build muscle',
};

export const DEFAULT_PROFILE = {
  name: '',
  sex: 'female',
  age: 20,
  heightIn: 66,
  weightLb: 150,
  startWeightLb: null,
  startDate: null,
  targetWeightLb: 150,
  goal: 'maintain',
  rateLbPerWeek: 0.5,
  activity: 'moderate',
  overrides: {},
  configured: false,
};

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;
const KCAL_PER_LB = 3500;

export function computeTargets(profile, currentWeightLb = profile.weightLb) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  const kg = currentWeightLb * LB_TO_KG;
  const cm = p.heightIn * IN_TO_CM;
  const male = p.sex === 'male';

  // Mifflin–St Jeor
  const bmr = 10 * kg + 6.25 * cm - 5 * p.age + (male ? 5 : -161);
  const tdee = bmr * (ACTIVITY_LEVELS[p.activity]?.factor ?? 1.55);
  const sign = p.goal === 'lose' ? -1 : p.goal === 'gain' ? 1 : 0;
  const dailyDelta = (sign * p.rateLbPerWeek * KCAL_PER_LB) / 7;
  const floor = male ? 1500 : 1200;
  const calories = Math.round(Math.max(floor, tdee + dailyDelta) / 10) * 10;

  // Protein: ~1.6 g/kg when cutting or bulking, ~1.2 g/kg to maintain.
  const protein = Math.round(kg * (sign === 0 ? 1.2 : 1.6));
  const fat = Math.round((calories * 0.3) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  const adult = p.age >= 19;
  const over50 = p.age > 50;

  const auto = {
    calories: { value: calories, kind: 'target' },
    g_protein: { value: protein, kind: 'min' },
    g_carbs: { value: carbs, kind: 'target' },
    g_fat: { value: fat, kind: 'target' },
    g_fiber: { value: Math.round((calories / 1000) * 14), kind: 'min' },
    g_sugar: { value: null, kind: 'none' },
    g_added_sugar: { value: Math.round((calories * 0.1) / 4), kind: 'max' },
    g_saturated_fat: { value: Math.round((calories * 0.1) / 9), kind: 'max' },
    g_trans_fat: { value: 2, kind: 'max' },
    mg_cholesterol: { value: 300, kind: 'max' },
    mg_sodium: { value: 2300, kind: 'max' },
    mg_potassium: { value: male ? 3400 : 2600, kind: 'min' },
    mg_calcium: { value: !adult ? 1300 : over50 && !male ? 1200 : 1000, kind: 'min' },
    mg_iron: { value: male || over50 ? 8 : adult ? 18 : 15, kind: 'min' },
    mg_vitamin_c: { value: male ? 90 : 75, kind: 'min' },
    mcg_vitamin_a: { value: male ? 900 : 700, kind: 'min' },
    mcg_vitamin_d: { value: 15, kind: 'min' },
  };

  const targets = {};
  for (const [key, t] of Object.entries(auto)) {
    const o = p.overrides?.[key];
    const overridden = o != null && o !== '' && Number.isFinite(+o);
    targets[key] = { ...t, auto: t.value, value: overridden ? +o : t.value, overridden };
    if (overridden && t.kind === 'none') targets[key].kind = 'max';
  }
  return { targets, bmr: Math.round(bmr), tdee: Math.round(tdee), dailyDelta: Math.round(dailyDelta) };
}

/** Status of an intake value against a target, for coloring + labels. */
export function targetStatus(value, t) {
  if (!t || t.value == null || t.kind === 'none') return { state: 'none', pct: null };
  const pct = (value ?? 0) / t.value;
  if (t.kind === 'max') return { state: pct > 1 ? 'over' : pct > 0.9 ? 'near' : 'ok', pct };
  if (t.kind === 'min') return { state: pct >= 1 ? 'met' : 'under', pct };
  return { state: pct > 1.1 ? 'over' : pct >= 0.9 ? 'met' : 'under', pct };
}
