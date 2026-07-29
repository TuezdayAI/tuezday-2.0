import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Persona, UpsertPersonaInput } from "@tuezday/contracts";
import type { ResolvePersona } from "@tuezday/brain";
import type { Db, DbExecutor } from "../db";
import { personas, type PersonaRow } from "../db/schema";
import { deleteGuidanceForScope } from "./guidance";
import {
  invalidateMatching,
  itemIdsForPersona,
} from "./matching-invalidation";

function rowToPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    overlay: row.overlay,
    topics: JSON.parse(row.topicsJson) as string[],
    tone: row.tone,
    styleRules: row.styleRules,
    avoid: row.avoid,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The resolver-facing view of a persona. Single mapping point so the draft
 * call sites (generations, signals, launches, sequences, pr, outbound, ads,
 * inspector) can't drift as persona fields grow.
 */
export function toResolvePersona(
  persona: Pick<Persona, "name" | "description" | "overlay" | "topics" | "tone" | "styleRules" | "avoid">,
): ResolvePersona {
  return {
    name: persona.name,
    description: persona.description,
    overlay: persona.overlay,
    topics: persona.topics,
    tone: persona.tone,
    styleRules: persona.styleRules,
    avoid: persona.avoid,
  };
}

export function createPersona(db: Db, workspaceId: string, input: UpsertPersonaInput): Persona {
  return db.transaction((tx) => {
    const now = Date.now();
    const row: PersonaRow = {
      id: randomUUID(),
      workspaceId,
      name: input.name,
      description: input.description,
      overlay: input.overlay,
      topicsJson: JSON.stringify(input.topics),
      tone: input.tone,
      styleRules: input.styleRules,
      avoid: input.avoid,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(personas).values(row).run();
    invalidateMatching(tx, workspaceId, {
      directItemIds: [],
      includeReadyNoMatch: true,
    });
    return rowToPersona(row);
  });
}

export function listPersonas(db: DbExecutor, workspaceId: string): Persona[] {
  return db
    .select()
    .from(personas)
    .where(eq(personas.workspaceId, workspaceId))
    .orderBy(desc(personas.createdAt))
    .all()
    .map(rowToPersona);
}

export function getPersona(
  db: DbExecutor,
  workspaceId: string,
  personaId: string,
): Persona | undefined {
  const row = db
    .select()
    .from(personas)
    .where(and(eq(personas.workspaceId, workspaceId), eq(personas.id, personaId)))
    .get();
  return row ? rowToPersona(row) : undefined;
}

export function updatePersona(
  db: Db,
  workspaceId: string,
  personaId: string,
  input: UpsertPersonaInput,
): Persona | undefined {
  return db.transaction((tx) => {
    const existing = getPersona(tx, workspaceId, personaId);
    if (!existing) return undefined;
    const matchingChanged =
      existing.name !== input.name ||
      existing.description !== input.description ||
      JSON.stringify(existing.topics) !== JSON.stringify(input.topics);
    const directItemIds = matchingChanged
      ? itemIdsForPersona(tx, workspaceId, personaId)
      : [];
    const now = Date.now();
    tx.update(personas)
      .set({
        name: input.name,
        description: input.description,
        overlay: input.overlay,
        topicsJson: JSON.stringify(input.topics),
        tone: input.tone,
        styleRules: input.styleRules,
        avoid: input.avoid,
        updatedAt: now,
      })
      .where(eq(personas.id, personaId))
      .run();
    if (matchingChanged) {
      invalidateMatching(tx, workspaceId, {
        directItemIds,
        includeReadyNoMatch: true,
      });
    }
    return { ...existing, ...input, updatedAt: now };
  });
}

export function deletePersona(db: Db, workspaceId: string, personaId: string): boolean {
  return db.transaction((tx) => {
    const existing = getPersona(tx, workspaceId, personaId);
    if (!existing) return false;
    const directItemIds = itemIdsForPersona(tx, workspaceId, personaId);
    invalidateMatching(tx, workspaceId, {
      directItemIds,
      includeReadyNoMatch: false,
    });
    // Scoped guidance cleanup lives here, not in an FK cascade — see
    // deleteGuidanceForScope for the SQLite ALTER TABLE caveat.
    deleteGuidanceForScope(tx, workspaceId, { personaId });
    tx.delete(personas).where(eq(personas.id, personaId)).run();
    return true;
  });
}
