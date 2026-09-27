/* ═══════════════════════════════════════════════════════════════
   The graph: layout, rendering, pan/zoom, minimap.
   Knows nothing about panels or forms — it calls out through
   the handlers registered in `hooks`.
   ═══════════════════════════════════════════════════════════════ */

import {
  state, famColor, famVars, getPerson, getSpouses, getChildren, getGrandchildren,
  getDepth, neighbours, term,
} from './data.js';

const NS = 'http://www.w3.org/2000/svg';

const el = id => document.getElementById(id);
const canvas = el('canvas');
const canvasWrap = el('canvasWrap');
const minimapEl = el('minimap');
const minimapCanvas = el('minimapCanvas');
const minimapViewport = el('minimapViewport');
const emptyState = el('emptyState');

const NODE_W = 146;
const NODE_H = 118;
const COL_GAP = 182;      // horizontal spacing between siblings
const ROW_GAP = 210;      // vertical spacing between generations
const FAMILY_GAP = 240;   // gap between family bands

export const view = {
  filter: 'all',          // 'all' | a family slug
  layout: 'generation',   // 'generation' | 'year'
  focusId: null,
  timelineOn: false,
  timelineYear: new Date().getFullYear(),
  connectMode: false,
};

export const hooks = {
  onNodeClick: () => {},
  onConnectPick: () => {},
};

let positions = {};
let visible = [];
let panX = 0, panY = 0, zoom = 0.7;

export const currentYear = () => (view.timelineOn ? view.timelineYear : new Date().getFullYear());

// ═══════════════════════ Layout ═══════════════════════

function peopleForView() {
  let people = view.filter === 'all' ? state.people : state.people.filter(p => p.family === view.filter);
  if (view.timelineOn) people = people.filter(p => p.born == null || p.born <= view.timelineYear);
  return people;
}

/**
 * Generations run top to bottom across the whole graph; families sit in
 * side-by-side bands. Spouses are kept adjacent inside a row.
 */
function layoutByGeneration() {
  const people = peopleForView();
  const pos = {};
  if (!people.length) return { people, pos };

  const fams = [...new Set(people.map(p => p.family || '—'))]
    .sort((a, b) => state.families.indexOf(a) - state.families.indexOf(b));

  let cursorX = 0;
  fams.forEach(fam => {
    const famPeople = people.filter(p => (p.family || '—') === fam);
    const depths = [...new Set(famPeople.map(p => getDepth(p.id)))].sort((a, b) => a - b);

    const rows = depths.map(d => {
      const inRow = famPeople.filter(p => getDepth(p.id) === d);
      const ordered = [];
      const used = new Set();
      [...inRow].sort((a, b) => (a.born ?? 9999) - (b.born ?? 9999)).forEach(p => {
        if (used.has(p.id)) return;
        ordered.push(p); used.add(p.id);
        getSpouses(p.id).forEach(sp => {
          if (!used.has(sp.id) && inRow.some(x => x.id === sp.id)) { ordered.push(sp); used.add(sp.id); }
        });
      });
      return { d, ordered };
    });

    const bandW = Math.max(...rows.map(r => (r.ordered.length - 1) * COL_GAP), 0);
    const centreX = cursorX + bandW / 2;

    rows.forEach(({ d, ordered }) => {
      const startX = centreX - ((ordered.length - 1) * COL_GAP) / 2;
      ordered.forEach((p, i) => { pos[p.id] = { x: startX + i * COL_GAP, y: d * ROW_GAP }; });
    });

    cursorX += bandW + FAMILY_GAP;
  });

  return { people, pos };
}

