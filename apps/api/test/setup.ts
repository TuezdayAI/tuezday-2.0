/**
 * Per-test-file setup. Vitest runs this inside each test file's environment,
 * so the afterAll below fires once per file — which is where fixture databases
 * get closed and dropped. Without it a full run would leave several hundred
 * databases on the server and exhaust its connection slots long before that.
 */
import { afterAll } from "vitest";
import { closeTestAdmin, dropTestDbs } from "./helpers";

afterAll(async () => {
  await dropTestDbs();
  await closeTestAdmin();
});
