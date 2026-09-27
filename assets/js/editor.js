/* ═══════════════════════════════════════════════════════════════
   Adding and editing, from inside the site.

   Entry is relationship-first: you rarely add "a person", you add
   "Amar's father" — so the forms ask for the link at the same time
   as the name, and write both in one go.
   ═══════════════════════════════════════════════════════════════ */

import {
  state, hasBackend, unlock, lock, savePerson, addRelation, saveStory,
  bulkImport, toSnapshot, getPerson, getParents, nextPersonId, slug,
} from './data.js';
import { escapeHTML, avatarHTML } from './graph.js';
import {
  el, openDrawer, openModal, closeModal, toast, field, segmented,
  setFieldError, downloadJSON,
} from './ui.js';

export const hooks = {
  afterChange: () => {},   // re-render the graph and overview
  openPerson: () => {},
};

const GENDERS = [{ label: 'Male', value: 'M' }, { label: 'Female', value: 'F' }, { label: 'Not set', value: '' }];

// ═══════════════════════ Admin drawer ═══════════════════════

export function openAdmin() {
  const body = el('adminBody');
  el('adminTitle').textContent = 'Add & edit';

  if (!hasBackend()) {
    el('adminSub').textContent = 'Read-only';
    body.innerHTML = `
      <div class="form-note">
        <strong>This site is showing a saved copy of the data.</strong><br>
        Editing from the browser needs a database behind it. Connect Supabase in
        <code>config.js</code> and this panel turns into a full editor — see
        <code>README.md</code> for the ten-minute setup.
      </div>
      <div class="admin-list">
        <button class="admin-item" data-act="export">
          <span class="ai-icon">↓</span>
          <span><span class="ai-title">Download a backup</span>
          <span class="ai-sub">The whole tree as a JSON file you can keep or re-import.</span></span>
        </button>
      </div>`;
    body.querySelector('[data-act="export"]').addEventListener('click', exportSnapshot);
    openDrawer('adminPanel');
    return;
  }

  if (!state.writable) {
    el('adminSub').textContent = 'Passcode needed';
    body.innerHTML = `
      <div class="form-note">
        Anyone can read this tree. Adding and changing people needs the family passcode.
      </div>
      <div class="field">
        <label for="pc">Passcode</label>
        <input id="pc" type="password" placeholder="••••••••" autocomplete="current-password">
        <div class="err"></div>
      </div>
      <button class="btn block" id="pcGo">Unlock editing</button>`;

    const input = body.querySelector('#pc');
    const go = body.querySelector('#pcGo');
    const submit = async () => {
      go.disabled = true;
      go.innerHTML = '<span class="spinner"></span>';
      try {
        await unlock(input.value);
        toast('Unlocked — you can add and edit now');
        openAdmin();
        hooks.afterChange();
      } catch (e) {
        body.querySelector('.field').classList.add('error');
        body.querySelector('.err').textContent = e.message;
        go.disabled = false;
        go.textContent = 'Unlock editing';
      }
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    openDrawer('adminPanel');
    setTimeout(() => input.focus(), 120);
    return;
  }

  el('adminSub').textContent = 'Editing unlocked';
  const gaps = state.people.filter(p => !p.gender || !p.born).length;
  body.innerHTML = `
    <div class="admin-list">
      <button class="admin-item" data-act="add">
        <span class="ai-icon">+</span>
        <span><span class="ai-title">Add a person</span>
        <span class="ai-sub">Name, family, and who they are related to — in one step.</span></span>
      </button>
      <button class="admin-item" data-act="quickfill">
        <span class="ai-icon">✓</span>
        <span><span class="ai-title">Fill in the gaps</span>
        <span class="ai-sub">${gaps ? `${gaps} ${gaps === 1 ? 'person is' : 'people are'} missing a gender or birth year.` : 'Nothing missing right now.'}</span></span>
      </button>
      <button class="admin-item" data-act="import">
        <span class="ai-icon">⇪</span>
        <span><span class="ai-title">Import from a Google Sheet</span>
        <span class="ai-sub">Replaces everything with the contents of a published sheet.</span></span>
      </button>
      <button class="admin-item" data-act="export">
        <span class="ai-icon">↓</span>
        <span><span class="ai-title">Download a backup</span>
        <span class="ai-sub">Save the whole tree as JSON. Do this before any big change.</span></span>
      </button>
      <button class="admin-item" data-act="lock">
        <span class="ai-icon">⌁</span>
        <span><span class="ai-title">Lock editing</span>
        <span class="ai-sub">Back to read-only on this device.</span></span>
      </button>
    </div>`;

  const on = (name, fn) => body.querySelector(`[data-act="${name}"]`).addEventListener('click', fn);
  on('add', () => openPersonForm());
  on('quickfill', openQuickFill);
  on('import', openImport);
  on('export', exportSnapshot);
  on('lock', () => { lock(); toast('Locked'); openAdmin(); hooks.afterChange(); });

  openDrawer('adminPanel');
}

function exportSnapshot() {
  downloadJSON(`family-tree-${new Date().toISOString().slice(0, 10)}.json`, toSnapshot());
  toast('Backup downloaded');
}

// ═══════════════════════ Person picker ═══════════════════════

/**
 * Type-ahead over everyone in the tree, with an optional "add someone new" row.
 * `wrap.selection` is either { id } or { newName } or null.
 */
function personPicker({ exclude = [], allowNew = true, placeholder = 'Search the tree…' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.innerHTML = `
    <label>Who?</label>
    <div class="picker">
      <input type="text" placeholder="${escapeHTML(placeholder)}" autocomplete="off">
      <div class="picker-results"></div>
    </div>
    <div class="chosen" hidden></div>
    <div class="err"></div>`;

  const input = wrap.querySelector('input');
  const results = wrap.querySelector('.picker-results');
  const chosen = wrap.querySelector('.chosen');
  const picker = wrap.querySelector('.picker');
  wrap.selection = null;

  const choose = sel => {
    wrap.selection = sel;
    results.classList.remove('show');
    picker.hidden = true;
    chosen.hidden = false;
    chosen.className = 'chosen selected-person';
    chosen.innerHTML = `<span class="sp-name">${escapeHTML(sel.id ? getPerson(sel.id).name : sel.newName + ' (new)')}</span>
                        <button type="button" title="Change">×</button>`;
    chosen.querySelector('button').addEventListener('click', () => {
      wrap.selection = null;
      chosen.hidden = true; picker.hidden = false;
      input.value = ''; input.focus();
    });
    wrap.dispatchEvent(new CustomEvent('change'));
  };

  const draw = () => {
    const q = input.value.toLowerCase().trim();
    const skip = new Set(exclude);
    const matches = state.people
      .filter(p => !skip.has(p.id))
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.maiden_name || '').toLowerCase().includes(q))
      .slice(0, 8);

    const rows = matches.map(p => `
      <button type="button" class="picker-item" data-id="${escapeHTML(p.id)}">
        <span class="pi-av">${avatarHTML(p)}</span>
        <span><span class="pi-name">${escapeHTML(p.name)}</span>
        <span class="pi-meta"> ${escapeHTML([p.family, p.born].filter(Boolean).join(' · '))}</span></span>
      </button>`);

    if (allowNew && q) {
      rows.unshift(`
        <button type="button" class="picker-item create" data-new="1">
          <span class="pi-av">+</span>
          <span><span class="pi-name">Add “${escapeHTML(input.value.trim())}” as a new person</span>
          <span class="pi-meta"> they are not in the tree yet</span></span>
        </button>`);
    }

    results.innerHTML = rows.join('') ||
      '<div class="picker-item" style="cursor:default"><span class="pi-meta">Nobody matches</span></div>';
    results.classList.add('show');
    results.querySelectorAll('[data-id]').forEach(b =>
      b.addEventListener('click', () => choose({ id: b.dataset.id })));
    results.querySelector('[data-new]')?.addEventListener('click', () =>
      choose({ newName: input.value.trim() }));
  };

  input.addEventListener('input', draw);
  input.addEventListener('focus', draw);
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) results.classList.remove('show'); });

  return wrap;
}

