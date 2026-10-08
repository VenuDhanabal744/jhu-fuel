import { api } from '../api.js';
import { h, seg, toast, MEALS, fmtDate } from '../ui.js';
import { NUTRIENTS } from '../nutrients.js';
import { openFoodSheet, fromSaved, logFoods } from '../food.js';
import { searchBox, groupedResults } from '../search.js';
import { renderReview } from '../review.js';
import { prepareImage } from '../image.js';

export async function render(ctx) {
  const { state } = ctx;
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let tab = params.get('tab') || 'search';

  const root = h('div');
  const panel = h('div', { style: { marginTop: '14px' } });

  const tabs = h('div');
  // `extra` carries data between tabs, e.g. a barcode that wasn't found -> label scan.
  const draw = (extra) => {
    tabs.replaceChildren(
      seg(
        [
          ['search', '🔍 Search'],
          ['barcode', '📦 Barcode'],
          ['label', '🏷️ Label'],
          ['describe', '📝 Describe'],
          ['custom', '✏️ Custom'],
        ],
        tab,
        (v) => {
          tab = v;
          draw();
        },
      ),
    );
    const fn = { search: searchTab, barcode: barcodeTab, label: labelTab, describe: describeTab, custom: customTab }[tab];
    const switchTab = (next, data) => {
      tab = next;
      draw(data);
    };
    panel.replaceChildren(fn(ctx, extra, switchTab));
  };

  root.append(
    h('h1', { class: 'page-title' }, `Add food · ${fmtDate(state.date, 'relative')}`),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row wrap spread' }, seg(MEALS, state.meal, (v) => (state.meal = v)), h('span', { class: 'small muted' }, 'Adding to this meal')),
      tabs,
    ),
    panel,
  );
  draw();
  return root;
}

function searchTab(ctx) {
  const { state } = ctx;
  const done = () => ctx.go('today');
  const empty = async () => {
    const [recent, foods] = await Promise.all([api('/recent'), api('/foods')]);
    const list = [
      ...recent.slice(0, 12).map((f) => ({ ...fromSaved(f), group: 'Recently logged' })),
      ...foods.map((f) => ({ ...fromSaved(f), source: 'custom', group: 'My foods', savedId: f.id })),
    ];
    if (!list.length) {
      return h('div', { class: 'empty small' }, h('span', { class: 'ico' }, '🔎'), 'Search everything JHU dining is serving today — try “pizza”, “eggs” or “salmon”.');
    }
    return groupedResults(list, (food) => openFoodSheet(food, { onDone: done }));
  };
  const box = searchBox(state.date, (food) => openFoodSheet(food, { onDone: done }), { empty });
  setTimeout(box.focus, 50);
  return box.node;
}

function describeTab(ctx) {
  const { state } = ctx;
  const text = h('textarea', {
    class: 'input',
    rows: 3,
    placeholder: 'e.g. “2 slices pepperoni pizza, caesar salad, chocolate chip cookie from the FFC”',
  });
  const out = h('div');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, '🔎 Find it on the menu');
  const form = h(
    'form',
    {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!text.value.trim()) return;
        btn.disabled = true;
        btn.replaceChildren(h('span', { class: 'spinner' }), ' Thinking…');
        try {
          const meal = state.meal === 'snack' ? null : state.meal;
          const result = await api('/analyze', { method: 'POST', body: { text: text.value, date: state.date, meal, location: 'any' } });
          out.replaceChildren(renderReview(ctx, { result, meal: state.meal, onLogged: () => ctx.go('today') }));
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '🔎 Find it on the menu';
        }
      },
    },
    h('div', { class: 'small muted' }, 'List what you ate, separated by commas — quantities and the dining hall are optional. Each item is matched to today’s JHU menus. (The first time, this downloads a ~60 MB language model.)'),
    text,
    btn,
  );
  return h('div', { class: 'stack' }, form, out);
}

/** Photo picker pair: camera + library. Calls onImage(dataUrl). */
function photoButtons(label, maxSide, onImage) {
  const pick = (capture) =>
    h('input', {
      type: 'file',
      accept: 'image/*',
      capture,
      class: 'hidden',
      onchange: async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          onImage(await prepareImage(file, maxSide));
        } catch {
          toast('Couldn’t read that image. Try a JPEG or PNG.', 'error');
        }
      },
    });
  const cam = pick('environment');
  const lib = pick(null);
  return h(
    'div',
    { class: 'row wrap' },
    h('button', { type: 'button', class: 'btn primary big grow', onclick: () => cam.click() }, label),
    h('button', { type: 'button', class: 'btn big', onclick: () => lib.click() }, '🖼 Choose photo'),
    cam,
    lib,
  );
}

