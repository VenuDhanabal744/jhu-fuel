import { api } from '../api.js';
import { h, seg, select, toast, MEALS, fmtDate, todayStr } from '../ui.js';
import { renderReview } from '../review.js';
import { prepareImage } from '../image.js';

let locationsCache = null;

/** Start loading the recognizer and show download progress until it's ready. */
async function watchRecognizer(el) {
  const { loadModels, recognizerStatus } = await import('../recognize.js');
  loadModels().catch(() => {});
  const started = Date.now();
  const tick = () => {
    const st = recognizerStatus();
    if (st.state === 'ready') return el.replaceChildren();
    if (!el.isConnected && Date.now() - started > 3000) return; // user left the page
    if (st.state === 'error') {
      return el.replaceChildren(h('div', { class: 'notice warn small' }, `The food recognizer couldn’t load (${st.error}). Check your connection and reopen this tab.`));
    }
    const pct = Math.round(st.progress * 100);
    el.replaceChildren(
      h(
        'div',
        { class: 'notice small' },
        h('div', null, pct >= 99 ? '⏳ Almost ready…' : pct > 0 ? `⏳ Setting up the food recognizer — ${pct}%` : '⏳ Setting up the food recognizer…'),
        h('div', { class: 'tiny muted', style: { margin: '4px 0 8px' } }, 'One-time ~90 MB download (use Wi-Fi). After that it works in about a second, even offline.'),
        h('div', { class: 'bar thin' }, h('i', { style: { width: `${pct}%` } })),
      ),
    );
    setTimeout(tick, 400);
  };
  tick();
}

export async function render(ctx) {
  const { state } = ctx;
  const root = h('div', { class: 'stack' });
  locationsCache ??= await api('/locations').catch(() => []);

  let meal = state.meal;
  let location = localStorage.getItem('snap.location') || 'any';

  const header = h(
    'div',
    null,
    h('h1', { class: 'page-title' }, '📷 Snap your plate'),
    h('p', { class: 'muted small', style: { marginTop: '-8px' } }, `Your photo is matched against what JHU dining is serving ${state.date === todayStr() ? 'today' : `on ${fmtDate(state.date)}`}, so you get the menu’s real nutrition data. Runs free, right on your phone — no AI subscription.`),
  );

  const loadingNotice = h('div');
  watchRecognizer(loadingNotice);

  const fileCam = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden', onchange: (e) => handle(e.target.files[0]) });
  const fileLib = h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => handle(e.target.files[0]) });
  const stage = h('div');

  const drop = h(
    'div',
    {
      class: 'dropzone',
      role: 'button',
      tabindex: 0,
      onclick: () => fileCam.click(),
      onkeydown: (e) => e.key === 'Enter' && fileCam.click(),
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add('drag');
      },
      ondragleave: () => drop.classList.remove('drag'),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove('drag');
        handle(e.dataTransfer.files[0]);
      },
    },
    h('span', { class: 'ico' }, '📸'),
    h('b', null, 'Take a photo of your plate'),
    h('span', { class: 'small muted' }, 'Shoot from above with everything in frame.', h('span', { class: 'desktop-only' }, ' On a computer, drop an image here.')),
  );

  const controls = h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'field' }, h('span', null, 'Meal'), seg(MEALS, meal, (v) => ((meal = v), (state.meal = v)), 'full')),
    h(
      'label',
      { class: 'field' },
      h('span', null, 'Where are you eating? (picking one makes matches more accurate)'),
      select(
        [['any', 'Not sure — check every dining hall'], ...locationsCache.map((l) => [l.slug, l.name])],
        location,
        (v) => {
          location = v;
          localStorage.setItem('snap.location', v);
        },
      ),
    ),
  );

  const startScreen = () =>
    stage.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        controls,
        drop,
        h('div', { class: 'two-up' }, h('button', { class: 'btn', onclick: () => fileLib.click() }, '🖼 Choose from library'), h('button', { class: 'btn', onclick: () => ctx.go('add') }, '🔍 Search instead')),
      ),
    );

  async function handle(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('That file isn’t an image', 'error');
    let dataUrl;
    try {
      dataUrl = await prepareImage(file);
    } catch {
      return toast('Couldn’t read that image. Try a JPEG or PNG.', 'error');
    }
    const started = Date.now();
    const status = h('span', null, 'Looking at your plate…');
    const ticker = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      status.textContent = s < 4 ? 'Looking at your plate…' : `Still working… (${s}s)`;
    }, 1000);
    stage.replaceChildren(
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'analyzing' }, h('img', { class: 'photo-preview', src: dataUrl, alt: 'Your plate' })),
        h('div', { class: 'row', style: { justifyContent: 'center', color: 'var(--text-2)' } }, h('span', { class: 'spinner' }), status),
      ),
    );
    try {
      const result = await api('/analyze', {
        method: 'POST',
        body: { image: dataUrl, date: state.date, meal: meal === 'snack' ? null : meal, location },
      });
      clearInterval(ticker);
      stage.replaceChildren(
        renderReview(ctx, {
          result,
          photoId: result.photoId,
          photoUrl: dataUrl,
          meal,
          onLogged: () => ctx.go('today'),
        }),
        h('button', { class: 'btn ghost block', style: { marginTop: '10px' }, onclick: startScreen }, '↺ Retake photo'),
      );
    } catch (err) {
      clearInterval(ticker);
      toast(err.message, 'error');
      startScreen();
    } finally {
      fileCam.value = '';
      fileLib.value = '';
    }
  }

  startScreen();
  root.append(header, loadingNotice, stage, fileCam, fileLib);
  return root;
}
