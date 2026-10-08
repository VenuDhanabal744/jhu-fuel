import { api } from '../api.js';
import { h, openSheet, toast, MEALS, MEAL_ICONS, todayStr } from '../ui.js';
import { NUTRIENT_BY_KEY, MACROS, MICROS, scaleNutrients, sumNutrients, fmt } from '../nutrients.js';
import { targetStatus } from '../targets.js';
import { ring } from '../charts.js';
import { openFoodSheet, fromSaved } from '../food.js';

const MACRO_COLORS = { g_protein: 'var(--series-1)', g_carbs: 'var(--series-2)', g_fat: 'var(--series-3)' };

export async function render(ctx) {
  const { state } = ctx;
  const [entries, profile] = await Promise.all([api(`/entries?date=${state.date}`), ctx.refreshProfile()]);
  const { targets } = profile;
  const totals = sumNutrients(entries.map((e) => scaleNutrients(e.nutrients, e.servings)));
  const rerender = () => ctx.render();

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'grid dash' },
      h('div', { class: 'stack' }, calorieCard(totals, targets), macroCard(totals, targets), weightCard(ctx, profile)),
      h('div', { class: 'stack' }, quickAdd(ctx), ...MEALS.map(([meal, label]) => mealBlock(ctx, meal, label, entries, rerender))),
    ),
    h('div', { class: 'section-title' }, 'All nutrients'),
    nutrientsCard(totals, targets, entries.length),
  );
}

function calorieCard(totals, targets) {
  const target = targets.calories.value;
  const eaten = totals.calories ?? 0;
  const remaining = target - eaten;
  const over = remaining < 0;
  const pct = eaten / target;
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Calories'), h('span', { class: 'badge' }, `${Math.round(pct * 100)}% of goal`)),
    h(
      'div',
      { class: 'ring-wrap' },
      h(
        'div',
        { class: 'ring' },
        ring(pct, { color: over ? 'var(--critical)' : 'var(--brand)' }),
        h(
          'div',
          { class: 'ring-center' },
          h('div', { class: 'big tabular' }, Math.abs(Math.round(remaining)).toLocaleString()),
          h('div', { class: 'lbl', style: over ? { color: 'var(--critical-text)', fontWeight: 700 } : null }, over ? '⚠ kcal over' : 'kcal left'),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('div', null, h('span', { class: 'muted' }, 'Goal'), h('b', null, target.toLocaleString())),
        h('div', null, h('span', { class: 'muted' }, 'Eaten'), h('b', null, Math.round(eaten).toLocaleString())),
        h('div', null, h('span', { class: 'muted' }, over ? 'Over' : 'Remaining'), h('b', { style: over ? { color: 'var(--critical-text)' } : null }, Math.abs(Math.round(remaining)).toLocaleString())),
      ),
    ),
  );
}

