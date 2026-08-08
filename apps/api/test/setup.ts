/**
 * Per-test-file setup. Vitest runs this inside each test file's environment, so
 * the hooks below wrap every test and every file.
 *
 * Fixture databases are dropped as soon as the test that made them ends. That
 * is a performance requirement, not housekeeping: holding them until the file
 * ends leaves ~140 databases live across the workers, and the server then
 * spends more time on catalog and autovacuum bookkeeping than on queries.
 * Fixtures a file's `beforeAll` created are pinned and survive to `afterAll` —
 * the first `beforeEach` runs after all `beforeAll` hooks, which is where the
 * boundary between the two is taken.
 *
 * It imports from ./postgres, not ./helpers: a setup file runs before the test
 * file's own imports, so anything it pulls in is already in the module registry
 * by the time `vi.mock()` tries to replace it. Reaching the app from here would
 * silently disable every service mock in the suite.
 */
import { afterAll, afterEach, beforeEach } from "vitest";
import { closeTestAdmin, dropTestDbs, dropTestFixtures, pinFileFixtures } from "./postgres";

beforeEach(() => {
  pinFileFixtures();
});

afterEach(async () => {
  await dropTestFixtures();
});

afterAll(async () => {
  await dropTestDbs();
  await closeTestAdmin();
});
