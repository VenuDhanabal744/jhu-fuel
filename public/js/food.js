// Food detail sheet: nutrition label, servings, meal - used to add menu items,
// saved foods and recent foods, and to edit logged entries.

import { api } from './api.js';
import { h, openSheet, stepper, select, toast, MEALS, DIET_ICONS } from './ui.js';
import { NUTRIENT_BY_KEY, scaleNutrients, fmt } from './nutrients.js';
import { state } from './app.js';

const LABEL_LINES = [
  ['g_fat', 0],
  ['g_saturated_fat', 1],
  ['g_trans_fat', 1],
  ['mg_cholesterol', 0],
  ['mg_sodium', 0],
  ['g_carbs', 0],
  ['g_fiber', 1],
  ['g_sugar', 1],
  ['g_added_sugar', 2],
  ['g_protein', 0],
  ['mcg_vitamin_d', 0],
  ['mg_calcium', 0],
  ['mg_iron', 0],
  ['mg_potassium', 0],
  ['mcg_vitamin_a', 0],
  ['mg_vitamin_c', 0],
];

export function nutritionLabel(nutrients, servingText) {
  const targets = state.profile?.targets ?? {};
  const pct = (key) => {
    const t = targets[key];
    if (!t?.value || nutrients[key] == null) return '';
    return `${Math.round((nutrients[key] / t.value) * 100)}%`;
  };
  return h(
    'div',
    { class: 'facts' },
    h('h4', null, 'Nutrition Facts'),
    servingText ? h('div', { class: 'small' }, servingText) : null,
    h('div', { class: 'cal' }, h('span', null, 'Calories'), h('b', null, fmt(nutrients.calories, 'calories'))),
    h('div', { class: 'line tiny muted', style: { justifyContent: 'flex-end' } }, '% of your daily goal'),
    LABEL_LINES.map(([key, indent]) =>
      h(
        'div',
        { class: 'line', style: indent ? { paddingLeft: `${indent * 14}px` } : null },
        h('span', null, indent ? NUTRIENT_BY_KEY[key].label : h('b', null, NUTRIENT_BY_KEY[key].label), ' ', h('span', { class: 'muted' }, fmt(nutrients[key], key))),
        h('span', { class: 'pct' }, pct(key)),
      ),
    ),
  );
}

export function sourceBadge(source) {
  if (source === 'menu') return h('span', { class: 'badge brand' }, '🏛 JHU menu');
  if (source === 'estimate') return h('span', { class: 'badge warn' }, '✨ AI estimate');
  if (source === 'packaged') return h('span', { class: 'badge' }, '📦 Packaged');
  if (source === 'restaurant') return h('span', { class: 'badge brand' }, '🍽 Restaurant');
  return h('span', { class: 'badge' }, '✏️ Custom');
}

export function iconBadges(icons = []) {
  const shown = icons.filter((i) => DIET_ICONS[i]);
  if (!shown.length) return null;
  return h('span', { class: 'icons' }, shown.map((i) => h('span', { class: 'badge', title: i }, `${DIET_ICONS[i]} ${i}`)));
}

function allergens(icons = []) {
  const list = icons.filter((i) => !DIET_ICONS[i]);
  return list.length ? h('div', { class: 'small' }, h('b', null, 'Contains: '), list.join(', ')) : null;
}

/**
 * @param food { name, source, location?, station?, serving?, nutrients, foodId?, description?, ingredients?, icons? }
 * @param opts { entry?, meal?, onDone? }
 */
