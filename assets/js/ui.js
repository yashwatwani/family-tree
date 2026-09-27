/* ═══════════════════════════════════════════════════════════════
   Shared UI: theme, toasts, drawers, modals, the overview
   screen, the timeline scrubber and the ambient particles.
   ═══════════════════════════════════════════════════════════════ */

import { state, famVars, setColorTheme, getDepth } from './data.js';
import { escapeHTML } from './graph.js';

export const el = id => document.getElementById(id);
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ═══════════════════════ Theme ═══════════════════════

const themeListeners = new Set();
export const onThemeChange = fn => themeListeners.add(fn);

export function getTheme() { return document.documentElement.dataset.theme || 'dark'; }

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  setColorTheme(theme);
  try { localStorage.setItem('ft-theme', theme); } catch (e) {}
  themeListeners.forEach(fn => fn(theme));
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  toast(next === 'light' ? 'Light — heirloom paper' : 'Dark — midnight');
}

// ═══════════════════════ Toast ═══════════════════════

let toastTimer;
export function toast(msg, kind = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'bad' ? 5200 : 2600);
}

// ═══════════════════════ Drawers ═══════════════════════

const DRAWERS = ['panel', 'statsPanel', 'adminPanel'];

export function openDrawer(id) {
  DRAWERS.forEach(d => { if (d !== id) el(d).classList.remove('show'); });
  el(id).classList.add('show');
  el('backdrop').classList.add('show');
}

export function closeDrawers() {
  DRAWERS.forEach(d => el(d).classList.remove('show'));
  el('backdrop').classList.remove('show');
}

export const anyDrawerOpen = () => DRAWERS.some(d => el(d).classList.contains('show'));

// ═══════════════════════ Modal ═══════════════════════

let modalOnClose = null;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.sub]
 * @param {HTMLElement|string} opts.body
 * @param {Array<{label:string, kind?:string, id?:string, onClick?:Function}>} [opts.actions]
 */
export function openModal({ title, sub = '', body, actions = [], onClose = null }) {
  el('modalTitle').textContent = title;
  el('modalSub').innerHTML = sub;
  el('modalSub').style.display = sub ? '' : 'none';

  const host = el('modalBody');
  host.innerHTML = '';
  if (typeof body === 'string') host.innerHTML = body;
  else if (body) host.appendChild(body);

  const foot = el('modalFoot');
  foot.innerHTML = '';
  actions.forEach(a => {
    if (a.spacer) { const s = document.createElement('div'); s.className = 'spacer'; foot.appendChild(s); return; }
    const b = document.createElement('button');
    b.className = 'btn' + (a.kind ? ' ' + a.kind : '');
    b.textContent = a.label;
    if (a.id) b.id = a.id;
    b.addEventListener('click', () => a.onClick?.(b));
    foot.appendChild(b);
  });
  foot.style.display = actions.length ? '' : 'none';

  modalOnClose = onClose;
  el('modal').classList.add('show');
  el('modalBackdrop').classList.add('show');
  setTimeout(() => host.querySelector('input, textarea, select')?.focus(), 90);
}

export function closeModal() {
  el('modal').classList.remove('show');
  el('modalBackdrop').classList.remove('show');
  const fn = modalOnClose;
  modalOnClose = null;
  fn?.();
}

export const modalOpen = () => el('modal').classList.contains('show');

