/* ═══════════════════════════════════════════════════════════════
   Wiring. Everything else stays unaware of everything else;
   this file is where they meet.
   ═══════════════════════════════════════════════════════════════ */

import {
  state, load, onChange, getPerson, findPath, describePath, famVars, hasBackend,
} from './data.js';
import {
  view, hooks as graphHooks, render, fitToView, zoomBy, centreOn,
  clearHighlights, highlightSet, highlightPath, escapeHTML, avatarHTML, isVisible,
} from './graph.js';
import { buildIndex, search, highlight, personLine } from './search.js';
import {
  el, setTheme, getTheme, toggleTheme, onThemeChange, toast, openDrawer, closeDrawers,
  anyDrawerOpen, closeModal, modalOpen, renderGalaxy, setupTimeline, startParticles,
} from './ui.js';
import { openPerson, openStats, hooks as panelHooks, openPersonId } from './panel.js';
import {
  openAdmin, openPersonForm, openRelativeForm, openStoryForm, hooks as editorHooks,
} from './editor.js';

const galaxy = el('galaxy');
const treeView = el('treeView');

// ═══════════════════════ Views ═══════════════════════

function enterTree(filter = 'all') {
  view.filter = filter;
  view.focusId = null;
  setConnectMode(false);
  galaxy.classList.add('hidden');
  treeView.classList.add('active');
  paintFilters();
  setTimeout(render, 200);
}

function exitToOverview() {
  treeView.classList.remove('active');
  galaxy.classList.remove('hidden');
  view.focusId = null;
  setConnectMode(false);
  setTimelineMode(false);
  el('focusBanner').classList.remove('show');
}

const inTree = () => treeView.classList.contains('active');

// ═══════════════════════ Toolbar ═══════════════════════

function paintFilters() {
  const host = el('famFilters');
  const buttons = [{ value: 'all', label: 'Everyone' },
    ...state.families.map(f => ({ value: f, label: f }))];
  host.innerHTML = buttons
    .map(b => `<button data-filter="${escapeHTML(b.value)}" class="${b.value === view.filter ? 'active' : ''}">${escapeHTML(b.label)}</button>`)
    .join('');
  host.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      view.filter = btn.dataset.filter;
      view.focusId = null;
      setConnectMode(false);
      el('focusBanner').classList.remove('show');
      paintFilters();
      render();
    });
  });
  host.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

el('layoutToggle').addEventListener('click', () => {
  view.layout = view.layout === 'generation' ? 'year' : 'generation';
  const btn = el('layoutToggle');
  btn.textContent = view.layout === 'year' ? 'By era' : 'By generation';
  btn.classList.toggle('active', view.layout === 'year');
  toast(view.layout === 'year' ? 'Laid out by birth year' : 'Laid out by generation');
  render();
});

// ═══════════════════════ Find path ═══════════════════════

let picks = [];

function setConnectMode(on) {
  view.connectMode = on;
  picks = [];
  el('connectBtn').classList.toggle('active', on);
  const banner = el('connectBanner');
  banner.classList.toggle('show', on);
  if (on) {
    banner.textContent = 'Pick the first person…';
    el('focusBanner').classList.remove('show');
  } else {
    clearHighlights();
  }
}

el('connectBtn').addEventListener('click', () => {
  if (!view.connectMode && view.focusId) { view.focusId = null; render(); }
  setConnectMode(!view.connectMode);
});

graphHooks.onConnectPick = id => {
  const banner = el('connectBanner');
  picks.push(id);

  if (picks.length === 1) {
    highlightSet([id]);
    banner.textContent = `${getPerson(id).name} → now pick the second person…`;
    return;
  }

  const path = findPath(picks[0], picks[1]);
  const [a, b] = picks.map(getPerson);
  picks = [];

  if (!path) {
    clearHighlights();
    banner.innerHTML = `<strong>${escapeHTML(a.name)}</strong> and <strong>${escapeHTML(b.name)}</strong> are not connected in the tree yet. Pick another pair…`;
    return;
  }

  clearHighlights();
  highlightPath(path);
  const steps = path.length - 1;
  setTimeout(() => {
    banner.innerHTML =
      `<span>${escapeHTML(describePath(path))}</span>` +
      `<span style="color:var(--ink-faint)">· ${steps} step${steps === 1 ? '' : 's'}</span>`;
  }, steps * 160 + 120);
};

graphHooks.onNodeClick = id => openPerson(id);

// ═══════════════════════ Focus ═══════════════════════

panelHooks.onFocus = id => {
  view.focusId = id;
  setConnectMode(false);
  closeDrawers();
  render();
  el('focusBanner').classList.add('show');
  el('focusWho').textContent = getPerson(id).name;
  toast(`Everyone, ranked by closeness to ${getPerson(id).name}`);
};

