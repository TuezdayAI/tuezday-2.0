import { createDb, type Db } from "../src/db";

/** Fresh in-memory database with all checked-in migrations applied. */
export function createTestDb(): Db {
  return createDb(":memory:");
}
