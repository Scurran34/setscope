// What picture to show for a recording, and what kind of picture it is. Rabbithole has
// no cover art of its own, so this says where each image came from and the page labels
// artist photos as photos, never as the release's artwork. In order:
//
//   1. soundcloud  the artwork of its linked SoundCloud upload, when someone confirmed
//                  the link or the match was near-certain (confidence ≥ 0.9)
//   2. creator     a remix, edit, VIP, bootleg or rework: a photo of whoever made that
//                  version (AYYBO for "Pump Up The Jam (AYYBO Edit)"), never of the
//                  original artist or vocalist
//   3. artist      an original: a photo of its first main artist with one
//   (none)         nothing: the page draws a neutral placeholder
//
// Featured vocalists' photos are never used, and neither are mashup components'. A
// missing picture says nothing about whether a track is released.

export type ImageKind = "soundcloud" | "creator" | "artist";

/** Confidence an automatic SoundCloud match needs before its artwork is shown. */
export const ARTWORK_MIN_CONFIDENCE = 0.9;

/** An artist's photo, or one of their verified aliases' (SQL, for artist row `a`). */
export const artistImageSql = (a: string) =>
  `coalesce(${a}.image_url, (select x.image_url from artist_aliases xal join artists x on x.id = xal.artist_id where xal.canonical_id = ${a}.id and x.image_url is not null limit 1))`;

/**
 * SQL for a json {url, kind} picture of track row `t` (null when there's none).
 * SoundCloud's default artwork is 100px ("-large"): the 300px copy is asked for instead.
 */
export function trackImageSql(t: string): string {
  return `coalesce(
    (select json_build_object('url', replace(l.artwork_url, '-large.', '-t300x300.'), 'kind', 'soundcloud')
       from external_track_links l
      where l.track_id = ${t}.id and l.artwork_url is not null and (l.provenance = 'user' or l.confidence >= ${ARTWORK_MIN_CONFIDENCE})
      order by (l.provenance = 'user') desc, l.confidence desc, l.created_at limit 1),
    (select json_build_object('url', ${artistImageSql("ia")}, 'kind', 'creator')
       from track_artists ita join artists ia on ia.id = ita.artist_id
      where ita.track_id = ${t}.id and ita.role = 'remixer' and ${t}.version_type in ('remix', 'edit', 'vip', 'bootleg', 'rework')
        and ${artistImageSql("ia")} is not null
      order by ita.position limit 1),
    (select json_build_object('url', ${artistImageSql("ia")}, 'kind', 'artist')
       from track_artists ita join artists ia on ia.id = ita.artist_id
      where ita.track_id = ${t}.id and ita.role = 'main' and ${t}.version_type not in ('remix', 'edit', 'vip', 'bootleg', 'rework', 'mashup')
        and ${artistImageSql("ia")} is not null
      order by ita.position limit 1)
  )`;
}

export interface TrackImage {
  url: string;
  kind: ImageKind;
}