function busy(text) {
  return h('div', { class: 'card row', style: { justifyContent: 'center', color: 'var(--text-2)' } }, h('span', { class: 'spinner' }), text);
}

function barcodeTab(ctx, _extra, switchTab) {
  const out = h('div');
  const done = () => ctx.go('today');

  const showProduct = (code, product) => {
    if (!product) {
      out.replaceChildren(
        h(
          'div',
          { class: 'card stack' },
          h('div', null, h('b', null, `Barcode ${code} isn’t in the food databases yet.`), h('div', { class: 'small muted' }, 'Scan its Nutrition Facts label instead — it’ll be saved with this barcode, so next time the scan finds it instantly.')),
          h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', onclick: () => switchTab('label', { barcode: code }) }, '🏷️ Scan the label'), h('button', { class: 'btn', onclick: () => switchTab('custom', { barcode: code }) }, '✏️ Type it in')),
        ),
      );
      return;
    }
    const food = { name: product.name, source: 'packaged', serving: product.serving, nutrients: product.nutrients };
    const n = product.nutrients;
    out.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row', style: { alignItems: 'flex-start', gap: '14px' } },
          product.image ? h('img', { src: product.image, alt: '', style: { width: '72px', height: '72px', objectFit: 'contain', borderRadius: '10px', background: '#fff', flex: 'none' } }) : null,
          h(
            'div',
            { class: 'grow' },
            h('h2', null, product.name),
            h('div', { class: 'small muted' }, `Per ${product.serving} · from ${product.database} · ${code}`),
            h('div', { style: { marginTop: '6px', fontWeight: 700 } }, `${Math.round(n.calories)} kcal · ${Math.round(n.g_protein ?? 0)}g protein · ${Math.round(n.g_carbs ?? 0)}g carbs · ${Math.round(n.g_fat ?? 0)}g fat`),
          ),
        ),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'btn primary grow', onclick: () => openFoodSheet(food, { onDone: done }) }, 'Add to log…'),
          product.savedId
            ? null
            : h(
                'button',
                {
                  class: 'btn',
                  onclick: async (e) => {
                    e.currentTarget.disabled = true;
                    await api('/foods', { method: 'POST', body: { ...food, barcode: code } });
                    toast('Saved to My foods');
                  },
                },
                '⭐ Save to My foods',
              ),
        ),
        h('div', { class: 'tiny muted' }, 'Community databases can have mistakes — if the numbers look off, scan the label instead.'),
      ),
    );
  };

  const lookup = async (request) => {
    out.replaceChildren(busy('Looking it up…'));
    try {
      const { code, product } = await request();
      showProduct(code, product);
    } catch (err) {
      out.replaceChildren(h('div', { class: 'notice warn' }, err.message));
    }
  };

  const digits = h('input', { class: 'input', inputmode: 'numeric', placeholder: 'or type the numbers under the barcode', pattern: '[0-9 ]*' });
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'small muted' }, 'Snap the barcode on any packaged food or drink — chips, cereal, protein bars, bottled drinks. Nutrition comes from Open Food Facts and the USDA database (free).'),
      photoButtons('📷 Scan barcode', 1600, (image) => lookup(() => api('/barcode', { method: 'POST', body: { image } }))),
      h(
        'form',
        {
          class: 'row',
          onsubmit: (e) => {
            e.preventDefault();
            const code = digits.value.replace(/\D/g, '');
            if (code.length < 8) return toast('A barcode is 8–14 digits', 'error');
            lookup(() => api(`/barcode/${code}`));
          },
        },
        h('div', { class: 'grow' }, digits),
        h('button', { class: 'btn' }, 'Look up'),
      ),
    ),
    out,
  );
}

