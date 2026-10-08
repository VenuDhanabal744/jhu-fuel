import { api } from '../api.js';
import { h, seg, fmtDate, defaultMeal } from '../ui.js';
import { openFoodSheet, fromMenuItem } from '../food.js';
import { foodRow } from '../search.js';

const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'late-night', 'all-day'];
const DIET_FILTERS = [
  ['all', 'All'],
  ['Vegan', '🌱 Vegan'],
  ['Vegetarian', '🥕 Vegetarian'],
  ['protein', '💪 20g+ protein'],
];

function pickMenu(menus, preferredSlug) {
  const byPref = menus.find((m) => m.menu === preferredSlug);
  if (byPref) return byPref;
  const meal = defaultMeal();
  return menus.find((m) => m.meal === meal) ?? menus.find((m) => m.meal === 'all-day') ?? menus[0];
}

export async function render(ctx) {
  const { state } = ctx;
  const index = await api(`/menus?date=${state.date}`);
  const root = h('div');
  root.append(h('h1', { class: 'page-title' }, `🏛 JHU Dining · ${fmtDate(state.date, 'relative')}`));

  if (!index.length) {
    root.append(h('div', { class: 'empty' }, h('span', { class: 'ico' }, '🍽'), 'No menus published for this day yet. Menus usually appear a week or two ahead.'));
    return root;
  }

  const locations = [...new Map(index.map((m) => [m.location, m.locationName]))];
  let loc = localStorage.getItem('menus.location');
  if (!locations.some(([slug]) => slug === loc)) loc = locations[0][0];
  let menuSlug = localStorage.getItem('menus.menu');
  let filter = '';
  let diet = 'all';

  const locChips = h('div', { class: 'chips' });
  const menuSeg = h('div');
  const body = h('div');
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter this menu…',
    oninput: (e) => {
      filter = e.target.value.trim().toLowerCase();
      drawBody();
    },
  });

  let currentMenu = null;
  let loadSeq = 0;

  function drawLocations() {
    locChips.replaceChildren(
      ...locations.map(([slug, name]) =>
        h(
          'button',
          {
            class: `chip ${slug === loc ? 'on' : ''}`,
            onclick: () => {
              loc = slug;
              localStorage.setItem('menus.location', slug);
              drawLocations();
              drawMenus();
            },
          },
          name,
        ),
      ),
    );
  }

  function drawMenus() {
    const menus = index.filter((m) => m.location === loc).sort((a, b) => MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal));
    const chosen = pickMenu(menus, menuSlug);
    menuSlug = chosen.menu;
    menuSeg.replaceChildren(
      menus.length > 1
        ? seg(
            menus.map((m) => [m.menu, m.menuName.replace(new RegExp(`^${m.locationName}\\s*`, 'i'), '').replace(/^Nolan's\s*|^Peabody\s*/i, '') || m.menuName]),
            menuSlug,
            (v) => {
              menuSlug = v;
              localStorage.setItem('menus.menu', v);
              loadMenu();
            },
          )
        : h('div', { class: 'small muted' }, chosen.menuName),
    );
    loadMenu();
  }

  async function loadMenu() {
    const seq = ++loadSeq;
    body.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
    let menu;
    try {
      menu = await api(`/menu?date=${state.date}&location=${loc}&menu=${menuSlug}`);
    } catch (err) {
      if (seq === loadSeq) body.replaceChildren(h('div', { class: 'empty small' }, err.message));
      return;
    }
    if (seq !== loadSeq) return;
    currentMenu = menu;
    drawBody();
  }

  function matches(it) {
    if (filter && !`${it.name} ${it.description}`.toLowerCase().includes(filter)) return false;
    if (diet === 'protein') return (it.nutrients.g_protein ?? 0) >= 20;
    if (diet !== 'all') return it.icons.includes(diet) || (diet === 'Vegetarian' && it.icons.includes('Vegan'));
    return true;
  }

  function drawBody() {
    if (!currentMenu) return;
    const mealForLog = ['breakfast', 'lunch', 'dinner'].includes(currentMenu.meal) ? currentMenu.meal : state.meal;
    const stations = currentMenu.stations
      .map((st) => ({ ...st, items: st.items.filter(matches) }))
      .filter((st) => st.items.length);
    if (!stations.length) {
      body.replaceChildren(h('div', { class: 'empty small' }, 'Nothing matches that filter.'));
      return;
    }
    body.replaceChildren(
      ...stations.map((st) =>
        h(
          'details',
          { class: 'card station', open: true },
          h('summary', null, h('span', null, st.name, ' ', h('span', { class: 'muted small' }, `(${st.items.length})`))),
          st.items.map((it) => {
            const food = fromMenuItem({ ...it, locationName: currentMenu.locationName, menuName: currentMenu.menuName, station: st.name });
            return foodRow(food, () => openFoodSheet(food, { meal: mealForLog }), { compact: true });
          }),
        ),
      ),
    );
  }

  root.append(
    h(
      'div',
      { class: 'menu-toolbar' },
      locChips,
      menuSeg,
      h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: { minWidth: '200px' } }, search), seg(DIET_FILTERS, diet, (v) => ((diet = v), drawBody()))),
    ),
    body,
    h('p', { class: 'tiny muted', style: { textAlign: 'center', marginTop: '18px' } }, 'Menus & nutrition from JHU Dining (hopkinsdining.nutrislice.com). Refreshed every few hours.'),
  );
  drawLocations();
  drawMenus();
  return root;
}
