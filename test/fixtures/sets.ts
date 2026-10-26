// Hand-made tracklists for the analysis tests. Names are invented so the expected
// numbers can be worked out by reading this file.

import type { Track, Tracklist } from "../../src/model.ts";

/** "Artist - Title" or "Artist - Title #trackId" -> Track. */
function track(spec: string): Track {
  const [name, trackId] = spec.split(" #");
  const dash = name!.indexOf(" - ");
  const t: Track = { artist: name!.slice(0, dash), title: name!.slice(dash + 3) };
  if (trackId) t.trackId = trackId;
  return t;
}

export function makeSet(id: string, date: string, djs: string[], tracks: string[]): Tracklist {
  return {
    id,
    url: `https://www.1001tracklists.com/tracklist/${id}/fixture.html`,
    title: `${djs.join(" & ")} @ Fixture ${date}`,
    djs,
    date,
    tracks: tracks.map(track),
  };
}

export const TODAY = "2026-10-25";
export const SINCE = "2025-04-25"; // 18 months before TODAY

// Song mode: "Nova - Pulse" is in s1-s4 (recent) and s5 (too old). s6 doesn't have it.
export const songSets: Tracklist[] = [
  makeSet("s1", "2026-09-10", ["DJ Alpha"], [
    "Rook - Drift",
    "Nova - Pulse",
    "ID - ID",
    "Kite - Glow",
    "Nova - ID",
  ]),
  makeSet("s2", "2026-08-01", ["DJ Alpha"], [
    "Nova - Pulse",
    "ID - ID",
    "Kite - Glow",
    "Kite - Glow", // played twice: still one set
  ]),
  makeSet("s3", "2026-06-15", ["DJ Beta", "DJ Alpha"], [
    "nova - pulse", // different capitalization, same song
    "Kite - Glow",
    "Nova - ID",
    "ID - ID #abc123",
  ]),
  makeSet("s4", "2026-05-01", ["DJ Gamma"], [
    "Nova - Pulse",
    "ID - ID #abc123",
    "ROOK - Drift", // different capitalization, same song
  ]),
  makeSet("s5", "2024-01-01", ["DJ Old"], ["Nova - Pulse", "Kite - Glow"]),
  makeSet("s6", "2026-07-07", ["DJ Delta"], ["Kite - Glow", "Rook - Drift"]),
];

// Artist mode for "Kite". Earlier window (2025-04-25 .. 2026-04-25): 10 sets by
// others, 1 with Kite (share 0.1). Recent window (2026-04-25 ..): 10 sets, 5 with
// Kite (share 0.5). That's a 5x jump, so the trend is "up".
function filler(prefix: string, dates: string[], kiteIndexes: number[], kiteTracks: string[]): Tracklist[] {
  return dates.map((date, i) => {
    const k = kiteIndexes.indexOf(i);
    const tracks = ["Rook - Drift", "Nova - Pulse"];
    if (k !== -1) tracks.push(kiteTracks[k]!);
    return makeSet(`${prefix}${i}`, date, [`DJ ${prefix}${i}`], tracks);
  });
}

const earlierDates = [
  "2025-05-01", "2025-06-01", "2025-07-01", "2025-08-01", "2025-09-01",
  "2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01",
];
const recentDates = [
  "2026-05-01", "2026-05-15", "2026-06-01", "2026-06-15", "2026-07-01",
  "2026-07-15", "2026-08-01", "2026-08-15", "2026-09-01", "2026-10-01",
];

export const artistSets: Tracklist[] = [
  ...filler("e", earlierDates, [3], ["Kite - Ember"]),
  ...filler("r", recentDates, [0, 2, 4, 6, 8], [
    "Kite - Glow",
    "Kite & Rook - Ember",
    "Kite - Glow",
    "Nova - Pulse (Kite Remix)",
    "Kite - Glow",
  ]),
  // Kite's own sets: count who Kite plays, and don't count Kite's own tracks.
  makeSet("own1", "2026-09-20", ["Kite"], [
    "Rook - Drift",
    "Rook - Drift",
    "Rook & Nova - Haze",
    "Kite - Glow",
    "ID - ID",
  ]),
  makeSet("own2", "2026-03-03", ["Kite", "DJ Beta"], ["Rook - Tide", "Nova - Pulse"]),
  makeSet("ownOld", "2023-03-03", ["Kite"], ["Old Act - Gone"]),
];