function familyDatalist() {
  const dl = document.createElement('datalist');
  dl.id = 'familyList';
  dl.innerHTML = state.families.map(f => `<option value="${escapeHTML(f)}">`).join('');
  return dl;
}

// ═══════════════════════ Person form ═══════════════════════

export function openPersonForm(id = null, presetFamily = '') {
  const existing = id ? getPerson(id) : null;
  const form = document.createElement('div');

  const fName = field({ label: 'Full name', name: 'name', value: existing?.name || '', placeholder: 'e.g. Savitri Watwani' });
  const fFamily = field({
    label: 'Family', name: 'family', list: 'familyList',
    value: existing?.family || presetFamily,
    placeholder: 'watwani',
    hint: 'Type a new name to start a new branch. It gets its own colour.',
  });
  const fGender = segmented({ label: 'Gender', options: GENDERS, value: existing?.gender || '',
    hint: 'Used for the wording: father or mother, son or daughter.' });

  const fBorn = field({ label: 'Born', name: 'born', value: existing?.born ?? '', placeholder: '1970' });
  const fDied = field({ label: 'Died', name: 'died', value: existing?.died ?? '', placeholder: 'leave blank if living' });
  const row1 = document.createElement('div'); row1.className = 'field-row';
  row1.append(fBorn, fDied);

  const fLocation = field({ label: 'Lives in', name: 'location', value: existing?.location || '', placeholder: 'Gwalior' });
  const fRole = field({ label: 'Known for', name: 'role', value: existing?.role || '', placeholder: 'The storyteller' });
  const row2 = document.createElement('div'); row2.className = 'field-row';
  row2.append(fLocation, fRole);

  const fMaiden = field({
    label: 'Name before marriage', name: 'maiden', value: existing?.maiden_name || '',
    placeholder: 'leave blank if unchanged',
  });
  const fPhoto = field({
    label: 'Photo link', name: 'photo', value: existing?.photo_url || '',
    placeholder: 'https://…',
    hint: 'Any public image URL. Google Drive links need to be set to “anyone with the link”.',
  });
  const fBio = field({ label: 'A few words about them', name: 'bio', rows: 4, value: existing?.bio || '',
    placeholder: 'Crossed the border in 1947 with nothing but a trunk and three children.' });

  form.append(fName, fFamily, fGender, row1, row2, fMaiden, fPhoto, fBio, familyDatalist());

  openModal({
    title: existing ? `Edit ${existing.name}` : 'Add a person',
    sub: existing ? '' : 'You can link them to the rest of the tree on the next step.',
    body: form,
    actions: [
      { label: 'Cancel', kind: 'secondary', onClick: closeModal },
      {
        label: existing ? 'Save changes' : 'Add person', id: 'personSave',
        onClick: async btn => {
          setFieldError(fName, '');
          const name = fName.control.value.trim();
          if (!name) return setFieldError(fName, 'A name is needed.');

          const born = fBorn.control.value.trim();
          const died = fDied.control.value.trim();
          if (born && !/^\d{3,4}$/.test(born)) return setFieldError(fBorn, 'Use a four-digit year.');
          if (died && !/^\d{3,4}$/.test(died)) return setFieldError(fDied, 'Use a four-digit year.');
          if (born && died && +died < +born) return setFieldError(fDied, 'That is before they were born.');

          const family = slug(fFamily.control.value) || slug(name.split(/\s+/).slice(-1)[0]);
          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          try {
            const saved = await savePerson({
              id: existing?.id || nextPersonId(family),
              name, family,
              born_family: existing?.born_family || family,
              gender: fGender.value,
              born, died,
              location: fLocation.control.value.trim(),
              role: fRole.control.value.trim(),
              maiden_name: fMaiden.control.value.trim(),
              photo_url: fPhoto.control.value.trim(),
              bio: fBio.control.value.trim(),
            });
            closeModal();
            toast(existing ? 'Saved' : `${saved.name} added`);
            hooks.afterChange();
            if (existing) hooks.openPerson(saved.id);
            else openRelativeForm(saved.id, { firstTime: true });
          } catch (e) {
            btn.disabled = false; btn.textContent = existing ? 'Save changes' : 'Add person';
            toast(e.message, 'bad');
          }
        },
      },
    ],
  });
}

