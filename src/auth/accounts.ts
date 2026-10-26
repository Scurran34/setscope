// Accounts: email + password, and login sessions.
//
//   - Passwords are hashed with scrypt (a deliberately slow hash) and a random salt.
//   - A session is a random token in an HttpOnly cookie. The database only stores its
//     SHA-256, so a leaked database can't be used to log in.
//   - The site is private: the first account can be created freely (that's you); after
//     that, signing up needs the invite code in SETSCOPE_INVITE_CODE. With no invite
//     code set, sign-up closes after the first account.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
export const SESSION_DAYS = 30;

export interface User {
  id: number;
  email: string;
  displayName: string;
}

/** Thrown for anything the person can fix: bad password, taken email, wrong invite code. */
export class AccountError extends Error {}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Accounts {
  private readonly pool: pg.Pool;
  private readonly inviteCode: string | undefined;
  /** Failed logins per email in the last 15 minutes, to slow down password guessing. */
  private readonly failures = new Map<string, number[]>();

  constructor(pool: pg.Pool, inviteCode = process.env.SETSCOPE_INVITE_CODE) {
    this.pool = pool;
    this.inviteCode = inviteCode?.trim() || undefined;
  }

  async userCount(): Promise<number> {
    return (await this.pool.query<{ n: number }>("select count(*)::int as n from users")).rows[0]!.n;
  }

  /** Sign-up is open for the first account, then needs the invite code (if one is set). */
  async signupStatus(): Promise<"open" | "invite" | "closed"> {
    if ((await this.userCount()) === 0) return "open";
    return this.inviteCode ? "invite" : "closed";
  }

  async register(input: { email: string; password: string; displayName: string; inviteCode?: string }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError("That email address doesn't look right.");
    if (input.password.length < 10) throw new AccountError("Use a password of at least 10 characters.");
    if (input.password.length > 200) throw new AccountError("That password is too long.");
    if (!displayName || displayName.length > 40) throw new AccountError("Your name should be 1 to 40 characters.");
    const status = await this.signupStatus();
    if (status === "closed") throw new AccountError("Sign-up is closed. Ask the owner for an invite.");
    if (status === "invite" && input.inviteCode?.trim() !== this.inviteCode) throw new AccountError("That invite code isn't right.");

    const hash = await hashPassword(input.password);
    try {
      const r = await this.pool.query<{ id: number }>(
        "insert into users (email, display_name, password_hash) values ($1, $2, $3) returning id",
        [email, displayName, hash],
      );
      return { id: r.rows[0]!.id, email, displayName };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AccountError("There's already an account with that email.");
      throw error;
    }
  }

  /** Check a password; returns the user, or throws an AccountError with one vague message. */
  async login(emailInput: string, password: string): Promise<User> {
    const email = emailInput.trim().toLowerCase();
    const now = Date.now();
    const recent = (this.failures.get(email) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) throw new AccountError("Too many attempts. Wait a few minutes and try again.");
    const r = await this.pool.query<{ id: number; email: string; display_name: string; password_hash: string }>(
      "select id, email, display_name, password_hash from users where email = $1",
      [email],
    );
    const row = r.rows[0];
    // Same message whether the email or the password was wrong.
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      this.failures.set(email, [...recent, now]);
      throw new AccountError("Wrong email or password.");
    }
    this.failures.delete(email);
    return { id: row.id, email: row.email, displayName: row.display_name };
  }

  /** Start a session; returns the token for the cookie. */
  async startSession(userId: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      `insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
      [tokenHash(token), userId, SESSION_DAYS],
    );
    return token;
  }

  async userForSession(token: string | undefined): Promise<User | undefined> {
    if (!token) return undefined;
    const r = await this.pool.query<{ id: number; email: string; display_name: string }>(
      `select u.id, u.email, u.display_name from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [tokenHash(token)],
    );
    const row = r.rows[0];
    return row && { id: row.id, email: row.email, displayName: row.display_name };
  }

  async endSession(token: string | undefined): Promise<void> {
    if (token) await this.pool.query("delete from sessions where token_hash = $1", [tokenHash(token)]);
  }

  /** The first account is the owner (can change site-wide settings like the GetSongBPM key). */
  async isOwner(userId: number): Promise<boolean> {
    const r = await this.pool.query<{ id: number }>("select id from users order by id limit 1");
    return r.rows[0]?.id === userId;
  }
}
