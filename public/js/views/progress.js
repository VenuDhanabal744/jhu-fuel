import { api } from '../api.js';
import { h, seg, todayStr, addDays, daysBetween } from '../ui.js';
import { NUTRIENTS, NUTRIENT_BY_KEY, fmt } from '../nutrients.js';
import { targetStatus } from '../targets.js';
import { barChart, lineChart } from '../charts.js';
import { weightProgress, logWeightSheet } from './today.js';

let range = 7;

export async function render(ctx) {
  const root = h('div');
  const content = h('div');
  root.append(
    h('div', { class: 'row wrap spread', style: { marginBottom: '14px' } }, h('h1', { class: 'page-title', style: { margin: 0 } }, '📈 Progress'), seg([[7, '7 days'], [30, '30 days'], [90, '90 days']], range, (v) => ((range = v), draw()))),
    content,
  );
  async function draw() {
    content.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
    content.replaceChildren(await build(ctx));
  }
  await draw();
  return root;
}

function streak(loggedDates) {
  const set = new Set(loggedDates);
  let d = todayStr();
  if (!set.has(d)) d = addDays(d, -1); // today not logged yet doesn't break the streak
  let n = 0;
  while (set.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

async function build(ctx) {
  const to = todayStr();
  const from = addDays(to, -(range - 1));
  const data = await api(`/summary?from=${from}&to=${to}`);
  const { targets, profile } = data;
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const dates = Array.from({ length: range }, (_, i) => addDays(from, i));
  const logged = data.days.filter((d) => d.count > 0);
  const calTarget = targets.calories.value;

  const avg = (key) => (logged.length ? logged.reduce((s, d) => s + (d.totals[key] ?? 0), 0) / logged.length : null);
  const onTarget = logged.filter((d) => Math.abs((d.totals.calories ?? 0) - calTarget) <= calTarget * 0.1).length;
  const label = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, range <= 7 ? { weekday: 'short' } : { month: 'numeric', day: 'numeric' });
  const longLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const series = (key) =>
    dates.map((d) => {
      const v = byDate.get(d)?.totals[key] ?? null;
      const t = targets[key]?.value;
      return {
        label: label(d),
        value: v,
        tip: () => [
          h('div', { class: 'muted' }, longLabel(d)),
          v == null
            ? h('div', null, 'Nothing logged')
            : h('div', null, h('b', null, `${fmt(v, key)}${key === 'calories' ? ' kcal' : ''}`), t ? h('span', { class: 'muted' }, ` · ${Math.round((v / t) * 100)}% of goal`) : null),
        ],
      };
    });

  // ----- stat tiles -----
  const avgCal = avg('calories');
  const weights = data.weights;
  const w = weightProgress(data);
  const inRange = weights.filter((x) => x.date >= from);
  const change = inRange.length > 1 ? +(inRange[inRange.length - 1].weight_lb - inRange[0].weight_lb).toFixed(1) : null;

  const tiles = h(
    'div',
    { class: 'stats' },
    stat('Avg calories', avgCal == null ? '—' : Math.round(avgCal).toLocaleString(), `Goal ${calTarget.toLocaleString()} · logged days only`),
    stat('Days on target', `${onTarget}/${logged.length}`, 'Within ±10% of calorie goal'),
    stat('Logging streak', `${streak(data.loggedDates)} 🔥`, `${logged.length} of ${range} days logged`),
    stat(
      profile.goal === 'maintain' ? 'Weight' : 'Goal progress',
      profile.goal === 'maintain' ? `${w.current} lb` : `${Math.round((w.pct ?? 0) * 100)}%`,
      change == null ? `${Math.abs(w.toGo)} lb to ${w.target} lb goal` : `${change > 0 ? '+' : ''}${change} lb in ${range} days`,
    ),
  );

  // ----- weight -----
  const weightCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Weight'), h('button', { class: 'btn small', onclick: () => logWeightSheet(ctx) }, '⚖️ Log weight')),
    weights.length
      ? [
          h('div', { class: 'legend' }, h('span', null, h('i', { class: 'swatch', style: { background: 'var(--series-1)' } }), 'Weigh-ins'), h('span', null, h('i', { class: 'dash' }), `Goal ${profile.targetWeightLb} lb`)),
          lineChart(weightPoints(weights, to), { target: profile.targetWeightLb }),
          weightPace(profile, weights),
        ]
      : h('div', { class: 'empty small' }, 'Log your weight to see your trend.'),
  );

  // ----- nutrient table -----
  const table = h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Avg / day'), h('th', { class: 'num' }, 'Goal'), h('th', { class: 'num' }, '% of goal'), h('th', { class: 'num' }, 'Days met'))),
      h(
        'tbody',
        null,
        NUTRIENTS.map((n) => {
          const t = targets[n.key];
          const a = avg(n.key);
          const met = t.value == null ? null : logged.filter((d) => ['met', 'ok', 'near'].includes(targetStatus(d.totals[n.key] ?? 0, t).state)).length;
          const st = targetStatus(a ?? 0, t);
          const flag = st.state === 'over' ? h('span', { class: 'status-ico bad' }, ' ▲') : st.state === 'met' || st.state === 'ok' ? h('span', { class: 'status-ico good' }, ' ✓') : null;
          return h(
            'tr',
            null,
            h('td', null, n.label, t.kind === 'max' ? h('span', { class: 'tiny muted' }, ' (limit)') : null),
            h('td', { class: 'num' }, a == null ? '—' : fmt(a, n.key)),
            h('td', { class: 'num' }, t.value == null ? '—' : fmt(t.value, n.key)),
            h('td', { class: 'num' }, t.value == null || a == null ? '—' : `${Math.round((a / t.value) * 100)}%`, a == null ? null : flag),
            h('td', { class: 'num' }, met == null ? '—' : `${met}/${logged.length}`),
          );
        }),
      ),
    ),
  );

  const macroColors = { g_protein: 'var(--series-1)', g_carbs: 'var(--series-2)', g_fat: 'var(--series-3)' };

  return h(
    'div',
    { class: 'stack' },
    tiles,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Calories per day')),
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'swatch', style: { background: 'var(--brand)' } }), 'Calories eaten'), h('span', null, h('i', { class: 'dash' }), 'Daily goal')),
      barChart(series('calories'), { target: calTarget, color: 'var(--brand)', height: 210 }),
    ),
    h(
      'div',
      { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' } },
      ['g_protein', 'g_carbs', 'g_fat'].map((key) =>
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head', style: { marginBottom: '4px' } }, h('h3', { class: 'row' }, h('i', { class: 'swatch', style: { background: macroColors[key] } }), `${NUTRIENT_BY_KEY[key].label} (g)`), h('span', { class: 'small muted' }, avg(key) == null ? '' : `avg ${Math.round(avg(key))} g`)),
          barChart(series(key), { target: targets[key].value, color: macroColors[key], height: 150 }),
        ),
      ),
    ),
    weightCard,
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Nutrient averages'), h('span', { class: 'small muted' }, `${logged.length} logged day${logged.length === 1 ? '' : 's'}`)), table),
  );
}

