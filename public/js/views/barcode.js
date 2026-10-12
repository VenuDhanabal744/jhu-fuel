// The Add › Barcode tab: live scanning, scanning several items into a basket, product
// details (portions, Nutri-Score, ingredients, how it fits your day), comparing products
// and recent scans.

import { api } from '../api.js';
import { h, seg, toast, openSheet, stepper, photoButtons, busy } from '../ui.js';
import { NUTRIENT_BY_KEY, scaleNutrients, sumNutrients, fmt } from '../nutrients.js';
import { openFoodSheet, logFoods } from '../food.js';
import { openScanner, cameraAvailable } from '../scanner.js';
import { withBrand } from '../barcode.js';
import { state } from '../app.js';

// Kept while the app is open, so switching tabs doesn't lose them.
const compare = []; // [{ code, product }]
const basket = []; // [{ code, product, status: 'loading' | 'ok' | 'missing' | 'error', servings }]
const COMPARE_MAX = 4;

const displayName = (p) => withBrand(p.name, p.brand);
const round = (v) => (v == null ? '—' : Math.round(v).toLocaleString());

/** The product as a food to log, for a portion ({ serving, nutrients }). */
function toFood(product, portion = { serving: product.serving, nutrients: product.nutrients }) {
  const diet = product.diet ?? {};
  const icons = [diet.vegan && 'Vegan', !diet.vegan && diet.vegetarian && 'Vegetarian', ...(product.allergens ?? []).map((a) => a[0].toUpperCase() + a.slice(1))].filter(Boolean);
  return { name: displayName(product), source: 'packaged', serving: portion.serving, nutrients: portion.nutrients, ingredients: product.ingredients ?? null, icons };
}

function productImage(product, small = false) {
  return product?.image
    ? h('img', { class: `product-img ${small ? 'small' : ''}`, src: product.image, alt: '', loading: 'lazy' })
    : h('div', { class: `product-img empty ${small ? 'small' : ''}`, 'aria-hidden': 'true' }, '📦');
}

function scoreBadges(product) {
  const out = [];
  if (product.nutriscore) out.push(h('span', { class: 'score', title: 'Nutri-Score: A (best) to E' }, h('b', { class: product.nutriscore }, product.nutriscore), 'Nutri-Score'));
  if (product.nova) {
    const text = ['', 'Unprocessed', 'Processed ingredient', 'Processed', 'Ultra-processed'][product.nova];
    out.push(h('span', { class: 'score', title: 'NOVA food processing group, 1 to 4' }, h('b', { class: `n${product.nova}` }, product.nova), text));
  }
  const d = product.diet ?? {};
  if (d.vegan) out.push(h('span', { class: 'badge good' }, '🌱 Vegan'));
  else if (d.vegetarian) out.push(h('span', { class: 'badge good' }, '🥕 Vegetarian'));
  if (d.palmOil) out.push(h('span', { class: 'badge' }, 'Contains palm oil'));
  if (product.savedId) out.push(h('span', { class: 'badge brand' }, '⭐ In My foods'));
  return out.length ? h('div', { class: 'row wrap', style: { gap: '10px' } }, out) : null;
}

function macroLine(n) {
  const item = (v, label, key) => h('span', null, `${key === 'calories' ? round(v) : fmt(v, key)} `, h('small', null, label));
  return h(
    'div',
    { class: 'macro-line' },
    item(n.calories, 'kcal', 'calories'),
    item(n.g_protein, 'protein', 'g_protein'),
    item(n.g_carbs, 'carbs', 'g_carbs'),
    item(n.g_fat, 'fat', 'g_fat'),
  );
}

// ---------- how a portion fits today's goals ----------

const LIMITS = ['mg_sodium', 'g_added_sugar', 'g_saturated_fat', 'g_trans_fat', 'mg_cholesterol'];
const GOODS = ['g_protein', 'g_fiber', 'mg_calcium', 'mg_iron', 'mg_potassium', 'mcg_vitamin_d', 'mg_vitamin_c', 'mcg_vitamin_a'];