/** Vertical axis is the birth year, so eras line up across families. */
function layoutByYear() {
  const people = peopleForView();
  const pos = {};
  const births = people.map(p => p.born).filter(Boolean);
  if (!births.length) return { people: [], pos };

  const minYear = Math.min(...births);
  const scale = 26;

  const fams = [...new Set(people.map(p => p.family || '—'))]
    .sort((a, b) => state.families.indexOf(a) - state.families.indexOf(b));

  fams.forEach((fam, fi) => {
    const baseX = fi * (COL_GAP * 3 + FAMILY_GAP);
    const taken = {};
    people
      .filter(p => (p.family || '—') === fam && p.born)
      .sort((a, b) => a.born - b.born)
      .forEach(p => {
        const y = (p.born - minYear) * scale;
        const key = Math.round(y / NODE_H);
        taken[key] = (taken[key] || 0) + 1;
        const n = taken[key] - 1;
        // fan out sideways when several people share a row
        const offset = n === 0 ? 0 : Math.ceil(n / 2) * COL_GAP * (n % 2 ? 1 : -1);
        pos[p.id] = { x: baseX + offset, y };
      });
  });

  return { people: people.filter(p => pos[p.id]), pos };
}

/** Rings of increasing relationship distance around one person. */
function layoutRadial(centreId) {
  const dist = { [centreId]: 0 };
  const queue = [centreId];
  while (queue.length) {
    const cur = queue.shift();
    for (const n of neighbours(cur)) {
      if (dist[n.id] === undefined) { dist[n.id] = dist[cur] + 1; queue.push(n.id); }
    }
  }

  let people = state.people.filter(p => dist[p.id] !== undefined);
  if (view.timelineOn) people = people.filter(p => p.born == null || p.born <= view.timelineYear);

  const rings = {};
  people.forEach(p => { (rings[dist[p.id]] ||= []).push(p); });

  const pos = { [centreId]: { x: 0, y: 0 } };
  Object.keys(rings).map(Number).sort((a, b) => a - b).forEach(d => {
    if (d === 0) return;
    const ring = rings[d].slice().sort((a, b) =>
      state.families.indexOf(a.family) - state.families.indexOf(b.family) || (a.born ?? 9999) - (b.born ?? 9999)
    );
    // Give each ring enough circumference that cards never overlap.
    const radius = Math.max(d * 300, (ring.length * (NODE_W + 34)) / (2 * Math.PI));
    ring.forEach((p, i) => {
      const angle = -Math.PI / 2 + (i / ring.length) * Math.PI * 2;
      pos[p.id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    });
  });

  return { people, pos };
}

// ═══════════════════════ Render ═══════════════════════

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function avatarHTML(p, cls = '') {
  return p.photo_url
    ? `<img src="${escapeAttr(p.photo_url)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${escapeAttr(initials(p.name))}'))">`
    : `<span class="${cls}">${escapeHTML(initials(p.name))}</span>`;
}

export const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeAttr = escapeHTML;

/** What to show under the name when nobody has typed a role. */
export function impliedRole(p) {
  if (p.role) return p.role;
  if (getGrandchildren(p.id).length) return term('grandparent', p);
  if (getChildren(p.id).length) return term('parent', p);
  return term('child', p);
}

function edgePath(a, b, type) {
  if (type === 'spouse') return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  // Parent -> child: drop out of the parent, run across, drop into the child.
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y - NODE_H / 2;
  if (y2 <= y1 + 4) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;  // radial / same-row: straight
  const mid = y1 + (y2 - y1) / 2;
  const r = Math.min(16, Math.abs(b.x - a.x) / 2, (y2 - y1) / 2);
  if (Math.abs(b.x - a.x) < 2) return `M ${a.x} ${y1} L ${b.x} ${y2}`;
  const dir = b.x > a.x ? 1 : -1;
  return `M ${a.x} ${y1} L ${a.x} ${mid - r} Q ${a.x} ${mid} ${a.x + r * dir} ${mid} ` +
         `L ${b.x - r * dir} ${mid} Q ${b.x} ${mid} ${b.x} ${mid + r} L ${b.x} ${y2}`;
}

export function render() {
  canvas.innerHTML = '';

  const result = view.focusId && getPerson(view.focusId)
    ? layoutRadial(view.focusId)
    : (view.layout === 'year' ? layoutByYear() : layoutByGeneration());

  positions = result.pos;
  visible = result.people.filter(p => positions[p.id]);

  const empty = visible.length === 0;
  emptyState.hidden = !empty;
  if (empty) {
    el('emptyStateSub').textContent = view.layout === 'year'
      ? 'Nobody here has a birth year yet, so the era layout has nothing to place. Switch back to "By generation", or add birth years.'
      : view.timelineOn
        ? `Nobody in this view was born before ${view.timelineYear}.`
        : 'Add someone to get started.';
    minimapEl.style.opacity = '0';
    return;
  }
  minimapEl.style.opacity = '';

  // ── edges ──
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'edges');
  let drawn = 0;
  state.relations.forEach(r => {
    const a = positions[r.a], b = positions[r.b];
    if (!a || !b) return;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('class', 'edge' + (r.type === 'spouse' ? ' marriage' : '') + (r.cross ? ' cross' : ''));
    path.setAttribute('d', edgePath(a, b, r.type));
    path.dataset.from = r.a; path.dataset.to = r.b;
    path.style.animationDelay = `${Math.min(drawn++ * 0.02, 0.9)}s`;
    svg.appendChild(path);
  });
  canvas.appendChild(svg);

  // ── nodes ──
  const yearNow = currentYear();
  visible.forEach((p, i) => {
    const pos = positions[p.id];
    const node = document.createElement('div');
    node.className = 'node' + (p.id === view.focusId ? ' focused' : '');
    node.style.cssText = `left:${pos.x}px;top:${pos.y}px;${famVars(p.family)}`;
    node.style.animationDelay = `${Math.min(i * 0.025 + 0.12, 1.1)}s`;
    node.dataset.id = p.id;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', p.name);

    const dead = p.died != null && (!view.timelineOn || p.died <= view.timelineYear);
    const age = p.born != null ? (dead && p.died != null ? p.died : yearNow) - p.born : null;
    const gender = p.gender === 'M' ? '<div class="gender-dot male" title="Male">♂</div>'
      : p.gender === 'F' ? '<div class="gender-dot female" title="Female">♀</div>'
      : '<div class="gender-dot missing" title="Gender not set">?</div>';

    node.innerHTML = `
      <div class="node-card">
        ${gender}
        ${dead ? '<div class="deceased-dot" title="No longer with us"></div>' : ''}
        <div class="photo">${avatarHTML(p)}</div>
        <div class="name">${escapeHTML(p.name)}</div>
        <div class="role">${escapeHTML(impliedRole(p))}</div>
        ${view.timelineOn && age != null ? `<div class="age">${age} yrs</div>` : ''}
      </div>`;

    const activate = e => {
      e.stopPropagation();
      if (view.connectMode) hooks.onConnectPick(p.id);
      else hooks.onNodeClick(p.id);
    };
    node.addEventListener('click', activate);
    node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); } });
    node.addEventListener('mouseenter', () => ripple(pos.x, pos.y));
    canvas.appendChild(node);
  });

  requestAnimationFrame(() => { fitToView(); renderMinimap(); });
}

