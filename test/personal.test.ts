import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { categoryHints, setsForYou, songsLike } from "../src/analysis/personal.ts";
import { songKey, trackFromName } from "../src/normalize.ts";
import { UserStore } from "../src/user.ts";
import { makeSet, SINCE } from "./fixtures/sets.ts";

const key = (name: string) => songKey(trackFromName(name));

const sets = [
  makeSet("a", "2026-09-01", ["DJ A"], ["Nova - Pulse", "Kite - Glow", "Rook - Drift"]),
  makeSet("b", "2026-09-05", ["DJ B"], ["Nova - Pulse", "Kite - Glow", "Mau P - Bounce"]),
  makeSet("c", "2026-09-09", ["DJ C"], ["Nova - Pulse", "Rook - Drift", "Mau P - Bounce"]),
  makeSet("d", "2026-09-10", ["DJ D"], ["Other - Thing", "Rook - Drift"]),
  makeSet("old", "2020-01-01", ["DJ Old"], ["Nova - Pulse", "Kite - Glow"]),
];

describe("setsForYou", () => {
  it("ranks sets by how many liked songs they play, newest first on ties", () => {
    const liked = new Set([key("Nova - Pulse"), key("Kite - Glow")]);
    const result = setsForYou(sets, liked, SINCE);
    expect(result.map((s) => [s.id, s.liked])).toEqual([
      ["b", ["Nova - Pulse", "Kite - Glow"]],
      ["a", ["Nova - Pulse", "Kite - Glow"]],
      ["c", ["Nova - Pulse"]],
    ]);
  });
});

describe("songsLike", () => {
  it("suggests songs that share 2+ sets with your picks, leaving out the picks", () => {
    const liked = new Set([key("Nova - Pulse")]);
    expect(songsLike(sets, liked, SINCE)).toEqual([
      { name: "Kite - Glow", count: 2 },
      { name: "Mau P - Bounce", count: 2 },
      { name: "Rook - Drift", count: 2 },
    ]);
    expect(songsLike(sets, liked, SINCE, { exclude: new Set([key("Kite - Glow")]) }).map((r) => r.name)).not.toContain("Kite - Glow");
  });

  it("ranks songs closely tied to your likes above songs that are simply everywhere", () => {
    const many = [
      makeSet("x1", "2026-09-01", ["DJ 1"], ["Mine - Liked", "Niche - Gem", "Big - Hit"]),
      makeSet("x2", "2026-09-02", ["DJ 2"], ["Mine - Liked", "Niche - Gem", "Big - Hit"]),
      makeSet("x3", "2026-09-03", ["DJ 3"], ["Mine - Liked", "Big - Hit"]),
      ...Array.from({ length: 12 }, (_, i) => makeSet(`y${i}`, "2026-09-04", [`DJ y${i}`], ["Big - Hit"])),
    ];
    // Big - Hit shares more sets (3) but is in 15; Niche - Gem shares 2 of its only 2.
    expect(songsLike(many, new Set([key("Mine - Liked")]), SINCE).map((r) => [r.name, r.count])).toEqual([
      ["Niche - Gem", 2],
      ["Big - Hit", 3],
    ]);
  });
});

describe("categoryHints", () => {
  const party = { name: "Party", songs: { [key("Nova - Pulse")]: "Nova - Pulse" } };
  it("suggests a category whose songs keep showing up in this song's sets", () => {
    // Kite - Glow is in a and b; both also have Nova - Pulse (a Party song).
    expect(categoryHints(sets, key("Kite - Glow"), [party], SINCE)).toEqual([{ category: "Party", sets: 2, of: 2 }]);
  });
  it("skips weak links and categories the song is already in", () => {
    // Other - Thing's only set has no Party song; Nova - Pulse is already in Party.
    expect(categoryHints(sets, key("Other - Thing"), [party], SINCE)).toEqual([]);
    expect(categoryHints(sets, key("Nova - Pulse"), [party], SINCE)).toEqual([]);
  });
});

describe("UserStore", () => {
  it("saves likes and categories, and drops empty categories", () => {
    const dir = mkdtempSync(join(tmpdir(), "setscope-user-"));
    const file = join(dir, "user.json");
    const user = new UserStore(file);
    user.setLiked("Nova - Pulse", true);
    user.setLabel("Nova - Pulse", " Party ", true);
    user.setLabel("Kite - Glow", "party", true); // same category, different case

    const reloaded = new UserStore(file).get();
    expect(Object.values(reloaded.likes)).toEqual(["Nova - Pulse"]);
    expect(Object.values(reloaded.categories)).toEqual([
      { name: "Party", songs: { [key("Nova - Pulse")]: "Nova - Pulse", [key("Kite - Glow")]: "Kite - Glow" } },
    ]);

    user.setLiked("Nova - Pulse", false);
    user.setLabel("Nova - Pulse", "Party", false);
    user.setLabel("Kite - Glow", "Party", false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ likes: {}, categories: {} });
    expect(() => user.setLabel("Nova - Pulse", "   ", true)).toThrow(/1 to 40/);
    rmSync(dir, { recursive: true, force: true });
  });
});
