/* ═══════════════════════════════════════════════════════════════
   Data layer: loading, the relationship graph, and writes.

   Two sources, in priority order:
     1. Supabase  — live, readable by anyone, writable with the passcode
     2. snapshot  — data/snapshot.json, read-only

   Nothing in here touches the DOM.
   ═══════════════════════════════════════════════════════════════ */

const CFG = window.FT_CONFIG || {};
const PASSCODE_KEY = 'ft-passcode';

export const state = {
  people: [],
  relations: [],
  stories: {},      // personId -> [{ id, year, title, description }]
  families: [],     // ordered list of family slugs
  depths: {},       // personId -> generation index within the whole graph
  source: 'none',   // 'supabase' | 'snapshot'
  writable: false,  // true once the passcode has been accepted
  error: null,
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { listeners.forEach(fn => fn()); }

export const hasBackend = () => Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);

// ═══════════════════════ Colour ═══════════════════════

const PALETTE = CFG.palette || ['#d4a574', '#b87a9c', '#6fa39a'];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const rgba = (hex, a) => `rgba(${hexToRgb(hex).join(', ')}, ${a})`;

/** Mix a colour towards black (amount < 0) or white (amount > 0). */
function shade(hex, amount) {
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const [r, g, b] = hexToRgb(hex).map(c => Math.round(c + (target - c) * t));
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

let themeIsLight = false;
export function setColorTheme(theme) { themeIsLight = theme === 'light'; }

/** Theme-aware accent set for a family. Light mode needs darker hues to stay legible on cream. */
export function famColor(fam) {
  const idx = Math.max(0, state.families.indexOf(fam));
  const base = PALETTE[idx % PALETTE.length];
  const hex = themeIsLight ? shade(base, -0.42) : base;
  return {
    hex,
    border: rgba(hex, themeIsLight ? 0.4 : 0.3),
    bg: rgba(hex, themeIsLight ? 0.1 : 0.1),
    glow: rgba(hex, themeIsLight ? 0.22 : 0.3),
    edge: rgba(hex, themeIsLight ? 0.35 : 0.25),
  };
}

/** Inline style string that hands a family's colours to CSS. */
export function famVars(fam) {
  const c = famColor(fam);
  return `--fam:${c.hex};--fam-border:${c.border};--fam-bg:${c.bg};--fam-glow:${c.glow};--fam-edge:${c.edge}`;
}

// ═══════════════════════ Normalising ═══════════════════════

export const slug = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

function normPerson(r) {
  return {
    id: String(r.id || '').trim(),
    name: String(r.name || '').trim(),
    family: slug(r.family),
    maiden_name: r.maiden_name || '',
    born_family: slug(r.born_family) || slug(r.family),
    gender: (r.gender || '').toUpperCase().charAt(0) || '',
    role: r.role || '',
    born: int(r.born),
    died: int(r.died),
    location: r.location || '',
    photo_url: r.photo_url || '',
    bio: r.bio || '',
  };
}

function normRelation(r) {
  return {
    id: r.id ?? null,
    a: String(r.person_a || r.a || '').trim(),
    b: String(r.person_b || r.b || '').trim(),
    type: slug(r.type),
    year: int(r.year),
    cross: false,
  };
}

/** Rebuild every derived index. Call after any mutation. */
export function reindex() {
  state.people = state.people.filter(p => p.id && p.name);

  const ids = new Set(state.people.map(p => p.id));
  state.relations = state.relations.filter(
    r => ids.has(r.a) && ids.has(r.b) && r.a !== r.b && (r.type === 'parent' || r.type === 'spouse')
  );

  // Families, ordered by first appearance so palette assignment is stable.
  const seen = [];
  state.people.forEach(p => { if (p.family && !seen.includes(p.family)) seen.push(p.family); });
  state.families = seen;

  const byId = new Map(state.people.map(p => [p.id, p]));
  state.relations.forEach(r => {
    const pa = byId.get(r.a), pb = byId.get(r.b);
    r.cross = r.type === 'spouse' && pa && pb && pa.family !== pb.family;
  });

  state.depths = computeDepths();
  notify();
}

// ═══════════════════════ Loading ═══════════════════════

function sbHeaders(extra = {}) {
  return {
    apikey: CFG.supabaseAnonKey,
    Authorization: `Bearer ${CFG.supabaseAnonKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sbGet(table) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/${table}?select=*`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Call a database function. Every write goes through one of these. */
export async function rpc(fn, args) {
  const res = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (e) {}
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

function ingest({ people, relations, stories }) {
  state.people = (people || []).map(normPerson);
  state.relations = (relations || []).map(normRelation);
  state.stories = {};
  (stories || []).forEach(s => {
    const pid = String(s.person_id || '').trim();
    if (!pid) return;
    (state.stories[pid] ||= []).push({
      id: s.id ?? null,
      year: int(s.year),
      title: s.title || '',
      description: s.description || s.desc || '',
    });
  });
  Object.values(state.stories).forEach(list => list.sort((a, b) => (a.year || 0) - (b.year || 0)));
}

export async function load() {
  state.error = null;

  if (hasBackend()) {
    try {
      const [people, relations, stories] = await Promise.all([
        sbGet('ft_people'), sbGet('ft_relations'), sbGet('ft_stories'),
      ]);
      ingest({ people, relations, stories });
      state.source = 'supabase';
      state.writable = Boolean(sessionStorage.getItem(PASSCODE_KEY));
      reindex();
      return;
    } catch (e) {
      console.warn('[data] Supabase unavailable, falling back to the snapshot:', e.message);
      state.error = `Live data unavailable (${e.message}). Showing the last saved copy.`;
    }
  }

  const res = await fetch(CFG.snapshotUrl || 'data/snapshot.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${CFG.snapshotUrl} (HTTP ${res.status})`);
  ingest(await res.json());
  state.source = 'snapshot';
  state.writable = false;
  reindex();
}

// ═══════════════════════ Graph queries ═══════════════════════

export const getPerson = id => state.people.find(p => p.id === id);
export const getParents = id => state.relations.filter(r => r.type === 'parent' && r.b === id).map(r => getPerson(r.a)).filter(Boolean);
export const getChildren = id => state.relations.filter(r => r.type === 'parent' && r.a === id).map(r => getPerson(r.b)).filter(Boolean);
export const getSpouses = id => state.relations
  .filter(r => r.type === 'spouse' && (r.a === id || r.b === id))
  .map(r => getPerson(r.a === id ? r.b : r.a)).filter(Boolean);

export function getSiblings(id) {
  const out = new Set();
  getParents(id).forEach(p => getChildren(p.id).forEach(c => { if (c.id !== id) out.add(c.id); }));
  return [...out].map(getPerson);
}
export function getGrandparents(id) {
  const out = new Set();
  getParents(id).forEach(p => getParents(p.id).forEach(g => out.add(g.id)));
  return [...out].map(getPerson);
}
export function getGrandchildren(id) {
  const out = new Set();
  getChildren(id).forEach(c => getChildren(c.id).forEach(g => out.add(g.id)));
  return [...out].map(getPerson);
}
export function getUncles(id) {
  const out = new Set();
  getParents(id).forEach(p => {
    getSiblings(p.id).forEach(u => out.add(u.id));
    getSpouses(p.id).forEach(sp => getSiblings(sp.id).forEach(u => out.add(u.id)));
  });
  getParents(id).forEach(p => out.delete(p.id));
  return [...out].map(getPerson);
}
export function getNephews(id) {
  const out = new Set();
  getSiblings(id).forEach(s => getChildren(s.id).forEach(n => out.add(n.id)));
  getSpouses(id).forEach(sp => getSiblings(sp.id).forEach(s => getChildren(s.id).forEach(n => out.add(n.id))));
  getChildren(id).forEach(c => out.delete(c.id));
  return [...out].map(getPerson);
}
export function getCousins(id) {
  const out = new Set();
  getParents(id).forEach(p => getSiblings(p.id).forEach(u => getChildren(u.id).forEach(c => out.add(c.id))));
  out.delete(id);
  getSiblings(id).forEach(s => out.delete(s.id));
  return [...out].map(getPerson);
}
export function getInLaws(id) {
  const out = new Set();
  getSpouses(id).forEach(sp => getParents(sp.id).forEach(p => out.add(p.id)));
  return [...out].map(getPerson);
}

export const neighbours = id => [...getParents(id), ...getChildren(id), ...getSpouses(id), ...getSiblings(id)];

export const getDepth = id => state.depths[id] ?? 0;

/**
 * Generation index for everyone. Roots (no parents, and no spouse with parents)
 * sit at 0; children sit one below their deepest parent; spouses inherit.
 */
function computeDepths() {
  const depth = {};
  state.people.forEach(p => {
    if (getParents(p.id).length) return;
    if (getSpouses(p.id).some(sp => getParents(sp.id).length)) return;
    depth[p.id] = 0;
  });

  let changed = true, guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    state.people.forEach(p => {
      if (depth[p.id] !== undefined) return;
      const known = getParents(p.id).map(par => depth[par.id]).filter(d => d !== undefined);
      if (known.length) { depth[p.id] = Math.max(...known) + 1; changed = true; return; }
      const sp = getSpouses(p.id).find(s => depth[s.id] !== undefined);
      if (sp) { depth[p.id] = depth[sp.id]; changed = true; }
    });
  }
  state.people.forEach(p => { if (depth[p.id] === undefined) depth[p.id] = 0; });
  return depth;
}

/** Shortest chain of relationships between two people, or null. */
export function findPath(fromId, toId) {
  if (fromId === toId) return [fromId];
  const seen = new Set([fromId]);
  const queue = [[fromId]];
  while (queue.length) {
    const path = queue.shift();
    for (const n of neighbours(path[path.length - 1])) {
      if (n.id === toId) return [...path, n.id];
      if (!seen.has(n.id)) { seen.add(n.id); queue.push([...path, n.id]); }
    }
  }
  return null;
}

/** True if `ancestorId` already sits above `personId` — used to reject cycles. */
export function isAncestorOf(ancestorId, personId) {
  const seen = new Set();
  const stack = [personId];
  while (stack.length) {
    const cur = stack.pop();
    for (const p of getParents(cur)) {
      if (p.id === ancestorId) return true;
      if (!seen.has(p.id)) { seen.add(p.id); stack.push(p.id); }
    }
  }
  return false;
}

// ═══════════════════════ Kinship language ═══════════════════════

const TERMS = {
  parent:      { M: 'Father', F: 'Mother', X: 'Parent' },
  child:       { M: 'Son', F: 'Daughter', X: 'Child' },
  spouse:      { M: 'Husband', F: 'Wife', X: 'Spouse' },
  sibling:     { M: 'Brother', F: 'Sister', X: 'Sibling' },
  grandparent: { M: 'Grandfather', F: 'Grandmother', X: 'Grandparent' },
  grandchild:  { M: 'Grandson', F: 'Granddaughter', X: 'Grandchild' },
  uncle:       { M: 'Uncle', F: 'Aunt', X: 'Aunt or uncle' },
  nephew:      { M: 'Nephew', F: 'Niece', X: 'Niece or nephew' },
};

export function term(key, person) {
  const t = TERMS[key];
  if (!t) return key;
  return t[(person && person.gender) || 'X'] || t.X;
}

/** Everything a person is to the rest of the graph, grouped for display. */
export function kinshipGroups(id) {
  const p = getPerson(id);
  if (!p) return [];
  const groups = [];
  const add = (label, people, relKind) => { if (people.length) groups.push({ label, people, relKind }); };

  add('Child of', getParents(id), 'parent');
  getSpouses(id).forEach(sp => groups.push({ label: `${term('spouse', p)} of`, people: [sp], relKind: 'spouse' }));
  add(`${term('sibling', p)} of`, getSiblings(id), null);
  add(`${term('parent', p)} of`, getChildren(id), 'child');
  add('Grandchild of', getGrandparents(id), null);
  add(`${term('grandparent', p)} of`, getGrandchildren(id), null);
  add('Niece or nephew of', getUncles(id), null);
  add(`${term('uncle', p)} of`, getNephews(id), null);
  add('Cousin of', getCousins(id), null);
  add('Child-in-law of', getInLaws(id), null);
  return groups;
}

/** Plain-English chain: "Yash → mother → Reema → husband → Amar". */
export function describePath(path) {
  if (!path || path.length < 2) return '';
  const parts = [getPerson(path[0])?.name ?? '?'];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const pb = getPerson(b);
    let step = 'relative';
    if (getParents(a).some(x => x.id === b)) step = term('parent', pb).toLowerCase();
    else if (getChildren(a).some(x => x.id === b)) step = term('child', pb).toLowerCase();
    else if (getSpouses(a).some(x => x.id === b)) step = term('spouse', pb).toLowerCase();
    else if (getSiblings(a).some(x => x.id === b)) step = term('sibling', pb).toLowerCase();
    parts.push(step, pb?.name ?? '?');
  }
  return parts.join(' → ');
}

// ═══════════════════════ Writes ═══════════════════════

export function nextPersonId(family) {
  const prefix = (family || 'p').charAt(0).toUpperCase();
  const used = new Set(state.people.map(p => p.id));
  for (let n = 1; n < 10000; n++) {
    const id = prefix + String(n).padStart(2, '0');
    if (!used.has(id)) return id;
  }
  return prefix + Date.now();
}

const passcode = () => sessionStorage.getItem(PASSCODE_KEY) || '';

function requireWrite() {
  if (!hasBackend()) throw new Error('This site is running from a read-only snapshot. Connect Supabase in config.js to enable editing.');
  if (!passcode()) throw new Error('Enter the passcode first.');
}

export async function unlock(code) {
  if (!hasBackend()) throw new Error('No database connected — editing is off.');
  const ok = await rpc('ft_check_passcode', { p_code: code });
  if (!ok) throw new Error('That passcode is not right.');
  sessionStorage.setItem(PASSCODE_KEY, code);
  state.writable = true;
  notify();
  return true;
}

export function lock() {
  sessionStorage.removeItem(PASSCODE_KEY);
  state.writable = false;
  notify();
}

export async function savePerson(person) {
  requireWrite();
  const p = normPerson(person);
  if (!p.name) throw new Error('A name is required.');
  if (!p.id) p.id = nextPersonId(p.family);
  await rpc('ft_save_person', { p_code: passcode(), p_person: p });

  const i = state.people.findIndex(x => x.id === p.id);
  if (i >= 0) state.people[i] = p; else state.people.push(p);
  reindex();
  return p;
}

export async function deletePerson(id) {
  requireWrite();
  await rpc('ft_delete_person', { p_code: passcode(), p_id: id });
  state.people = state.people.filter(p => p.id !== id);
  state.relations = state.relations.filter(r => r.a !== id && r.b !== id);
  delete state.stories[id];
  reindex();
}

/**
 * Link two people. `type` is 'parent' (a is the parent of b) or 'spouse'.
 * Throws on the mistakes that are easy to make and hard to spot later.
 */
export async function addRelation(a, b, type, year = null) {
  requireWrite();
  if (a === b) throw new Error('Someone cannot be related to themselves.');
  if (!getPerson(a) || !getPerson(b)) throw new Error('Both people must exist first.');

  const [ka, kb] = type === 'spouse' ? [a, b].sort() : [a, b];
  const exists = state.relations.some(r =>
    r.type === type && ((r.a === ka && r.b === kb) || (type === 'spouse' && r.a === kb && r.b === ka))
  );
  if (exists) throw new Error('That link already exists.');

  if (type === 'parent') {
    if (isAncestorOf(b, a)) throw new Error(`${getPerson(b).name} is already an ancestor of ${getPerson(a).name} — that would make a loop.`);
    if (getParents(b).length >= 2) throw new Error(`${getPerson(b).name} already has two parents.`);
  }

  const saved = await rpc('ft_save_relation', {
    p_code: passcode(),
    p_relation: { person_a: ka, person_b: kb, type, year },
  });
  state.relations.push(normRelation(saved || { person_a: ka, person_b: kb, type, year }));
  reindex();
}

export async function removeRelation(a, b, type) {
  requireWrite();
  await rpc('ft_delete_relation', { p_code: passcode(), p_a: a, p_b: b, p_type: type });
  state.relations = state.relations.filter(r => !(
    r.type === type && ((r.a === a && r.b === b) || (r.a === b && r.b === a))
  ));
  reindex();
}

export async function saveStory(personId, story) {
  requireWrite();
  const payload = {
    id: story.id ?? null,
    person_id: personId,
    year: int(story.year),
    title: (story.title || '').trim(),
    description: (story.description || '').trim(),
  };
  if (!payload.title) throw new Error('Give the moment a title.');
  const saved = await rpc('ft_save_story', { p_code: passcode(), p_story: payload });
  const row = { id: saved?.id ?? payload.id, year: payload.year, title: payload.title, description: payload.description };

  const list = (state.stories[personId] ||= []);
  const i = list.findIndex(s => s.id != null && s.id === row.id);
  if (i >= 0) list[i] = row; else list.push(row);
  list.sort((x, y) => (x.year || 0) - (y.year || 0));
  notify();
  return row;
}

export async function deleteStory(personId, storyId) {
  requireWrite();
  await rpc('ft_delete_story', { p_code: passcode(), p_id: storyId });
  state.stories[personId] = (state.stories[personId] || []).filter(s => s.id !== storyId);
  notify();
}

/** Replace everything in the database with the given payload. Used by the importer. */
export async function bulkImport(payload) {
  requireWrite();
  await rpc('ft_bulk_import', {
    p_code: passcode(),
    p_people: payload.people,
    p_relations: payload.relations,
    p_stories: payload.stories || [],
  });
  await load();
}

// ═══════════════════════ Export ═══════════════════════

/** The current graph as a snapshot file — a backup, and the read-only fallback. */
export function toSnapshot() {
  return {
    exported_at: new Date().toISOString(),
    source: state.source,
    families: state.families,
    people: state.people,
    relations: state.relations.map(r => ({ person_a: r.a, person_b: r.b, type: r.type, year: r.year })),
    stories: Object.entries(state.stories).flatMap(([person_id, list]) =>
      list.map(s => ({ person_id, year: s.year, title: s.title, description: s.description }))
    ),
  };
}