async function fitLines(nutrients) {
  const sum = await api(`/summary?from=${state.date}&to=${state.date}`);
  const totals = sum.days[0]?.totals ?? {};
  const targets = sum.targets ?? {};
  const lines = [];
  const kcalGoal = targets.calories?.value;
  if (kcalGoal && nutrients.calories != null) {
    const after = (totals.calories ?? 0) + nutrients.calories;
    const left = kcalGoal - (totals.calories ?? 0);
    lines.push([
      after > kcalGoal ? '⚠️' : '🎯',
      after > kcalGoal
        ? `Puts you at ${round(after)} of ${round(kcalGoal)} kcal today — ${round(after - kcalGoal)} over your goal.`
        : `${Math.round((nutrients.calories / Math.max(left, 1)) * 100)}% of the ${round(left)} kcal you have left today.`,
    ]);
  }
  for (const key of LIMITS) {
    const t = targets[key];
    const v = nutrients[key];
    if (!t?.value || !v) continue;
    const pct = v / t.value;
    const over = (totals[key] ?? 0) + v > t.value;
    if (pct >= 0.2 || over) {
      const label = NUTRIENT_BY_KEY[key].label.toLowerCase();
      lines.push(['🧂', `High in ${label}: ${Math.round(pct * 100)}% of your daily limit${over ? ' — it would put you over today' : ''}.`]);
    }
  }
  const goods = GOODS.map((key) => [key, targets[key]?.value ? (nutrients[key] ?? 0) / targets[key].value : 0])
    .filter(([, pct]) => pct >= 0.1)
    .sort((a, b) => b[1] - a[1]);
  for (const [key, pct] of goods.slice(0, 3)) {
    lines.push(['💪', `${pct >= 0.2 ? 'Excellent' : 'Good'} source of ${NUTRIENT_BY_KEY[key].label.toLowerCase()}: ${Math.round(pct * 100)}% of your daily goal.`]);
  }
  if (lines.length < 2) lines.push(['👍', 'Nothing else stands out against your daily targets.']);
  return lines;
}

// ---------- product card ----------

function portionOptions(p) {
  const unit = p.unit ?? 'g';
  const serving = p.serving || '1 serving';
  const label = /^[\d.]+\s*(g|ml)$/i.test(serving)
    ? `1 serving (${serving})`
    : p.servingGrams && !/\d\s*(g|ml)\b/i.test(serving)
    ? `${serving} (${round(p.servingGrams)} ${unit})`
    : serving;
  const opts = [['serving', label]];
  if (p.per100 && p.servingGrams !== 100) opts.push(['100', `100 ${unit}`]);
  if (p.per100 && p.packageGrams && Math.abs(p.packageGrams - (p.servingGrams ?? 0)) > 1) opts.push(['package', `Whole package (${round(p.packageGrams)} ${unit})`]);
  if (p.per100) opts.push(['custom', 'Custom']);
  return opts;
}

function portionOf(p, kind, grams) {
  const unit = p.unit ?? 'g';
  if (kind === '100') return { serving: `100 ${unit}`, nutrients: p.per100 };
  if (kind === 'package') return { serving: `1 package (${round(p.packageGrams)} ${unit})`, nutrients: scaleNutrients(p.per100, p.packageGrams / 100) };
  if (kind === 'custom') return { serving: `${round(grams)} ${unit}`, nutrients: scaleNutrients(p.per100, grams / 100) };
  return { serving: p.serving, nutrients: p.nutrients };
}

