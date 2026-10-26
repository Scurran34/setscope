-- 002: keep the genre tag the source gave each tracklist line. The same song can be
-- tagged differently in different sets; tracks.genre stays as the latest tag.
alter table set_tracks add column genre text;
