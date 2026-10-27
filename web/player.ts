// In-site playback. Three layers:
//
//   PlayerCore        what's loaded, playing/paused, position, volume, errors. Knows nothing
//                     about the page or any particular service (and is unit tested).
//   PlaybackProvider  one music service. SoundCloudProvider drives SoundCloud's official
//                     embedded player through its Widget API; another service would be
//                     another provider.
//   mountPlayerBar    the bar at the bottom of every page.
//
// Rules: nothing plays until someone presses play; there is only ever one player, and it
// lives outside the page area, so moving between pages doesn't stop it or start another;
// audio is only ever streamed by the provider's own player (never downloaded or proxied).

/** Something that can be played. Today: a set's recording on SoundCloud. */
export interface Playable {
  provider: "soundcloud";
  /** What the provider loads: for SoundCloud, an API track URL. */
  source: string;
  title: string;
  subtitle?: string;
  /** The page this came from (a 1001Tracklists set page), as a fallback link. */
  pageUrl?: string;
}

/** What the provider says about the sound once loaded (for credits and artwork). */
export interface SoundInfo {
  title: string;
  uploader: string;
  uploaderUrl?: string;
  permalink?: string;
  artwork?: string;
}

export type PlayerStatus = "empty" | "loading" | "playing" | "paused" | "ended" | "error";

export interface PlayerState {
  item?: Playable;
  status: PlayerStatus;
  /** Milliseconds. */
  position: number;
  duration: number;
  /** 0 to 100. */
  volume: number;
  sound?: SoundInfo;
  error?: string;
}

export interface ProviderEvents {
  ready(info: { duration: number; sound?: SoundInfo }): void;
  play(): void;
  pause(): void;
  finish(): void;
  progress(positionMs: number): void;
  error(message: string): void;
}

export interface PlaybackProvider {
  /** Load an item; `autoplay` is only ever true right after someone pressed play. */
  load(item: Playable, autoplay: boolean): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setVolume(volume: number): void;
}

export class PlayerCore {
  private state: PlayerState = { status: "empty", position: 0, duration: 0, volume: 80 };
  private readonly listeners = new Set<(state: PlayerState) => void>();
  private readonly provider: PlaybackProvider;

  /** `makeProvider` receives the events the provider should report. */
  constructor(makeProvider: (events: ProviderEvents) => PlaybackProvider) {
    this.provider = makeProvider({
      ready: ({ duration, sound }) => {
        const next: Partial<PlayerState> = { duration };
        if (sound) next.sound = sound;
        // Someone pressed play to get here. Browsers often block the embed's own autoplay,
        // so ask it to play now; if that's blocked too, show ▶ (one more press) rather
        // than an endless "Loading…".
        const wanted = this.state.status === "loading";
        if (wanted) next.status = "paused";
        this.set(next);
        this.provider.setVolume(this.state.volume);
        if (wanted) this.provider.play();
      },
      play: () => this.set({ status: "playing" }),
      pause: () => this.state.status !== "ended" && this.set({ status: "paused" }),
      finish: () => this.set({ status: "ended", position: this.state.duration }),
      progress: (position) => this.set({ position }),
      error: (message) => this.set({ status: "error", error: message }),
    });
  }

  get(): PlayerState {
    return this.state;
  }

