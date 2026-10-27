import { describe, expect, it } from "vitest";
import { musicalKey } from "../src/soundcloud/key.ts";

describe("musicalKey", () => {
  it("reads SoundCloud's key signatures as DJ keys with Camelot codes", () => {
    expect(musicalKey("Gb:min")).toEqual({ key: "F#m", camelot: "11A" });
    expect(musicalKey("A:min")).toEqual({ key: "Am", camelot: "8A" });
    expect(musicalKey("Ab:min")).toEqual({ key: "G#m", camelot: "1A" });
    expect(musicalKey("C:maj")).toEqual({ key: "C", camelot: "8B" });
    expect(musicalKey("F# major")).toEqual({ key: "F#", camelot: "2B" });
    expect(musicalKey("Bbm")).toEqual({ key: "Bbm", camelot: "3A" });
  });
  it("leaves anything else alone", () => {
    expect(musicalKey("")).toBeUndefined();
    expect(musicalKey(null)).toBeUndefined();
    expect(musicalKey("H:min")).toBeUndefined();
    expect(musicalKey("banger")).toBeUndefined();
  });
});