function productCard(ctx, code, product, { switchTab, onCompare }) {
  const done = () => ctx.go('today');
  const opts = portionOptions(product);
  let kind = 'serving';
  let grams = product.servingGrams ?? 100;
  const macros = h('div');
  const fit = h('div', { class: 'fit' });
  const gramsInput = h('input', {
    class: 'input',
    type: 'number',
    inputmode: 'decimal',
    min: 1,
    step: 'any',
    value: grams,
    'aria-label': `Amount in ${product.unit ?? 'g'}`,
    oninput: (e) => {
      grams = +e.target.value || 0;
      if (grams > 0) draw();
    },
  });
  const gramsRow = h('label', { class: 'field hidden' }, h('span', null, `Amount (${product.unit ?? 'g'})`), gramsInput);
  let fitSeq = 0;

  const portion = () => portionOf(product, kind, grams);
  function draw() {
    const { nutrients } = portion();
    macros.replaceChildren(
      macroLine(nutrients),
      h('div', { class: 'small muted', style: { marginTop: '4px' } }, `Sugar ${fmt(nutrients.g_sugar, 'g_sugar')} · Fiber ${fmt(nutrients.g_fiber, 'g_fiber')} · Sodium ${fmt(nutrients.mg_sodium, 'mg_sodium')}`),
    );
    const seq = ++fitSeq;
    fitLines(nutrients)
      .then((lines) => seq === fitSeq && fit.replaceChildren(...lines.map(([ico, text]) => h('div', null, h('span', { 'aria-hidden': 'true' }, ico), h('span', null, text)))))
      .catch(() => fit.replaceChildren());
  }
  draw();

  const actions = h(
    'div',
    { class: 'stack', style: { gap: '8px' } },
    h('button', { class: 'btn primary block', onclick: () => openFoodSheet(toFood(product, portion()), { onDone: done }) }, 'Add to log…'),
    h(
      'div',
      { class: 'row' },
      product.savedId
        ? null
        : h(
            'button',
            {
              class: 'btn grow',
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              await api('/foods', { method: 'POST', body: { ...toFood(product), barcode: code } });
              toast('Saved to My foods');
            },
          },
            '⭐ Save',
          ),
      h('button', { class: 'btn grow', onclick: () => onCompare(code, product) }, '⚖️ Compare'),
    ),
  );

  return h(
    'div',
    { class: 'card stack' },
    h(
      'div',
      { class: 'product-head' },
      productImage(product),
      h('div', { class: 'grow' }, h('h2', null, product.name), h('div', { class: 'small muted' }, [product.brand && !product.name.toLowerCase().includes(product.brand.toLowerCase()) ? product.brand : null, product.database, code].filter(Boolean).join(' · '))),
    ),
    scoreBadges(product),
    opts.length > 1
      ? h(
          'div',
          { class: 'stack', style: { gap: '8px' } },
          seg(opts, kind, (v) => {
            kind = v;
            gramsRow.classList.toggle('hidden', v !== 'custom');
            if (v === 'custom') gramsInput.focus();
            draw();
          }),
          gramsRow,
        )
      : h('div', { class: 'small muted' }, `Per ${product.serving}`),
    macros,
    h('div', { class: 'notice small', style: { margin: 0 } }, h('div', { class: 'small', style: { fontWeight: 700, marginBottom: '6px' } }, 'How it fits your day'), fit),
    product.allergens?.length ? h('div', { class: 'small' }, h('b', null, 'Contains: '), product.allergens.join(', ')) : null,
    product.ingredients ? h('details', { class: 'small muted' }, h('summary', null, 'Ingredients'), h('p', null, product.ingredients)) : null,
    actions,
    h(
      'div',
      { class: 'tiny muted' },
      'Community databases can have mistakes. ',
      h(
        'a',
        {
          href: '#',
          onclick: (e) => {
            e.preventDefault();
            switchTab('custom', {
              barcode: code,
              name: displayName(product),
              serving: product.serving,
              nutrients: product.nutrients,
              notice: ['', 'Fix anything that’s wrong. Your version is saved with this barcode, so future scans use it.'],
            });
          },
        },
        'Fix the numbers',
      ),
      ' · ',
      h('a', { href: '#', onclick: (e) => (e.preventDefault(), switchTab('label', { barcode: code })) }, 'Scan the label instead'),
    ),
  );
}

function notFoundCard(code, switchTab) {
  return h(
    'div',
    { class: 'card stack' },
    h('div', null, h('b', null, `Barcode ${code} isn’t in the food databases yet.`), h('div', { class: 'small muted' }, 'Scan its Nutrition Facts label instead — it’ll be saved with this barcode, so next time the scan finds it instantly.')),
    h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => switchTab('label', { barcode: code }) }, '🏷️ Scan the label'), h('button', { class: 'btn', onclick: () => switchTab('custom', { barcode: code }) }, '✏️ Type it in')),
  );
}