function macroCard(totals, targets) {
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head', style: { marginBottom: 0 } }, h('h2', null, 'Macros')),
    MACROS.map((key) => {
      const t = targets[key];
      const v = totals[key] ?? 0;
      const st = targetStatus(v, t);
      return h(
        'div',
        { class: 'macro' },
        h(
          'div',
          { class: 'macro-head' },
          h('span', { class: 'name' }, h('i', { class: 'swatch', style: { background: MACRO_COLORS[key] } }), NUTRIENT_BY_KEY[key].label, statusIcon(st)),
          h('span', { class: 'tabular' }, h('b', null, Math.round(v)), ` / ${t.value} g`),
        ),
        h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, (st.pct ?? 0) * 100)}%`, background: MACRO_COLORS[key] } })),
      );
    }),
    h(
      'div',
      { class: 'small muted', style: { marginTop: '12px' } },
      macroSplit(totals),
    ),
  );
}

function macroSplit(t) {
  const p = (t.g_protein ?? 0) * 4;
  const c = (t.g_carbs ?? 0) * 4;
  const f = (t.g_fat ?? 0) * 9;
  const sum = p + c + f;
  if (!sum) return 'Log food to see your macro split.';
  return `Split: ${Math.round((p / sum) * 100)}% protein · ${Math.round((c / sum) * 100)}% carbs · ${Math.round((f / sum) * 100)}% fat`;
}

function statusIcon(st) {
  if (st.state === 'met') return h('span', { class: 'status-ico good', title: 'Goal met' }, '✓');
  if (st.state === 'over') return h('span', { class: 'status-ico bad', title: 'Over' }, '▲ over');
  if (st.state === 'near') return h('span', { class: 'status-ico near', title: 'Near limit' }, '● near limit');
  return null;
}

export function weightProgress(profile) {
  const p = profile.profile;
  const start = p.startWeightLb ?? p.weightLb;
  const current = profile.currentWeightLb;
  const target = p.targetWeightLb;
  const total = target - start;
  const done = current - start;
  const pct = p.goal === 'maintain' || total === 0 ? null : Math.max(0, Math.min(1, done / total));
  return { start, current, target, pct, toGo: +(target - current).toFixed(1) };
}

function weightCard(ctx, profile) {
  const p = profile.profile;
  const w = weightProgress(profile);
  let body;
  if (p.goal === 'maintain') {
    const diff = +(w.current - w.target).toFixed(1);
    const ok = Math.abs(diff) <= 2;
    body = h(
      'div',
      null,
      h('div', { class: 'row spread' }, h('div', { class: 'stat' }, h('div', { class: 'val tabular' }, `${w.current} lb`), h('div', { class: 'sub' }, `Maintaining around ${w.target} lb`))),
      h('div', { class: 'small', style: { marginTop: '8px', color: ok ? 'var(--good-text)' : 'var(--text-2)' } }, ok ? '✓ Within 2 lb of your target' : `${Math.abs(diff)} lb ${diff > 0 ? 'above' : 'below'} target`),
    );
  } else {
    const pct = Math.round((w.pct ?? 0) * 100);
    const reached = (p.goal === 'lose' && w.current <= w.target) || (p.goal === 'gain' && w.current >= w.target);
    const weeksLeft = p.rateLbPerWeek > 0 ? Math.abs(w.toGo) / p.rateLbPerWeek : null;
    body = h(
      'div',
      null,
      h(
        'div',
        { class: 'row spread' },
        h('div', { class: 'stat' }, h('div', { class: 'val tabular' }, `${pct}%`), h('div', { class: 'sub' }, 'of the way to your goal')),
        h('div', { class: 'stat', style: { textAlign: 'right' } }, h('div', { class: 'val tabular' }, `${w.current}`), h('div', { class: 'sub' }, 'lb now')),
      ),
      h('div', { class: 'goal-track', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${pct}%` } })),
      h('div', { class: 'goal-ends' }, h('span', null, `Start ${w.start} lb`), h('span', null, `Goal ${w.target} lb`)),
      h(
        'div',
        { class: 'small', style: { marginTop: '8px', color: reached ? 'var(--good-text)' : 'var(--text-2)' } },
        reached
          ? '🎉 Goal reached! Set a new one on the Goals tab.'
          : `${Math.abs(w.toGo)} lb to go${weeksLeft ? ` · about ${Math.ceil(weeksLeft)} weeks at ${p.rateLbPerWeek} lb/week` : ''}`,
      ),
    );
  }
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Weight goal'), h('button', { class: 'btn small', onclick: () => logWeightSheet(ctx) }, '⚖️ Log weight')),
    body,
  );
}

export function logWeightSheet(ctx) {
  const { state } = ctx;
  const input = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.1', value: state.profile.currentWeightLb, required: true });
  const date = h('input', { class: 'input', type: 'date', value: state.date, max: todayStr(), required: true });
  openSheet({
    title: 'Log weight',
    subtitle: 'Weigh in at the same time of day for the most consistent trend.',
    content: (close) =>
      h(
        'form',
        {
          class: 'stack',
          onsubmit: async (e) => {
            e.preventDefault();
            await api('/weights', { method: 'POST', body: { date: date.value, weightLb: +input.value } });
            toast('Weight logged');
            close();
            ctx.render();
          },
        },
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Weight (lb)'), input), h('label', { class: 'field' }, h('span', null, 'Date'), date)),
        h('button', { class: 'btn primary block' }, 'Save'),
      ),
  });
}

