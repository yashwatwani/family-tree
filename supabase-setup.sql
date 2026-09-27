-- ═══════════════════════════════════════════════════════════════════════════
--  Our Families — database setup
--
--  Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--  It is safe to run again later; it will not wipe your data.
--
--  ▶ BEFORE YOU RUN IT: change the passcode on the line marked ⬇ below.
--
--  How the security works
--  ----------------------
--  The anon key in config.js is public, on purpose. It is allowed to READ the
--  three tables and nothing else — row level security blocks every write.
--  Writes only happen through the ft_* functions here, and each one checks the
--  passcode against a salted hash stored in a table that the anon key cannot
--  read at all. So anyone can look at your tree; only people with the passcode
--  can change it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─────────────────────────── 1. Tables ───────────────────────────

create table if not exists ft_people (
  id           text primary key,
  name         text not null,
  family       text not null default '',
  maiden_name  text not null default '',
  born_family  text not null default '',
  gender       text not null default '' check (gender in ('', 'M', 'F', 'X')),
  role         text not null default '',
  born         integer check (born is null or born between 1 and 2200),
  died         integer check (died is null or died between 1 and 2200),
  location     text not null default '',
  photo_url    text not null default '',
  bio          text not null default '',
  updated_at   timestamptz not null default now(),
  check (died is null or born is null or died >= born)
);

create table if not exists ft_relations (
  id        bigint generated always as identity primary key,
  person_a  text not null references ft_people(id) on delete cascade,
  person_b  text not null references ft_people(id) on delete cascade,
  type      text not null check (type in ('parent', 'spouse')),
  year      integer,
  check (person_a <> person_b),
  unique (person_a, person_b, type)
);

create index if not exists ft_relations_a_idx on ft_relations (person_a);
create index if not exists ft_relations_b_idx on ft_relations (person_b);

create table if not exists ft_stories (
  id          bigint generated always as identity primary key,
  person_id   text not null references ft_people(id) on delete cascade,
  year        integer,
  title       text not null,
  description text not null default ''
);

create index if not exists ft_stories_person_idx on ft_stories (person_id);

-- Private: the anon key can never read this table.
create table if not exists ft_settings (
  key   text primary key,
  value text not null
);

-- Brute-force speed bump.
create table if not exists ft_attempts (
  at timestamptz not null default now()
);
create index if not exists ft_attempts_at_idx on ft_attempts (at);


-- ─────────────────────────── 2. Row level security ───────────────────────────

alter table ft_people    enable row level security;
alter table ft_relations enable row level security;
alter table ft_stories   enable row level security;
alter table ft_settings  enable row level security;
alter table ft_attempts  enable row level security;

drop policy if exists ft_people_read    on ft_people;
drop policy if exists ft_relations_read on ft_relations;
drop policy if exists ft_stories_read   on ft_stories;

create policy ft_people_read    on ft_people    for select using (true);
create policy ft_relations_read on ft_relations for select using (true);
create policy ft_stories_read   on ft_stories   for select using (true);

-- No policies on ft_settings or ft_attempts, so nobody outside the functions
-- below can touch them. No insert/update/delete policies anywhere: every write
-- goes through a function.

grant select on ft_people, ft_relations, ft_stories to anon, authenticated;


-- ─────────────────────────── 3. Passcode ───────────────────────────

insert into ft_settings (key, value)
values ('salt', gen_random_uuid()::text)
on conflict (key) do nothing;

