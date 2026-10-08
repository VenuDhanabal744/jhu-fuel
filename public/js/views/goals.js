import { api } from '../api.js';
import { h, seg, select, toast, todayStr, fmtDate } from '../ui.js';
import { NUTRIENTS, fmt } from '../nutrients.js';
import { computeTargets, ACTIVITY_LEVELS, GOALS } from '../targets.js';

const RATES = [
  [0.25, '0.25 lb / week (gentle)'],
  [0.5, '0.5 lb / week (recommended)'],
  [1, '1 lb / week'],
  [1.5, '1.5 lb / week (aggressive)'],
  [2, '2 lb / week (max)'],
];

export async function render(ctx) {
  const { state } = ctx;
  const [payload, weights, foods] = await Promise.all([ctx.refreshProfile(), api('/weights'), api('/foods')]);
  const p = structuredClone(payload.profile);
  const firstRun = !p.configured;
  p.weightLb = payload.currentWeightLb;
  p.overrides ??= {};

  const preview = h('div');
  const targetsBody = h('tbody');

  const numInput = (key, attrs = {}) =>
    h('input', {
      class: 'input',
      type: 'number',
      inputmode: 'decimal',
      step: 'any',
      value: p[key],
      required: true,
      ...attrs,
      oninput: (e) => {
        p[key] = e.target.value === '' ? '' : +e.target.value;
        update();
      },
    });

  const ft = h('input', { class: 'input', type: 'number', min: 3, max: 8, value: Math.floor(p.heightIn / 12), oninput: () => setHeight() });
  const inch = h('input', { class: 'input', type: 'number', min: 0, max: 11.5, step: 0.5, value: +(p.heightIn % 12).toFixed(1), oninput: () => setHeight() });
  function setHeight() {
    p.heightIn = (+ft.value || 0) * 12 + (+inch.value || 0);
    update();
  }

  const rateField = h('label', { class: 'field' }, h('span', null, 'Pace'), select(RATES.map(([v, l]) => [String(v), l]), String(p.rateLbPerWeek), (v) => ((p.rateLbPerWeek = +v), update())));
  const targetField = h('label', { class: 'field' }, h('span', null, 'Target weight (lb)'), numInput('targetWeightLb', { min: 60, max: 600 }));

  function update() {
    const valid = p.age > 0 && p.heightIn > 0 && p.weightLb > 0;
    rateField.classList.toggle('hidden', p.goal === 'maintain');
    if (!valid) return;
    const { targets, bmr, tdee, dailyDelta } = computeTargets(p, p.weightLb);
    preview.replaceChildren(
      h(
        'div',
        { class: 'stats' },
        miniStat('Daily calories', targets.calories.value.toLocaleString(), targets.calories.overridden ? 'custom' : 'auto'),
        miniStat('Maintenance (TDEE)', tdee.toLocaleString(), `BMR ${bmr.toLocaleString()}`),
        miniStat(dailyDelta < 0 ? 'Daily deficit' : dailyDelta > 0 ? 'Daily surplus' : 'Balance', `${dailyDelta > 0 ? '+' : ''}${dailyDelta}`, 'kcal vs. maintenance'),
      ),
    );
    targetsBody.replaceChildren(
      ...NUTRIENTS.map((n) => {
        const t = targets[n.key];
        const override = h('input', {
          class: 'input',
          type: 'number',
          step: 'any',
          min: 0,
          placeholder: t.auto == null ? 'none' : String(t.auto),
          value: p.overrides[n.key] ?? '',
          style: { maxWidth: '110px', minHeight: '34px', padding: '5px 8px' },
          'aria-label': `Custom ${n.label} target`,
          onchange: (e) => {
            if (e.target.value === '') delete p.overrides[n.key];
            else p.overrides[n.key] = +e.target.value;
            update();
          },
        });
        const kind = { min: 'At least', max: 'Limit', target: 'Aim for', none: '—' }[t.kind];
        return h(
          'tr',
          null,
          h('td', null, n.label),
          h('td', { class: 'small muted' }, kind),
          h('td', { class: 'num' }, t.value == null ? '—' : `${fmt(t.value, n.key)}${n.key === 'calories' ? ' kcal' : ''}`),
          h('td', null, override),
        );
      }),
    );
  }

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          state.profile = await api('/profile', { method: 'PUT', body: { ...p, today: todayStr() } });
          state.status = { ...state.status, configured: true };
          toast('Goals saved');
          ctx.go('today');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'About you'),
      h(
        'div',
        { class: 'form-grid' },
        h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, 'Name (optional)'), h('input', { class: 'input', value: p.name, oninput: (e) => (p.name = e.target.value) })),
        h('div', { class: 'field' }, h('span', null, 'Sex (for BMR)'), seg([['female', 'Female'], ['male', 'Male']], p.sex, (v) => ((p.sex = v), update()))),
        h('label', { class: 'field' }, h('span', null, 'Age'), numInput('age', { min: 13, max: 100 })),
        h('div', { class: 'field' }, h('span', null, 'Height'), h('div', { class: 'row' }, h('div', { class: 'input-suffix grow' }, ft, h('em', null, 'ft')), h('div', { class: 'input-suffix grow' }, inch, h('em', null, 'in')))),
        h('label', { class: 'field' }, h('span', null, 'Current weight (lb)'), numInput('weightLb', { min: 60, max: 600 })),
      ),
      h('label', { class: 'field' }, h('span', null, 'Activity level'), select(Object.entries(ACTIVITY_LEVELS).map(([k, v]) => [k, v.label]), p.activity, (v) => ((p.activity = v), update()))),
    ),
    h(
      'div',
      { class: 'card stack' },
      h('h2', null, 'Your goal'),
      seg(Object.entries(GOALS), p.goal, (v) => ((p.goal = v), update())),
      h('div', { class: 'form-grid' }, targetField, rateField),
      preview,
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Daily nutrient targets'), h('span', { class: 'small muted' }, 'Leave blank for auto')),
      h('div', { class: 'small muted', style: { marginBottom: '8px' } }, 'Auto targets follow the Dietary Guidelines for Americans and NIH recommended intakes for your age and sex.'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Target'), h('th', null, 'Custom'))), targetsBody)),
    ),
    h('button', { class: 'btn primary big block' }, firstRun ? 'Start tracking →' : 'Save goals'),
  );

  update();

  const root = h(
    'div',
    null,
    h('h1', { class: 'page-title' }, firstRun ? '👋 Welcome to JHU Fuel' : '🎯 Goals'),
    firstRun
      ? h('p', { class: 'muted', style: { marginTop: '-6px' } }, 'Tell me a bit about yourself and I’ll set daily calorie, macro and micronutrient targets. You can fine-tune any of them.')
      : null,
    firstRun ? h('div', { class: 'notice small', style: { marginBottom: '14px' } }, 'Moving from another device? ', importLink(ctx), ' instead.') : null,
    form,
  );

  if (!firstRun) {
    root.append(
      h('div', { class: 'section-title' }, 'Weigh-ins'),
      h(
        'div',
        { class: 'card', style: { padding: 0, overflow: 'hidden' } },
        weights.length
          ? [...weights].reverse().slice(0, 30).map((w) =>
              h(
                'div',
                { class: 'food-row', style: { cursor: 'default' } },
                h('div', { class: 'grow' }, fmtDate(w.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
                h('b', { class: 'tabular' }, `${w.weight_lb} lb`),
                h('button', { class: 'icon-btn', 'aria-label': 'Delete weigh-in', onclick: async () => (await api(`/weights/${w.date}`, { method: 'DELETE' }), ctx.render()) }, '✕'),
              ),
            )
          : h('div', { class: 'empty small' }, 'No weigh-ins yet.'),
      ),
      h('div', { class: 'section-title' }, 'My foods'),
      h(
        'div',
        { class: 'card', style: { padding: 0, overflow: 'hidden' } },
        foods.length
          ? foods.map((f) =>
              h(
                'div',
                { class: 'food-row', style: { cursor: 'default' } },
                h('div', { class: 'grow' }, h('div', { class: 'name' }, f.name), h('div', { class: 'meta' }, f.serving_desc || '1 serving')),
                h('b', { class: 'tabular' }, `${fmt(f.nutrients.calories, 'calories')} kcal`),
                h('button', { class: 'icon-btn', 'aria-label': `Delete ${f.name}`, onclick: async () => (await api(`/foods/${f.id}`, { method: 'DELETE' }), ctx.render()) }, '✕'),
              ),
            )
          : h('div', { class: 'empty small' }, 'Custom foods you save will appear here.'),
      ),
      h('div', { class: 'section-title' }, 'Backup'),
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'small muted' }, 'Your log is stored only on this device. Save a backup now and then (e.g. to iCloud Drive), or use one to move your data to another phone or browser.'),
        h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => exportBackup() }, '⬇️ Save backup'), importLink(ctx, true)),
      ),
      h('p', { class: 'tiny muted', style: { textAlign: 'center', marginTop: '18px' } }, 'Photo recognition, barcodes and label reading all run on this device — free, no account.'),
    );
  }
  return root;
}

async function exportBackup() {
  const data = await api('/backup');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `jhu-fuel-backup-${todayStr()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  // On iPhone the share sheet lets you save to Files/iCloud Drive; elsewhere just download.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importLink(ctx, button = false) {
  const input = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'hidden',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const res = await api('/backup', { method: 'POST', body: JSON.parse(await file.text()) });
        toast(`Imported ${res.entries} food entries and ${res.weights} weigh-ins`);
        ctx.state.status = await api('/status');
        ctx.go('today');
      } catch (err) {
        toast(err.message.includes('JSON') ? 'That file isn’t a valid backup.' : err.message, 'error');
      }
    },
  });
  return h('span', null, h(button ? 'button' : 'a', { class: button ? 'btn' : '', href: button ? null : '#', onclick: (e) => (e.preventDefault(), input.click()) }, button ? '⬆️ Restore from backup' : 'Restore a backup'), input);
}

function miniStat(label, value, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val tabular' }, value), h('div', { class: 'sub' }, sub));
}