function quickAdd(ctx) {
  const btn = (ico, label, hash, primary) =>
    h('button', { class: `btn ${primary ? 'primary' : ''}`, onclick: () => (location.hash = hash) }, h('span', { class: 'ico' }, ico), label);
  return h(
    'div',
    { class: 'quick-add' },
    btn('📷', 'Snap plate', '#/snap', true),
    btn('🏛', 'JHU menus', '#/menus'),
    btn('🔍', 'Search', '#/add?tab=search'),
    btn('📦', 'Barcode', '#/add?tab=barcode'),
    btn('🏷️', 'Label', '#/add?tab=label'),
    btn('✏️', 'Custom', '#/add?tab=custom'),
  );
}

function entryThumb(e) {
  if (e.photo_url) return h('img', { class: 'thumb', src: e.photo_url, alt: '', loading: 'lazy' });
  return h('div', { class: 'thumb', 'aria-hidden': 'true' }, ({ menu: '🏛', estimate: '✨', packaged: '📦' })[e.source] ?? '✏️');
}

function mealBlock(ctx, meal, label, entries, rerender) {
  const list = entries.filter((e) => e.meal === meal);
  const kcal = list.reduce((sum, e) => sum + (e.nutrients.calories ?? 0) * e.servings, 0);
  return h(
    'div',
    { class: 'card meal-block' },
    h('div', { class: 'card-head' }, h('h3', null, `${MEAL_ICONS[meal]} ${label}`), h('span', { class: 'meal-kcal' }, `${Math.round(kcal).toLocaleString()} kcal`)),
    list.length
      ? list.map((e) => {
          const n = scaleNutrients(e.nutrients, e.servings);
          return h(
            'div',
            {
              class: 'entry',
              role: 'button',
              tabindex: 0,
              onclick: () => openFoodSheet({ ...fromSaved(e), photoId: e.photo_id }, { entry: e, onDone: rerender }),
              onkeydown: (ev) => ev.key === 'Enter' && ev.currentTarget.click(),
            },
            entryThumb(e),
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'name ellipsis' }, e.name),
              h('div', { class: 'meta ellipsis' }, [`${+e.servings.toFixed(2)} × ${e.serving_desc || 'serving'}`, e.location].filter(Boolean).join(' · ')),
            ),
            h(
              'div',
              { class: 'kcal' },
              `${fmt(n.calories, 'calories')}`,
              h('small', null, `${Math.round(n.g_protein ?? 0)}P ${Math.round(n.g_carbs ?? 0)}C ${Math.round(n.g_fat ?? 0)}F`),
            ),
          );
        })
      : h('div', { class: 'empty-meal' }, 'Nothing logged yet.'),
    h(
      'div',
      { class: 'meal-add' },
      h(
        'button',
        {
          class: 'btn ghost small',
          onclick: () => {
            ctx.state.meal = meal;
            ctx.go('add');
          },
        },
        `＋ Add to ${label.toLowerCase()}`,
      ),
      h(
        'button',
        {
          class: 'btn ghost small',
          onclick: () => {
            ctx.state.meal = meal;
            ctx.go('snap');
          },
        },
        '📷 Snap',
      ),
    ),
  );
}

function nutrientsCard(totals, targets, count) {
  return h(
    'div',
    { class: 'card' },
    count ? null : h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Nothing logged yet for this day.'),
    h(
      'div',
      { class: 'nutrient-grid' },
      MICROS.map((key) => {
        const meta = NUTRIENT_BY_KEY[key];
        const t = targets[key];
        const v = totals[key];
        const st = targetStatus(v, t);
        const kindText = t.kind === 'max' ? 'limit' : t.kind === 'min' ? 'goal' : t.kind === 'target' ? 'target' : '';
        const color = st.state === 'over' ? 'var(--critical)' : st.state === 'met' ? 'var(--good)' : st.state === 'near' ? 'var(--warning)' : 'var(--accent)';
        return h(
          'div',
          { class: 'nutrient-row' },
          h(
            'div',
            { class: 'macro-head' },
            h('span', { class: 'name' }, meta.label, statusIcon(st)),
            h(
              'span',
              { class: 'tabular small' },
              h('b', null, fmt(v ?? 0, key, { unit: false })),
              t.value != null ? ` / ${fmt(t.value, key)} ${kindText}` : ` ${meta.unit}`,
            ),
          ),
          t.value != null ? h('div', { class: 'bar thin' }, h('i', { style: { width: `${Math.min(100, (st.pct ?? 0) * 100)}%`, background: color } })) : h('div', { class: 'tiny muted' }, 'No daily recommendation'),
        );
      }),
    ),
  );
}