panelHooks.onResetFocus = () => {
  view.focusId = null;
  closeDrawers();
  el('focusBanner').classList.remove('show');
  render();
};

el('focusClear').addEventListener('click', () => panelHooks.onResetFocus());

// ═══════════════════════ Timeline ═══════════════════════

function setTimelineMode(on) {
  view.timelineOn = on;
  el('timelineBtn').classList.toggle('active', on);
  el('timelineScrubber').classList.toggle('show', on);
  if (inTree()) render();
}

el('timelineBtn').addEventListener('click', () => {
  if (!inTree()) enterTree(view.filter);
  setTimelineMode(!view.timelineOn);
});

// ═══════════════════════ Search palette ═══════════════════════

const palette = el('palette');
const paletteInput = el('paletteInput');
const paletteResults = el('paletteResults');
let flat = [];
let cursor = 0;

function openPalette(prefill = '') {
  paletteInput.value = prefill;
  palette.classList.add('show');
  el('paletteBackdrop').classList.add('show');
  drawPalette();
  setTimeout(() => paletteInput.focus(), 60);
}

function closePalette() {
  palette.classList.remove('show');
  el('paletteBackdrop').classList.remove('show');
}

const paletteIsOpen = () => palette.classList.contains('show');

function drawPalette() {
  const q = paletteInput.value;
  const groups = search(q);
  flat = groups.flatMap(g => g.items);
  cursor = 0;

  if (!flat.length) {
    paletteResults.innerHTML = `
      <div class="pr-empty">
        <div class="big">Nothing matches “${escapeHTML(q)}”</div>
        <div class="small">Try a first name, a city, a year, or part of a story.</div>
      </div>`;
    el('paletteCount').textContent = '';
    return;
  }

  let i = 0;
  paletteResults.innerHTML = groups.map(g => `
    <div class="pr-group-label">${g.label}</div>
    ${g.items.map(item => renderResult(item, q, i++)).join('')}
  `).join('');

  paletteResults.querySelectorAll('.pr-item').forEach(node => {
    node.addEventListener('click', () => choose(+node.dataset.i));
    node.addEventListener('mousemove', () => setCursor(+node.dataset.i));
  });
  el('paletteCount').textContent = `${flat.length} result${flat.length === 1 ? '' : 's'}`;
  setCursor(0);
}

const KIND_ICON = { place: '⌖', year: '◷', family: '❖', story: '❝', marriage: '∞' };

function renderResult(item, q, i) {
  const p = item.person;
  const avatar = item.kind === 'person' && p
    ? `<span class="pr-av" style="${famVars(p.family)}">${avatarHTML(p)}</span>`
    : `<span class="pr-av square">${KIND_ICON[item.kind] || '•'}</span>`;

  const subtitle = item.kind === 'person' && p ? personLine(p) : item.subtitle;

  return `
    <button class="pr-item" data-i="${i}">
      ${avatar}
      <span class="pr-text">
        <span class="pr-name">${highlight(item.title, q, escapeHTML)}</span>
        <span class="pr-meta">${highlight(subtitle, q, escapeHTML)}</span>
      </span>
      ${item.kind !== 'person' ? `<span class="pr-kind">${item.kind}</span>` : ''}
    </button>`;
}

function setCursor(i) {
  cursor = Math.max(0, Math.min(flat.length - 1, i));
  paletteResults.querySelectorAll('.pr-item').forEach(n => n.classList.toggle('sel', +n.dataset.i === cursor));
  paletteResults.querySelector('.pr-item.sel')?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const item = flat[i];
  if (!item) return;
  closePalette();

  switch (item.kind) {
    case 'person':
    case 'story':
    case 'marriage': {
      const id = item.payload.personId;
      if (!inTree()) enterTree('all');
      setTimeout(() => {
        if (!isVisible(id)) { view.filter = 'all'; view.focusId = null; paintFilters(); render(); }
        setTimeout(() => { centreOn(id); openPerson(id); }, 320);
      }, inTree() ? 0 : 260);
      break;
    }
    case 'family':
      enterTree(item.payload.family);
      break;
    case 'place': {
      const ids = item.payload.people;
      if (!inTree()) enterTree('all'); else { view.filter = 'all'; view.focusId = null; paintFilters(); render(); }
      setTimeout(() => {
        clearHighlights();
        highlightSet(ids);
        toast(`${ids.length} ${ids.length === 1 ? 'person' : 'people'} in ${item.title} — click anywhere to clear`);
      }, 420);
      break;
    }
    case 'year':
      if (!inTree()) enterTree('all');
      setTimeout(() => {
        el('tsInput').value = item.payload.year;
        el('tsInput').dispatchEvent(new Event('input'));
        setTimelineMode(true);
        toast(`The tree as it stood in ${item.payload.year}`);
      }, 300);
      break;
  }
}