  subscribe(listener: (state: PlayerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Play this item: a new item loads and starts; the current one toggles play/pause. */
  play(item: Playable): void {
    if (this.state.item?.source === item.source && this.state.status !== "error") return this.toggle();
    this.state = { status: "loading", position: 0, duration: 0, volume: this.state.volume, item };
    this.emit();
    this.provider.load(item, true);
  }

  toggle(): void {
    const { status, item } = this.state;
    if (!item) return;
    if (status === "playing" || status === "loading") this.provider.pause();
    else if (status === "ended") {
      this.provider.seek(0);
      this.provider.play();
    } else this.provider.play();
  }

  /** Pause if playing; never starts anything. */
  pause(): void {
    if (this.state.status === "playing" || this.state.status === "loading") this.provider.pause();
  }

  /** Jump to a point, 0 (start) to 1 (end). */
  seekTo(fraction: number): void {
    if (!this.state.duration) return;
    const ms = Math.round(Math.min(1, Math.max(0, fraction)) * this.state.duration);
    this.provider.seek(ms);
    this.set({ position: ms });
  }

  setVolume(volume: number): void {
    const v = Math.round(Math.min(100, Math.max(0, volume)));
    this.provider.setVolume(v);
    this.set({ volume: v });
  }

  /** Is this item the one loaded (so a list can show it as playing)? */
  isCurrent(source: string): boolean {
    return this.state.item?.source === source;
  }

  private set(change: Partial<PlayerState>): void {
    this.state = { ...this.state, ...change };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

/** "1:02:05", "4:09" */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ---------- SoundCloud ----------

// The parts of SoundCloud's Widget API (https://w.soundcloud.com/player/api.js) we use.
interface ScSound {
  title?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  user?: { username?: string; permalink_url?: string; avatar_url?: string };
}
interface ScWidget {
  bind(event: string, listener: (data?: { currentPosition?: number }) => void): void;
  load(url: string, options: Record<string, unknown>): void;
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  setVolume(volume: number): void;
  getDuration(callback: (ms: number) => void): void;
  getCurrentSound(callback: (sound: ScSound | null) => void): void;
}
interface ScGlobal {
  Widget: ((iframe: HTMLIFrameElement) => ScWidget) & { Events: Record<string, string> };
}

/** A soundcloud.com link without the tracking parameters SoundCloud's API adds (?utm_...). */
export function cleanSoundCloudUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "soundcloud.com" || u.hostname === "www.soundcloud.com") return `https://soundcloud.com${u.pathname.replace(/\/$/, "")}`;
  } catch {
    // not a URL: leave it to the widget
  }
  return url;
}

/** Embed options: small and quiet; no buy/share/download buttons. */
const EMBED_OPTIONS = { show_artwork: false, buying: false, sharing: false, download: false, show_comments: false, show_playcount: false, color: "#5b4bd6" };

export class SoundCloudProvider implements PlaybackProvider {
  private iframe: HTMLIFrameElement;
  private readonly events: ProviderEvents;
  private widget: ScWidget | undefined;

  constructor(iframe: HTMLIFrameElement, events: ProviderEvents) {
    this.iframe = iframe;
    this.events = events;
  }

  load(item: Playable, autoplay: boolean): void {
    const sc = (globalThis as { SC?: ScGlobal }).SC;
    if (!sc) {
      this.events.error("SoundCloud's player couldn't load (check your connection or content blocker).");
      return;
    }
    const url = cleanSoundCloudUrl(item.source);
    // Every sound gets a fresh embed (a new frame in the same place, same id). Reusing one
    // with widget.load() left every sound after the first stuck on "Loading…": the widget
    // stopped reporting READY (or the load callback) after its first sound.
    const fresh = this.iframe.cloneNode(false) as HTMLIFrameElement;
    const params = new URLSearchParams({ url, auto_play: String(autoplay), ...Object.fromEntries(Object.entries(EMBED_OPTIONS).map(([k, v]) => [k, String(v)])) });
    fresh.src = `https://w.soundcloud.com/player/?${params}`;
    this.iframe.replaceWith(fresh);
    this.iframe = fresh;
    this.widget = sc.Widget(fresh);
    this.bindEvents(sc);
  }

  play(): void {
    this.widget?.play();
  }

  pause(): void {
    this.widget?.pause();
  }

  seek(ms: number): void {
    this.widget?.seekTo(ms);
  }

  setVolume(volume: number): void {
    this.widget?.setVolume(volume);
  }

  /** The sound is loaded: tell the player its length and who uploaded it. */
  private reportReady(): void {
    const widget = this.widget;
    if (!widget) return;
    widget.getDuration((duration) => {
      widget.getCurrentSound((sound) => {
        const info: { duration: number; sound?: SoundInfo } = { duration };
        if (sound) {
          const s: SoundInfo = { title: sound.title ?? "", uploader: sound.user?.username ?? "" };
          if (sound.user?.permalink_url) s.uploaderUrl = sound.user.permalink_url;
          if (sound.permalink_url) s.permalink = cleanSoundCloudUrl(sound.permalink_url);
          const art = sound.artwork_url ?? sound.user?.avatar_url;
          if (art) s.artwork = art;
          info.sound = s;
        }
        this.events.ready(info);
      });
    });
  }

