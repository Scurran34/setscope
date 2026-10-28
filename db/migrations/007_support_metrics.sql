-- 007: what kind of set each one is (from the source's own wording), which recurring
-- show it belongs to, sets indexed twice, and SoundCloud artwork for linked recordings.

-- The set's type, as 1001Tracklists labels it in the page description
-- ("Tracklist / playlist for radio show ..."): live (festival, club or event), radio,
-- podcast, or unknown when the page doesn't say. Never guessed from track counts.
alter table sets add column set_type text not null default 'unknown'
  check (set_type in ('live', 'radio', 'podcast', 'unknown'));
-- Where the type came from ("page description: radio show"), or null when unknown.
alter table sets add column set_type_evidence text;
-- The recurring show or event the source links in the set's title ("/source/sf28f3" =
-- Dance Department), so repeated episodes of one show can be recognised.
alter table sets add column series_key text;
alter table sets add column series_name text;
create index sets_series on sets (series_key) where series_key is not null;

-- Backfill from the pages already saved (new sets get these when they're parsed).
-- Postgres caps a regex repetition at 255, hence the two halves of the title window.
with page as (
  select set_id,
         substring(html from 'Tracklist / playlist for (live set|radio show|podcast) ') kind,
         substring(html from 'id="pageTitle"(.{1,250}.{0,250})') title
    from set_pages
)
update sets s set
  set_type = case page.kind when 'live set' then 'live' when 'radio show' then 'radio' when 'podcast' then 'podcast' else 'unknown' end,
  set_type_evidence = case when page.kind is not null then 'page description: ' || page.kind end,
  series_key = substring(page.title from 'href="/source/([a-z0-9]+)/'),
  series_name = substring(page.title from 'href="/source/[^"]+">([^<]+)<')
  from page where page.set_id = s.id;

-- The same performance indexed twice (two tracklist pages for one set): same DJ, played
-- within a day, and nearly the same identified tracks. The later copy is left out of
-- every count; nothing is deleted. Different nights with similar tracklists (a tour, a
-- weekly show) are separate performances and are *not* listed here.
create table set_duplicates (
  set_id       bigint primary key references sets(id) on delete cascade,
  duplicate_of bigint not null references sets(id) on delete cascade,
  similarity   real not null,
  check (set_id <> duplicate_of)
);

-- SoundCloud's artwork for a linked upload, kept as a reference like the link itself.
alter table external_track_links add column artwork_url text;

-- When someone last opened a waiting set by hand ("Open next set"), so the next press
-- offers a different one while this one is being saved.
alter table collection_jobs add column opened_at timestamptz;