/** Small confirm dialog that resolves true/false. */
export function confirmDialog({ title, sub, confirmLabel = 'Delete', kind = 'danger' }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; closeModal(); resolve(v); };
    openModal({
      title, sub, body: '',
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: () => finish(false) },
        { label: confirmLabel, kind, onClick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

// ═══════════════════════ Overview ═══════════════════════

export function renderGalaxy(onFamilyClick) {
  const cfg = window.FT_CONFIG || {};
  el('brandMark').textContent = cfg.siteTitle || 'Our Families';
  el('galaxyHeadline').textContent = cfg.headline || 'One family, many branches';

  const fams = state.families;
  el('galaxyDeck').textContent = fams.length
    ? fams.map(f => f.charAt(0).toUpperCase() + f.slice(1)).join(' · ')
    : 'Nobody here yet';

  const inner = el('galaxyInner');
  inner.innerHTML = '';
  fams.forEach((fam, i) => {
    const count = state.people.filter(p => p.family === fam).length;
    const node = document.createElement('button');
    node.className = 'cluster';
    node.setAttribute('role', 'listitem');
    node.style.cssText = famVars(fam);
    node.style.animationDelay = `${0.3 + i * 0.16}s`;
    node.innerHTML = `
      <span class="orbit"></span>
      <span class="label">${escapeHTML(fam)}</span>
      <span class="count">${count} ${count === 1 ? 'person' : 'people'}</span>`;
    if (!reduceMotion()) {
      const orbit = node.querySelector('.orbit');
      const dots = Math.min(12, Math.max(4, count));
      for (let d = 0; d < dots; d++) {
        const s = document.createElement('span');
        const angle = (d / dots) * Math.PI * 2;
        const r = 38 + Math.random() * 12;
        s.style.cssText =
          `left:calc(50% + ${Math.cos(angle) * r}%);top:calc(50% + ${Math.sin(angle) * r}%);` +
          `opacity:${0.35 + Math.random() * 0.4};animation-delay:${Math.random() * 8}s`;
        orbit.appendChild(s);
      }
    }
    node.addEventListener('click', () => onFamilyClick(fam));
    inner.appendChild(node);
  });

  const gens = new Set(state.people.map(p => getDepth(p.id))).size;
  const crosses = state.relations.filter(r => r.cross).length;
  const stories = Object.values(state.stories).reduce((n, l) => n + l.length, 0);

  const stats = [
    { n: state.people.length, l: 'people' },
    { n: gens, l: 'generations' },
    { n: state.relations.length, l: 'connections' },
    { n: crosses, l: crosses === 1 ? 'family joined' : 'families joined' },
  ];
  if (stories) stats.push({ n: stories, l: 'stories' });

  el('galaxyStats').innerHTML = stats
    .map(s => `<div class="stat"><div class="num">${s.n}</div><div class="lab">${s.l}</div></div>`)
    .join('');
}

// ═══════════════════════ Timeline scrubber ═══════════════════════

export function setupTimeline(onYearChange) {
  const input = el('tsInput');
  const years = state.people.flatMap(p => [p.born, p.died]).filter(Boolean);
  const min = years.length ? Math.min(...years) : 1900;
  const max = Math.max(new Date().getFullYear(), years.length ? Math.max(...years) : 0);

  input.min = min; input.max = max; input.value = max;

  const span = max - min || 1;
  el('tsLegend').innerHTML = [min, min + Math.round(span / 3), min + Math.round((span * 2) / 3), 'today']
    .map(v => `<span>${v}</span>`).join('');

  const events = state.people.flatMap(p => [
    p.born ? { year: p.born } : null,
    p.died ? { year: p.died } : null,
  ].filter(Boolean));
  el('tsEvents').innerHTML = events
    .map(e => `<div class="ts-event-dot" style="left:${((e.year - min) / span) * 100}%" data-year="${e.year}"></div>`)
    .join('');

  const paint = () => {
    const y = +input.value;
    el('tsYear').textContent = y;
    const pct = ((y - min) / span) * 100;
    el('tsFill').style.width = pct + '%';
    el('tsThumb').style.left = pct + '%';
    el('tsEvents').querySelectorAll('.ts-event-dot').forEach(d => {
      d.classList.toggle('active', +d.dataset.year <= y);
    });
    return y;
  };

  input.oninput = () => onYearChange(paint());
  paint();
  return { min, max };
}

// ═══════════════════════ Particles ═══════════════════════

export function startParticles() {
  if (reduceMotion()) return;
  const cv = el('particles');
  const ctx = cv.getContext('2d');
  let dots = [];

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = window.innerWidth * dpr;
    cv.height = window.innerHeight * dpr;
    cv.style.width = window.innerWidth + 'px';
    cv.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const count = window.innerWidth < 860 ? 36 : 78;
  for (let i = 0; i < count; i++) {
    dots.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.08,
      vy: (Math.random() - 0.5) * 0.08,
      size: Math.random() * 1.4 + 0.3,
      alpha: Math.random() * 0.34 + 0.05,
      phase: Math.random() * Math.PI * 2,
      speed: 0.01 + Math.random() * 0.02,
    });
  }

  let rgb = '232, 227, 211', mult = 1;
  const readTheme = () => {
    const css = getComputedStyle(document.documentElement);
    rgb = css.getPropertyValue('--particle').trim() || rgb;
    mult = parseFloat(css.getPropertyValue('--particle-opacity')) || 1;
  };
  readTheme();
  onThemeChange(() => setTimeout(readTheme, 30));

  (function frame() {
    const w = window.innerWidth, h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy; d.phase += d.speed;
      if (d.x < 0) d.x = w; else if (d.x > w) d.x = 0;
      if (d.y < 0) d.y = h; else if (d.y > h) d.y = 0;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb}, ${d.alpha * (0.5 + 0.5 * Math.sin(d.phase)) * mult})`;
      ctx.fill();
    }
    requestAnimationFrame(frame);
  })();
}

// ═══════════════════════ Small helpers ═══════════════════════

/** Build a form field. Returns the wrapper; the control is `.control`. */
export function field({ label, name, type = 'text', value = '', placeholder = '', hint = '', list = null, rows = 0 }) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const id = `f-${name}`;
  wrap.innerHTML = `<label for="${id}">${escapeHTML(label)}</label>` +
    (rows
      ? `<textarea id="${id}" name="${name}" rows="${rows}" placeholder="${escapeHTML(placeholder)}"></textarea>`
      : `<input id="${id}" name="${name}" type="${type}" placeholder="${escapeHTML(placeholder)}"${list ? ` list="${list}"` : ''} autocomplete="off">`) +
    (hint ? `<div class="hint">${hint}</div>` : '') +
    `<div class="err"></div>`;
  const control = wrap.querySelector('input, textarea');
  control.value = value ?? '';
  wrap.control = control;
  return wrap;
}

/** Segmented single-choice control. `wrap.value` reads the selection. */
export function segmented({ label, options, value = '', hint = '' }) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.innerHTML = `<label>${escapeHTML(label)}</label><div class="seg"></div>` +
    (hint ? `<div class="hint">${hint}</div>` : '');
  const seg = wrap.querySelector('.seg');
  let current = value;
  options.forEach(o => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.dataset.value = o.value;
    b.className = o.value === current ? 'on' : '';
    b.addEventListener('click', () => {
      current = o.value;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.value === current));
      wrap.dispatchEvent(new CustomEvent('change', { detail: current }));
    });
    seg.appendChild(b);
  });
  Object.defineProperty(wrap, 'value', { get: () => current, set: v => {
    current = v;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.value === current));
  } });
  return wrap;
}

export function setFieldError(fieldEl, msg) {
  fieldEl.classList.toggle('error', Boolean(msg));
  const err = fieldEl.querySelector('.err');
  if (err) err.textContent = msg || '';
}

export function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
