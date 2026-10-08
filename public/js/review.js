// Review screen for AI results (photo or text): confirm matches, swap to
// alternatives, fix portions, then log everything in one go.

import { h, stepper, select, toast, MEALS } from './ui.js';
import { scaleNutrients, sumNutrients, fmt } from './nutrients.js';
import { logFoods, sourceBadge } from './food.js';
import { openSearchPicker } from './search.js';

const CONF = {
  high: ['good', '● High confidence'],
  medium: ['', '● Medium confidence'],
  low: ['warn', '● Low confidence — double-check'],
};

export function renderReview(ctx, { result, photoId, photoUrl, meal, onLogged }) {
  const { state } = ctx;
  let chosenMeal = meal;
  const drafts = result.items.map((it) => ({ ...it, alternatives: [...it.alternatives] }));
  const list = h('div');
  const totals = h('div', { class: 'grow' });
  const logBtn = h('button', { class: 'btn primary', onclick: () => submit() });

  const redraw = () => {
    list.replaceChildren(...(drafts.length ? drafts.map(draftRow) : [h('div', { class: 'empty small' }, 'No items. Add something below.')]));
    const t = sumNutrients(drafts.map((d) => scaleNutrients(d.match.nutrients, d.servings)));
    totals.replaceChildren(
      h('div', { class: 'kcal-total' }, `${fmt(t.calories ?? 0, 'calories')} kcal`),
      h('div', { class: 'small muted ellipsis' }, `${Math.round(t.g_protein ?? 0)}P · ${Math.round(t.g_carbs ?? 0)}C · ${Math.round(t.g_fat ?? 0)}F g`),
    );
    logBtn.textContent = `Log ${drafts.length} item${drafts.length === 1 ? '' : 's'}`;
    logBtn.disabled = !drafts.length;
  };

  function draftRow(d, i) {
    const n = scaleNutrients(d.match.nutrients, d.servings);
    const [confCls, confText] = CONF[d.confidence] ?? CONF.medium;
    const altOptions = [['cur', `${d.match.name}${d.match.location ? ` — ${d.match.location}` : ''}`], ...d.alternatives.map((a, j) => [`alt${j}`, `${a.name} — ${a.location}`]), ['search', '🔍 Something else…']];
    const kcalEl = h('b', { class: 'tabular' }, `${fmt(n.calories ?? 0, 'calories')} kcal`);
    return h(
      'div',
      { class: 'draft-item' },
      h(
        'div',
        { class: 'row spread', style: { alignItems: 'flex-start' } },
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'name' }, d.match.name),
          d.label || d.portion ? h('div', { class: 'seen' }, d.label ? `You said: ${d.label}` : null, d.portion ? ` · ${d.portion}` : null) : null,
          h('div', { class: 'row wrap', style: { marginTop: '6px', gap: '6px' } }, sourceBadge(d.match.source), d.confidence ? h('span', { class: `badge ${confCls}` }, confText) : null, d.match.location ? h('span', { class: 'badge' }, d.match.location) : null),
        ),
        h('button', { class: 'icon-btn', 'aria-label': `Remove ${d.match.name}`, onclick: () => (drafts.splice(i, 1), redraw()) }, '✕'),
      ),
      h(
        'div',
        { class: 'row wrap', style: { marginTop: '10px', gap: '10px' } },
        stepper(d.servings, (v) => {
          d.servings = v;
          redraw();
        }),
        h('span', { class: 'small muted' }, `× ${d.match.serving || 'serving'}`),
        h('span', { class: 'grow' }),
        kcalEl,
      ),
      d.alternatives.length || d.match.source !== 'custom'
        ? h(
            'div',
            { style: { marginTop: '8px' } },
            select(
              altOptions,
              'cur',
              (v) => {
                if (v === 'search') {
                  openSearchPicker(state.date, (food) => {
                    d.alternatives.unshift(d.match);
                    d.match = food;
                    d.confidence = null;
                    redraw();
                  });
                  return redraw();
                }
                const j = +v.slice(3);
                const alt = d.alternatives[j];
                d.alternatives[j] = d.match;
                d.match = alt;
                redraw();
              },
              { 'aria-label': 'Change match' },
            ),
          )
        : null,
    );
  }

  async function submit() {
    logBtn.disabled = true;
    try {
      await logFoods(
        drafts.map((d) => ({ ...d.match, servings: d.servings, confidence: d.confidence, photoId })),
        chosenMeal,
      );
      toast(`Logged ${drafts.length} item${drafts.length === 1 ? '' : 's'} to ${chosenMeal}`);
      onLogged?.();
    } catch (err) {
      toast(err.message, 'error');
      logBtn.disabled = false;
    }
  }

  // "Also on your plate?" — other likely menu items; tap to add.
  const suggestions = [...(result.suggestions ?? [])];
  const suggestionChips = h('div');
  const drawSuggestions = () => {
    suggestionChips.replaceChildren(
      ...(suggestions.length
        ? [
            h('div', { class: 'section-title', style: { marginTop: '14px' } }, 'Also on your plate? Tap to add'),
            h(
              'div',
              { class: 'row wrap', style: { gap: '6px' } },
              suggestions.map((food, i) =>
                h(
                  'button',
                  {
                    class: 'chip',
                    onclick: () => {
                      suggestions.splice(i, 1);
                      drafts.push({ match: food, alternatives: [], servings: 1, label: '', portion: '', confidence: null });
                      redraw();
                      drawSuggestions();
                    },
                  },
                  `＋ ${food.name}`,
                ),
              ),
            ),
          ]
        : []),
    );
  };

  redraw();
  drawSuggestions();

  return h(
    'div',
    { class: 'stack' },
    photoUrl ? h('img', { class: 'photo-preview compact', src: photoUrl, alt: 'Your plate' }) : null,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Here’s what I found'), result.likelyLocation ? h('span', { class: 'badge brand' }, `📍 ${result.likelyLocation}`) : null),
      h('div', { class: 'small', style: { marginBottom: '6px' } }, result.summary),
      result.notes ? h('div', { class: 'notice small', style: { margin: '8px 0' } }, '💡 ', result.notes) : null,
      list,
      suggestionChips,
      h('button', { class: 'btn ghost small', style: { marginTop: '6px' }, onclick: () => openSearchPicker(state.date, (food) => (drafts.push({ match: food, alternatives: [], servings: 1, label: '', portion: '', confidence: null }), redraw())) }, '＋ Add something it missed'),
    ),
    h('div', { class: 'totals-bar' }, totals, select(MEALS, chosenMeal, (v) => (chosenMeal = v), { 'aria-label': 'Meal' }), logBtn),
  );
}
