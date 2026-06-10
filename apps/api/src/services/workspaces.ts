import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { CreateWorkspaceInput, Workspace } from "@tuezday/contracts";
import type { Db } from "../db";
import { workspaces } from "../db/schema";
import { ensureBrainDocs } from "./brain";

export function createWorkspace(db: Db, input: CreateWorkspaceInput): Workspace {
  const now = Date.now();
  const row = {
    id: randomUUID(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(workspaces).values(row).run();
  // Every workspace owns its five brain docs from the moment it exists.
  ensureBrainDocs(db, row.id);
  return row;
}

export function listWorkspaces(db: Db): Workspace[] {
  return db.select().from(workspaces).orderBy(desc(workspaces.createdAt)).all();
}

export function getWorkspace(db: Db, id: string): Workspace | undefined {
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}
