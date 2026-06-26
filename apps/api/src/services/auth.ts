import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LoginInput, RegisterInput, User } from "@tuezday/contracts";
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

export function getUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
}

export function getUser(db: Db, id: string): User | undefined {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? rowToUser(row) : undefined;
}

export function createSession(db: Db, userId: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.insert(sessions)
    .values({
      id: randomUUID(),
      userId,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    })
    .run();
  return token;
}

export function registerAccount(db: Db, input: RegisterInput): { user: User; token: string } {
  if (getUserByEmail(db, input.email)) throw new EmailTakenError(input.email);
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
  db.insert(users).values(row).run();
  return { user: rowToUser(row), token: createSession(db, row.id) };
}

export function login(db: Db, input: LoginInput): { user: User; token: string } | null {
  const row = getUserByEmail(db, input.email);
  if (!row || !row.passwordHash || !verifyPassword(input.password, row.passwordHash)) return null;
  return { user: rowToUser(row), token: createSession(db, row.id) };
}

/** Resolve a bearer token to its user, or null if unknown/expired. */
export function sessionUser(db: Db, token: string): User | null {
  const session = db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get();
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  return user ? rowToUser(user) : null;
}

export function revokeSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
}
