/* ═══════════════════════════════════════════════════════════════
   The person drawer and the statistics drawer.
   ═══════════════════════════════════════════════════════════════ */

import {
  state, getPerson, getDepth, famVars, kinshipGroups, removeRelation,
  deletePerson, deleteStory, term,
} from './data.js';
import { escapeHTML, avatarHTML, impliedRole, view, currentYear } from './graph.js';
import { el, openDrawer, toast, confirmDialog } from './ui.js';

export const hooks = {
  onFocus: () => {},          // make this person the centre of the graph
  onResetFocus: () => {},
  onEditPerson: () => {},
  onAddRelative: () => {},
  onAddStory: () => {},
  afterChange: () => {},
};

let currentId = null;
export const openPersonId = () => currentId;

// ═══════════════════════ Person ═══════════════════════

export function openPerson(id) {
  const p = getPerson(id);
  if (!p) { toast('That person is no longer in the tree'); return; }
  currentId = id;

  const editing = state.writable;
  const groups = kinshipGroups(id);
  const stories = state.stories[id] || [];
  const year = currentYear();
  const age = p.born != null ? (p.died ?? year) - p.born : null;

  const kinHTML = groups.map(g => `
    <div class="kin-group">
      <div class="kin-label">${escapeHTML(g.label)}</div>
      <div class="kin-people">
        ${g.people.map(person => `
          <div class="kin-person" style="${famVars(person.family)}" data-id="${escapeHTML(person.id)}">
            <span class="kin-avatar">${avatarHTML(person)}</span>
            <span class="kin-name">${escapeHTML(person.name)}</span>
            ${editing && g.relKind
              ? `<button class="kin-remove" data-unlink="${escapeHTML(person.id)}" data-kind="${g.relKind}"
                         title="Remove this link" aria-label="Remove link to ${escapeHTML(person.name)}">×</button>`
              : ''}
          </div>`).join('')}
      </div>
    </div>`).join('');

  el('panelContent').innerHTML = `
    <div class="panel-head" style="${famVars(p.family)}">
      <div class="panel-photo">${avatarHTML(p)}</div>
      <div class="panel-name">${escapeHTML(p.name)}</div>
      ${p.maiden_name ? `<div class="panel-maiden">née ${escapeHTML(p.maiden_name)}</div>` : ''}
      ${p.role ? `<div class="panel-role">${escapeHTML(p.role)}</div>` : ''}
      <div class="panel-tag">${escapeHTML(p.family || 'no family')}${
        p.gender === 'M' ? ' · ♂' : p.gender === 'F' ? ' · ♀' : ''}</div>
    </div>

    ${p.bio ? `<div class="panel-section"><div class="panel-bio">${escapeHTML(p.bio)}</div></div>` : ''}

    <div class="panel-actions">
      ${view.focusId === p.id
        ? `<button class="btn secondary" data-act="unfocus">Reset the view</button>`
        : `<button class="btn" data-act="focus">Centre on ${escapeHTML(p.name.split(' ')[0])}</button>`}
      <button class="btn secondary" data-act="share">Copy link</button>
      ${editing ? `<button class="btn secondary" data-act="edit">Edit</button>` : ''}
      ${editing ? `<button class="btn secondary" data-act="relative">Add a relative</button>` : ''}
    </div>

    <div class="panel-section">
      <h3>Life</h3>
      <div class="stat-grid">
        <div>
          <div class="stat-label">Years</div>
          <div class="stat-value">${p.born ? `${p.born}–${p.died ?? 'present'}` : '—'}</div>
        </div>
        <div>
          <div class="stat-label">${p.died ? 'Lived' : 'Age'}</div>
          <div class="stat-value">${age != null ? age : '—'}${age != null ? '<span class="unit">years</span>' : ''}</div>
        </div>
        <div>
          <div class="stat-label">Generation</div>
          <div class="stat-value">${getDepth(id) + 1}<span class="unit">of ${maxDepth() + 1}</span></div>
        </div>
        <div>
          <div class="stat-label">Lives in</div>
          <div class="stat-value" style="font-size:17px">${escapeHTML(p.location || '—')}</div>
        </div>
      </div>
    </div>

    ${(stories.length || editing) ? `
      <div class="panel-section">
        <h3>Their story</h3>
        ${stories.length ? stories.map(s => `
          <div class="tl-item">
            <div class="tl-year">${s.year ?? '—'}</div>
            <div style="flex:1">
              <div class="tl-title">${escapeHTML(s.title)}</div>
              ${s.description ? `<div class="tl-desc">${escapeHTML(s.description)}</div>` : ''}
            </div>
            ${editing && s.id != null
              ? `<button class="tl-del" data-delstory="${escapeHTML(String(s.id))}" title="Remove" aria-label="Remove this moment">×</button>`
              : ''}
          </div>`).join('')
          : `<p class="tl-desc" style="margin-bottom:14px">No moments recorded yet.</p>`}
        ${editing ? `<button class="btn secondary" data-act="story" style="margin-top:12px">Add a moment</button>` : ''}
      </div>` : ''}

    ${groups.length ? `
      <div class="panel-section">
        <h3>In this family they are</h3>
        <div>${kinHTML}</div>
      </div>`
      : `<div class="panel-section">
           <h3>In this family they are</h3>
           <p class="tl-desc">Not connected to anyone yet.${editing ? ' Use “Add a relative” above.' : ''}</p>
         </div>`}

    ${editing ? `
      <div class="panel-section">
        <h3>Danger zone</h3>
        <button class="btn danger block" data-act="delete">Remove ${escapeHTML(p.name)} from the tree</button>
      </div>` : ''}
  `;

  wirePanel(p);
  openDrawer('panel');
}

