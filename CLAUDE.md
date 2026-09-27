# Handoff notes for Claude

You're picking up a family tree site that's already built and live. This file
is so you don't have to re-derive context from scratch, and so you don't redo
— or worse, undo — work a previous session already did. `README.md` is the
human-facing doc; this one is for you.

## Current state (check this is still true before assuming anything)

- GitHub: `yashwatwani/family-tree`, public, branch `main`. Netlify deploys
  from it automatically on push.
- Live: <https://watwani-family.netlify.app>
- Database: a real Supabase project, already seeded with the family's actual
  23 people and 21 relationships. `config.js` already has its URL and
  publishable key committed on purpose — do not blank these out, and do not
  spin up a second Supabase project "to be safe."
- The family passcode that unlocks editing is **not in this repo, not in git
  history, and not known to any Claude session**. It's hashed server-side in
  `ft_settings`, which the public key can never read (verified: RLS on that
  table returns `[]` for every query from `anon`, never an error that would
  leak whether a guess was close). If you need to test writes, ask the user
  for the passcode in chat rather than trying to read or reset it — and don't
  echo it back into a file.
- `legacy/` is the old single-file version, kept only for reference. Nothing
  reads from it. Don't "helpfully" merge it back in or delete it without
  asking — it's there because the user might want to compare.
- `data/snapshot.json` is the read-only fallback the live site falls back to
  if Supabase is ever unreachable. It is **not** kept in sync automatically —
  if the database diverges from it (people added through the site), the
  snapshot goes stale. That's expected; it's a fallback, not a mirror. Refresh
  it deliberately (export from the site's *Download a backup*, or query
  Supabase) if staleness starts to matter.

## Architecture, in one pass

```
index.html            markup only, no inline logic
config.js             the one file a human is expected to hand-edit
supabase-setup.sql    schema + RLS + all write functions; the only way to write
assets/js/data.js     state, graph queries (getParents/getSpouses/etc.), all
                       Supabase calls. Nothing else touches fetch() for data.
assets/js/graph.js    layout math + SVG rendering + pan/zoom. Pure DOM, no
                       fetch, no app state beyond what render() is given.
assets/js/search.js   the search index over people/stories/marriages/places/years
assets/js/panel.js    person drawer + stats drawer (read side)
assets/js/editor.js   every form (add/edit person, relative, story, import,
                       quick-fill), all write-side
assets/js/ui.js       theme, toast, drawers, modals — no domain knowledge
assets/js/main.js     wiring only: imports the above, connects DOM events to
                       functions. If you're looking for "where does clicking X
                       lead", start here.
```

Modules talk to each other through the small `hooks` objects exported by
`graph.js`, `panel.js`, `editor.js` (e.g. `panelHooks.onFocus = id => ...`)
rather than importing each other directly — keeps them independently
testable/replaceable. Follow that pattern rather than reaching into another
module's internals.

## Things that bit me building this — don't reintroduce them

1. **`ft_people`'s text columns are `not null default ''`.** An explicit SQL
   `null` still violates that constraint — the default only fires when the
   column is *omitted* from the insert, not when null is passed explicitly.
   Any code that generates SQL for this table must write `''` for blank text
   and reserve `null` only for `born`/`died`/`year` (real nullable integers).
   `tools/migrate-sheet.mjs`'s `q()`/`qn()` split enforces this — if you touch
   it, keep the split.
2. **`[hidden]` needs `!important`** in `app.css`. `.galaxy` etc. set
   `display: flex`, which beats the attribute selector's default `display:
   none` on specificity grounds, so a plain `[hidden] { display: none }`
   silently does nothing on those elements.
3. **Person ids are assigned server-side** (in `ft_save_person`), not in the
   browser, specifically so two people adding someone at the same moment can't
   land on the same id and clobber each other. Don't move id generation back
   into `editor.js`.
4. **The passcode brake is a growing delay, not a hard lockout** — a hard
   lockout after N wrong guesses would let anyone lock the real family out by
   deliberately failing the passcode a few times. Keep it that shape if you
   touch `ft_check_passcode`.
5. **Netlify on this account has a monthly credit cap.** If a deploy shows
   `error_message: "Skipped due to account credit usage exceeded"`, that is
   not caused by anything in this repo — don't go hunting for a build bug.
   Check `netlify api getSite --data '{"site_id":"..."}'` for
   `published_deploy.commit_ref` to see what's actually live vs. what's queued.

## Testing changes before you push

There's no CI. Before pushing anything that touches `supabase-setup.sql`,
actually run it — don't just read it and reason about correctness. A local
throwaway Postgres is enough to catch the constraint-shaped bugs above:

```bash
initdb -D /tmp/ftpg-data --auth=trust
pg_ctl -D /tmp/ftpg-data -o "-p 55432 -k /tmp -c listen_addresses=''" -l /tmp/ftpg.log start
createdb -h /tmp -p 55432 ft
psql -h /tmp -p 55432 -d ft -c "create role anon nologin; create role authenticated nologin;"
psql -h /tmp -p 55432 -d ft -v ON_ERROR_STOP=1 -f supabase-setup.sql
psql -h /tmp -p 55432 -d ft -v ON_ERROR_STOP=1 -f data/seed.sql
# then `set role anon;` and call the ft_* functions the way the browser would
pg_ctl -D /tmp/ftpg-data stop
```

For the frontend, `python3 -m http.server` and a browser tool (this session
used a mock Supabase harness injected via a throwaway HTML file — recreate one
if you need to test writes without touching the real database; don't test
destructive flows like `ft_bulk_import` against the live project).

## Data quality already known and flagged in-app

Eight people (the Makranis and most Sidhwanis) have no relationships at all —
this is real, not a bug, and only the user can say who they connect to. Most
people are missing gender and/or birth year. The app surfaces all of this
under *Family in numbers → Worth filling in* rather than hiding it — don't
"fix" it by inventing data.
