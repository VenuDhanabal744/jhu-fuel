import { api } from './api.js';
import { h, openSheet } from './ui.js';
import { fmt } from './nutrients.js';
import { fromMenuItem, fromSaved, iconBadges } from './food.js';

/** Search today's JHU menus + saved foods + recent foods. Returns normalized foods with a group tag. */
export async function searchFoods(date, q, signal) {
  const res = await api(`/search?date=${date}&q=${encodeURIComponent(q)}`, { signal });
  return [
    ...res.menu.map((it) => ({ ...fromMenuItem(it), group: 'Today’s JHU menus' })),
    ...(res.restaurants ?? []).map((it) => ({ ...fromMenuItem(it), group: 'Restaurant dishes' })),
    ...res.custom.map((f) => ({ ...fromSaved(f), source: 'custom', group: 'My foods' })),
    ...res.recent.map((f) => ({ ...fromSaved(f), group: 'Recently logged' })),
  ];
}

export function foodRow(food, onPick, { compact = false } = {}) {
  const n = food.nutrients ?? {};
  return h(
    'div',
    { class: 'food-row', role: 'button', tabindex: 0, onclick: () => onPick(food), onkeydown: (e) => e.key === 'Enter' && onPick(food) },
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'name' }, food.name, ' ', iconBadges(food.icons)),
      h('div', { class: 'meta ellipsis' }, (compact ? [food.serving] : [food.serving, food.location, food.station?.split(' · ').pop()]).filter(Boolean).join(' · ')),
    ),
    h(
      'div',
      { class: 'kcal' },
      n.calories == null ? '—' : fmt(n.calories, 'calories'),
      h('small', null, n.calories == null ? 'no data' : `${Math.round(n.g_protein ?? 0)}P ${Math.round(n.g_carbs ?? 0)}C ${Math.round(n.g_fat ?? 0)}F`),
    ),
    h('span', { class: 'add-dot', 'aria-hidden': 'true' }, '+'),
  );
}

export function groupedResults(foods, onPick) {
  if (!foods.length) return h('div', { class: 'empty small' }, 'No matches. Try a different word, or add a custom food.');
  const groups = new Map();
  for (const f of foods) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  return h(
    'div',
    null,
    [...groups].map(([name, list]) =>
      h('div', null, h('div', { class: 'section-title', style: { marginTop: '12px' } }, name), h('div', { class: 'card', style: { padding: 0, overflow: 'hidden' } }, list.map((f) => foodRow(f, onPick)))),
    ),
  );
}

/** A live search box. Returns { node, focus }. */
export function searchBox(date, onPick, { placeholder = 'Search today’s menus, your foods…', empty } = {}) {
  const results = h('div');
  let ctrl;
  let timer;
  const run = async (q) => {
    ctrl?.abort();
    if (!q.trim()) {
      results.replaceChildren(empty ? await empty() : '');
      return;
    }
    ctrl = new AbortController();
    results.replaceChildren(h('div', { class: 'skeleton' }));
    try {
      results.replaceChildren(groupedResults(await searchFoods(date, q, ctrl.signal), onPick));
    } catch (err) {
      if (err.name !== 'AbortError') results.replaceChildren(h('div', { class: 'empty small' }, err.message));
    }
  };
  const input = h('input', {
    class: 'input',
    type: 'search',
    placeholder,
    autocomplete: 'off',
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => run(e.target.value), 220);
    },
  });
  run('');
  return { node: h('div', null, input, results), focus: () => input.focus() };
}

export function openSearchPicker(date, onPick) {
  openSheet({
    title: 'Add an item',
    subtitle: 'Search what JHU dining is serving today',
    content: (close) =>
      searchBox(date, (food) => {
        close();
        onPick(food);
      }).node,
  });
}
