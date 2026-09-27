#!/usr/bin/env node
/**
 * One-off migration: published Google Sheet -> data/snapshot.json + supabase-seed.sql
 *
 * Run:  node tools/migrate-sheet.mjs
 *
 * Why this exists: the Relationships tab's header row was corrupted by the Google
 * Sheets "Table" feature, which folded the header and the first two data rows into
 * a single line. Those two rows (Amar -> Yash, Amar -> Hitanshi) were being silently
 * dropped on every page load. They are recovered explicitly below.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHEET_ID = '18JlWreivwih4dwEjxgC1tFvjltLEDu72uQnTfx2oNS4';
const TABS = { people: 'People', relations: 'Relationships', stories: 'Stories' };

/** Rows lost to the corrupted header row. Read directly off the raw CSV. */
const RECOVERED_RELATIONS = [
  { person_a: 'Amar Watwani', person_b: 'Yash Watwani', type: 'Parent', year: '' },
  { person_a: 'Amar Watwani', person_b: 'Hitanshi Watwani', type: 'Parent', year: '' },
];

// ── CSV ──────────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && inQuotes && n === '"') { cell += '"'; i++; }
    else if (c === '"') { inQuotes = !inQuotes; }
    else if (c === ',' && !inQuotes) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && n === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else { cell += c; }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];

  // Recover from the Sheets "Table" header corruption: "person_a Amar Watwani ..."
  const headerRow = rows[0].map(h => h.trim().split(/\s+/)[0].toLowerCase());
  return rows.slice(1)
    .filter(r => r.some(c => c.trim()))
    .map(r => Object.fromEntries(headerRow.map((h, i) => [h, (r[i] || '').trim()])));
}

