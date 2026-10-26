-- 001: the shared music catalog, accounts and personal data, and collection bookkeeping.
--
-- Shared (everyone sees the same rows): artists, tracks, sets, set_tracks, ...
-- Personal (one user's rows, never shown to others): user_likes, collections,
-- followed_artists, vault_entries.

-- ---------- shared catalog ----------

create table artists (
  id          bigserial primary key,
  name        text not null,                 -- most common spelling, e.g. "CHRIS STASSY"
  name_key    text not null unique,          -- normalized: lowercase, no accents/periods/apostrophes
  tl_page     text,                          -- their 1001Tracklists page
  country     text,
  image_url   text,
  links       jsonb not null default '[]',   -- [{label, url}] from their DJ card
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- How a recording relates to its original. "extended" mixes count as the original
-- recording (same identity); anything else is its own track linked by original_key.
create type version_type as enum ('original', 'remix', 'edit', 'vip', 'bootleg', 'mashup', 'rework', 'unknown');

-- What we know about whether a track is identified and released. Absence of a link is
-- a reason to investigate, never proof of anything.
create type id_status as enum ('identified', 'unidentified', 'potentially_unreleased', 'confirmed_unreleased', 'released', 'unknown');

create table tracks (
  id              bigserial primary key,
  artist_text     text not null,               -- as written: "Riordan & Locky"
  title           text not null,               -- as written: "Friction (Extended Mix)"
  -- Identified tracks: normalized "artists - title" (version tags like Extended Mix removed).
  -- Unidentified IDs without a 1001Tracklists id: null, so placeholders are never merged by name.
  identity_key    text unique,
  tl_track_id     text unique,                 -- 1001Tracklists' own track id, when the source gives one
  version_type    version_type not null default 'original',
  version_artists text,                        -- remixer/editor credit, e.g. "Kite"
  original_key    text,                        -- identity_key of the original, for versions
  parent_track_id bigint references tracks(id) on delete set null,
  label           text,
  genre           text,                        -- most recent genre tag from the source
  id_status       id_status not null default 'identified',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index tracks_original_key on tracks (original_key) where original_key is not null;
create index tracks_parent on tracks (parent_track_id) where parent_track_id is not null;
create index tracks_id_status on tracks (id_status);

create table track_artists (
  track_id  bigint not null references tracks(id) on delete cascade,
  artist_id bigint not null references artists(id) on delete cascade,
  role      text not null check (role in ('main', 'remixer')),
  position  int not null,
  primary key (track_id, artist_id, role)
);
create index track_artists_artist on track_artists (artist_id);

create table sets (
  id                bigserial primary key,
  source            text not null default '1001tracklists',
  source_id         text not null,              -- e.g. "p3yju6k"
  url               text not null,
  title             text not null,
  performed_on      date,                       -- when the set was played (rankings use this)
  soundcloud_url    text,                       -- the set's recording, an API track URL
  parser_version    int,
  first_indexed_at  timestamptz not null default now(),
  last_refreshed_at timestamptz,
  unique (source, source_id)
);
create index sets_performed_on on sets (performed_on);

create table set_djs (
  set_id    bigint not null references sets(id) on delete cascade,
  artist_id bigint not null references artists(id) on delete cascade,
  position  int not null,
  primary key (set_id, artist_id)
);
create index set_djs_artist on set_djs (artist_id);

-- One row per tracklist line, in order, with exactly what the source wrote.
create table set_tracks (
  set_id     bigint not null references sets(id) on delete cascade,
  position   int not null,
  track_id   bigint not null references tracks(id),
  raw_artist text not null,
  raw_title  text not null,
  primary key (set_id, position)
);
create index set_tracks_track on set_tracks (track_id);

-- The page each set was read from, so the parser can be improved without refetching.
create table set_pages (
  set_id     bigint primary key references sets(id) on delete cascade,
  html       text not null,
  fetched_at timestamptz not null default now()
);

-- What changed when a set was re-read (e.g. "ID - ID" became "Artist - Title").
create table track_metadata_history (
  id          bigserial primary key,
  set_id      bigint not null references sets(id) on delete cascade,
  position    int not null,
  old_track_id bigint references tracks(id) on delete set null,
  new_track_id bigint references tracks(id) on delete set null,
  old_text    text not null,
  new_text    text not null,
  changed_at  timestamptz not null default now()
);
create index track_metadata_history_tracks on track_metadata_history (old_track_id, new_track_id);

-- Links from a track to a playable/purchasable recording elsewhere (SoundCloud first).
-- Only references are stored, never audio or another service's catalog.
create table external_track_links (
  id          bigserial primary key,
  track_id    bigint not null references tracks(id) on delete cascade,
  provider    text not null check (provider in ('soundcloud')),
  url         text not null,
  external_id text,
  confidence  real not null default 1,          -- 1 = exact/verified, lower = matched
  provenance  text not null check (provenance in ('source_page', 'user', 'search_match')),
  added_by    bigint,                           -- users.id, set below
  created_at  timestamptz not null default now(),
  unique (track_id, provider, url)
);

-- ---------- accounts ----------

create table users (
  id            bigserial primary key,
  email         text not null unique,           -- stored lowercase
  display_name  text not null,
  password_hash text not null,                  -- scrypt, with its own salt and parameters
  created_at    timestamptz not null default now()
);
alter table external_track_links add constraint external_track_links_added_by
  foreign key (added_by) references users(id) on delete set null;

create table sessions (
  token_hash  text primary key,                 -- sha256 of the cookie value; the cookie itself is never stored
  user_id     bigint not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user on sessions (user_id);

-- ---------- personal data ----------

create table user_likes (
  user_id    bigint not null references users(id) on delete cascade,
  track_id   bigint not null references tracks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

create table collections (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  name       text not null,
  name_key   text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name_key)
);

create table collection_tracks (
  collection_id bigint not null references collections(id) on delete cascade,
  track_id      bigint not null references tracks(id) on delete cascade,
  added_at      timestamptz not null default now(),
  primary key (collection_id, track_id)
);

create table followed_artists (
  user_id    bigint not null references users(id) on delete cascade,
  artist_id  bigint not null references artists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, artist_id)
);

create table vault_entries (
  user_id    bigint not null references users(id) on delete cascade,
  track_id   bigint not null references tracks(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, track_id)
);

-- ---------- collection bookkeeping ----------

create table collection_jobs (
  id              bigserial primary key,
  kind            text not null check (kind in ('fetch_set', 'refresh_set')),
  target          text not null,                -- the set URL
  status          text not null check (status in ('queued', 'running', 'done', 'failed', 'blocked')),
  priority        int not null default 0,       -- higher first
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  requested_by    bigint references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- One live job per target: asking twice doesn't fetch twice.
create unique index collection_jobs_live on collection_jobs (kind, target) where status in ('queued', 'running', 'blocked');
create index collection_jobs_next on collection_jobs (status, priority desc, next_attempt_at);

-- How far "Gather more sets" has got for an artist or track page.
create table discovery_progress (
  page_url          text primary key,           -- the 1001Tracklists DJ or track page
  artist_id         bigint references artists(id) on delete set null,
  sets_seen         int not null default 0,     -- distinct set links seen on the page so far
  sets_indexed      int not null default 0,     -- of those, how many we have
  historical_done   boolean not null default false,
  last_attempt_at   timestamptz,
  last_success_at   timestamptz,
  last_error        text
);

create table source_refresh_history (
  id           bigserial primary key,
  set_id       bigint not null references sets(id) on delete cascade,
  refreshed_at timestamptz not null default now(),
  result       text not null check (result in ('unchanged', 'updated', 'failed', 'blocked')),
  changes      int not null default 0,
  error        text
);
create index source_refresh_history_set on source_refresh_history (set_id, refreshed_at desc);
