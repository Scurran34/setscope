// Turning reports into terminal text. Kept apart from the analysis so tests can
// check numbers without caring about layout.

import type { ArtistReport } from "./analysis/artist.ts";
import type { SongReport } from "./analysis/song.ts";
import type { Ranked } from "./model.ts";

function rankedList(title: string, items: Ranked[], unit: string, empty: string): string {
  if (items.length === 0) return `${title}\n  ${empty}\n`;
  const width = String(items[0]!.count).length;
  const lines = items.map((item, i) => {
    const rank = String(i + 1).padStart(2);
    const units = (item.count === 1 ? unit : `${unit}s`).padEnd(unit.length + 1);
    return `  ${rank}. ${String(item.count).padStart(width)} ${units}  ${item.name}`;
  });
  return `${title}\n${lines.join("\n")}\n`;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function formatSongReport(r: SongReport): string {
  const header =
    `Song: ${r.song}\n` +
    `Sets since ${r.since}: ${r.setsConsidered} cached, ${r.setsWithSong} contain this song.\n`;
  if (r.setsWithSong === 0) {
    const didYouMean = r.suggestions.length
      ? `\n${rankedList("Did you mean", r.suggestions, "set", "")}`
      : "";
    return `${header}\nNo cached sets contain it. Add some with: setscope add <saved track page>\n${didYouMean}`;
  }
  const spellings = r.matchedAs.map((m) => m.name).join(", ");
  return [
    `${header}Matched: ${spellings}\n`,
    rankedList("DJs who play it most", r.topDjs, "set", "none"),
    rankedList("Recurring IDs in those sets", r.recurringIds, "set", "No ID showed up in more than one set."),
    rankedList("Most played alongside it", r.coPlayed, "set", "none"),
  ].join("\n");
}

export function formatArtistReport(r: ArtistReport): string {
  const { recent, earlier, direction } = r.trend;
  const bar = (n: number, max: number) => "#".repeat(max === 0 ? 0 : Math.round((n / max) * 30));
  const maxShare = Math.max(0, ...r.monthly.map((m) => (m.sets ? m.setsWithArtist / m.sets : 0)));
  const months = r.monthly.map((m) => {
    const share = m.sets ? m.setsWithArtist / m.sets : 0;
    return `  ${m.month}  ${String(m.setsWithArtist).padStart(3)}/${String(m.sets).padEnd(4)} ${bar(share, maxShare)}`;
  });

  return [
    `Artist: ${r.artist}   (sets since ${r.since}, other DJs only)\n`,
    `Trend: ${direction.toUpperCase()}`,
    `  recent  ${recent.from} → now:        ${recent.setsWithArtist}/${recent.sets} sets (${percent(recent.share)})`,
    `  earlier ${earlier.from} → ${earlier.to}: ${earlier.setsWithArtist}/${earlier.sets} sets (${percent(earlier.share)})\n`,
    `Monthly (sets with ${r.artist} / sets cached):`,
    months.length ? months.join("\n") : "  no sets cached in range",
    "",
    rankedList(`Most played ${r.artist} tracks since ${recent.from}`, r.topTracksRecent, "set", "none"),
    rankedList(
      `Artists ${r.artist} plays most (${r.ownSets} of their own sets)`,
      r.mostPlayedArtists,
      "play",
      r.ownSets === 0 ? `No sets by ${r.artist} cached. Save their DJ page and run: setscope add <file>` : "none",
    ),
  ].join("\n");
}
