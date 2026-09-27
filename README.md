# Our Families — a living family graph

An interactive family tree you can share with a link. Explore generations, see
how any two people are connected, search everything, and — once the database is
switched on — add people from inside the site itself.

No build step, no npm, no framework. Plain HTML, CSS and JavaScript modules.

---

## Project status

This is already set up and live. If you're picking this up fresh — a new
machine, a new Claude Code session, whatever — here's what already exists so
you don't redo it:

| | |
|---|---|
| **Code** | <https://github.com/yashwatwani/family-tree> (public), branch `main` |
| **Live site** | <https://watwani-family.netlify.app>, auto-deploys on every push to `main` |
| **Database** | Supabase project `watwani-family` (ref `bvlwcofqykcvxarwexrx`), org "yashwatwani's Org" |
| **Editing** | Unlocked with a passcode only the family has — not stored anywhere in this repo or known to any AI session, including this one |

`config.js` already has the live Supabase URL and publishable key committed —
that's intentional and safe (see *Is it safe to publish that key?* below), so
you should **not** need to redo the Supabase steps unless you're deliberately
starting a second, separate tree.

If Netlify shows *"Skipped due to account credit usage exceeded"* on a deploy,
that's the free-tier monthly credit limit, not a bug — it resets on the 1st of
each month. Check `netlify api getSite` on the site id, or just wait a few
days; nothing needs fixing in the code.

See `CLAUDE.md` for the fuller technical handoff notes (architecture, gotchas,
conventions) aimed at an AI assistant working on this next.

---

## Run it on your own machine

Browsers block a page from reading local files, so open it through a tiny server
rather than double-clicking `index.html`:

```bash
cd ~/Documents/family-tree && python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

## Put it online (Netlify)

**The quick way.** Go to <https://app.netlify.com/drop> and drag this whole
folder onto the page. You get a live URL in about twenty seconds. To update it
later, drag the folder again.

**The tidy way.** Push the folder to GitHub, then in Netlify choose
*Add new site → Import an existing project*, pick the repo, and leave the build
command empty and the publish directory as `.` — `netlify.toml` already says so.
Every push then redeploys itself.

Either way, rename the site under *Site configuration → Change site name* so the
link you send round reads `watwani-family.netlify.app` rather than a random one.

At this point the site is live and read-only: it reads `data/snapshot.json`, and
the *Add & edit* button explains that editing is off.

---

## Turn on adding and editing

This takes about ten minutes and is free.

### 1. Make a Supabase project

Sign up at <https://supabase.com>, create a project, and wait for it to finish
setting up. Any region near you is fine.

### 2. Create the tables

Open **SQL Editor → New query**, paste in the whole of `supabase-setup.sql`, and
**change the passcode on the line marked ⬇** before you run it. That passcode is
what your family will type to unlock editing, so pick something they can
remember and you are happy to send over WhatsApp.

Press **Run**. It should finish with no errors.

### 3. Load your existing people in

Open a second query, paste in the whole of `data/seed.sql`, and run it. That
puts the 23 people and 21 relationships already in this folder into the
database.

### 4. Point the site at it

In Supabase go to **Project Settings → Data API** for the project URL, and
**Project Settings → API Keys** for the `anon` `public` key. Put both into
`config.js`:

```js
supabaseUrl: 'https://yourproject.supabase.co',
supabaseAnonKey: 'eyJhbGciOi...',
```

Redeploy. The site now reads live from the database, and anyone who knows the
passcode can press **+** in the top bar, unlock, and start adding people.

> **Is it safe to publish that key?** Yes — that is what the anon key is for. It
> is allowed to read the three tables and nothing else. Every write goes through
> a database function that checks your passcode against a salted hash kept in a
> table the key cannot read. Details are in the comments at the top of
> `supabase-setup.sql`.

---

## Using it

| | |
|---|---|
| **Search everything** | `⌘K` (or `/`). Searches names, maiden names, families, roles, places, birth and death years, marriages, and the text of every story. |
| **Find path** | In the tree toolbar. Pick two people and it lights up the chain between them and spells it out: *Yash → mother → Reema → husband → Amar*. |
| **Centre on someone** | Open a person, press *Centre on …*. Everyone rearranges into rings by how closely they are related to that person. |
| **Time travel** | The clock icon, or `T`. Drag the year back and watch the tree shrink to who was alive then. |
| **Theme** | The sun/moon icon, or `L`. Midnight, or heirloom paper. It remembers your choice. |
| **Share one person** | Open them and press *Copy link*. The link opens straight to their page. |

Other keys: `space` to enter the tree, `F` to fit, `+`/`−` to zoom, `A` to add a
person, `Esc` to go back, `?` for the list.

### Adding people

The forms are built around links rather than rows, because that is how you
actually think about it. You add *Amar's father*, not "a person, and separately
a relationship". So:

1. Press **+ → Add a person**, fill in what you know.
2. It immediately asks how they connect — parent, partner, child or sibling — and
   you either pick someone already in the tree or type a name to create them on
   the spot.

From any person's page you can also **Add a relative**, **Add a moment** for
their timeline, **Edit** them, or remove a wrong link with the small × on a
relationship chip.

**Fill in the gaps** (under **+**) is the fast way to clear out missing data: it
lists everyone missing a gender or a birth year with the controls right there,
and saves the lot in one go.

The database refuses the mistakes that are hard to spot later: a third parent, a
loop where someone ends up their own ancestor, a duplicate marriage, or a link
to somebody who does not exist.

---

## Your data

Three tables, mirrored by `data/snapshot.json`:

- **people** — `id`, `name`, `family`, `maiden_name`, `born_family`, `gender`,
  `role`, `born`, `died`, `location`, `photo_url`, `bio`
- **relations** — `person_a`, `person_b`, `type` (`parent` or `spouse`), `year`.
  For `parent`, `person_a` is the parent. For `spouse` the order does not matter.
- **stories** — `person_id`, `year`, `title`, `description`

Families are just a text field. Type a new one and it gets its own colour on the
overview screen automatically.

### Backups

**+ → Download a backup** saves the whole tree as JSON at any time. Do it before
an import. To make a backup the live fallback, drop it in as
`data/snapshot.json` and redeploy — that file is what visitors see if Supabase
is ever unreachable.

### Importing from a Google Sheet

Still possible, under **+ → Import from a Google Sheet**. It checks the sheet
first and tells you what it found before writing anything. Note that it
**replaces everything**.

---

## What was fixed on the way in

The old Google Sheet had problems the site had been quietly working around:

- The Relationships tab's header row had been mangled by the Sheets *Table*
  feature, which folded the header and the first two data rows into one line.
  Those two rows — Amar as the father of Yash and of Hitanshi — were being
  dropped on every single page load. They are back.
- Two relationship rows were exact duplicates.
- Eight people (all the Makranis and Sidhwanis) have no relationships at all, so
  they float unattached. The tree flags this under *Family in numbers →
  Worth filling in*; only you can say who they belong to.
- Nobody had a gender or, in 14 cases, a birth year. Use **Fill in the gaps**.

`tools/migrate-sheet.mjs` is the script that did the cleanup. Run
`node tools/migrate-sheet.mjs` to regenerate `data/snapshot.json` and
`data/seed.sql` from the sheet again.

---

## Files

```
index.html              the page
config.js               the only file you normally edit
supabase-setup.sql      run once in Supabase to create the database
netlify.toml            deploy settings, no build step
assets/css/theme.css    colours for both themes — change them here
assets/css/app.css      everything else
assets/js/data.js       loading, the relationship graph, saving
assets/js/graph.js      layout, drawing, pan and zoom
assets/js/search.js     the search index
assets/js/panel.js      person and statistics drawers
assets/js/editor.js     the add and edit forms
assets/js/ui.js         theme, toasts, drawers, modals, overview
assets/js/main.js       wiring
data/snapshot.json      offline copy of the tree, and the read-only fallback
data/seed.sql           the same data as SQL, for first load into Supabase
tools/migrate-sheet.mjs one-off Google Sheet importer
legacy/                 the previous single-file version, kept for reference
```
