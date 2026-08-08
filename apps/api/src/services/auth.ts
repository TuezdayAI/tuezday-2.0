import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LoginInput, RegisterInput, User, GoogleProfile } from "@tuezday/contracts";
import type { Db } from "../db";
import { sessions, users, type UserRow } from "../db/schema";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SCRYPT_KEYLEN = 64;

export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`An account with email "${email}" already exists.`);
    this.name = "EmailTakenError";
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Only the SHA-256 of a session token is stored; the raw token is returned once. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return (await db.select().from(users).where(eq(users.email, email.toLowerCase())))[0];
}

export async function getUser(db: Db, id: string): Promise<User | undefined> {
  const row = (await db.select().from(users).where(eq(users.id, id)))[0];
  return row ? rowToUser(row) : undefined;
}

export async function updateUserName(db: Db, id: string, name: string): Promise<User | undefined> {
  await db.update(users).set({ name, updatedAt: Date.now() }).where(eq(users.id, id));
  return await getUser(db, id);
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await db.insert(sessions)
    .values({
      id: randomUUID(),
      userId,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
  return token;
}

export async function registerAccount(db: Db, input: RegisterInput): Promise<{ user: User; token: string }> {
  if (await getUserByEmail(db, input.email)) throw new EmailTakenError(input.email);
  const now = Date.now();
  const row: UserRow = {
    id: randomUUID(),
    email: input.email,
    name: input.name,
    passwordHash: hashPassword(input.password),
    googleSub: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(users).values(row);
  return { user: rowToUser(row), token: await createSession(db, row.id) };
}

export async function login(db: Db, input: LoginInput): Promise<{ user: User; token: string } | null> {
  const row = await getUserByEmail(db, input.email);
  if (!row || !row.passwordHash || !verifyPassword(input.password, row.passwordHash)) return null;
  return { user: rowToUser(row), token: await createSession(db, row.id) };
}

/** Resolve a bearer token to its user, or null if unknown/expired. */
export async function sessionUser(db: Db, token: string): Promise<User | null> {
  const session = (await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token))))[0];
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = (await db.select().from(users).where(eq(users.id, session.userId)))[0];
  return user ? rowToUser(user) : null;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/**
 * Sign a user in with Google. Link by verified email: reuse the existing
 * account if one has this email (attaching the google_sub once), else create a
 * password-less user. Always returns a fresh session — same shape as login().
 */
export async function upsertGoogleUser(db: Db, profile: GoogleProfile): Promise<{ user: User; token: string }> {
  const existing = await getUserByEmail(db, profile.email);
  if (existing) {
    if (!existing.googleSub) {
      await db.update(users)
        .set({ googleSub: profile.sub, updatedAt: Date.now() })
        .where(eq(users.id, existing.id));
    }
    return { user: rowToUser(existing), token: await createSession(db, existing.id) };
  }
  const now = Date.now();
  const row: UserRow = {
    id: randomUUID(),
    email: profile.email,
    name: profile.name,
    passwordHash: null,
    googleSub: profile.sub,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(users).values(row);
  return { user: rowToUser(row), token: await createSession(db, row.id) };
}
