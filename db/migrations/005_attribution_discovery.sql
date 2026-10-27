-- 005: who made a track (not just "main" and "remixer"), verified artist aliases,
-- saved unreleased IDs by where they were heard, and gathering that can be stopped.

-- Credit roles, from how tracklists write a line:
--   main             "A & B - Title": the track's artists
--   featured         "A ft. B - Title": B (1001Tracklists writes vocalists this way too)
--   remixer          "Title (C Remix)" / "(C Edit)" / "(C Mashup)": who made this version
--   mashup_component "A vs. B - X vs. Y": artists whose songs a mashup is built from
alter table track_artists drop constraint track_artists_role_check;
alter table track_artists add constraint track_artists_role_check check (role in ('main', 'featured', 'remixer', 'mashup_component'));

-- One artist listed under two names. Only pairs with evidence go here; analytics,
-- filtering and gathering treat the alias as the canonical artist.
create table artist_aliases (
  artist_id    bigint primary key references artists(id) on delete cascade,
  canonical_id bigint not null references artists(id) on delete cascade,
  evidence     text not null,
  created_at   timestamptz not null default now(),
  check (artist_id <> canonical_id)
);

-- Lorenzo is Chris Lorenzo: 1001Tracklists' own URLs for "Lorenzo @ ..." sets use the
-- slug chris-lorenzo, and Chris Lorenzo's profile links to Beatport and Traxsource
-- pages named "Lorenzo".
insert into artist_aliases (artist_id, canonical_id, evidence)
select alias.id, canonical.id,
       '1001Tracklists set URLs for "Lorenzo @ ..." sets use the slug chris-lorenzo; Chris Lorenzo''s 1001Tracklists profile links Beatport and Traxsource pages named "Lorenzo".'
  from artists alias, artists canonical
 where alias.name_key = 'lorenzo' and canonical.name_key = 'chris lorenzo';

-- Small settings the app keeps for itself (e.g. which version of the credit rules
-- the stored credits were made with).
create table app_meta (
  key   text primary key,
  value text not null
);

-- Unreleased Vault: an ID is saved as the line it was heard on (a set and a position),
-- never merged with other "ID - ID" lines. What it is now comes from that line, so
-- when a refreshed tracklist identifies it, the Vault shows that by itself.
create table vault_items (
  user_id    bigint not null references users(id) on delete cascade,
  set_id     bigint not null references sets(id) on delete cascade,
  position   int not null,
  saved_text text not null,               -- the line as it read when saved ("Fisher - ID")
  created_at timestamptz not null default now(),
  primary key (user_id, set_id, position)
);

-- Which DJ or track page a fetch job came from, so "Stop gathering" can cancel it.
alter table collection_jobs add column discovery_page text;
create index collection_jobs_discovery_page on collection_jobs (discovery_page) where discovery_page is not null;
