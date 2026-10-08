// Small SVG charts drawn at the container's real pixel width (so text stays legible),
// with hover tooltips. Colors come from CSS tokens in app.css.

import { h, s, clear } from './ui.js';

function responsive(draw) {
  const wrap = h('div', { class: 'chart' });
  let lastW = 0;
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w > 0 && w !== lastW) {
      lastW = w;
      clear(wrap);
      draw(wrap, w);
    }
  }).observe(wrap);
  return wrap;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= count) ?? 10 * mag;
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(+v.toFixed(6));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function tooltip(wrap) {
  const tip = h('div', { class: 'tooltip hidden', role: 'status' });
  wrap.append(tip);
  return {
    show(x, y, content) {
      tip.replaceChildren(...content);
      tip.classList.remove('hidden');
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(x, half), wrap.clientWidth - half)}px`;
      tip.style.top = `${y - 8}px`;
    },
    hide() {
      tip.classList.add('hidden');
    },
  };
}

/** Rounded-top bar anchored to the baseline. */
function barPath(x, y, w, hgt, r = 4) {
  r = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hgt} Z`;
}

/**
 * @param data [{ label, value|null, tip: () => Node[] }]
 * @param opts { target, targetLabel, color, height, format }
 */
export function barChart(data, { target = null, targetLabel = 'Goal', color = 'var(--series-1)', height = 190, format = (v) => Math.round(v).toLocaleString() } = {}) {
  return responsive((wrap, W) => {
    const m = { l: 44, r: 10, t: 18, b: 24 };
    const pw = W - m.l - m.r;
    const ph = height - m.t - m.b;
    const maxVal = Math.max(1, ...data.map((d) => d.value ?? 0), target ?? 0);
    const ticks = niceTicks(0, maxVal * 1.05);
    const yMax = ticks[ticks.length - 1];
    const y = (v) => m.t + ph - (v / yMax) * ph;
    const band = pw / Math.max(1, data.length);
    const gap = Math.max(2, band * 0.28);
    const bw = Math.max(2, Math.min(34, band - gap));
    const every = Math.ceil(data.length / Math.max(1, Math.floor(pw / 46)));

    const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img' });
    for (const t of ticks) {
      svg.append(
        s('line', { class: t === 0 ? 'baseline' : 'gridline', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }),
        s('text', { class: 'tick', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, format(t)),
      );
    }
    const tip = tooltip(wrap);
    data.forEach((d, i) => {
      const cx = m.l + band * i + band / 2;
      if (d.value != null && d.value > 0) {
        const top = y(d.value);
        svg.append(s('path', { d: barPath(cx - bw / 2, top, bw, m.t + ph - top), fill: color }));
      }
      if (i % every === 0 || data.length <= 10) {
        svg.append(s('text', { class: 'tick', x: cx, y: height - 6, 'text-anchor': 'middle' }, d.label));
      }
      const hit = s('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ph });
      const show = () => tip.show(cx, d.value ? y(d.value) : m.t + ph, d.tip());
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('click', show);
      hit.addEventListener('mouseleave', tip.hide);
      svg.append(hit);
    });
    if (target) {
      svg.append(
        s('line', { class: 'target', x1: m.l, x2: W - m.r, y1: y(target), y2: y(target) }),
        s('text', { class: 'target-label', x: W - m.r, y: y(target) - 5, 'text-anchor': 'end' }, `${targetLabel} ${format(target)}`),
      );
    }
    svg.addEventListener('mouseleave', tip.hide);
    wrap.prepend(svg);
  });
}

/**
 * @param points [{ date: 'YYYY-MM-DD', value }]
 * @param opts { target, domain: [from, to], height, unit }
 */
export function lineChart(points, { target = null, domain, height = 220, unit = 'lb', color = 'var(--series-1)' } = {}) {
  return responsive((wrap, W) => {
    const m = { l: 44, r: 14, t: 18, b: 24 };
    const pw = W - m.l - m.r;
    const ph = height - m.t - m.b;
    const t = (d) => new Date(`${d}T12:00:00`).getTime();
    const [x0, x1] = domain ? domain.map(t) : [t(points[0].date), t(points[points.length - 1].date)];
    const vals = points.map((p) => p.value).concat(target ?? []);
    const ticks = niceTicks(Math.min(...vals) - 1, Math.max(...vals) + 1, 4);
    const [y0, y1] = [ticks[0], ticks[ticks.length - 1]];
    const x = (d) => m.l + (x1 === x0 ? pw / 2 : ((t(d) - x0) / (x1 - x0)) * pw);
    const y = (v) => m.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;

    const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img' });
    for (const tk of ticks) {
      svg.append(
        s('line', { class: tk === y0 ? 'baseline' : 'gridline', x1: m.l, x2: W - m.r, y1: y(tk), y2: y(tk) }),
        s('text', { class: 'tick', x: m.l - 6, y: y(tk) + 4, 'text-anchor': 'end' }, tk.toLocaleString()),
      );
    }
    // x labels: start, middle, end
    const fmtD = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const xs = x1 === x0 ? [x0] : [x0, (x0 + x1) / 2, x1];
    xs.forEach((ms, i) => {
      const px = x1 === x0 ? m.l + pw / 2 : m.l + ((ms - x0) / (x1 - x0)) * pw;
      svg.append(s('text', { class: 'tick', x: px, y: height - 6, 'text-anchor': xs.length === 1 ? 'middle' : ['start', 'middle', 'end'][i] }, fmtD(ms)));
    });
    if (target != null) {
      svg.append(
        s('line', { class: 'target', x1: m.l, x2: W - m.r, y1: y(target), y2: y(target) }),
        s('text', { class: 'target-label', x: W - m.r, y: y(target) - 5, 'text-anchor': 'end' }, `Goal ${target} ${unit}`),
      );
    }
    if (points.length > 1) {
      svg.append(
        s('path', {
          d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date)},${y(p.value)}`).join(' '),
          fill: 'none',
          stroke: color,
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }),
      );
    }
    for (const p of points) {
      svg.append(s('circle', { cx: x(p.date), cy: y(p.value), r: 4, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));
    }
    const cross = s('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ph, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
    svg.append(cross);
    const tip = tooltip(wrap);
    const overlay = s('rect', { class: 'hit', x: m.l, y: m.t, width: pw, height: ph });
    const move = (evt) => {
      const rect = svg.getBoundingClientRect();
      const mx = evt.clientX - rect.left;
      let best = points[0];
      for (const p of points) if (Math.abs(x(p.date) - mx) < Math.abs(x(best.date) - mx)) best = p;
      cross.setAttribute('x1', x(best.date));
      cross.setAttribute('x2', x(best.date));
      cross.setAttribute('visibility', 'visible');
      tip.show(x(best.date), y(best.value), [
        h('div', { class: 'muted' }, new Date(`${best.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })),
        h('b', null, `${best.value} ${unit}`),
      ]);
    };
    overlay.addEventListener('mousemove', move);
    overlay.addEventListener('click', move);
    overlay.addEventListener('mouseleave', () => {
      cross.setAttribute('visibility', 'hidden');
      tip.hide();
    });
    svg.append(overlay);
    wrap.prepend(svg);
  });
}

/** Circular progress ring. */
export function ring(pct, { size = 150, stroke = 12, color = 'var(--brand)' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  return s(
    'svg',
    { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
    s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': stroke }),
    clamped > 0 && s('circle', {
      cx: size / 2,
      cy: size / 2,
      r,
      fill: 'none',
      stroke: color,
      'stroke-width': stroke,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${c * clamped} ${c}`,
    }),
  );
}
