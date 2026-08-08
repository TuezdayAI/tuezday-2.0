/**
 * Per-test-file setup. Vitest runs this inside each test file's environment,
 * so the afterAll below fires once per file — which is where fixture databases
 * get closed and dropped. Without it a full run would leave several hundred
 * databases on the server and exhaust its connection slots long before that.
 *
 * It imports from ./postgres, not ./helpers: a setup file runs before the test
 * file's own imports, so anything it pulls in is already in the module
 * registry by the time `vi.mock()` tries to replace it. Reaching the app from
 * here would silently disable every service mock in the suite.
 */
import { afterAll } from "vitest";
import { closeTestAdmin, dropTestDbs } from "./postgres";

afterAll(async () => {
  await dropTestDbs();
  await closeTestAdmin();
});