function maxDepth() {
  const d = Object.values(state.depths);
  return d.length ? Math.max(...d) : 0;
}

function wirePanel(p) {
  const root = el('panelContent');

  root.querySelectorAll('.kin-person').forEach(node => {
    node.addEventListener('click', e => {
      if (e.target.closest('[data-unlink]')) return;
      openPerson(node.dataset.id);
    });
  });

  root.querySelectorAll('[data-unlink]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const otherId = btn.dataset.unlink;
      const kind = btn.dataset.kind;   // 'parent' (other is parent), 'child', 'spouse'
      const other = getPerson(otherId);
      const ok = await confirmDialog({
        title: 'Remove this link?',
        sub: `This unlinks <strong>${escapeHTML(p.name)}</strong> and <strong>${escapeHTML(other?.name || otherId)}</strong>. Both people stay in the tree.`,
        confirmLabel: 'Remove link',
      });
      if (!ok) return;
      try {
        if (kind === 'spouse') await removeRelation(p.id, otherId, 'spouse');
        else if (kind === 'parent') await removeRelation(otherId, p.id, 'parent');
        else await removeRelation(p.id, otherId, 'parent');
        toast('Link removed');
        hooks.afterChange();
        openPerson(p.id);
      } catch (err) { toast(err.message, 'bad'); }
    });
  });

  root.querySelectorAll('[data-delstory]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove this moment?', sub: 'It will be deleted for everyone.', confirmLabel: 'Remove' });
      if (!ok) return;
      try {
        await deleteStory(p.id, isNaN(+btn.dataset.delstory) ? btn.dataset.delstory : +btn.dataset.delstory);
        toast('Removed');
        openPerson(p.id);
      } catch (err) { toast(err.message, 'bad'); }
    });
  });

  const act = name => root.querySelector(`[data-act="${name}"]`);

  act('focus')?.addEventListener('click', () => hooks.onFocus(p.id));
  act('unfocus')?.addEventListener('click', () => hooks.onResetFocus());
  act('edit')?.addEventListener('click', () => hooks.onEditPerson(p.id));
  act('relative')?.addEventListener('click', () => hooks.onAddRelative(p.id));
  act('story')?.addEventListener('click', () => hooks.onAddStory(p.id));

  act('share')?.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?p=${encodeURIComponent(p.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — it opens straight to this person');
    } catch (e) {
      toast(url);
    }
  });

  act('delete')?.addEventListener('click', async () => {
    const links = state.relations.filter(r => r.a === p.id || r.b === p.id).length;
    const ok = await confirmDialog({
      title: `Remove ${p.name}?`,
      sub: `This deletes them for everyone, along with ${links} relationship${links === 1 ? '' : 's'} and their story entries. It cannot be undone.`,
      confirmLabel: 'Remove permanently',
    });
    if (!ok) return;
    try {
      await deletePerson(p.id);
      toast(`${p.name} removed`);
      currentId = null;
      hooks.afterChange();
      el('panel').classList.remove('show');
      el('backdrop').classList.remove('show');
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ═══════════════════════ Statistics ═══════════════════════

export function openStats(onPersonClick) {
  const people = state.people;
  const total = people.length;
  const living = people.filter(p => !p.died).length;
  const thisYear = new Date().getFullYear();

  const famCounts = state.families.map(f => [f, people.filter(p => p.family === f).length]);
  const maxFam = Math.max(1, ...famCounts.map(x => x[1]));

  const decades = {};
  people.forEach(p => { if (p.born) decades[Math.floor(p.born / 10) * 10] = (decades[Math.floor(p.born / 10) * 10] || 0) + 1; });
  const decadeKeys = Object.keys(decades).map(Number).sort((a, b) => a - b);
  const maxDecade = Math.max(1, ...Object.values(decades));

  const cities = {};
  people.forEach(p => {
    const c = (p.location || '').split(',')[0].trim();
    if (c) cities[c] = (cities[c] || 0) + 1;
  });
  const topCities = Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const ages = people.filter(p => !p.died && p.born).map(p => thisYear - p.born);
  const avgAge = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;
  const withBirth = people.filter(p => p.born && !p.died).sort((a, b) => a.born - b.born);
  const eldest = withBirth[0];
  const youngest = withBirth[withBirth.length - 1];

  const noGender = people.filter(p => !p.gender);
  const noBirth = people.filter(p => !p.born);
  const connected = new Set(state.relations.flatMap(r => [r.a, r.b]));
  const orphans = people.filter(p => !connected.has(p.id));

  const bar = (label, n, max, colour) => `
    <div class="bar-row">
      <div class="lbl">${escapeHTML(label)}</div>
      <div class="bar-bg"><div class="bar-fill" data-w="${(n / max) * 100}" ${colour ? `style="--bar:${colour}"` : ''}></div></div>
      <div class="num">${n}</div>
    </div>`;

  const healthRow = (title, sub, list) => `
    <div class="health-row">
      <div class="health-icon">!</div>
      <div style="flex:1">
        <div class="health-title">${title}</div>
        <div class="health-sub">${sub}</div>
        <div class="health-names">
          ${list.slice(0, 10).map(p => `<span class="chip" data-id="${escapeHTML(p.id)}">${escapeHTML(p.name)}</span>`).join('')}
          ${list.length > 10 ? `<span class="chip static">+${list.length - 10} more</span>` : ''}
        </div>
      </div>
    </div>`;

  el('statsBody').innerHTML = `
    <div class="stat-card">
      <div class="h">The graph</div>
      <div class="stat-trio">
        <div><div class="stat-big">${total}</div><div class="lab">people</div></div>
        <div><div class="stat-big">${living}</div><div class="lab">living</div></div>
        <div><div class="stat-big">${state.relations.length}</div><div class="lab">links</div></div>
      </div>
    </div>

    <div class="stat-card">
      <div class="h">By family</div>
      <div class="bars">${famCounts.map(([f, n]) => bar(f, n, maxFam, famColourOf(f))).join('')}</div>
    </div>

    ${decadeKeys.length ? `
      <div class="stat-card">
        <div class="h">Born by decade</div>
        <div class="bars">${decadeKeys.map(d => bar(`${d}s`, decades[d], maxDecade)).join('')}</div>
      </div>` : ''}

    ${topCities.length ? `
      <div class="stat-card">
        <div class="h">Where everyone is</div>
        <div class="bars">${topCities.map(([c, n]) => bar(c, n, topCities[0][1])).join('')}</div>
      </div>` : ''}

    <div class="stat-card">
      <div class="h">People notes</div>
      <div class="stat-grid">
        <div><div class="stat-label">Average age</div><div class="stat-value">${avgAge ?? '—'}</div></div>
        <div><div class="stat-label">Families joined</div><div class="stat-value">${state.relations.filter(r => r.cross).length}</div></div>
        ${eldest ? `<div><div class="stat-label">Eldest living</div><div class="stat-value" style="font-size:17px">${escapeHTML(eldest.name)}</div><div class="health-sub">${thisYear - eldest.born} years</div></div>` : ''}
        ${youngest ? `<div><div class="stat-label">Youngest</div><div class="stat-value" style="font-size:17px">${escapeHTML(youngest.name)}</div><div class="health-sub">${thisYear - youngest.born} years</div></div>` : ''}
      </div>
    </div>

    ${(noGender.length || noBirth.length || orphans.length) ? `
      <div class="stat-card">
        <div class="h">Worth filling in</div>
        ${orphans.length ? healthRow(
          `${orphans.length} ${orphans.length === 1 ? 'person is' : 'people are'} not linked to anyone`,
          'They float on their own in the graph. Open one and use “Add a relative”.', orphans) : ''}
        ${noGender.length ? healthRow(
          `${noGender.length} ${noGender.length === 1 ? 'person has' : 'people have'} no gender set`,
          'Without it the tree says “Parent” instead of Father or Mother.', noGender) : ''}
        ${noBirth.length ? healthRow(
          `${noBirth.length} ${noBirth.length === 1 ? 'person has' : 'people have'} no birth year`,
          'Birth years drive the era layout and the time-travel slider.', noBirth) : ''}
      </div>` : `
      <div class="stat-card">
        <div class="h">Data health</div>
        <div style="font-family:var(--serif);font-style:italic;font-size:17px;color:var(--accent-strong)">
          Everyone has a gender, a birth year and at least one link. Nicely done.
        </div>
      </div>`}
  `;

  el('statsBody').querySelectorAll('.chip[data-id]').forEach(c => {
    c.addEventListener('click', () => onPersonClick(c.dataset.id));
  });

  // Animate the bars after layout so the widths transition.
  requestAnimationFrame(() => {
    el('statsBody').querySelectorAll('.bar-fill').forEach(b => { b.style.width = b.dataset.w + '%'; });
  });

  openDrawer('statsPanel');
}

function famColourOf(fam) {
  const m = famVars(fam).match(/--fam:([^;]+)/);
  return m ? m[1] : null;
}
