import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Persona, UpsertPersonaInput } from "@tuezday/contracts";
import type { Db } from "../db";
import { personas } from "../db/schema";

export function createPersona(db: Db, workspaceId: string, input: UpsertPersonaInput): Persona {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    workspaceId,
    name: input.name,
    description: input.description,
    overlay: input.overlay,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(personas).values(row).run();
  return row;
}

export function listPersonas(db: Db, workspaceId: string): Persona[] {
  return db
    .select()
    .from(personas)
    .where(eq(personas.workspaceId, workspaceId))
    .orderBy(desc(personas.createdAt))
    .all();
}

export function getPersona(db: Db, workspaceId: string, personaId: string): Persona | undefined {
  return db
    .select()
    .from(personas)
    .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, personaId)))
    .get();
}

export function updatePersona(
  db: Db,
  workspaceId: string,
  personaId: string,
  input: UpsertPersonaInput,
): Persona | undefined {
  const existing = getPersona(db, workspaceId, personaId);
  if (!existing) return undefined;
  const now = Date.now();
  db.update(personas)
    .set({ name: input.name, description: input.description, overlay: input.overlay, updatedAt: now })
    .where(eq(personas.id, personaId))
    .run();
  return { ...existing, ...input, updatedAt: now };
}

export function deletePersona(db: Db, workspaceId: string, personaId: string): boolean {
  const existing = getPersona(db, workspaceId, personaId);
  if (!existing) return false;
  db.delete(personas).where(eq(personas.id, personaId)).run();
  return true;
}
