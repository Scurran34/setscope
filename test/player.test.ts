import { describe, expect, it } from "vitest";
import { formatTime, PlayerCore, type PlaybackProvider, type Playable, type ProviderEvents } from "../web/player.ts";

/** A fake provider: records calls, and lets a test fire the events a real one would. */
function setup() {
  const calls: string[] = [];
  let events!: ProviderEvents;
  const core = new PlayerCore((e) => {
    events = e;
    const provider: PlaybackProvider = {
      load: (item, autoplay) => calls.push(`load ${item.title} autoplay=${autoplay}`),
      play: () => calls.push("play"),
      pause: () => calls.push("pause"),
      seek: (ms) => calls.push(`seek ${ms}`),
      setVolume: (v) => calls.push(`volume ${v}`),
    };
    return provider;
  });
  return { core, calls, events: () => events };
}

const setA: Playable = { provider: "soundcloud", source: "https://api.soundcloud.com/tracks/1", title: "Set A", subtitle: "DJ A · 2026-10-01" };
const setB: Playable = { provider: "soundcloud", source: "https://api.soundcloud.com/tracks/2", title: "Set B" };

describe("PlayerCore", () => {
  it("starts empty and plays nothing until asked", () => {
    const { core, calls } = setup();
    expect(core.get()).toMatchObject({ status: "empty", position: 0 });
    core.toggle();
    expect(calls).toEqual([]);
  });

  it("loads on play, reports progress, and toggles pause/play for the same item", () => {
    const { core, calls, events } = setup();
    core.play(setA);
    expect(core.get()).toMatchObject({ status: "loading", item: setA });
    events().ready({ duration: 3_600_000, sound: { title: "Set A", uploader: "DJ A", permalink: "https://soundcloud.com/a/set" } });
    events().play();
    events().progress(60_000);
    expect(core.get()).toMatchObject({ status: "playing", position: 60_000, duration: 3_600_000, sound: { uploader: "DJ A" } });
    core.play(setA); // same item: pause
    events().pause();
    expect(core.get().status).toBe("paused");
    core.toggle();
    expect(calls).toEqual(["load Set A autoplay=true", "volume 80", "play", "pause", "play"]);
  });

  it("switches to another item in the same player, forgetting the old sound", () => {
    const { core, calls, events } = setup();
    core.play(setA);
    events().ready({ duration: 1000, sound: { title: "Set A", uploader: "DJ A" } });
    core.play(setB);
    expect(core.get()).toMatchObject({ status: "loading", item: setB, position: 0, duration: 0 });
    expect(core.get().sound).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("load"))).toEqual(["load Set A autoplay=true", "load Set B autoplay=true"]);
    expect(core.isCurrent(setB.source)).toBe(true);
  });

  it("seeks by fraction within the duration, and clamps volume", () => {
    const { core, calls, events } = setup();
    core.seekTo(0.5); // nothing loaded: nothing to seek
    core.play(setA);
    events().ready({ duration: 200_000 });
    core.seekTo(0.25);
    core.seekTo(7);
    core.setVolume(150);
    expect(calls.slice(-3)).toEqual(["seek 50000", "seek 200000", "volume 100"]);
    expect(core.get().volume).toBe(100);
  });

  it("restarts from the top after the end, and shows errors instead of pretending to play", () => {
    const { core, calls, events } = setup();
    core.play(setA);
    events().ready({ duration: 1000 });
    events().finish();
    expect(core.get()).toMatchObject({ status: "ended", position: 1000 });
    core.toggle();
    expect(calls.slice(-2)).toEqual(["seek 0", "play"]);
    events().error("SoundCloud can't play this here");
    expect(core.get()).toMatchObject({ status: "error", error: "SoundCloud can't play this here" });
    core.play(setA); // retrying an errored item loads it again rather than toggling
    expect(calls.at(-1)).toBe("load Set A autoplay=true");
  });

  it("asks to play once ready (the press that loaded it), and shows ▶ if the browser blocked that", () => {
    const { core, calls, events } = setup();
    core.play(setA);
    events().ready({ duration: 1000 });
    expect(core.get().status).toBe("paused"); // until the provider confirms it's playing
    expect(calls).toEqual(["load Set A autoplay=true", "volume 80", "play"]);
    events().play();
    expect(core.get().status).toBe("playing");
  });

  it("pause never starts playback", () => {
    const { core, calls, events } = setup();
    core.play(setA);
    events().pause();
    core.pause();
    expect(calls).toEqual(["load Set A autoplay=true"]);
  });
});

describe("formatTime", () => {
  it("formats minutes and hours", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(249_000)).toBe("4:09");
    expect(formatTime(3_725_000)).toBe("1:02:05");
  });
});
