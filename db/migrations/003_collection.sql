-- 003: the collection system.
--   - jobs can be "held": found, but older than the window, set aside until someone includes them
--   - jobs carry the set's date (from its URL) so the newest are fetched first
--   - one row of shared collector state: whether collecting is paused, and why
--   - more detail on discovery progress for each DJ/track page

alter table collection_jobs drop constraint collection_jobs_status_check;
alter table collection_jobs add constraint collection_jobs_status_check
  check (status in ('queued', 'running', 'done', 'failed', 'blocked', 'held'));
drop index collection_jobs_live;
create unique index collection_jobs_live on collection_jobs (kind, target)
  where status in ('queued', 'running', 'blocked', 'held');
alter table collection_jobs add column performed_on date;
drop index collection_jobs_next;
create index collection_jobs_next on collection_jobs (status, priority desc, performed_on desc nulls last, id);

create table collector_state (
  id               int primary key check (id = 1),
  paused_reason    text check (paused_reason in ('site', 'failure', 'restart')),
  paused_detail    text,
  paused_at        timestamptz,
  -- "Done: N sets" counts from here; reset when a new batch starts on an idle queue.
  batch_started_at timestamptz not null default now()
);
insert into collector_state (id) values (1);

alter table discovery_progress add column sets_new int not null default 0;
alter table discovery_progress add column sets_older int not null default 0;
create index discovery_progress_artist on discovery_progress (artist_id);
