// Core data types. Everything else (parsing, caching, analysis) speaks in these.

/** One row in a tracklist. */
export interface Track {
  /** "Kim Fai", or "ID" when the artist is unknown. */
  artist: string;
  /** "Higher", or "ID" when the title is unknown. */
  title: string;
  label?: string;
  /** 1001Tracklists' own track id (e.g. "3jwgd0bp"). Missing on some rows. */
  trackId?: string;
}

/** One DJ set, radio show, or mix. */
export interface Tracklist {
  /** Id from the URL, e.g. "p3yju6k" in /tracklist/p3yju6k/... */
  id: string;
  url: string;
  title: string;
  /** Everyone credited with playing the set (B2B sets have several). */
  djs: string[];
  /** Date the set was played, "YYYY-MM-DD". */
  date: string;
  tracks: Track[];
}

/** A name with a count, used for every "top N" list in the reports. */
export interface Ranked {
  name: string;
  count: number;
}
