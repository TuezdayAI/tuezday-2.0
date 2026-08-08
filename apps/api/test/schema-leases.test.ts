/**
 * Lease and queue schema invariants (Sprint 49).
 *
 * Ported from sprint49-migrations.test.ts, which asserted these against a
 * database replayed up to migration 0055. What it was really checking is that
 * the columns and partial-unique indexes the lease fences depend on exist —
 * and those are the load-bearing part, not the migration number.
 */
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers";
import { columnNames, indexes } from "./schema-introspection";
import { PG_ERROR, expectPgError } from "./postgres";
import { discoveredItems, discoveryJobs, discoverySources, drafts, workspaces } from "../src/db/schema";

const WS = "ws-1";

describe("lease and queue schema", () => {
  it("persists a task lease with its fence columns", async () => {
    const db = await createTestDb();
    expect(await columnNames(db, "task_leases")).toEqual(
      expect.arrayContaining([
        "key",
        "owner",
        "version",
        "expires_at",
        "heartbeat_at",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("carries the discovery execution version and job lease columns", async () => {
    const db = await createTestDb();
    expect(await columnNames(db, "discovery_sources")).toContain("execution_version");
    expect(await columnNames(db, "discovery_jobs")).toEqual(
      expect.arrayContaining([
        "source_execution_version",
        "lease_owner",
        "lease_version",
        "lease_expires_at",
        "heartbeat_at",
      ]),
    );

    const jobIndexes = await indexes(db, "discovery_jobs");
    expect(
      jobIndexes.find((i) => i.name === "discovery_jobs_one_active_source")?.definition,
    ).toContain("CREATE UNIQUE INDEX");
  });

  it("allows one active job per source and unlimited finished ones", async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({ id: WS, name: "W", createdAt: 1, updatedAt: 1 });
    await db.insert(discoverySources).values({
      id: "src-1",
      workspaceId: WS,
      type: "rss",
      name: "Feed",
      configJson: JSON.stringify({ feedUrl: "https://feeds.example.com/a.xml" }),
      status: "active",
      createdAt: 1,
    });

    const insertJob = (id: string, status: string) =>
      db.insert(discoveryJobs).values({
        id,
        workspaceId: WS,
        sourceId: "src-1",
        status,
        sourceExecutionVersion: 1,
        createdAt: 1,
      });

    await insertJob("job-1", "queued");
    // The partial index is what makes the enqueue path idempotent across API
    // processes; without it the conflict-ignore insert would be a no-op guard
    // that races.
    await expectPgError(insertJob("job-dup", "queued"), PG_ERROR.uniqueViolation);
    await insertJob("job-done-1", "succeeded");
    await insertJob("job-done-2", "succeeded");
  });

  it("keeps an automatic draft's idempotency key unique when present", async () => {
    const db = await createTestDb();
    await db.insert(workspaces).values({ id: WS, name: "W", createdAt: 1, updatedAt: 1 });

    const insertDraft = (id: string, automationKey: string | null) =>
      db.insert(drafts).values({
        id,
        workspaceId: WS,
        taskType: "signal_response",
        channel: "linkedin",
        originalContent: "a",
        content: "a",
        state: "pending_review",
        automationKey,
        createdAt: 1,
        updatedAt: 1,
      });

    await insertDraft("draft-1", "auto:ws:sig:linkedin");
    await expectPgError(insertDraft("draft-dup", "auto:ws:sig:linkedin"), PG_ERROR.uniqueViolation);
    // Hand-written drafts have no key and must never collide with each other.
    await insertDraft("draft-2", null);
    await insertDraft("draft-3", null);
  });

  it("carries the matching claim columns and their queue index", async () => {
    const db = await createTestDb();
    expect(await columnNames(db, "discovered_items")).toEqual(
      expect.arrayContaining([
        "matching_state",
        "matching_version",
        "matching_input_fingerprint",
        "matching_lease_owner",
        "matching_lease_expires_at",
        "matching_heartbeat_at",
        "matching_error",
      ]),
    );
    expect((await indexes(db, "discovered_items")).map((i) => i.name)).toContain(
      "discovered_items_matching_queue",
    );
    // Referenced so a schema rename breaks the import, not just the string.
    expect(discoveredItems.matchingState.name).toBe("matching_state");
  });
});