  private bindEvents(sc: ScGlobal): void {
    const widget = this.widget!;
    const E = sc.Widget.Events;
    // Events from an embed that has since been replaced are ignored.
    const current = () => this.widget === widget;
    widget.bind(E.READY!, () => current() && this.reportReady());
    widget.bind(E.PLAY!, () => current() && this.events.play());
    widget.bind(E.PAUSE!, () => current() && this.events.pause());
    widget.bind(E.FINISH!, () => current() && this.events.finish());
    widget.bind(E.PLAY_PROGRESS!, (data) => current() && this.events.progress(data?.currentPosition ?? 0));
    widget.bind(E.ERROR!, () => current() && this.events.error("SoundCloud can't play this here (it may be private, removed, or not allowed to be embedded)."));
  }
}

// ---------- the bar at the bottom ----------

/**
 * Draws the player bar into `root`: artwork, what's playing with credit to the uploader
 * and SoundCloud, play/pause, a seek bar, time, volume, and SoundCloud's own player.
 */
export function mountPlayerBar(core: PlayerCore, root: HTMLElement, scFrame: HTMLIFrameElement): void {
  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const toggle = q<HTMLButtonElement>(".pl-toggle");
  const seek = q<HTMLInputElement>(".pl-seek");
  const volume = q<HTMLInputElement>(".pl-volume");
  toggle.addEventListener("click", () => core.toggle());
  seek.addEventListener("input", () => core.seekTo(Number(seek.value) / 1000));
  volume.addEventListener("input", () => core.setVolume(Number(volume.value)));
  q<HTMLButtonElement>(".pl-close").addEventListener("click", () => {
    core.pause();
    root.classList.add("pl-collapsed");
  });

  let seeking = false;
  seek.addEventListener("pointerdown", () => (seeking = true));
  seek.addEventListener("pointerup", () => (seeking = false));

  // "Playing" but the clock hasn't moved: the stream may be stuck (network, a content
  // blocker, or a browser that can't decode it). Say so, with a way out, instead of
  // sitting at 0:00.
  let lastPosition = -1;
  let stuckSince = 0;
  setInterval(() => {
    const s = core.get();
    if (s.status !== "playing" || s.position !== lastPosition) {
      lastPosition = s.position;
      stuckSince = Date.now();
      return;
    }
    if (Date.now() - stuckSince < 12_000) return;
    const sub = q(".pl-sub");
    if (sub.dataset.stuck === "1") return;
    sub.dataset.stuck = "1";
    const link = document.createElement("a");
    link.href = s.sound?.permalink ?? s.item?.pageUrl ?? "#";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open it on SoundCloud";
    sub.replaceChildren("Still not playing? It may be buffering, or ", link);
  }, 2_000);

  core.subscribe((s) => {
    root.hidden = s.status === "empty";
    if (s.status !== "empty") root.classList.remove("pl-collapsed");
    // The provider swaps in a fresh frame for each sound (same id), so look it up each time.
    const frame = (scFrame.id && document.getElementById(scFrame.id)) || scFrame;
    frame.hidden = s.status === "empty";
    const playing = s.status === "playing";
    toggle.textContent = playing ? "❚❚" : "▶";
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
    toggle.disabled = s.status === "error";
    q(".pl-title").textContent = s.item?.title ?? "";
    delete q(".pl-sub").dataset.stuck;
    q(".pl-sub").textContent =
      s.status === "loading" ? "Loading…" : s.status === "error" ? (s.error ?? "Can't play this") : (s.item?.subtitle ?? "");
    const credit = q(".pl-credit");
    credit.replaceChildren();
    if (s.sound) {
      // SoundCloud's terms: credit the uploader and SoundCloud, and link to the track.
      const uploader = document.createElement("a");
      uploader.href = s.sound.uploaderUrl ?? s.sound.permalink ?? "#";
      uploader.target = "_blank";
      uploader.rel = "noopener";
      uploader.textContent = s.sound.uploader || "the uploader";
      const track = document.createElement("a");
      track.href = s.sound.permalink ?? "#";
      track.target = "_blank";
      track.rel = "noopener";
      track.textContent = "SoundCloud";
      credit.append("Uploaded by ", uploader, " · on ", track);
    } else if (s.status === "error" && s.item?.pageUrl) {
      const page = document.createElement("a");
      page.href = s.item.pageUrl;
      page.target = "_blank";
      page.rel = "noopener";
      page.textContent = "Open the set page to listen there";
      credit.append(page);
    }
    const art = q<HTMLImageElement>(".pl-art");
    art.hidden = !s.sound?.artwork;
    if (s.sound?.artwork && art.src !== s.sound.artwork) art.src = s.sound.artwork;
    if (!seeking) seek.value = String(s.duration ? Math.round((s.position / s.duration) * 1000) : 0);
    seek.disabled = !s.duration;
    q(".pl-time").textContent = s.duration ? `${formatTime(s.position)} / ${formatTime(s.duration)}` : "";
    volume.value = String(s.volume);
  });
}
