/* ═══════════════════════════════════════════════════════════════
   Search everything: people, stories, marriages, places, years
   and families — one index, one ranked list.
   ═══════════════════════════════════════════════════════════════ */

import { state, getPerson, getSpouses, term } from './data.js';

let index = [];

const lower = s => String(s ?? '').toLowerCase();

/**
 * Score one field against the query.
 * Exact > starts-with > word-start > contains > fuzzy subsequence.
 * Returns 0 when there is no match at all.
 */
function scoreField(q, text) {
  const t = lower(text);
  if (!t || !q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 820;

  const wordStart = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (wordStart.test(t)) return 640;
  if (t.includes(q)) return 430;

  // Fuzzy: every character of the query in order. Tighter runs score higher.
  let i = 0, gaps = 0, last = -1;
  for (let c = 0; c < t.length && i < q.length; c++) {
    if (t[c] === q[i]) {
      if (last >= 0) gaps += c - last - 1;
      last = c; i++;
    }
  }
  if (i < q.length) return 0;
  return Math.max(60, 220 - gaps * 6);
}

function entryScore(q, entry) {
  let best = 0;
  for (const f of entry.fields) {
    const s = scoreField(q, f.text) * (f.weight ?? 1);
    if (s > best) best = s;
  }
  return best;
}

// ═══════════════════════ Index ═══════════════════════

export function buildIndex() {
  index = [];

  state.people.forEach(p => {
    const bits = [p.family, p.location, p.role].filter(Boolean);
    index.push({
      kind: 'person',
      id: p.id,
      person: p,
      title: p.name,
      subtitle: [
        p.born ? (p.died ? `${p.born}–${p.died}` : `b. ${p.born}`) : null,
        ...bits,
      ].filter(Boolean).join(' · '),
      fields: [
        { text: p.name, weight: 1 },
        { text: p.maiden_name, weight: 0.92 },
        { text: p.role, weight: 0.7 },
        { text: p.location, weight: 0.62 },
        { text: p.family, weight: 0.6 },
        { text: p.bio, weight: 0.42 },
        { text: p.id, weight: 0.5 },
        { text: String(p.born ?? ''), weight: 0.55 },
        { text: String(p.died ?? ''), weight: 0.5 },
      ],
      payload: { personId: p.id },
    });
  });

  Object.entries(state.stories).forEach(([pid, list]) => {
    const p = getPerson(pid);
    if (!p) return;
    list.forEach(s => {
      index.push({
        kind: 'story',
        id: `story:${pid}:${s.id ?? s.title}`,
        person: p,
        title: s.title,
        subtitle: `${s.year ? s.year + ' · ' : ''}${p.name}${s.description ? ' — ' + s.description : ''}`,
        fields: [
          { text: s.title, weight: 1 },
          { text: s.description, weight: 0.75 },
          { text: String(s.year ?? ''), weight: 0.6 },
          { text: p.name, weight: 0.5 },
        ],
        payload: { personId: pid },
      });
    });
  });

  state.relations.filter(r => r.type === 'spouse').forEach(r => {
    const a = getPerson(r.a), b = getPerson(r.b);
    if (!a || !b) return;
    index.push({
      kind: 'marriage',
      id: `m:${r.a}:${r.b}`,
      person: a,
      title: `${a.name} & ${b.name}`,
      subtitle: [r.year ? `married ${r.year}` : 'married', r.cross ? 'joined two families' : null]
        .filter(Boolean).join(' · '),
      fields: [
        { text: `${a.name} ${b.name}`, weight: 0.95 },
        { text: `${b.name} ${a.name}`, weight: 0.95 },
        { text: 'marriage wedding married spouse', weight: 0.6 },
        { text: String(r.year ?? ''), weight: 0.6 },
      ],
      payload: { personId: r.a },
    });
  });

  const places = {};
  state.people.forEach(p => {
    const city = (p.location || '').split(',')[0].trim();
    if (city) (places[city] ||= []).push(p);
  });
  Object.entries(places).forEach(([city, people]) => {
    index.push({
      kind: 'place',
      id: `place:${city}`,
      title: city,
      subtitle: `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${people.slice(0, 3).map(p => p.name).join(', ')}${people.length > 3 ? '…' : ''}`,
      fields: [{ text: city, weight: 1 }, { text: 'place city location lives', weight: 0.5 }],
      payload: { people: people.map(p => p.id) },
    });
  });

  const years = {};
  state.people.forEach(p => {
    if (p.born) (years[p.born] ||= []).push(`${p.name} born`);
    if (p.died) (years[p.died] ||= []).push(`${p.name} died`);
  });
  Object.entries(years).forEach(([year, events]) => {
    index.push({
      kind: 'year',
      id: `year:${year}`,
      title: year,
      subtitle: events.join(' · '),
      fields: [{ text: year, weight: 1 }, { text: events.join(' '), weight: 0.45 }],
      payload: { year: Number(year) },
    });
  });

  state.families.forEach(fam => {
    const people = state.people.filter(p => p.family === fam);
    index.push({
      kind: 'family',
      id: `fam:${fam}`,
      title: fam,
      subtitle: `${people.length} ${people.length === 1 ? 'person' : 'people'} · show only this family`,
      fields: [{ text: fam, weight: 1 }, { text: 'family branch surname', weight: 0.45 }],
      payload: { family: fam },
    });
  });

  return index.length;
}

// ═══════════════════════ Query ═══════════════════════

const KIND_ORDER = ['person', 'story', 'marriage', 'family', 'place', 'year'];
const KIND_LABEL = {
  person: 'People', story: 'Stories & moments', marriage: 'Marriages',
  family: 'Families', place: 'Places', year: 'Years',
};
// People should win ties against aggregates.
const KIND_BOOST = { person: 1.15, story: 0.98, marriage: 0.9, family: 0.86, place: 0.84, year: 0.8 };

export function search(query, limit = 40) {
  const q = lower(query).trim();
  if (!q) return defaultResults();

  const scored = [];
  for (const entry of index) {
    const s = entryScore(q, entry) * (KIND_BOOST[entry.kind] ?? 1);
    if (s > 0) scored.push({ entry, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));

  const groups = new Map();
  scored.slice(0, limit).forEach(({ entry }) => {
    if (!groups.has(entry.kind)) groups.set(entry.kind, []);
    groups.get(entry.kind).push(entry);
  });

  return KIND_ORDER
    .filter(k => groups.has(k))
    .map(k => ({ kind: k, label: KIND_LABEL[k], items: groups.get(k) }));
}

/** What the palette shows before anyone types. */
function defaultResults() {
  const groups = [];

  const fams = index.filter(e => e.kind === 'family');
  if (fams.length) groups.push({ kind: 'family', label: 'Jump to a family', items: fams });

  // The elders first — they are usually the entry point into a tree.
  const elders = state.people
    .filter(p => p.born)
    .sort((a, b) => a.born - b.born)
    .slice(0, 5)
    .map(p => index.find(e => e.kind === 'person' && e.id === p.id))
    .filter(Boolean);
  if (elders.length) groups.push({ kind: 'person', label: 'Start with the eldest', items: elders });

  return groups;
}

/** Wrap the matched run in <mark>. Only for literal substring hits. */
export function highlight(text, query, escape) {
  const t = String(text ?? '');
  const q = lower(query).trim();
  if (!q) return escape(t);
  const i = lower(t).indexOf(q);
  if (i < 0) return escape(t);
  return escape(t.slice(0, i)) + '<mark>' + escape(t.slice(i, i + q.length)) + '</mark>' + escape(t.slice(i + q.length));
}

/** One-line description of who a person is, for result subtitles. */
export function personLine(p) {
  const spouses = getSpouses(p.id);
  const bits = [];
  if (p.born) bits.push(p.died ? `${p.born}–${p.died}` : `b. ${p.born}`);
  if (p.family) bits.push(p.family);
  if (spouses.length) bits.push(`${term('spouse', p).toLowerCase()} of ${spouses[0].name}`);
  if (p.location) bits.push(p.location);
  return bits.join(' · ');
}