// ---------- compare ----------

const COMPARE_ROWS = [
  ['calories', null],
  ['g_protein', 'high'],
  ['g_carbs', null],
  ['g_fiber', 'high'],
  ['g_sugar', 'low'],
  ['g_added_sugar', 'low'],
  ['g_fat', null],
  ['g_saturated_fat', 'low'],
  ['mg_sodium', 'low'],
];

function openCompare(onChange) {
  const per100 = compare.every((c) => c.product.per100);
  let basis = per100 ? '100' : 'serving';
  const table = h('div', { class: 'compare-wrap' });
  const draw = () => {
    const cols = compare.map(({ product }) => (basis === '100' ? product.per100 : product.nutrients));
    const row = (label, values, better, fmtFn) => {
      const nums = values.filter((v) => v != null);
      const best = better && nums.length > 1 ? (better === 'high' ? Math.max(...nums) : Math.min(...nums)) : null;
      const allSame = nums.every((v) => v === nums[0]);
      return h('tr', null, h('td', null, label), values.map((v) => h('td', { class: best != null && !allSame && v === best ? 'best' : '' }, fmtFn(v))));
    };
    table.replaceChildren(
      h(
        'table',
        { class: 'compare-table' },
        h('thead', null, h('tr', null, h('th', null, ''), compare.map(({ product }) => h('th', null, productImage(product, true), h('div', null, product.name))))),
        h(
          'tbody',
          null,
          basis === 'serving' ? h('tr', null, h('td', null, 'Serving'), compare.map(({ product }) => h('td', null, product.serving))) : null,
          COMPARE_ROWS.map(([key, better]) => row(NUTRIENT_BY_KEY[key].label, cols.map((n) => n?.[key] ?? null), better, (v) => (key === 'calories' ? round(v) : fmt(v, key)))),
          row('Protein per 100 kcal', cols.map((n) => (n?.calories ? ((n.g_protein ?? 0) / n.calories) * 100 : null)), 'high', (v) => (v == null ? '—' : `${v.toFixed(1)} g`)),
          h('tr', null, h('td', null, 'Nutri-Score'), compare.map(({ product }) => h('td', null, product.nutriscore ? h('span', { class: 'score' }, h('b', { class: product.nutriscore }, product.nutriscore)) : '—'))),
          h('tr', null, h('td', null, 'Processing'), compare.map(({ product }) => h('td', null, product.nova ? `NOVA ${product.nova}` : '—'))),
        ),
      ),
    );
  };
  draw();
  openSheet({
    title: 'Compare products',
    subtitle: 'Green = better for that nutrient',
    content: (close) =>
      h(
        'div',
        { class: 'stack' },
        per100
          ? seg(
              [
                ['100', 'Per 100 g'],
                ['serving', 'Per serving'],
              ],
              basis,
              (v) => ((basis = v), draw()),
              'full',
            )
          : h('div', { class: 'small muted' }, 'Per serving (some products don’t list per-100 g values).'),
        table,
        h(
          'div',
          { class: 'sheet-actions' },
          h('button', { class: 'btn', onclick: () => (compare.splice(0), onChange(), close()) }, 'Clear'),
          h('button', { class: 'btn primary', onclick: close }, 'Done'),
        ),
      ),
  });
}

// ---------- the tab ----------