// ═══════════════════════ Relative form ═══════════════════════

const REL_OPTIONS = [
  { label: 'Parent', value: 'parent' },
  { label: 'Partner', value: 'spouse' },
  { label: 'Child', value: 'child' },
  { label: 'Sibling', value: 'sibling' },
];

export function openRelativeForm(personId, { firstTime = false } = {}) {
  const p = getPerson(personId);
  if (!p) return;

  const form = document.createElement('div');
  const kind = segmented({ label: `They are ${p.name}'s…`, options: REL_OPTIONS, value: 'parent' });
  const picker = personPicker({ exclude: [personId] });
  const fYear = field({ label: 'Year they married', name: 'year', placeholder: 'e.g. 1994' });
  fYear.style.display = 'none';

  const note = document.createElement('div');
  note.className = 'form-note';

  const refresh = () => {
    fYear.style.display = kind.value === 'spouse' ? '' : 'none';
    if (kind.value === 'sibling') {
      const parents = getParents(personId);
      note.innerHTML = parents.length
        ? `A sibling is added as another child of ${parents.map(x => `<strong>${escapeHTML(x.name)}</strong>`).join(' and ')}.`
        : `<strong>${escapeHTML(p.name)}</strong> has no parents recorded, so there is nothing to share. Add a parent first, then siblings.`;
    } else if (kind.value === 'parent') {
      const n = getParents(personId).length;
      note.innerHTML = n >= 2
        ? `<strong>${escapeHTML(p.name)}</strong> already has two parents. Remove one first if this is a correction.`
        : `Adds them above ${escapeHTML(p.name)} in the tree.`;
    } else if (kind.value === 'child') {
      note.innerHTML = `Adds them below ${escapeHTML(p.name)}. Link the other parent afterwards from the child's own page.`;
    } else {
      note.innerHTML = `Partners sit side by side. If they come from different families, the tree draws the join in gold.`;
    }
  };
  kind.addEventListener('change', refresh);
  refresh();

  form.append(kind, note, picker, fYear);

  openModal({
    title: firstTime ? `Link ${p.name} to the tree` : `Add a relative of ${p.name}`,
    sub: firstTime ? 'Skip this if they stand alone for now — you can link them any time.' : '',
    body: form,
    actions: [
      { label: firstTime ? 'Skip' : 'Cancel', kind: 'secondary', onClick: () => { closeModal(); hooks.openPerson(personId); } },
      {
        label: 'Add link',
        onClick: async btn => {
          setFieldError(picker, '');
          const sel = picker.selection;
          if (!sel) return setFieldError(picker, 'Pick someone, or type a name to add them.');

          const k = kind.value;
          if (k === 'sibling' && !getParents(personId).length) {
            return setFieldError(picker, 'Add a parent first — siblings are worked out from shared parents.');
          }

          const year = fYear.control.value.trim();
          if (k === 'spouse' && year && !/^\d{3,4}$/.test(year)) return setFieldError(fYear, 'Use a four-digit year.');

          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          try {
            let otherId = sel.id;
            if (!otherId) {
              // Sensible default: blood relatives inherit the family, partners do not.
              const family = k === 'spouse' ? slug(sel.newName.split(/\s+/).slice(-1)[0]) : p.family;
              const created = await savePerson({ id: nextPersonId(family), name: sel.newName, family, born_family: family });
              otherId = created.id;
            }

            if (k === 'parent') await addRelation(otherId, personId, 'parent');
            else if (k === 'child') await addRelation(personId, otherId, 'parent');
            else if (k === 'spouse') await addRelation(personId, otherId, 'spouse', year ? +year : null);
            else for (const par of getParents(personId)) await addRelation(par.id, otherId, 'parent');

            closeModal();
            toast('Linked');
            hooks.afterChange();
            hooks.openPerson(personId);
          } catch (e) {
            btn.disabled = false; btn.textContent = 'Add link';
            setFieldError(picker, e.message);
          }
        },
      },
    ],
  });
}

