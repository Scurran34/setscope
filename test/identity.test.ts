import { describe, expect, it } from "vitest";
import { credits, identify, versionOf } from "../src/catalog/identity.ts";

describe("versionOf", () => {
  it("names remixes, edits, VIPs, bootlegs, mashups and reworks, with who made them", () => {
    expect(versionOf("Pulse (Kite Remix)")).toEqual({ type: "remix", artists: "Kite", base: "Pulse" });
    expect(versionOf("Pulse (Kite & Rook Edit)")).toEqual({ type: "edit", artists: "Kite & Rook", base: "Pulse" });
    expect(versionOf("Pulse (VIP)")).toEqual({ type: "vip", base: "Pulse" });
    expect(versionOf("Pulse (Kite VIP Mix)")).toEqual({ type: "vip", artists: "Kite", base: "Pulse" });
    expect(versionOf("Pulse [Kite Bootleg]")).toEqual({ type: "bootleg", artists: "Kite", base: "Pulse" });
    expect(versionOf("Pulse (Kite Flip)")).toEqual({ type: "bootleg", artists: "Kite", base: "Pulse" });
    expect(versionOf("Pulse (Mashup)")).toEqual({ type: "mashup", base: "Pulse" });
    expect(versionOf("Pulse (Kite Rework)")).toEqual({ type: "rework", artists: "Kite", base: "Pulse" });
  });

  it("treats extended/original/radio mixes and other brackets as the original", () => {
    expect(versionOf("Friction (Extended Mix)")).toEqual({ type: "original", base: "Friction" });
    expect(versionOf("Friction (Radio Edit)")).toEqual({ type: "original", base: "Friction" });
    expect(versionOf("Friction (feat. Someone)")).toEqual({ type: "original", base: "Friction (feat. Someone)" });
    expect(versionOf("Friction")).toEqual({ type: "original", base: "Friction" });
  });
});

describe("identify", () => {
  it("gives the same identity to spelling variants and extended mixes", () => {
    const a = identify({ artist: "Riordan & Locky", title: "Friction" });
    const b = identify({ artist: "riordan & locky", title: "Friction (Extended Mix)" });
    expect(a.identityKey).toBe("riordan & locky - friction");
    expect(b.identityKey).toBe(a.identityKey);
    expect(b.versionType).toBe("original");
  });

  it("gives a remix its own identity, linked to the original", () => {
    const remix = identify({ artist: "Nova", title: "Pulse (Kite Remix)" });
    expect(remix).toMatchObject({
      identityKey: "nova - pulse (kite remix)",
      versionType: "remix",
      versionArtists: "Kite",
      originalKey: "nova - pulse",
      mainArtists: ["Nova"],
      remixers: ["Kite"],
    });
    expect(remix.identityKey).not.toBe(identify({ artist: "Nova", title: "Pulse" }).identityKey);
  });

  it("never gives an unidentified ID an identity by name", () => {
    expect(identify({ artist: "ID", title: "ID" })).toMatchObject({ identityKey: null, idStatus: "unidentified" });
    expect(identify({ artist: "Fisher", title: "ID" })).toMatchObject({ identityKey: null, idStatus: "unidentified", mainArtists: ["Fisher"] });
  });
});

describe("credits", () => {
  const c = (artist: string, title: string) => credits({ artist, title }).map((x) => `${x.name}:${x.role}`);
  it("keeps featured artists apart from the track's artists", () => {
    expect(c("Calvin Harris ft. Rihanna", "This Is What You Came For")).toEqual(["Calvin Harris:main", "Rihanna:featured"]);
    expect(c("MK & Sonny Fodera feat. Clementine Douglas", "Asking")).toEqual(["MK:main", "Sonny Fodera:main", "Clementine Douglas:featured"]);
  });
  it("credits whoever made a version", () => {
    expect(c("Rihanna", "Only Girl (Kito Remix)")).toEqual(["Rihanna:main", "Kito:remixer"]);
    expect(c("Calvin Harris", "Acceptable In The 80's (Chris Lake / Chris Lorenzo Edit)")).toEqual(["Calvin Harris:main", "Chris Lake:remixer", "Chris Lorenzo:remixer"]);
  });
  it("treats the artists of a mashup as components, and its maker as the creator", () => {
    expect(c("Chris Lorenzo & Kah-Lo vs. Fergie & will.i.am", "In This Bih' vs. Fergalicious (Angel TFC Edit)")).toEqual([
      "Chris Lorenzo:mashup_component",
      "Kah-Lo:mashup_component",
      "Fergie:mashup_component",
      "will.i.am:mashup_component",
      "Angel TFC:remixer",
    ]);
    expect(c("The Temper Trap", "Sweet Disposition (Someone Mashup)")).toEqual(["The Temper Trap:mashup_component", "Someone:remixer"]);
  });
  it("keeps acts with '&' in their name whole when they have their own page", () => {
    expect(credits({ artist: "Cause & Affect & Chris Lorenzo", title: "Snatch Ma Crops" }, ["Cause & Affect"]).map((x) => x.name)).toEqual(["Cause & Affect", "Chris Lorenzo"]);
    expect(credits({ artist: "Green Velvet", title: "Flash (Cause & Affect Remix)" }, ["Cause & Affect"]).map((x) => `${x.name}:${x.role}`)).toEqual(["Green Velvet:main", "Cause & Affect:remixer"]);
    expect(credits({ artist: "Cause & Affect", title: "Stampede" }).map((x) => x.name)).toEqual(["Cause", "Affect"]); // no evidence: split
  });

  it("reads 'A vs. B' with an ordinary title as a collaboration", () => {
    expect(c("Armin van Buuren vs. Vini Vici", "Great Spirit")).toEqual(["Armin van Buuren:main", "Vini Vici:main"]);
  });
});