function ripple(x, y) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.cssText = `left:${x}px;top:${y}px`;
  canvas.appendChild(r);
  setTimeout(() => r.remove(), 1100);
}

// ═══════════════════════ Pan & zoom ═══════════════════════

function applyTransform() {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  updateMinimapViewport();
}

function bounds() {
  const ids = Object.keys(positions);
  if (!ids.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  ids.forEach(id => {
    const p = positions[id];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  return { minX, maxX, minY, maxY };
}

/**
 * Frame the whole graph inside the area that the fixed chrome leaves free —
 * the top bar and toolbar above, the scrubber and zoom buttons below.
 */
export function fitToView() {
  const b = bounds();
  if (!b) return;
  const narrow = window.innerWidth < 860;

  const insetTop = narrow ? 126 : 142;
  const insetBottom = (view.timelineOn ? 150 : 56) + (narrow ? 40 : 0);
  const pad = 40;

  // Positions are card centres, so widen by half a card to get the visual edges.
  const left = b.minX - NODE_W / 2, right = b.maxX + NODE_W / 2;
  const top = b.minY - NODE_H / 2, bottom = b.maxY + NODE_H / 2;

  const viewW = canvasWrap.clientWidth;
  const availH = Math.max(160, canvasWrap.clientHeight - insetTop - insetBottom);

  zoom = Math.max(0.15, Math.min(
    viewW / ((right - left) + pad * 2),
    availH / ((bottom - top) + pad * 2),
    1.1
  ));
  panX = viewW / 2 - ((left + right) / 2) * zoom;
  panY = insetTop + availH / 2 - ((top + bottom) / 2) * zoom;
  applyTransform();
}

export function zoomBy(factor) {
  const old = zoom;
  zoom = Math.max(0.15, Math.min(3, zoom * factor));
  const cx = canvasWrap.clientWidth / 2, cy = canvasWrap.clientHeight / 2;
  panX = cx - (cx - panX) * (zoom / old);
  panY = cy - (cy - panY) * (zoom / old);
  applyTransform();
}

/** Slide a person to the centre of the screen without changing zoom. */
export function centreOn(id, targetZoom) {
  const p = positions[id];
  if (!p) return false;
  if (targetZoom) zoom = targetZoom;
  panX = canvasWrap.clientWidth / 2 - p.x * zoom;
  panY = canvasWrap.clientHeight / 2 - p.y * zoom;
  applyTransform();
  return true;
}

let dragging = false, sx = 0, sy = 0, spx = 0, spy = 0, moved = false;

canvasWrap.addEventListener('pointerdown', e => {
  if (e.target.closest('.node') || e.target.closest('.minimap')) return;
  dragging = true; moved = false;
  sx = e.clientX; sy = e.clientY; spx = panX; spy = panY;
  canvasWrap.classList.add('grabbing');
  canvasWrap.setPointerCapture(e.pointerId);
});
canvasWrap.addEventListener('pointermove', e => {
  if (!dragging) return;
  const dx = e.clientX - sx, dy = e.clientY - sy;
  if (!moved && Math.hypot(dx, dy) > 3) { moved = true; canvas.classList.add('notransition'); }
  if (!moved) return;
  panX = spx + dx; panY = spy + dy;
  applyTransform();
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  canvasWrap.classList.remove('grabbing');
  canvas.classList.remove('notransition');
};
canvasWrap.addEventListener('pointerup', endDrag);
canvasWrap.addEventListener('pointercancel', endDrag);

canvasWrap.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvasWrap.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const old = zoom;
  zoom = Math.max(0.15, Math.min(3, zoom * (1 - e.deltaY * 0.0012)));
  panX = mx - (mx - panX) * (zoom / old);
  panY = my - (my - panY) * (zoom / old);
  canvas.classList.add('notransition');
  applyTransform();
  clearTimeout(canvasWrap._zt);
  canvasWrap._zt = setTimeout(() => canvas.classList.remove('notransition'), 90);
}, { passive: false });

// Pinch to zoom
let pinchDist = 0, pinchZoom = 1;
canvasWrap.addEventListener('touchstart', e => {
  if (e.touches.length !== 2) return;
  dragging = false;
  pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  pinchZoom = zoom;
}, { passive: true });
canvasWrap.addEventListener('touchmove', e => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  zoom = Math.max(0.15, Math.min(3, pinchZoom * (d / pinchDist)));
  canvas.classList.add('notransition');
  applyTransform();
}, { passive: false });
canvasWrap.addEventListener('touchend', () => canvas.classList.remove('notransition'));

// ═══════════════════════ Minimap ═══════════════════════

export function renderMinimap() {
  const ctx = minimapCanvas.getContext('2d');
  const w = minimapCanvas.width, h = minimapCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const b = bounds();
  if (!b) return;
  const pad = 26;
  const scale = Math.min((w - pad * 2) / ((b.maxX - b.minX) || 1), (h - pad * 2) / ((b.maxY - b.minY) || 1));
  const X = x => (x - b.minX) * scale + pad;
  const Y = y => (y - b.minY) * scale + pad;

  const css = getComputedStyle(document.documentElement);
  const lineCol = css.getPropertyValue('--minimap-edge').trim();
  const accent = css.getPropertyValue('--accent-strong').trim();

  state.relations.forEach(r => {
    const a = positions[r.a], c = positions[r.b];
    if (!a || !c) return;
    ctx.beginPath();
    ctx.moveTo(X(a.x), Y(a.y));
    ctx.lineTo(X(c.x), Y(c.y));
    ctx.strokeStyle = r.cross ? accent : lineCol;
    ctx.lineWidth = r.cross ? 1.4 : 0.8;
    ctx.stroke();
  });

  visible.forEach(p => {
    const pos = positions[p.id];
    if (!pos) return;
    const focused = p.id === view.focusId;
    ctx.beginPath();
    ctx.arc(X(pos.x), Y(pos.y), focused ? 7 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = focused ? accent : famColor(p.family).hex;
    ctx.fill();
  });

  Object.assign(minimapEl.dataset, { minx: b.minX, miny: b.minY, scale, pad });
  updateMinimapViewport();
}

function updateMinimapViewport() {
  const d = minimapEl.dataset;
  if (!d.scale) return;
  // The minimap canvas is drawn at 2x its CSS size.
  const s = (+d.scale) / 2, pad = (+d.pad) / 2;
  const left = (-panX / zoom - +d.minx) * s + pad;
  const top = (-panY / zoom - +d.miny) * s + pad;
  minimapViewport.style.cssText =
    `left:${left}px;top:${top}px;width:${(canvasWrap.clientWidth / zoom) * s}px;height:${(canvasWrap.clientHeight / zoom) * s}px`;
}

minimapEl.addEventListener('click', e => {
  const d = minimapEl.dataset;
  if (!d.scale) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const s = (+d.scale) / 2, pad = (+d.pad) / 2;
  const cx = (e.clientX - rect.left - pad) / s + +d.minx;
  const cy = (e.clientY - rect.top - pad) / s + +d.miny;
  panX = canvasWrap.clientWidth / 2 - cx * zoom;
  panY = canvasWrap.clientHeight / 2 - cy * zoom;
  applyTransform();
});

// ═══════════════════════ Highlighting ═══════════════════════

export function clearHighlights() {
  canvas.querySelectorAll('.node, .edge').forEach(n => n.classList.remove('dim', 'highlight'));
}

/** Dim everything except the given people; used by "Find path" and search filtering. */
export function highlightSet(ids, { animate = false } = {}) {
  const keep = new Set(ids);
  canvas.querySelectorAll('.node').forEach(n => n.classList.toggle('dim', !keep.has(n.dataset.id)));
  canvas.querySelectorAll('.edge').forEach(p => p.classList.add('dim'));
  ids.forEach((id, i) => {
    const node = canvas.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
    if (!node) return;
    if (animate) setTimeout(() => node.classList.add('highlight'), i * 160);
    else node.classList.add('highlight');
  });
}

/** Light up the chain of edges along a path of people. */
export function highlightPath(path) {
  highlightSet(path, { animate: true });
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    setTimeout(() => {
      canvas.querySelectorAll('.edge').forEach(p => {
        if ((p.dataset.from === a && p.dataset.to === b) || (p.dataset.from === b && p.dataset.to === a)) {
          p.classList.remove('dim');
          p.classList.add('highlight');
        }
      });
    }, i * 160);
  }
}

export const isVisible = id => Boolean(positions[id]);

window.addEventListener('resize', () => {
  if (el('treeView').classList.contains('active')) { fitToView(); renderMinimap(); }
});
