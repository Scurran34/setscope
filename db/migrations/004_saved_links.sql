-- 004: SoundCloud tracks someone saved into one of their collections (a remix found
-- through remix search, a curator's like...). Personal: a bookmark (link, title, who
-- uploaded it), not a copy of the track, and not part of the shared catalog.
create table collection_links (
  collection_id bigint not null references collections(id) on delete cascade,
  provider      text not null check (provider in ('soundcloud')),
  url           text not null,
  title         text not null,
  artist_text   text not null,
  added_at      timestamptz not null default now(),
  primary key (collection_id, url)
);
