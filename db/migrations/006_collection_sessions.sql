-- 006: collection sessions ("collect 25 new sets from Fisher"), each person's collecting
-- preferences, and when the source said to come back.

-- One gather someone started. Its sets are ordinary fetch jobs that point back here.
--   running          the worker may take its sets
--   checkpoint       paused for a short countdown every N saved sets (checkpoint_until)
--   paused           waiting for the person: after a checkpoint with Auto-Collect off,
--                    or Auto-Collect switched off (pause_reason says which)
--   access_required  1001Tracklists is refusing or asking for verification
--   stopping         Stop pressed while a set was mid-fetch; becomes stopped right after
--   stopped          ended by the person; never restarts on its own
--   completed        reached its target, or ran out of sets to fetch
--   failed           couldn't go on for another reason (last_error)
create table collection_sessions (
  id               bigserial primary key,
  requested_by     bigint references users(id) on delete set null,
  artist_id        bigint references artists(id) on delete set null,
  label            text not null,                 -- who or what it collects: "Fisher"
  source_page      text,                          -- the DJ/track page the sets came from
  target           int not null check (target > 0),   -- new sets wanted
  collected        int not null default 0,        -- new sets saved by this session
  cached           int not null default 0,        -- sets seen that were already indexed
  pages_scanned    int not null default 0,        -- set links seen on the source page so far
  state            text not null default 'running' check (state in
                     ('queued', 'running', 'checkpoint', 'paused', 'access_required', 'stopping', 'stopped', 'completed', 'failed')),
  pause_reason     text check (pause_reason in ('checkpoint', 'auto_off', 'restart')),
  checkpoint_every int not null default 5 check (checkpoint_every in (5, 10)),
  checkpoint_until timestamptz,
  stop_requested   boolean not null default false,
  last_success_at  timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- At most one open session per source page, so gathering a DJ twice adds to the same one.
create unique index collection_sessions_open_page on collection_sessions (source_page)
  where source_page is not null and state in ('queued', 'running', 'checkpoint', 'paused', 'access_required', 'stopping');
create index collection_sessions_requested_by on collection_sessions (requested_by, updated_at desc);

alter table collection_jobs add column session_id bigint references collection_sessions(id) on delete set null;
create index collection_jobs_session on collection_jobs (session_id) where session_id is not null;

-- Each person's collecting preferences. Auto-Collect is off until they turn it on.
create table collect_prefs (
  user_id          bigint primary key references users(id) on delete cascade,
  auto_collect     boolean not null default false,
  checkpoint_every int not null default 5 check (checkpoint_every in (5, 10)),
  default_target   int not null default 25 check (default_target > 0),
  updated_at       timestamptz not null default now()
);

-- When 1001Tracklists said to come back (Retry-After), and what kind of refusal it was.
alter table collector_state add column paused_until timestamptz;
alter table collector_state add column block_kind text;