// ═══════════════════════ Story form ═══════════════════════

export function openStoryForm(personId) {
  const p = getPerson(personId);
  if (!p) return;

  const form = document.createElement('div');
  const fYear = field({ label: 'Year', name: 'year', placeholder: '1947' });
  const fTitle = field({ label: 'What happened', name: 'title', placeholder: 'Crossed the border' });
  const fDesc = field({ label: 'Tell it properly', name: 'desc', rows: 4,
    placeholder: 'Left Hyderabad with one trunk and three children. Walked for four days.' });
  form.append(fYear, fTitle, fDesc);

  openModal({
    title: `A moment in ${p.name}'s life`,
    sub: 'These build up into a timeline on their page.',
    body: form,
    actions: [
      { label: 'Cancel', kind: 'secondary', onClick: closeModal },
      {
        label: 'Add moment',
        onClick: async btn => {
          setFieldError(fTitle, ''); setFieldError(fYear, '');
          const title = fTitle.control.value.trim();
          if (!title) return setFieldError(fTitle, 'Say what happened.');
          const year = fYear.control.value.trim();
          if (year && !/^\d{3,4}$/.test(year)) return setFieldError(fYear, 'Use a four-digit year.');

          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          try {
            await saveStory(personId, { year, title, description: fDesc.control.value.trim() });
            closeModal();
            toast('Added to their story');
            hooks.openPerson(personId);
          } catch (e) {
            btn.disabled = false; btn.textContent = 'Add moment';
            toast(e.message, 'bad');
          }
        },
      },
    ],
  });
}