create or replace function ft_hash(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select encode(
    sha256(((select value from ft_settings where key = 'salt') || p_code)::bytea),
    'hex'
  );
$$;

revoke execute on function ft_hash(text) from public, anon, authenticated;

-- ⬇⬇⬇  CHANGE THIS to your own family passcode, then run the file.  ⬇⬇⬇
insert into ft_settings (key, value)
values ('passcode', ft_hash('change-this-passcode'))
on conflict (key) do update set value = excluded.value;
-- ⬆⬆⬆  Re-run just these three lines any time you want to change it.  ⬆⬆⬆


-- Guessing defence. The check has to come before we look at the guess,
-- otherwise it tells an attacker nothing they did not already know — so the
-- main brake is a delay that grows with recent failures rather than a lockout,
-- and the hard stop sits high enough that a family member fumbling their
-- passcode will never reach it.
create or replace function ft_check_passcode(p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  recent integer;
  ok     boolean;
begin
  delete from ft_attempts where at < now() - interval '1 hour';
  select count(*) into recent from ft_attempts where at > now() - interval '15 minutes';

  if recent >= 50 then
    raise exception 'Too many wrong passcodes have been tried. Wait fifteen minutes.';
  end if;

  -- 0.25s at rest, up to 2s once someone is clearly hammering it.
  perform pg_sleep(least(2.0, 0.25 + recent * 0.05));

  select value = ft_hash(p_code) into ok from ft_settings where key = 'passcode';
  ok := coalesce(ok, false);

  if ok then
    delete from ft_attempts;         -- a good passcode clears the slate
  else
    insert into ft_attempts default values;
  end if;

  return ok;
end;
$$;

create or replace function ft_require(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not ft_check_passcode(p_code) then
    raise exception 'Wrong passcode.';
  end if;
end;
$$;


-- ─────────────────────────── 4. Write functions ───────────────────────────

-- Leave "id" out of the payload for a new person and the database picks the
-- next free one. Doing it here rather than in the browser means two people
-- adding at the same moment can never land on the same id and overwrite
-- each other.
create or replace function ft_save_person(p_code text, p_person jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  result   ft_people;
  v_id     text := coalesce(trim(p_person->>'id'), '');
  v_prefix text;
begin
  perform ft_require(p_code);

  if coalesce(trim(p_person->>'name'), '') = '' then
    raise exception 'A name is required.';
  end if;

  if v_id = '' then
    v_prefix := upper(left(coalesce(nullif(trim(p_person->>'family'), ''), 'p'), 1));
    if v_prefix !~ '^[A-Z]$' then v_prefix := 'P'; end if;
    select v_prefix || lpad(
      (coalesce(max(substring(id from '^' || v_prefix || '([0-9]+)$')::integer), 0) + 1)::text, 2, '0')
      into v_id
      from ft_people
     where id ~ ('^' || v_prefix || '[0-9]+$');
  end if;

  insert into ft_people as t (
    id, name, family, maiden_name, born_family, gender, role,
    born, died, location, photo_url, bio, updated_at
  ) values (
    v_id,
    trim(p_person->>'name'),
    coalesce(lower(trim(p_person->>'family')), ''),
    coalesce(p_person->>'maiden_name', ''),
    coalesce(lower(trim(p_person->>'born_family')), ''),
    coalesce(upper(left(coalesce(p_person->>'gender', ''), 1)), ''),
    coalesce(p_person->>'role', ''),
    nullif(p_person->>'born', '')::integer,
    nullif(p_person->>'died', '')::integer,
    coalesce(p_person->>'location', ''),
    coalesce(p_person->>'photo_url', ''),
    coalesce(p_person->>'bio', ''),
    now()
  )
  on conflict (id) do update set
    name        = excluded.name,
    family      = excluded.family,
    maiden_name = excluded.maiden_name,
    born_family = excluded.born_family,
    gender      = excluded.gender,
    role        = excluded.role,
    born        = excluded.born,
    died        = excluded.died,
    location    = excluded.location,
    photo_url   = excluded.photo_url,
    bio         = excluded.bio,
    updated_at  = now()
  returning * into result;

  return to_jsonb(result);
end;
$$;


create or replace function ft_delete_person(p_code text, p_id text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ft_require(p_code);
  delete from ft_people where id = p_id;   -- relations and stories cascade
end;
$$;


create or replace function ft_save_relation(p_code text, p_relation jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_type   text := lower(trim(p_relation->>'type'));
  v_a      text := trim(p_relation->>'person_a');
  v_b      text := trim(p_relation->>'person_b');
  v_year   integer := nullif(p_relation->>'year', '')::integer;
  v_swap   text;
  result   ft_relations;
begin
  perform ft_require(p_code);

  if v_type not in ('parent', 'spouse') then
    raise exception 'A link must be "parent" or "spouse".';
  end if;
  if v_a = v_b then
    raise exception 'Someone cannot be linked to themselves.';
  end if;

  -- A marriage has no direction, so store it in a fixed order.
  if v_type = 'spouse' and v_a > v_b then
    v_swap := v_a; v_a := v_b; v_b := v_swap;
  end if;

  if v_type = 'parent' then
    if (select count(*) from ft_relations where person_b = v_b and type = 'parent') >= 2 then
      raise exception 'That person already has two parents.';
    end if;
    -- Walk up from the proposed parent; if we meet the child, it is a loop.
    if exists (
      with recursive up as (
        select person_a as ancestor from ft_relations where person_b = v_a and type = 'parent'
        union
        select r.person_a from ft_relations r join up on r.person_b = up.ancestor where r.type = 'parent'
      )
      select 1 from up where ancestor = v_b
    ) then
      raise exception 'That would make a loop in the family tree.';
    end if;
  end if;

  insert into ft_relations (person_a, person_b, type, year)
  values (v_a, v_b, v_type, v_year)
  on conflict (person_a, person_b, type) do update set year = coalesce(excluded.year, ft_relations.year)
  returning * into result;

  return to_jsonb(result);
end;
$$;


create or replace function ft_delete_relation(p_code text, p_a text, p_b text, p_type text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ft_require(p_code);
  delete from ft_relations
   where type = p_type
     and ((person_a = p_a and person_b = p_b) or (person_a = p_b and person_b = p_a));
end;
$$;


create or replace function ft_save_story(p_code text, p_story jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id   bigint := nullif(p_story->>'id', '')::bigint;
  result ft_stories;
begin
  perform ft_require(p_code);

  if coalesce(trim(p_story->>'title'), '') = '' then
    raise exception 'A moment needs a title.';
  end if;

  if v_id is null then
    insert into ft_stories (person_id, year, title, description)
    values (
      trim(p_story->>'person_id'),
      nullif(p_story->>'year', '')::integer,
      trim(p_story->>'title'),
      coalesce(p_story->>'description', '')
    )
    returning * into result;
  else
    update ft_stories set
      year        = nullif(p_story->>'year', '')::integer,
      title       = trim(p_story->>'title'),
      description = coalesce(p_story->>'description', '')
    where id = v_id
    returning * into result;
  end if;

  return to_jsonb(result);
end;
$$;


create or replace function ft_delete_story(p_code text, p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ft_require(p_code);
  delete from ft_stories where id = p_id;
end;
$$;


-- Replaces the entire tree. Used by the "Import from a Google Sheet" button.
create or replace function ft_bulk_import(
  p_code text, p_people jsonb, p_relations jsonb, p_stories jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_people integer := 0;
  v_rels   integer := 0;
  v_tales  integer := 0;
begin
  perform ft_require(p_code);

  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) = 0 then
    raise exception 'The import had no people in it — nothing was changed.';
  end if;

  delete from ft_stories;
  delete from ft_relations;
  delete from ft_people;

  insert into ft_people (id, name, family, maiden_name, born_family, gender, role,
                         born, died, location, photo_url, bio)
  select
    trim(e->>'id'), trim(e->>'name'),
    coalesce(lower(trim(e->>'family')), ''),
    coalesce(e->>'maiden_name', ''),
    coalesce(lower(trim(e->>'born_family')), ''),
    coalesce(upper(left(coalesce(e->>'gender', ''), 1)), ''),
    coalesce(e->>'role', ''),
    nullif(e->>'born', '')::integer,
    nullif(e->>'died', '')::integer,
    coalesce(e->>'location', ''),
    coalesce(e->>'photo_url', ''),
    coalesce(e->>'bio', '')
  from jsonb_array_elements(p_people) e
  where coalesce(trim(e->>'id'), '') <> '' and coalesce(trim(e->>'name'), '') <> ''
  on conflict (id) do nothing;
  get diagnostics v_people = row_count;

  insert into ft_relations (person_a, person_b, type, year)
  select trim(e->>'person_a'), trim(e->>'person_b'), lower(trim(e->>'type')), nullif(e->>'year', '')::integer
  from jsonb_array_elements(coalesce(p_relations, '[]'::jsonb)) e
  where lower(trim(e->>'type')) in ('parent', 'spouse')
    and trim(e->>'person_a') <> trim(e->>'person_b')
    and exists (select 1 from ft_people where id = trim(e->>'person_a'))
    and exists (select 1 from ft_people where id = trim(e->>'person_b'))
  on conflict (person_a, person_b, type) do nothing;
  get diagnostics v_rels = row_count;

  insert into ft_stories (person_id, year, title, description)
  select trim(e->>'person_id'), nullif(e->>'year', '')::integer,
         trim(e->>'title'), coalesce(e->>'description', '')
  from jsonb_array_elements(coalesce(p_stories, '[]'::jsonb)) e
  where coalesce(trim(e->>'title'), '') <> ''
    and exists (select 1 from ft_people where id = trim(e->>'person_id'));
  get diagnostics v_tales = row_count;

  return jsonb_build_object('people', v_people, 'relations', v_rels, 'stories', v_tales);
end;
$$;


-- ─────────────────────────── 5. Permissions ───────────────────────────

grant execute on function
  ft_check_passcode(text),
  ft_save_person(text, jsonb),
  ft_delete_person(text, text),
  ft_save_relation(text, jsonb),
  ft_delete_relation(text, text, text, text),
  ft_save_story(text, jsonb),
  ft_delete_story(text, bigint),
  ft_bulk_import(text, jsonb, jsonb, jsonb)
to anon, authenticated;

-- ft_require and ft_hash are internal only.
revoke execute on function ft_require(text) from public, anon, authenticated;