export function openFoodSheet(food, { entry, meal, onDone } = {}) {
  let servings = entry?.servings ?? 1;
  let chosenMeal = entry?.meal ?? meal ?? state.meal;
  const labelSlot = h('div');
  const drawLabel = () => {
    labelSlot.replaceChildren(nutritionLabel(scaleNutrients(food.nutrients, servings), `${servings} × ${food.serving || 'serving'}`));
  };
  drawLabel();

  const hasNutrition = food.nutrients?.calories != null;

  openSheet({
    title: food.name,
    subtitle: [food.location, food.station].filter(Boolean).join(' · ') || null,
    content: (close) =>
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'row wrap' }, sourceBadge(food.source), iconBadges(food.icons), food.serving ? h('span', { class: 'badge' }, `Serving: ${food.serving}`) : null),
        food.description ? h('div', { class: 'small muted' }, food.description) : null,
        allergens(food.icons),
        food.estimated ? h('div', { class: 'notice small' }, '≈ Typical-dish estimate: USDA average nutrition for this kind of dish, not this restaurant’s own recipe. Adjust servings to match your portion.') : null,
        hasNutrition ? null : h('div', { class: 'notice warn' }, 'JHU Dining hasn’t published nutrition data for this item, so it will count as 0 calories. Consider adding a custom entry with an estimate instead.'),
        h(
          'div',
          { class: 'row wrap', style: { gap: '14px' } },
          h('label', { class: 'field' }, h('span', null, 'Servings'), stepper(servings, (v) => ((servings = v), drawLabel()))),
          h('label', { class: 'field grow' }, h('span', null, 'Meal'), select(MEALS, chosenMeal, (v) => (chosenMeal = v))),
        ),
        labelSlot,
        food.ingredients ? h('details', { class: 'small muted' }, h('summary', null, 'Ingredients'), h('p', null, food.ingredients)) : null,
        h(
          'div',
          { class: 'sheet-actions' },
          entry
            ? [
                h(
                  'button',
                  {
                    class: 'btn danger',
                    onclick: async () => {
                      await api(`/entries/${entry.id}`, { method: 'DELETE' });
                      toast(`Removed ${food.name}`);
                      close();
                      onDone?.();
                    },
                  },
                  'Delete',
                ),
                h(
                  'button',
                  {
                    class: 'btn primary',
                    onclick: async () => {
                      await api(`/entries/${entry.id}`, { method: 'PATCH', body: { servings, meal: chosenMeal } });
                      toast('Saved');
                      close();
                      onDone?.();
                    },
                  },
                  'Save',
                ),
              ]
            : h(
                'button',
                {
                  class: 'btn primary',
                  onclick: async (e) => {
                    e.currentTarget.disabled = true;
                    await logFoods([{ ...food, servings }], chosenMeal);
                    toast(`Added ${food.name} to ${chosenMeal}`);
                    close();
                    onDone?.();
                  },
                },
                'Add to log',
              ),
        ),
      ),
  });
}

/** Persist foods as log entries on the selected date. */
export function logFoods(foods, meal) {
  return api('/entries', {
    method: 'POST',
    body: foods.map((f) => ({
      date: state.date,
      meal,
      name: f.name,
      source: f.source ?? 'custom',
      location: f.location ?? null,
      station: f.station ?? null,
      foodId: f.foodId ?? null,
      serving: f.serving ?? null,
      servings: f.servings ?? 1,
      nutrients: f.nutrients,
      photoId: f.photoId ?? null,
      confidence: f.confidence ?? null,
    })),
  });
}

/** Normalize the different food shapes (menu item, saved food, recent entry) into one. */
export function fromMenuItem(it) {
  return {
    name: it.name,
    source: it.source ?? 'menu',
    estimated: it.estimated ?? false,
    location: it.locationName,
    station: it.station === 'Menu' ? it.menuName : `${it.menuName} · ${it.station}`,
    serving: servingText(it.serving),
    nutrients: it.nutrients,
    foodId: it.foodId,
    description: it.description,
    ingredients: it.ingredients,
    icons: it.icons,
  };
}

export function fromSaved(row) {
  return {
    name: row.name,
    source: row.source ?? 'custom',
    location: row.location ?? null,
    station: row.station ?? null,
    serving: row.serving_desc ?? null,
    nutrients: row.nutrients,
    foodId: row.food_id ?? null,
  };
}

export function servingText(serving) {
  if (serving?.text) return serving.text;
  if (!serving?.amount) return '1 serving';
  const amt = +serving.amount;
  return `${Number.isFinite(amt) ? +amt.toFixed(2) : serving.amount} ${serving.unit ?? ''}`.trim();
}
