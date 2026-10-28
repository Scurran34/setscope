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
  /** Genre as tagged on 1001Tracklists, e.g. "Tech House". */
  genre?: string;
  /** Each credited artist's 1001Tracklists page, keyed by name as written. */
  artistPages?: Record<string, string>;
}

/** What a set page says about one of its DJs (their card on the page). */
export interface DjProfile {
  name: string;
  /** Their 1001Tracklists page. */
  page?: string;
  /** e.g. "Switzerland" */
  country?: string;
  /** Profile picture URL. */
  image?: string;
  /** Their own links: SoundCloud, Spotify, Instagram, website... */
  links: { label: string; url: string }[];
}

/** One DJ set, radio show, or mix. */
export interface Tracklist {
  /** Id from the URL, e.g. "p3yju6k" in /tracklist/p3yju6k/... */
  id: string;
  url: string;
  title: string;
  /** Everyone credited with playing the set (B2B sets have several). */
  djs: string[];
  /** Each DJ's 1001Tracklists page (their list of sets), keyed by name as in `djs`. */
  djPages?: Record<string, string>;
  /** Date the set was played, "YYYY-MM-DD". */
  date: string;
  tracks: Track[];
  /** The set's recording on SoundCloud, as an API track URL ("https://api.soundcloud.com/tracks/123"). */
  soundcloud?: string;
  /** The DJ cards on the page. */
  djProfiles?: DjProfile[];
  /** Which parser version read this set; older ones get re-read from their saved HTML. */
  parserVersion?: number;
  /** What the source calls the set (live set, radio show, podcast); absent when it doesn't say. */
  kind?: SetKind;
  /** The recurring show or event linked in the set's title ("Dance Department"). */
  series?: { key: string; name: string };
}

export type SetKind = "live" | "radio" | "podcast";

/** A name with a count, used for every "top N" list in the reports. */
export interface Ranked {
  name: string;
  count: number;
  /** A 1001Tracklists page for this entry, when there is one (e.g. a DJ's set list). */
  url?: string;
}

/** A set as shown in lists: enough to name it, link to it and listen to it. */
export interface SetSummary {
  id: string;
  title: string;
  date: string;
  url: string;
  djs: string[];
  soundcloud?: string;
}

export function summarize(set: Tracklist): SetSummary {
  const summary: SetSummary = { id: set.id, title: set.title, date: set.date, url: set.url, djs: set.djs };
  if (set.soundcloud) summary.soundcloud = set.soundcloud;
  return summary;
}
