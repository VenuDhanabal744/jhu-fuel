import { api } from './api.js';
import { h, clear, toast, todayStr, addDays, fmtDate, defaultMeal } from './ui.js';
import * as today from './views/today.js';
import * as snap from './views/snap.js';
import * as menus from './views/menus.js';
import * as add from './views/add.js';
import * as progress from './views/progress.js';
import * as goals from './views/goals.js';

export const state = {
  date: todayStr(),
  meal: defaultMeal(),
  status: null, // { recognizer, configured }
  profile: null, // { profile, targets, currentWeightLb, bmr, tdee }
};

const ROUTES = {
  today: { view: today, label: 'Today', ico: '📊', dated: true },
  snap: { view: snap, label: 'Snap', ico: '📷', dated: true },
  menus: { view: menus, label: 'Menus', ico: '🏛', dated: true },
  add: { view: add, label: 'Add', ico: '＋', dated: true, hidden: true },
  progress: { view: progress, label: 'Progress', ico: '📈' },
  goals: { view: goals, label: 'Goals', ico: '🎯' },
};

export function go(route) {
  if (location.hash === `#/${route}`) render();
  else location.hash = `#/${route}`;
}

export async function refreshProfile() {
  state.profile = await api('/profile');
  return state.profile;
}

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES[name] ? name : 'today';
}

function renderNav(route) {
  const links = (cls) =>
    Object.entries(ROUTES)
      .filter(([, r]) => !r.hidden)
      .map(([name, r]) =>
        h(
          'a',
          { href: `#/${name}`, class: `navlink ${name === route || (route === 'add' && name === 'today') ? 'active' : ''} ${cls(name)}` },
          h('span', { class: 'ico', 'aria-hidden': 'true' }, r.ico),
          h('span', null, r.label),
        ),
      );
  clear(document.getElementById('topnav')).append(...links(() => ''));
  clear(document.getElementById('bottomnav')).append(...links((n) => (n === 'snap' ? 'snap' : '')));
}

function renderDateNav(route) {
  const el = clear(document.getElementById('datenav'));
  if (!ROUTES[route].dated) return;
  const picker = h('input', {
    type: 'date',
    value: state.date,
    onchange: (e) => e.target.value && setDate(e.target.value),
  });
  el.append(
    h('button', { 'aria-label': 'Previous day', onclick: () => setDate(addDays(state.date, -1)) }, '‹'),
    h(
      'button',
      { class: 'date-label', onclick: () => (picker.showPicker ? picker.showPicker() : picker.click()) },
      fmtDate(state.date, 'relative'),
    ),
    picker,
    h('button', { 'aria-label': 'Next day', onclick: () => setDate(addDays(state.date, 1)) }, '›'),
  );
  if (state.date !== todayStr()) el.append(h('button', { class: 'small', onclick: () => setDate(todayStr()) }, 'Today'));
}

function setDate(date) {
  state.date = date;
  render();
}

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  let route = currentRoute();
  if (state.status && !state.status.configured && route !== 'goals') {
    location.hash = '#/goals';
    return;
  }
  // No tab bar until the profile is set up - there's nothing to navigate to yet.
  document.body.classList.toggle('onboarding', !!state.status && !state.status.configured);
  renderNav(route);
  renderDateNav(route);
  const view = document.getElementById('view');
  clear(view).append(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  try {
    const node = await ROUTES[route].view.render({ state, go, render, refreshProfile });
    if (seq !== renderSeq) return;
    clear(view).append(node);
  } catch (err) {
    if (seq !== renderSeq) return;
    console.error(err);
    clear(view).append(
      h('div', { class: 'empty' }, h('span', { class: 'ico' }, '⚠️'), h('div', null, err.message), h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: render }, 'Retry')),
    );
  }
}

async function boot() {
  try {
    [state.status, state.profile] = await Promise.all([api('/status'), api('/profile')]);
  } catch (err) {
    toast(err.message, 'error');
  }
  window.addEventListener('hashchange', () => {
    window.scrollTo(0, 0);
    render();
  });
  // Roll the default date forward if the app stays open (or is reopened) past midnight.
  let lastToday = todayStr();
  const checkDay = () => {
    const t = todayStr();
    if (t !== lastToday) {
      if (state.date === lastToday) state.date = t;
      lastToday = t;
      render();
    }
  };
  setInterval(checkDay, 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkDay());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
}

boot();