export function barcodeTab(ctx, _extra, switchTab) {
  const out = h('div');
  const tray = h('div');
  const basketSlot = h('div');
  const historySlot = h('div');
  const done = () => ctx.go('today');

  function drawTray() {
    tray.replaceChildren(
      compare.length
        ? h(
            'div',
            { class: 'card row', style: { gap: '10px' } },
            h('div', { class: 'grow small' }, h('b', null, `⚖️ Comparing ${compare.length}: `), compare.map((c) => c.product.name).join(' · ')),
            compare.length > 1 ? h('button', { class: 'btn primary small', onclick: () => openCompare(drawTray) }, 'View') : h('span', { class: 'tiny muted' }, 'Scan another to compare'),
            h('button', { class: 'icon-btn', 'aria-label': 'Clear comparison', onclick: () => (compare.splice(0), drawTray()) }, '✕'),
          )
        : '',
    );
  }

  const addToCompare = (code, product) => {
    if (!compare.some((c) => c.code === code)) {
      if (compare.length >= COMPARE_MAX) compare.shift();
      compare.push({ code, product });
    }
    drawTray();
    if (compare.length > 1) openCompare(drawTray);
    else toast('Added — now scan or look up another product to compare');
  };

  const show = (code, product) => {
    out.replaceChildren(product ? productCard(ctx, code, product, { switchTab, onCompare: addToCompare }) : notFoundCard(code, switchTab));
    drawHistory();
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const lookup = async (request) => {
    out.replaceChildren(busy('Looking it up…'));
    try {
      const { code, product } = await request();
      show(code, product);
    } catch (err) {
      out.replaceChildren(h('div', { class: 'notice warn' }, err.message));
    }
  };

  // ----- live scanning -----

  async function scanOne() {
    try {
      await openScanner({ onCode: (code) => lookup(() => api(`/barcode/${code}`)) });
    } catch (err) {
      toast(err.message, 'error');
      other.open = true;
    }
  }

  async function scanMany() {
    try {
      await openScanner({
        multi: true,
        title: 'Scan each item',
        onCode: async (code) => {
          let item = basket.find((b) => b.code.replace(/^0+/, '') === code.replace(/^0+/, ''));
          if (item) {
            item.servings += 1;
            drawBasket();
            return `${item.product ? item.product.name : code} ×${item.servings}`;
          }
          item = { code, product: null, status: 'loading', servings: 1 };
          basket.push(item);
          drawBasket();
          try {
            const { product } = await api(`/barcode/${code}`);
            Object.assign(item, { product, status: product ? 'ok' : 'missing' });
          } catch {
            item.status = 'error';
          }
          drawBasket();
          return item.product ? item.product.name : 'Not in the databases — you can add it after';
        },
        onClose: () => {
          drawBasket();
          drawHistory();
          basketSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      });
    } catch (err) {
      toast(err.message, 'error');
      other.open = true;
    }
  }

  function drawBasket() {
    if (!basket.length) return basketSlot.replaceChildren();
    const ok = basket.filter((b) => b.status === 'ok');
    const totals = sumNutrients(ok.map((b) => scaleNutrients(b.product.nutrients, b.servings)));
    basketSlot.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'row' }, h('h2', { class: 'grow' }, `🛒 Scanned items (${basket.length})`), h('button', { class: 'btn ghost small', onclick: () => (basket.splice(0), drawBasket()) }, 'Clear')),
        h(
          'div',
          null,
          basket.map((b) =>
            h(
              'div',
              { class: 'basket-row' },
              productImage(b.product, true),
              h(
                'div',
                { class: 'grow', style: { minWidth: 0 } },
                h('div', { class: 'ellipsis', style: { fontWeight: 600 } }, b.product ? displayName(b.product) : `Barcode ${b.code}`),
                b.status === 'ok'
                  ? h('div', { class: 'small muted' }, `${round(b.product.nutrients.calories * b.servings)} kcal`)
                  : b.status === 'loading'
                  ? h('div', { class: 'small muted' }, 'Looking it up…')
                  : h('a', { class: 'small', href: '#', onclick: (e) => (e.preventDefault(), switchTab('label', { barcode: b.code })) }, b.status === 'missing' ? 'Not found — scan its label' : 'Couldn’t look it up — try the label'),
              ),
              b.status === 'ok' ? stepper(b.servings, (v) => ((b.servings = v), drawBasket()), { step: 0.5, min: 0.5 }) : null,
              h('button', { class: 'icon-btn', 'aria-label': 'Remove', onclick: () => (basket.splice(basket.indexOf(b), 1), drawBasket()) }, '✕'),
            ),
          ),
        ),
        ok.length ? h('div', { class: 'small' }, h('b', null, 'Total: '), `${round(totals.calories)} kcal · ${fmt(totals.g_protein, 'g_protein')} protein · ${fmt(totals.g_carbs, 'g_carbs')} carbs · ${fmt(totals.g_fat, 'g_fat')} fat`) : null,
        h(
          'div',
          { class: 'row wrap' },
          h(
            'button',
            {
              class: 'btn primary grow',
              disabled: !ok.length,
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                await logFoods(ok.map((b) => ({ ...toFood(b.product), servings: b.servings })), state.meal);
                toast(`Added ${ok.length} item${ok.length === 1 ? '' : 's'} to ${state.meal}`);
                basket.splice(0);
                done();
              },
            },
            `Add ${ok.length || ''} to ${state.meal}`,
          ),
          h('button', { class: 'btn', onclick: scanMany }, '＋ Scan more'),
        ),
      ),
    );
  }

  // ----- recent scans -----

  async function drawHistory() {
    const list = (await api('/barcode-history')).slice(0, 12);
    if (!list.length) return historySlot.replaceChildren();
    const ago = (t) => {
      const m = Math.round((Date.now() - t) / 60000);
      return m < 60 ? `${Math.max(m, 1)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
    };
    historySlot.replaceChildren(
      h(
        'details',
        { class: 'card station', open: true },
        h('summary', null, h('span', null, '🕘 Recent scans')),
        list.map((x) =>
          h(
            'div',
            { class: 'food-row', role: 'button', tabindex: 0, onclick: () => lookup(() => api(`/barcode/${x.code}`)) },
            productImage(x, true),
            h(
              'div',
              { class: 'grow', style: { minWidth: 0 } },
              h('div', { class: 'name ellipsis' }, x.name ? withBrand(x.name, x.brand) : `Unknown product (${x.code})`),
              h('div', { class: 'meta ellipsis' }, [x.calories != null ? `${round(x.calories)} kcal per ${x.serving}` : 'Not in the databases', ago(x.at)].join(' · ')),
            ),
            h(
              'button',
              {
                class: 'icon-btn',
                'aria-label': 'Remove from recent scans',
                onclick: async (e) => {
                  e.stopPropagation();
                  await api(`/barcode-history/${x.code}`, { method: 'DELETE' });
                  drawHistory();
                },
              },
              '✕',
            ),
          ),
        ),
      ),
    );
  }

  // ----- layout -----

  const digits = h('input', { class: 'input', inputmode: 'numeric', placeholder: 'Type the numbers under the barcode', pattern: '[0-9 ]*', 'aria-label': 'Barcode number' });
  const manual = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        const code = digits.value.replace(/\D/g, '');
        if (code.length < 8) return toast('A barcode is 8–14 digits', 'error');
        digits.blur();
        lookup(() => api(`/barcode/${code}`));
      },
    },
    h('div', { class: 'grow' }, digits),
    h('button', { class: 'btn' }, 'Look up'),
  );
  const photo = photoButtons('📸 Take photo', 1600, (image) => lookup(() => api('/barcode', { method: 'POST', body: { image } })), { compact: true });
  const live = cameraAvailable();
  const other = h('details', { open: !live }, h('summary', { class: 'small', style: { cursor: 'pointer', fontWeight: 600 } }, 'Other ways: photo or type the number'), h('div', { class: 'stack', style: { marginTop: '10px' } }, photo, manual));

  drawTray();
  drawBasket();
  drawHistory();
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'small muted' }, 'Point your camera at the barcode on any packaged food or drink — chips, cereal, protein bars, bottled drinks, Bento Sushi boxes. Nutrition comes from Open Food Facts and the USDA (free).'),
      live ? h('button', { type: 'button', class: 'btn primary big block', onclick: scanOne }, '📷 Scan a barcode') : null,
      live ? h('button', { type: 'button', class: 'btn block', onclick: scanMany }, '🛒 Scan several items') : null,
      other,
    ),
    basketSlot,
    out,
    tray,
    historySlot,
  );
}