// ═══════════════════════ Quick fill ═══════════════════════

export function openQuickFill() {
  const gaps = state.people.filter(p => !p.gender || !p.born);
  if (!gaps.length) { toast('Nothing missing — everyone has a gender and a birth year'); return; }

  const form = document.createElement('div');
  const rows = gaps.map(p => {
    const row = document.createElement('div');
    row.className = 'quickfill-row';
    row.innerHTML = `<div><div class="qf-name">${escapeHTML(p.name)}</div>
                     <div class="qf-meta">${escapeHTML(p.family)}${p.born ? ' · b. ' + p.born : ''}</div></div>`;
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;align-items:center';

    let seg = null, yearInput = null;
    if (!p.gender) {
      seg = segmented({ label: '', options: GENDERS.slice(0, 2), value: '' });
      seg.style.marginBottom = '0';
      seg.querySelector('label').remove();
      seg.style.width = '150px';
      right.appendChild(seg);
    }
    if (!p.born) {
      yearInput = document.createElement('input');
      yearInput.type = 'text';
      yearInput.placeholder = 'born';
      yearInput.inputMode = 'numeric';
      right.appendChild(yearInput);
    }
    row.appendChild(right);
    return { p, row, seg, yearInput };
  });

  rows.forEach(r => form.appendChild(r.row));

  openModal({
    title: 'Fill in the gaps',
    sub: `${gaps.length} ${gaps.length === 1 ? 'person needs' : 'people need'} a gender or a birth year. Fill in what you know and leave the rest.`,
    body: form,
    actions: [
      { label: 'Cancel', kind: 'secondary', onClick: closeModal },
      {
        label: 'Save what I filled in',
        onClick: async btn => {
          const updates = rows
            .map(({ p, seg, yearInput }) => {
              const gender = seg?.value || '';
              const born = (yearInput?.value || '').trim();
              if (!gender && !born) return null;
              if (born && !/^\d{3,4}$/.test(born)) return { error: `${p.name}: "${born}" is not a year` };
              return { ...p, gender: gender || p.gender, born: born ? +born : p.born };
            })
            .filter(Boolean);

          const bad = updates.find(u => u.error);
          if (bad) return toast(bad.error, 'bad');
          if (!updates.length) return closeModal();

          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          let ok = 0;
          for (const u of updates) {
            try { await savePerson(u); ok++; } catch (e) { toast(`${u.name}: ${e.message}`, 'bad'); }
          }
          closeModal();
          toast(`Updated ${ok} ${ok === 1 ? 'person' : 'people'}`);
          hooks.afterChange();
        },
      },
    ],
  });
}

// ═══════════════════════ Google Sheet import ═══════════════════════

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && quoted && n === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && n === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  // Sheets' "Table" feature can fold data into the header row; take the first token.
  const headers = rows[0].map(h => h.trim().split(/\s+/)[0].toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).filter(r => r.some(c => c.trim()))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}

async function fetchTab(sheetId, tab) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`"${tab}" tab: HTTP ${res.status}. Is the sheet published to the web?`);
  const text = await res.text();
  if (text.trim().startsWith('<')) throw new Error(`"${tab}" tab came back as a web page — the sheet is not published.`);
  return parseCSV(text);
}

