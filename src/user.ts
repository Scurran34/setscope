// Your own choices: liked songs and your categories ("Party", "Warm-up"...).
// Kept in data/user.json next to the cache, so they're local and survive restarts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeName, songKey, trackFromName } from "./normalize.ts";

export interface Category {
  /** The name as you typed it. */
  name: string;
  /** songKey -> how the song is written ("Mau P - Just A Little Bit More"). */
  songs: Record<string, string>;
}

export interface UserData {
  /** songKey -> how the song is written. */
  likes: Record<string, string>;
  /** normalized category name -> category. */
  categories: Record<string, Category>;
}

export class UserStore {
  private readonly file: string | undefined;
  private data: UserData = { likes: {}, categories: {} };

  /** Without a file, nothing is saved (tests). */
  constructor(file?: string) {
    this.file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<UserData>;
      this.data = { likes: saved.likes ?? {}, categories: saved.categories ?? {} };
    }
  }

  get(): UserData {
    return this.data;
  }

  setLiked(song: string, liked: boolean): void {
    const key = songKey(trackFromName(song));
    if (liked) this.data.likes[key] = song;
    else delete this.data.likes[key];
    this.save();
  }

  /** Add or remove a song from a category; a category with no songs left disappears. */
  setLabel(song: string, category: string, on: boolean): void {
    const name = category.trim();
    if (!name || name.length > 40) throw new Error("Category names are 1 to 40 characters.");
    const key = songKey(trackFromName(song));
    const id = normalizeName(name);
    const existing = this.data.categories[id] ?? { name, songs: {} };
    if (on) existing.songs[key] = song;
    else delete existing.songs[key];
    if (Object.keys(existing.songs).length > 0) this.data.categories[id] = existing;
    else delete this.data.categories[id];
    this.save();
  }

  private save(): void {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
