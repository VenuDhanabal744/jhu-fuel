// Restaurants within 10 miles of campus (OpenStreetMap) with chain menus or typical
// cuisine dishes (USDA). Rendered inside the Menus tab.

import { api } from '../api.js';
import { h, openSheet, toast } from '../ui.js';
import { openFoodSheet, fromMenuItem } from '../food.js';
import { foodRow } from '../search.js';

const CATEGORIES = [
  ['all', 'All'],
  ['real', '✅ Real menus'],
  ['pizza', '🍕 Pizza'],
  ['burger', '🍔 Burgers'],
  ['chicken', '🍗 Chicken'],
  ['sandwich', '🥪 Sandwiches'],
  ['mexican', '🌯 Mexican & Latin'],
  ['chinese', '🥡 Chinese'],
  ['japanese', '🍣 Japanese'],
  ['asian', '🍜 Thai, Viet & Korean'],
  ['indian', '🍛 Indian'],
  ['mediterranean', '🥙 Mediterranean'],
  ['seafood', '🦀 Seafood'],
  ['american', '🍽 American'],
  ['breakfast', '🥞 Breakfast'],
  ['coffee', '☕ Coffee'],
  ['bakery', '🍩 Donuts & bakery'],
  ['dessert', '🍦 Dessert'],
  ['drinks', '🥤 Smoothies & tea'],
];
const CATEGORY_GROUPS = {
  asian: ['thai', 'vietnamese', 'korean'],
  mexican: ['mexican', 'peruvian', 'caribbean'],
  american: ['american', 'barbecue', 'wings', 'hot_dog', 'salad', 'jhu'],
  bakery: ['donut', 'bagel', 'bakery', 'pretzel'],
  dessert: ['ice_cream'],
  drinks: ['smoothie', 'bubble_tea'],
};
const PAGE = 40;

// Remembered while the app is open, so going back from a restaurant keeps your place.
const ui = { query: '', category: 'all', shown: PAGE, origin: null };

function milesBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(x));
}

const distanceOf = (p) => (ui.origin ? milesBetween(ui.origin, p) : p.dist);
const fmtMiles = (mi) => (mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function describe(p) {
  const cuisine = p.cuisine.length ? p.cuisine.slice(0, 2).map(titleCase).join(', ') : { cafe: 'Café', ice_cream: 'Ice cream', fast_food: 'Fast food', restaurant: 'Restaurant', food_court: 'Food court' }[p.kind];
  return cuisine;
}

function matches(p, q, category) {
  if (category === 'real' && !p.menu.startsWith('chain:') && p.menu !== 'jhu') return false;
  if (category !== 'all' && category !== 'real' && !(CATEGORY_GROUPS[category] ?? [category]).includes(p.cat)) return false;
  if (!q) return true;
  return `${p.name} ${p.cuisine.join(' ')} ${p.address ?? ''}`.toLowerCase().includes(q);
}

function placeRow(p, onPick) {
  const real = p.menu.startsWith('chain:') || p.menu === 'jhu';
  return h(
    'div',
    { class: 'food-row', role: 'button', tabindex: 0, onclick: () => onPick(p), onkeydown: (e) => e.key === 'Enter' && onPick(p) },
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'name' }, p.name, ' ', real ? h('span', { class: 'badge good' }, p.menu === 'jhu' ? 'JHU menu' : '✅ Real menu') : null),
      h('div', { class: 'meta ellipsis' }, [describe(p), p.address].filter(Boolean).join(' · ')),
    ),
    h('div', { class: 'kcal' }, fmtMiles(distanceOf(p)), h('small', null, ui.origin ? 'from you' : 'from campus')),
  );
}

export async function renderList() {
  const places = await api('/restaurants');
  const list = h('div');
  const count = h('div', { class: 'small muted', style: { margin: '10px 2px 8px' } });
  const nearBtn = h('button', { class: `chip ${ui.origin ? 'on' : ''}`, onclick: () => toggleNearMe() }, ui.origin ? '📍 Near me' : '📍 Sort by near me');

  function draw() {
    const q = ui.query.trim().toLowerCase();
    const found = places.filter((p) => matches(p, q, ui.category));
    if (ui.origin) found.sort((a, b) => distanceOf(a) - distanceOf(b));
    count.textContent = `${found.length.toLocaleString()} place${found.length === 1 ? '' : 's'} within 10 miles of campus`;
    list.replaceChildren(
      found.length
        ? h(
            'div',
            { class: 'card', style: { padding: 0, overflow: 'hidden' } },
            found.slice(0, ui.shown).map((p) => placeRow(p, (pl) => (location.hash = `#/menus?r=${pl.id}`))),
          )
        : h('div', { class: 'empty small' }, 'No restaurants match.'),
      found.length > ui.shown
        ? h('button', { class: 'btn block', style: { marginTop: '10px' }, onclick: () => ((ui.shown += PAGE), draw()) }, `Show more (${(found.length - ui.shown).toLocaleString()} left)`)
        : null,
    );
  }

  function toggleNearMe() {
    if (ui.origin) {
      ui.origin = null;
      nearBtn.classList.remove('on');
      nearBtn.textContent = '📍 Sort by near me';
      return draw();
    }
    if (!navigator.geolocation) return toast('Location isn’t available on this device', 'error');
    nearBtn.textContent = '📍 Finding you…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        ui.origin = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        nearBtn.classList.add('on');
        nearBtn.textContent = '📍 Near me';
        draw();
      },
      () => {
        nearBtn.textContent = '📍 Sort by near me';
        toast('Couldn’t get your location — allow it in Settings › Privacy › Location Services.', 'error');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search restaurants or cuisines…',
    value: ui.query,
    oninput: (e) => {
      ui.query = e.target.value;
      ui.shown = PAGE;
      draw();
    },
  });
  const chips = h(
    'div',
    { class: 'chips' },
    nearBtn,
    CATEGORIES.map(([key, label]) =>
      h(
        'button',
        {
          class: `chip ${ui.category === key ? 'on' : ''}`,
          onclick: (e) => {
            ui.category = key;
            ui.shown = PAGE;
            for (const c of chips.querySelectorAll('.chip:not(:first-child)')) c.classList.toggle('on', c === e.currentTarget);
            draw();
          },
        },
        label,
      ),
    ),
  );

  draw();
  return h(
    'div',
    null,
    h('div', { class: 'stack' }, search, chips),
    count,
    list,
    h('p', { class: 'tiny muted', style: { textAlign: 'center', marginTop: '18px' } }, 'Restaurants © OpenStreetMap contributors. Nutrition: USDA FoodData Central.'),
  );
}