paletteInput.addEventListener('input', drawPalette);
paletteInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(cursor + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(cursor - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(cursor); }
  else if (e.key === 'Escape') closePalette();
});
el('searchTrigger').addEventListener('click', () => openPalette());
el('paletteBackdrop').addEventListener('click', closePalette);

// Clicking empty canvas clears a place highlight.
el('canvasWrap').addEventListener('click', e => {
  if (e.target.closest('.node')) return;
  if (!view.connectMode) clearHighlights();
});

// ═══════════════════════ Chrome ═══════════════════════

el('brand').addEventListener('click', exitToOverview);
el('treeBack').addEventListener('click', exitToOverview);
el('zoomIn').addEventListener('click', () => zoomBy(1.25));
el('zoomOut').addEventListener('click', () => zoomBy(0.8));
el('zoomFit').addEventListener('click', fitToView);
el('themeBtn').addEventListener('click', toggleTheme);
el('adminBtn').addEventListener('click', openAdmin);
el('statsBtn').addEventListener('click', () => openStats(id => { closeDrawers(); setTimeout(() => openPerson(id), 240); }));

el('backdrop').addEventListener('click', closeDrawers);
el('modalBackdrop').addEventListener('click', closeModal);
el('modalClose').addEventListener('click', closeModal);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeDrawers));

onThemeChange(() => {
  renderGalaxy(fam => enterTree(fam));
  if (inTree()) render();
});

// ═══════════════════════ Editor wiring ═══════════════════════

panelHooks.onEditPerson = id => openPersonForm(id);
panelHooks.onAddRelative = id => openRelativeForm(id);
panelHooks.onAddStory = id => openStoryForm(id);
panelHooks.afterChange = refreshAll;

editorHooks.afterChange = refreshAll;
editorHooks.openPerson = id => openPerson(id);

function refreshAll() {
  buildIndex();
  renderGalaxy(fam => enterTree(fam));
  paintFilters();
  el('adminBtn').classList.toggle('unlocked', state.writable);
  if (inTree()) render();
}

onChange(() => { buildIndex(); });

// ═══════════════════════ Keyboard ═══════════════════════

window.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteIsOpen() ? closePalette() : openPalette();
    return;
  }

  if (e.key === 'Escape') {
    if (paletteIsOpen()) closePalette();
    else if (modalOpen()) closeModal();
    else if (anyDrawerOpen()) closeDrawers();
    else if (view.connectMode) setConnectMode(false);
    else if (inTree()) exitToOverview();
    return;
  }

  if (typing || modalOpen() || paletteIsOpen()) return;

  switch (e.key) {
    case '/': e.preventDefault(); openPalette(); break;
    case ' ': if (!inTree()) { e.preventDefault(); enterTree('all'); } break;
    case 'f': case 'F': if (inTree()) fitToView(); break;
    case '+': case '=': if (inTree()) zoomBy(1.25); break;
    case '-': case '_': if (inTree()) zoomBy(0.8); break;
    case 't': case 'T': el('timelineBtn').click(); break;
    case 'l': case 'L': toggleTheme(); break;
    case 'a': case 'A': if (state.writable) openPersonForm(); break;
    case '?': toast('⌘K search · space enter · f fit · +/− zoom · t time · l theme · esc back'); break;
  }
});

// ═══════════════════════ Boot ═══════════════════════

async function boot() {
  setTheme(getTheme());
  startParticles();

  try {
    await load();
  } catch (e) {
    el('bootError').hidden = false;
    el('bootError').innerHTML = `
      <div class="inner">
        <h2>The tree could not load</h2>
        <p>${escapeHTML(e.message)}</p>
        <p>If you opened this file straight from your computer, browsers block reading
        <code>data/snapshot.json</code>. Run <code>python3 -m http.server</code> in this
        folder and open <code>localhost:8000</code>, or deploy it to Netlify.</p>
      </div>`;
    return;
  }

  if (state.error) toast(state.error, 'bad');

  buildIndex();
  renderGalaxy(fam => enterTree(fam));
  setupTimeline(year => { view.timelineYear = year; if (inTree()) render(); });
  el('adminBtn').classList.toggle('unlocked', state.writable);

  if (!hasBackend()) el('adminBtn').title = 'Read-only — connect a database to edit';

  // Deep link: ?p=W01 opens straight to a person.
  const wanted = new URLSearchParams(location.search).get('p');
  if (wanted && getPerson(wanted)) {
    enterTree('all');
    setTimeout(() => { centreOn(wanted); openPerson(wanted); }, 700);
  }
}

boot();