/** Weigh-ins from the last 30+ days (or the latest one if none are that recent). */
function weightPoints(weights, to) {
  const windowStart = addDays(to, -Math.max(range, 30) + 1);
  const recent = weights.filter((x) => x.date >= windowStart);
  return (recent.length ? recent : weights.slice(-1)).map((x) => ({ date: x.date, value: x.weight_lb }));
}

function stat(label, value, sub) {
  return h('div', { class: 'card stat' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val tabular' }, value), h('div', { class: 'sub' }, sub));
}

/** Compare actual weekly pace (least-squares over the last 4 weeks) with the plan. */
function weightPace(profile, weights) {
  const recent = weights.filter((x) => x.date >= addDays(todayStr(), -28));
  if (recent.length < 2 || profile.goal === 'maintain') return null;
  const xs = recent.map((x) => daysBetween(recent[0].date, x.date));
  const ys = recent.map((x) => x.weight_lb);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (!den) return null;
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den; // lb/day
  const perWeek = +(slope * 7).toFixed(2);
  const planned = profile.goal === 'lose' ? -profile.rateLbPerWeek : profile.rateLbPerWeek;
  const remaining = profile.targetWeightLb - ys[ys.length - 1];
  const eta = Math.sign(perWeek) === Math.sign(remaining) && perWeek !== 0 ? Math.ceil(remaining / perWeek) : null;
  return h(
    'div',
    { class: 'small', style: { marginTop: '10px', color: 'var(--text-2)' } },
    `Recent trend: ${perWeek > 0 ? '+' : ''}${perWeek} lb/week (plan: ${planned > 0 ? '+' : ''}${planned}). `,
    eta ? `At this pace you’ll reach ${profile.targetWeightLb} lb in about ${eta} week${eta === 1 ? '' : 's'}.` : 'Not trending toward your goal yet — keep logging consistently.',
  );
}