async function fetchTab(tab) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${tab}: HTTP ${res.status}`);
  return parseCSV(await res.text());
}

// ── Transform ────────────────────────────────────────────────────────────────

const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

function normaliseType(raw) {
  const t = norm(raw);
  if (['parent', 'father', 'mother', 'child', 'son', 'daughter'].includes(t)) return 'parent';
  if (['spouse', 'husband', 'wife', 'married', 'marriage'].includes(t)) return 'spouse';
  return null;
}

async function main() {
  const [peopleRows, relRows, storyRows] = await Promise.all([
    fetchTab(TABS.people), fetchTab(TABS.relations), fetchTab(TABS.stories),
  ]);

  const report = { warnings: [], fixes: [] };

  const people = peopleRows
    .filter(r => r.id && r.name)
    .map(r => ({
      id: r.id.trim(),
      name: r.name.trim(),
      family: norm(r.family),
      maiden_name: r.maiden_name || '',
      born_family: norm(r.born_family) || norm(r.family),
      gender: (r.gender || '').toUpperCase().charAt(0) || '',
      role: r.role || '',
      born: num(r.born),
      died: num(r.died),
      location: r.location || '',
      photo_url: r.photo_url || '',
      bio: r.bio || '',
    }));

  const byId = new Map(people.map(p => [p.id, p]));
  const byName = new Map(people.map(p => [norm(p.name), p.id]));

  report.fixes.push(`Recovered ${RECOVERED_RELATIONS.length} relationship rows eaten by the corrupted header row`);

  const seen = new Set();
  const relations = [];
  let dropped = 0, deduped = 0;

  for (const r of [...RECOVERED_RELATIONS, ...relRows]) {
    const type = normaliseType(r.type);
    if (!type) { dropped++; continue; }

    const a = byId.has(r.person_a) ? r.person_a : byName.get(norm(r.person_a));
    const b = byId.has(r.person_b) ? r.person_b : byName.get(norm(r.person_b));
    if (!a || !b) {
      dropped++;
      report.warnings.push(`Unknown person in relationship: "${r.person_a}" -> "${r.person_b}"`);
      continue;
    }
    if (a === b) { dropped++; report.warnings.push(`Self-relationship skipped: ${a}`); continue; }

    // A spouse link is undirected, so order it canonically before de-duping.
    const [ka, kb] = type === 'spouse' ? [a, b].sort() : [a, b];
    const key = `${type}:${ka}:${kb}`;
    if (seen.has(key)) { deduped++; continue; }
    seen.add(key);

    relations.push({ person_a: ka, person_b: kb, type, year: num(r.year) });
  }

  if (deduped) report.fixes.push(`Removed ${deduped} duplicate relationship rows`);
  if (dropped) report.warnings.push(`${dropped} relationship rows could not be used`);

  const stories = storyRows
    .map(r => ({
      person_id: byId.has(r.person_id) ? r.person_id : byName.get(norm(r.person_id)),
      year: num(r.year),
      title: (r.title || '').trim(),
      description: (r.description || r.desc || '').trim(),
    }))
    .filter(s => s.person_id && s.title);

  // ── Health check ───────────────────────────────────────────────────────────
  const connected = new Set(relations.flatMap(r => [r.person_a, r.person_b]));
  const orphans = people.filter(p => !connected.has(p.id));
  if (orphans.length) {
    report.warnings.push(
      `${orphans.length} people have no relationships at all: ` +
      orphans.map(p => p.name).join(', ')
    );
  }
  const noGender = people.filter(p => !p.gender);
  if (noGender.length) report.warnings.push(`${noGender.length} people have no gender set`);
  const noBorn = people.filter(p => !p.born);
  if (noBorn.length) report.warnings.push(`${noBorn.length} people have no birth year`);

  const families = [...new Set(people.map(p => p.family).filter(Boolean))].sort();

  const snapshot = {
    exported_at: new Date().toISOString(),
    source: `google-sheet:${SHEET_ID}`,
    families,
    people,
    relations,
    stories,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
  writeFileSync(join(ROOT, 'data', 'seed.sql'), buildSeedSQL(snapshot));

  console.log(`people:      ${people.length}`);
  console.log(`relations:   ${relations.length}`);
  console.log(`stories:     ${stories.length}`);
  console.log(`families:    ${families.join(', ')}`);
  console.log('\nFixed:');
  report.fixes.forEach(f => console.log(`  + ${f}`));
  console.log('\nStill needs attention:');
  report.warnings.forEach(w => console.log(`  ! ${w}`));
  console.log('\nWrote data/snapshot.json and data/seed.sql');
}

// ── SQL seed ─────────────────────────────────────────────────────────────────

// Text columns are `not null default ''`, so a blank value must be written as
// the empty string, not SQL null — null is only for the two nullable ints below.
const q = v => (v === null || v === undefined ? "''" : `'${String(v).replace(/'/g, "''")}'`);
const qn = v => (v === null || v === undefined || v === '' ? 'null' : String(parseInt(v, 10)));

function buildSeedSQL(s) {
  const lines = [
    '-- Generated by tools/migrate-sheet.mjs — do not edit by hand.',
    '-- Run this in the Supabase SQL editor AFTER supabase-setup.sql.',
    '',
    'begin;',
    '',
    'delete from ft_stories;',
    'delete from ft_relations;',
    'delete from ft_people;',
    '',
    'insert into ft_people (id, name, family, maiden_name, born_family, gender, role, born, died, location, photo_url, bio) values',
    s.people.map(p => `  (${[q(p.id), q(p.name), q(p.family), q(p.maiden_name), q(p.born_family), q(p.gender), q(p.role), qn(p.born), qn(p.died), q(p.location), q(p.photo_url), q(p.bio)].join(', ')})`).join(',\n') + ';',
    '',
    'insert into ft_relations (person_a, person_b, type, year) values',
    s.relations.map(r => `  (${[q(r.person_a), q(r.person_b), q(r.type), qn(r.year)].join(', ')})`).join(',\n') + ';',
    '',
  ];
  if (s.stories.length) {
    lines.push(
      'insert into ft_stories (person_id, year, title, description) values',
      s.stories.map(t => `  (${[q(t.person_id), qn(t.year), q(t.title), q(t.description)].join(', ')})`).join(',\n') + ';',
      ''
    );
  }
  lines.push('commit;', '');
  return lines.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