export function openImport() {
  const form = document.createElement('div');
  const fId = field({
    label: 'Google Sheet ID or URL', name: 'sheet',
    placeholder: 'https://docs.google.com/spreadsheets/d/…',
    hint: 'The sheet must be published: File → Share → Publish to web → CSV.',
  });
  const fPeople = field({ label: 'People tab', name: 'ptab', value: 'People' });
  const fRel = field({ label: 'Relationships tab', name: 'rtab', value: 'Relationships' });
  const fStories = field({ label: 'Stories tab', name: 'stab', value: 'Stories' });
  const rowTabs = document.createElement('div'); rowTabs.className = 'field-row'; rowTabs.append(fPeople, fRel);

  const out = document.createElement('div');

  form.innerHTML = `<div class="form-note">
    <strong>This replaces everything.</strong> Download a backup first if you have edited anything here.
  </div>`;
  form.append(fId, rowTabs, fStories, out);

  let staged = null;

  openModal({
    title: 'Import from a Google Sheet',
    body: form,
    actions: [
      { label: 'Cancel', kind: 'secondary', onClick: closeModal },
      {
        label: 'Check the sheet', id: 'impCheck',
        kind: 'secondary',
        onClick: async btn => {
          const raw = fId.control.value.trim();
          const sheetId = raw.replace(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//, '').replace(/\/.*$/, '');
          if (!sheetId) return setFieldError(fId, 'Paste the sheet link or its ID.');
          setFieldError(fId, '');

          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          out.innerHTML = '';
          try {
            const [peopleRows, relRows, storyRows] = await Promise.all([
              fetchTab(sheetId, fPeople.control.value.trim() || 'People'),
              fetchTab(sheetId, fRel.control.value.trim() || 'Relationships').catch(() => []),
              fetchTab(sheetId, fStories.control.value.trim() || 'Stories').catch(() => []),
            ]);
            staged = stageImport(peopleRows, relRows, storyRows);
            out.innerHTML = `<div class="form-note" style="border-left-color:var(--ok)">
              Found <strong>${staged.people.length} people</strong>,
              <strong>${staged.relations.length} links</strong> and
              <strong>${staged.stories.length} story entries</strong>.
              ${staged.skipped ? `<br>${staged.skipped} rows were skipped because they pointed at people who are not in the People tab.` : ''}
              <br>Press <strong>Replace everything</strong> to write this in.
            </div>`;
            el('impWrite').disabled = false;
          } catch (e) {
            out.innerHTML = `<div class="form-note" style="border-left-color:var(--danger)">${escapeHTML(e.message)}</div>`;
          }
          btn.disabled = false; btn.textContent = 'Check the sheet';
        },
      },
      {
        label: 'Replace everything', id: 'impWrite', kind: 'danger',
        onClick: async btn => {
          if (!staged) return;
          btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
          try {
            await bulkImport(staged);
            closeModal();
            toast(`Imported ${staged.people.length} people`);
            hooks.afterChange();
          } catch (e) {
            btn.disabled = false; btn.textContent = 'Replace everything';
            toast(e.message, 'bad');
          }
        },
      },
    ],
  });

  el('impWrite').disabled = true;
}

function stageImport(peopleRows, relRows, storyRows) {
  const people = peopleRows.filter(r => r.id && r.name).map(r => ({
    id: r.id.trim(), name: r.name.trim(), family: slug(r.family),
    maiden_name: r.maiden_name || '', born_family: slug(r.born_family) || slug(r.family),
    gender: (r.gender || '').toUpperCase().charAt(0) || '',
    role: r.role || '', born: r.born ? +r.born : null, died: r.died ? +r.died : null,
    location: r.location || '', photo_url: r.photo_url || '', bio: r.bio || '',
  }));

  const ids = new Set(people.map(p => p.id));
  const byName = new Map(people.map(p => [slug(p.name), p.id]));
  const resolve = v => (ids.has((v || '').trim()) ? v.trim() : byName.get(slug(v)));

  let skipped = 0;
  const seen = new Set();
  const relations = [];
  relRows.forEach(r => {
    let type = slug(r.type);
    if (['father', 'mother', 'child', 'son', 'daughter'].includes(type)) type = 'parent';
    if (['husband', 'wife', 'married', 'marriage'].includes(type)) type = 'spouse';
    if (type !== 'parent' && type !== 'spouse') { skipped++; return; }

    const a = resolve(r.person_a), b = resolve(r.person_b);
    if (!a || !b || a === b) { skipped++; return; }
    const [ka, kb] = type === 'spouse' ? [a, b].sort() : [a, b];
    const key = `${type}:${ka}:${kb}`;
    if (seen.has(key)) { skipped++; return; }
    seen.add(key);
    relations.push({ person_a: ka, person_b: kb, type, year: r.year ? +r.year : null });
  });

  const stories = storyRows.map(r => ({
    person_id: resolve(r.person_id), year: r.year ? +r.year : null,
    title: (r.title || '').trim(), description: (r.description || r.desc || '').trim(),
  })).filter(s => s.person_id && s.title);

  return { people, relations, stories, skipped };
}