export async function renderDetail(ctx, id) {
  const { place: p, menu, items } = await api(`/restaurants/${id}`);
  const maps = `https://maps.apple.com/?q=${encodeURIComponent(p.name)}&ll=${p.lat},${p.lon}`;
  const root = h(
    'div',
    { class: 'stack' },
    h('button', { class: 'btn ghost small', onclick: () => (location.hash = '#/menus?mode=restaurants') }, '‹ All restaurants'),
    h(
      'div',
      { class: 'card stack' },
      h('div', null, h('h1', { class: 'page-title', style: { margin: 0 } }, p.name), h('div', { class: 'muted small' }, [describe(p), `${fmtMiles(distanceOf(p))} ${ui.origin ? 'from you' : 'from campus'}`].join(' · '))),
      p.address ? h('div', { class: 'small' }, '📍 ', p.address) : null,
      p.hours ? h('div', { class: 'small' }, '🕒 ', p.hours.replace(/;\s*/g, ' · ')) : null,
      h(
        'div',
        { class: 'row wrap' },
        h('a', { class: 'btn small', href: maps, target: '_blank', rel: 'noopener' }, '🧭 Directions'),
        p.website ? h('a', { class: 'btn small', href: p.website, target: '_blank', rel: 'noopener' }, '🌐 Website') : null,
        p.phone ? h('a', { class: 'btn small', href: `tel:${p.phone.replace(/[^\d+]/g, '')}` }, '📞 Call') : null,
      ),
    ),
  );

  if (p.menu === 'jhu') {
    root.append(h('div', { class: 'notice' }, 'This is a JHU dining location — its real daily menu is under JHU Dining.'), h('button', { class: 'btn primary block', onclick: () => (location.hash = '#/menus?mode=jhu') }, '🏛 Open JHU Dining menus'));
    return root;
  }

  root.append(
    menu?.kind === 'chain'
      ? h('div', { class: 'notice small' }, `✅ Nutrition from the USDA’s lab analysis of ${menu.name} food. Chains change their menus — if your item isn’t here, use Search, Barcode or Custom.`)
      : h('div', { class: 'notice warn small' }, `≈ We couldn’t find ${p.name}’s own nutrition info, so here are dishes a ${menu?.name.replace(/^Typical /, '') ?? 'restaurant'} typically serves, with USDA average nutrition. Pick the closest one and adjust servings.`),
    h(
      'button',
      {
        class: 'btn block',
        onclick: () => {
          localStorage.setItem('snap.location', `rest:${p.id}`);
          localStorage.setItem('snap.locationName', p.name);
          ctx.go('snap');
        },
      },
      '📷 Snap my plate here',
    ),
  );

  const sections = new Map();
  for (const it of items) {
    if (!sections.has(it.station)) sections.set(it.station, []);
    sections.get(it.station).push(it);
  }
  const meal = ctx.state.meal;
  for (const [name, list] of sections) {
    root.append(
      h(
        'details',
        { class: 'card station', open: true },
        h('summary', null, h('span', null, sections.size > 1 ? name : 'Menu', ' ', h('span', { class: 'muted small' }, `(${list.length})`))),
        list.map((it) => {
          const food = fromMenuItem(it);
          return foodRow(food, () => openFoodSheet(food, { meal }), { compact: true });
        }),
      ),
    );
  }
  return root;
}

/** Sheet to pick a restaurant (used by Snap). Calls onPick(place). */
export async function openRestaurantPicker(onPick) {
  const places = await api('/restaurants');
  const list = h('div');
  const draw = (q) => {
    const found = places.filter((p) => matches(p, q.trim().toLowerCase(), 'all') && p.menu !== 'jhu').slice(0, 40);
    list.replaceChildren(
      found.length
        ? h('div', { class: 'card', style: { padding: 0, overflow: 'hidden', marginTop: '10px' } }, found.map((p) => placeRow(p, choose)))
        : h('div', { class: 'empty small' }, 'No restaurants match.'),
    );
  };
  let close;
  const choose = (p) => {
    close();
    onPick(p);
  };
  ({ close } = openSheet({
    title: 'Where are you eating?',
    subtitle: 'Closest to campus first',
    content: h('div', null, h('input', { class: 'input', type: 'search', placeholder: 'Search restaurants…', oninput: (e) => draw(e.target.value) }), list),
  }));
  draw('');
}