function labelTab(ctx, extra = {}) {
  const out = h('div');
  const intro = h(
    'div',
    { class: 'card stack' },
    extra?.barcode ? h('div', { class: 'notice small' }, `This will be saved with barcode ${extra.barcode}.`) : null,
    h('div', { class: 'small muted' }, 'Photograph the Nutrition Facts panel: hold the phone straight-on, fill the frame with the label, and avoid glare. Every value is read for you to check before logging.'),
    photoButtons('🏷️ Scan label', 2000, async (image) => {
      out.replaceChildren(busy('Reading the label… (a few seconds)'));
      try {
        const res = await api('/label', { method: 'POST', body: { image } });
        out.replaceChildren(
          customTab(ctx, {
            ...extra,
            nutrients: res.nutrients,
            serving: res.serving,
            flagged: res.flagged,
            notice:
              res.found.length < 4
                ? ['warn', 'Couldn’t read much from that photo. Retake it straight-on and closer, or fill in the values below.']
                : ['', `Read ${res.found.length} values from the label. Double-check them${res.flagged.length ? ' — highlighted ones looked off' : ''}, add a name, and you’re set.`],
          }),
        );
        out.querySelector('input[name=foodname]')?.focus();
      } catch (err) {
        out.replaceChildren(h('div', { class: 'notice warn' }, err.message));
      }
    }),
  );
  return h('div', { class: 'stack' }, intro, out);
}

function customTab(ctx, prefill = {}) {
  const { state } = ctx;
  const inputs = {};
  const flagged = new Set(prefill?.flagged ?? []);
  const numberField = (n) => {
    const value = prefill?.nutrients?.[n.key];
    const input = h('input', {
      class: 'input',
      type: 'number',
      inputmode: 'decimal',
      step: 'any',
      min: 0,
      required: n.key === 'calories',
      name: n.key,
      value: value ?? '',
      style: flagged.has(n.key) ? { borderColor: 'var(--critical)', boxShadow: '0 0 0 3px rgba(208,59,59,.2)' } : null,
    });
    inputs[n.key] = input;
    return h('label', { class: 'field' }, h('span', null, `${n.label}${n.key === 'calories' ? ' *' : ''}${flagged.has(n.key) ? ' ⚠ check' : ''}`), h('div', { class: 'input-suffix' }, input, h('em', null, n.unit)));
  };
  const name = h('input', { class: 'input', required: true, name: 'foodname', placeholder: 'e.g. Chobani vanilla yogurt' });
  const serving = h('input', { class: 'input', placeholder: 'e.g. 1 cup, 1 bar, 150 g', value: prefill?.serving ?? '' });
  const servings = h('input', { class: 'input', type: 'number', step: 'any', min: 0.1, value: 1 });
  const save = h('input', { type: 'checkbox', checked: true });

  const [main, rest] = [NUTRIENTS.slice(0, 4), NUTRIENTS.slice(4)];
  return h(
    'form',
    {
      class: 'card stack',
      onsubmit: async (e) => {
        e.preventDefault();
        const nutrients = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value === '' ? null : +el.value]));
        const food = { name: name.value.trim(), serving: serving.value.trim() || '1 serving', nutrients, source: prefill?.barcode ? 'packaged' : 'custom', barcode: prefill?.barcode };
        try {
          if (save.checked) await api('/foods', { method: 'POST', body: food });
          await logFoods([{ ...food, servings: +servings.value || 1 }], state.meal);
          toast(`Added ${food.name}`);
          ctx.go('today');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    prefill?.notice ? h('div', { class: `notice small ${prefill.notice[0]}` }, prefill.notice[1]) : h('div', { class: 'small muted' }, 'Enter values for ONE serving — copy them from the package label. Only calories are required.'),
    h('div', { class: 'form-grid' }, h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, 'Food name *'), name), h('label', { class: 'field' }, h('span', null, 'Serving size'), serving), h('label', { class: 'field' }, h('span', null, 'Servings eaten'), servings)),
    h('div', { class: 'form-grid' }, main.map(numberField)),
    h('details', { open: !!prefill?.nutrients }, h('summary', { class: 'small', style: { cursor: 'pointer', fontWeight: 600 } }, 'More nutrients (fiber, sodium, vitamins…)'), h('div', { class: 'form-grid', style: { marginTop: '12px' } }, rest.map(numberField))),
    h('label', { class: 'row small' }, save, 'Save to “My foods” for one-tap logging later'),
    h('button', { class: 'btn primary block' }, 'Add to log'),
  );
}
