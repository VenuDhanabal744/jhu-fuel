// Tiny DOM helpers - no framework.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs, true);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs, isSvg = false) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'class' && !isSvg) el.className = v;
    else if (!isSvg && k in el && typeof v !== 'string') el[k] = v;
    else if (!isSvg && (k === 'value' || k === 'checked' || k === 'selected')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2600);
}

/** Modal sheet. `content` is a node or a function(close) -> node. */
export function openSheet({ title, subtitle, content }) {
  const prevFocus = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    prevFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const body = typeof content === 'function' ? content(close) : content;
  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'div',
      { class: 'sheet-head' },
      h('div', { class: 'grow' }, h('h2', null, title), subtitle ? h('div', { class: 'small muted' }, subtitle) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕'),
    ),
    body,
  );
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close() }, sheet);
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKey);
  sheet.querySelector('input, select, button.primary')?.focus?.({ preventScroll: true });
  return { close };
}

export function stepper(value, onChange, { step = 0.25, min = 0.25, max = 20 } = {}) {
  const input = h('input', { type: 'number', inputmode: 'decimal', step, min, max, value, 'aria-label': 'Servings' });
  const set = (v) => {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    input.value = +v.toFixed(2);
    onChange(+input.value);
  };
  input.addEventListener('change', () => set(+input.value || min));
  return h(
    'div',
    { class: 'stepper' },
    h('button', { type: 'button', 'aria-label': 'Less', onclick: () => set(+input.value - (+input.value > 1 ? 0.5 : step)) }, '−'),
    input,
    h('button', { type: 'button', 'aria-label': 'More', onclick: () => set(+input.value + (+input.value >= 1 ? 0.5 : step)) }, '+'),
  );
}

export function select(options, value, onChange, attrs = {}) {
  return h(
    'select',
    { class: 'input', ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );
}

export function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'tablist' });
  for (const [v, label] of options) {
    const btn = h('button', { type: 'button', class: v === value ? 'on' : '', role: 'tab', 'aria-selected': String(v === value) }, label);
    btn.addEventListener('click', () => {
      for (const b of wrap.children) {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      }
      onChange(v);
    });
    wrap.append(btn);
  }
  return wrap;
}

// ---------- dates ----------

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

export function fmtDate(dateStr, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const t = todayStr();
  if (opts === 'relative') {
    if (dateStr === t) return 'Today';
    if (dateStr === addDays(t, -1)) return 'Yesterday';
    if (dateStr === addDays(t, 1)) return 'Tomorrow';
    opts = { weekday: 'short', month: 'short', day: 'numeric' };
  }
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, opts);
}

export const MEALS = [
  ['breakfast', 'Breakfast'],
  ['lunch', 'Lunch'],
  ['dinner', 'Dinner'],
  ['snack', 'Snacks'],
];
export const MEAL_ICONS = { breakfast: '🍳', lunch: '🥗', dinner: '🍝', snack: '🍎' };

export function defaultMeal(date = new Date()) {
  const mins = date.getHours() * 60 + date.getMinutes();
  if (mins < 10 * 60 + 30) return 'breakfast';
  if (mins < 15 * 60) return 'lunch';
  if (mins < 21 * 60) return 'dinner';
  return 'snack';
}

// Nutrislice "food icons" mix diet labels with allergens; show these as badges, the rest as "Contains".
export const DIET_ICONS = { Vegan: '🌱', Vegetarian: '🥕', Halal: '☪︎' };
