// Turning 1001Tracklists HTML into our model. No network here: input is an HTML
// string, whether it came from the fetcher or from a page you saved in your browser.

import * as cheerio from "cheerio";
import type { DjProfile, Track, Tracklist } from "../model.ts";

const SITE = "https://www.1001tracklists.com";
const TRACKLIST_PATH = /\/tracklist\/([a-z0-9]+)\/[^"'\s?#]*\.html/i;

/**
 * Bump when the parser learns something new; cached sets read by an older version
 * are re-read from their saved HTML at startup (no network).
 * 2: genre per track, SoundCloud per set.
 * 3: artist page links per track, DJ cards (country, picture, contact links) per set.
 */
export const PARSER_VERSION = 3;

/** Id from a tracklist URL or path, e.g. "p3yju6k". */
export function tracklistId(url: string): string | undefined {
  return url.match(TRACKLIST_PATH)?.[1];
}

/** Set date from the URL slug ("...-2026-10-25.html"), so old sets can be skipped before fetching. */
export function dateFromUrl(url: string): string | undefined {
  return url.match(/(\d{4}-\d{2}-\d{2})\.html/)?.[1];
}

/** True if the HTML is a tracklist page (as opposed to a DJ page, track page, or challenge). */
export function isTracklistPage(html: string): boolean {
  return html.includes("tlpItem");
}

export function parseTracklist(html: string, url: string): Tracklist {
  const $ = cheerio.load(html);
  const id = tracklistId(url);
  if (!id) throw new Error(`Not a tracklist URL: ${url}`);

  const title = $("#pageTitle").text().replace(/\s+/g, " ").trim() || $("title").text().trim();

  // DJs are the artist links in the page title; the label/source link ("Toolroom Radio") isn't.
  const djLinks = $("#pageTitle a[href*='/artist/'], #pageTitle a[href*='/dj/']")
    .map((_, a) => ({ name: $(a).text().trim(), href: $(a).attr("href") ?? "" }))
    .get()
    .filter((link) => link.name.length > 0);
  const djs = djLinks.map((link) => link.name);
  const djPages: Record<string, string> = {};
  for (const link of djLinks) if (link.href) djPages[link.name] = absolute(link.href);

  const tracks: Track[] = $("div.tlpItem")
    .map((_, row) => parseRow($(row)))
    .get()
    .filter((t): t is Track => t !== undefined);

  const set: Tracklist = { id, url: absolute(url), title, djs: unique(djs), djPages, date: setDate($, title), tracks };
  // The page embeds SoundCloud's player for the set's recording, when there is one.
  const soundcloudId = html.match(/api\.soundcloud\.com\/tracks\/(\d+)/)?.[1];
  if (soundcloudId) set.soundcloud = `https://api.soundcloud.com/tracks/${soundcloudId}`;
  const profiles = djCards($);
  if (profiles.length > 0) set.djProfiles = profiles;
  set.parserVersion = PARSER_VERSION;
  return set;
}

type Selection = ReturnType<cheerio.CheerioAPI>;

function parseRow(row: Selection): Track | undefined {
  // The visible text is the most reliable source: ID rows don't always carry metadata.
  const name =
    row.find(".trackValue").first().text().replace(/\s+/g, " ").trim() ||
    row.find("meta[itemprop='name']").attr("content")?.trim() ||
    "";
  const dash = name.indexOf(" - ");
  if (dash === -1) {
    // A bare "ID" row has no dash; anything else without one isn't a track we can use.
    return name.toUpperCase() === "ID" ? { artist: "ID", title: "ID" } : undefined;
  }
  const track: Track = { artist: name.slice(0, dash).trim(), title: name.slice(dash + 3).trim() };
  const label = row.find(".trackLabel").first().text().replace(/\s+/g, " ").trim();
  if (label) track.label = label;
  const trackId = row.attr("data-trackid");
  if (trackId) track.trackId = trackId;
  const genre = row.find("meta[itemprop='genre']").first().attr("content")?.trim();
  if (genre && genre.toLowerCase() !== "tracklist") track.genre = genre;
  // Each artist name is a span holding its own text plus a hidden "open artist page" link.
  const pages: Record<string, string> = {};
  row.find(".trackValue a[href*='/artist/']").each((_, a) => {
    const holder = row.find(a).closest("span.tgHid").parent();
    const name = holder.contents().filter((_, n) => n.type === "text").text().trim();
    const href = row.find(a).attr("href");
    if (name && href) pages[name] = absolute(href);
  });
  if (Object.keys(pages).length > 0) track.artistPages = pages;
  return track;
}

/** The DJ cards near the bottom of a set page: link, flag, picture and "Contact Links". */
function djCards($: cheerio.CheerioAPI): DjProfile[] {
  const cards: DjProfile[] = [];
  $("div.fTab").each((_, tab) => {
    const card = $(tab);
    const nameLink = card.find(".h a[href*='/artist/']").first();
    const name = nameLink.text().trim();
    if (!name) return;
    const profile: DjProfile = { name, links: [] };
    const page = nameLink.attr("href");
    if (page) profile.page = absolute(page);
    const country = card.find(".h img.flag").attr("title")?.replace(/^Home Country\s+/i, "").trim();
    if (country) profile.country = country;
    const image = card.find("img.artwork").attr("data-src") ?? card.find("img.artwork").attr("src");
    if (image && !image.includes("empty.png")) profile.image = image;
    card.find("details a[href^='http']").each((_, a) => {
      const label = ($(a).attr("title") ?? $(a).text()).replace(/\s+Link$/i, "").trim();
      const url = $(a).attr("href")?.trim();
      if (label && url) profile.links.push({ label, url });
    });
    cards.push(profile);
  });
  return cards;
}

/**
 * The page has two datePublished values: when the tracklist was posted (a full
 * timestamp) and when the set was played (a plain date). We want the plain one.
 */
function setDate($: cheerio.CheerioAPI, title: string): string {
  const plain = $("meta[itemprop='datePublished']")
    .map((_, m) => $(m).attr("content") ?? "")
    .get()
    .find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const fromTitle = title.match(/(\d{4}-\d{2}-\d{2})\s*$/)?.[1];
  const date = plain ?? fromTitle;
  if (!date) throw new Error(`Couldn't find the set date in "${title}"`);
  return date;
}

/**
 * Every tracklist link in a saved page (DJ page, track page, search results) or in a
 * plain text file of URLs. A regex instead of an HTML parser so both kinds of input work.
 */
export function extractTracklistUrls(text: string): string[] {
  const pattern = new RegExp(TRACKLIST_PATH.source, "gi");
  return unique([...text.matchAll(pattern)].map((m) => absolute(m[0])));
}

/** The page's own URL, from a saved tracklist page. */
export function canonicalUrl(html: string): string | undefined {
  const $ = cheerio.load(html);
  const url = $("meta[property='og:url']").attr("content") ?? $("link[rel='canonical']").attr("href");
  return url ? absolute(url) : undefined;
}

/** True if a page is a tracklist page at all (it may list no tracks yet). */
export function isTracklistShell(html: string): boolean {
  return isTracklistPage(html) || /\/tracklist\/[a-z0-9]+\//i.test(canonicalUrl(html) ?? "");
}

/** True if a saved page is the bot check rather than the page you meant to save. */
export function isChallengePage(html: string): boolean {
  return /validate your are real human|validate you are (a )?real human|you will be forwarded|cf-chl|challenge-platform|just a moment\.\.\.|attention required|are you a robot/i.test(html);
}

function absolute(urlOrPath: string): string {
  if (urlOrPath.startsWith("http")) return urlOrPath.replace(/^https?:\/\/(www\.)?1001tracklists\.com/, SITE);
  return SITE + (urlOrPath.startsWith("/") ? "" : "/") + urlOrPath;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
