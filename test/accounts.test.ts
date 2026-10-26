import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountError, Accounts, hashPassword, verifyPassword } from "../src/auth/accounts.ts";
import { PgCatalog } from "../src/catalog/pg-catalog.ts";
import { PgUserData, UserDataError } from "../src/personal/user-data.ts";
import { databaseAvailable, freshSchema } from "./helpers/db.ts";
import { makeSet } from "./fixtures/sets.ts";

describe("password hashing", () => {
  it("verifies the right password only, with a different salt each time", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt:16384:8:1:/);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong horse battery", a)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)("Accounts", () => {
  let pool: pg.Pool;
  let accounts: Accounts;
  beforeAll(async () => {
    pool = await freshSchema("accounts");
    accounts = new Accounts(pool, "let-me-in");
  });
  afterAll(async () => pool?.end());

  it("lets the first person sign up freely, then requires the invite code", async () => {
    expect(await accounts.signupStatus()).toBe("open");
    const owner = await accounts.register({ email: " Sean@Example.com ", password: "a long password", displayName: "Sean" });
    expect(owner).toMatchObject({ email: "sean@example.com", displayName: "Sean" });
    expect(await accounts.isOwner(owner.id)).toBe(true);

    expect(await accounts.signupStatus()).toBe("invite");
    await expect(accounts.register({ email: "friend@example.com", password: "a long password", displayName: "Friend" })).rejects.toThrow(/invite code/);
    const friend = await accounts.register({ email: "friend@example.com", password: "a long password", displayName: "Friend", inviteCode: "let-me-in" });
    expect(await accounts.isOwner(friend.id)).toBe(false);
    await expect(accounts.register({ email: "SEAN@example.com", password: "a long password", displayName: "Again", inviteCode: "let-me-in" })).rejects.toThrow(/already an account/);
  });

  it("rejects weak input with a helpful message", async () => {
    await expect(accounts.register({ email: "nope", password: "a long password", displayName: "X", inviteCode: "let-me-in" })).rejects.toBeInstanceOf(AccountError);
    await expect(accounts.register({ email: "x@example.com", password: "short", displayName: "X", inviteCode: "let-me-in" })).rejects.toThrow(/at least 10/);
  });

  it("closes sign-up after the first account when no invite code is set", async () => {
    expect(await new Accounts(pool, undefined).signupStatus()).toBe("closed");
  });

  it("logs in, keeps a session, and logs out; never stores the session token itself", async () => {
    const user = await accounts.login("SEAN@example.com", "a long password");
    const token = await accounts.startSession(user.id);
    expect(await accounts.userForSession(token)).toMatchObject({ id: user.id, displayName: "Sean" });
    expect((await pool.query("select token_hash from sessions")).rows.some((r) => r.token_hash === token)).toBe(false);
    await accounts.endSession(token);
    expect(await accounts.userForSession(token)).toBeUndefined();
    expect(await accounts.userForSession(undefined)).toBeUndefined();
  });

  it("gives the same answer for a wrong email and a wrong password, and slows down guessing", async () => {
    await expect(accounts.login("nobody@example.com", "a long password")).rejects.toThrow("Wrong email or password.");
    await expect(accounts.login("sean@example.com", "not the password")).rejects.toThrow("Wrong email or password.");
    for (let i = 0; i < 9; i++) await accounts.login("sean@example.com", "not the password").catch(() => {});
    await expect(accounts.login("sean@example.com", "a long password")).rejects.toThrow(/Too many attempts/);
  });
});

describe.skipIf(!available)("PgUserData", () => {
  let pool: pg.Pool;
  let data: PgUserData;
  let alice: number;
  let bob: number;
  beforeAll(async () => {
    pool = await freshSchema("user_data");
    await new PgCatalog(pool).save(makeSet("s1", "2026-09-10", ["DJ A"], ["Nova - Pulse", "Kite - Glow"]), "");
    const accounts = new Accounts(pool, "code");
    alice = (await accounts.register({ email: "a@example.com", password: "a long password", displayName: "A" })).id;
    bob = (await accounts.register({ email: "b@example.com", password: "a long password", displayName: "B", inviteCode: "code" })).id;
    data = new PgUserData(pool);
  });
  afterAll(async () => pool?.end());

  it("keeps each person's likes and categories to themselves, pointing at shared tracks", async () => {
    await data.setLiked(alice, "nova - pulse (Extended Mix)", true);
    await data.setLabel(alice, "Kite - Glow", "Party", true);
    expect(await data.get(alice)).toEqual({
      likes: { "nova - pulse": "Nova - Pulse" },
      categories: { party: { name: "Party", songs: { "kite - glow": "Kite - Glow" } } },
    });
    expect(await data.get(bob)).toEqual({ likes: {}, categories: {} });
    expect((await pool.query("select count(*)::int as n from tracks")).rows[0].n).toBe(2); // no per-user copies
  });

  it("unlikes, keeps an emptied playlist until it's deleted, and refuses songs it doesn't know", async () => {
    await data.setLiked(alice, "Nova - Pulse", false);
    await data.setLabel(alice, "Kite - Glow", "party", false);
    expect(await data.get(alice)).toEqual({ likes: {}, categories: { party: { name: "Party", songs: {} } } });
    expect(await data.createPlaylist(alice, "  Warm-up ")).toBe("Warm-up");
    expect(await data.deletePlaylist(alice, "PARTY")).toBe(true);
    expect(await data.deletePlaylist(alice, "party")).toBe(false);
    expect(await data.get(alice)).toEqual({ likes: {}, categories: { "warm-up": { name: "Warm-up", songs: {} } } });
    await expect(data.createPlaylist(alice, " ")).rejects.toBeInstanceOf(UserDataError);
    await expect(data.setLiked(alice, "Nobody - Nothing", true)).rejects.toBeInstanceOf(UserDataError);
  });

  it("imports the old single-user likes file into an account, skipping unknown songs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "setscope-legacy-"));
    const file = join(dir, "user.json");
    writeFileSync(file, JSON.stringify({
      likes: { "nova - pulse": "Nova - Pulse", "gone - song": "Gone - Song" },
      categories: { warm: { name: "Warm-up", songs: { "kite - glow": "Kite - Glow" } } },
    }));
    expect(await data.importLegacy(bob, file)).toEqual({ imported: 2, skipped: 1 });
    expect(await data.get(bob)).toMatchObject({ likes: { "nova - pulse": "Nova - Pulse" }, categories: { "warm-up": { name: "Warm-up" } } });
    expect(await data.importLegacy(bob, join(dir, "missing.json"))).toEqual({ imported: 0, skipped: 0 });
    rmSync(dir, { recursive: true, force: true });
  });
});
