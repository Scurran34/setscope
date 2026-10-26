import { describe, expect, it } from "vitest";
import { identify, versionOf } from "../src/catalog/identity.ts";

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
