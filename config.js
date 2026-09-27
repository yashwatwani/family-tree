/* ───────────────────────────────────────────────────────────────
   The only file you need to edit.

   Leave supabase blank and the site runs read-only from
   data/snapshot.json. Fill it in and the site becomes live:
   anyone can read it, and anyone with the passcode can add
   and edit people from inside the site itself.

   Both values below are safe to publish. The Supabase "anon"
   key is designed to be public — every write is checked against
   your passcode inside the database, not here in the browser.
   ─────────────────────────────────────────────────────────────── */

window.FT_CONFIG = {
  // Site → Settings → Title
  siteTitle: 'Our Families',
  headline: 'One family, many branches',

  // Project Settings → Data API → Project URL, e.g. 'https://abcdefgh.supabase.co'
  supabaseUrl: 'https://bvlwcofqykcvxarwexrx.supabase.co',

  // Project Settings → API Keys → anon / public (or "publishable" on newer projects)
  supabaseAnonKey: 'sb_publishable_luMehkjTnSSEowMtfRYmYQ_5c6UX65w',

  // Fallback data, used when Supabase is not configured or unreachable.
  snapshotUrl: 'data/snapshot.json',

  // Colours are assigned to families in the order they first appear.
  palette: [
    '#d4a574', '#b87a9c', '#6fa39a', '#a89bd8', '#e8a87c',
    '#85ccb8', '#d49a9a', '#9ab8d6', '#c2b07a', '#8fb98a',
  ],
};
