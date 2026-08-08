/**
 * Name → UUID resolution.
 *
 * Plane's API speaks UUIDs, but humans (and models) say "Tuezday", "In Progress",
 * "TUEZ-42". Every tool argument that names an object goes through here, so callers
 * never have to look a UUID up first. Lookups are cached per process.
 */

import type { PlaneClient } from "./client.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value.trim());

export interface Project {
  id: string;
  name: string;
  identifier?: string;
  description?: string;
}

export interface Named {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface Member {
  id: string;
  display_name: string;
  email?: string;
  role?: unknown;
}

export interface Issue {
  id: string;
  name: string;
  sequence_id?: number;
  project?: string;
  state?: string;
  priority?: string;
  assignees?: string[];
  labels?: string[];
  [key: string]: unknown;
}

/** A resolution failure the model can act on — it lists what was actually available. */
export class ResolveError extends Error {
  constructor(kind: string, ref: string, candidates: string[]) {
    const available = candidates.length
      ? ` Available ${kind}s: ${candidates.slice(0, 40).join(", ")}`
      : ` No ${kind}s found in this scope.`;
    super(`Could not resolve ${kind} "${ref}".${available}`);
    this.name = "ResolveError";
  }
}

const TTL_MS = 5 * 60 * 1000;

export class Resolver {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly client: PlaneClient) {}

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Drop cached lists so the next lookup re-reads Plane (called after every write). */
  invalidate(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------- projects

  projects(): Promise<Project[]> {
    return this.cached("projects", () => this.client.list<Project>("projects"));
  }

  async project(ref: string): Promise<Project> {
    const projects = await this.projects();
    const needle = ref.trim().toLowerCase();

    const exact = projects.find(
      (p) =>
        p.id === ref.trim() ||
        p.identifier?.toLowerCase() === needle ||
        p.name.toLowerCase() === needle
    );
    if (exact) return exact;

    const partial = projects.filter((p) => p.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0]!;

    throw new ResolveError(
      "project",
      ref,
      projects.map((p) => (p.identifier ? `${p.name} (${p.identifier})` : p.name))
    );
  }

  // ------------------------------------------------- states / labels / people

  states(projectId: string): Promise<Named[]> {
    return this.cached(`states:${projectId}`, () =>
      this.client.list<Named>(`projects/${projectId}/states`)
    );
  }

  async state(projectId: string, ref: string): Promise<Named> {
    return this.byName(await this.states(projectId), ref, "state");
  }

  labels(projectId: string): Promise<Named[]> {
    return this.cached(`labels:${projectId}`, () =>
      this.client.list<Named>(`projects/${projectId}/labels`)
    );
  }

  async label(projectId: string, ref: string): Promise<Named> {
    return this.byName(await this.labels(projectId), ref, "label");
  }

  /**
   * Project membership rows vary in shape across Plane versions — the member may be
   * nested under `member` or flattened onto the row. Normalize both.
   */
  members(projectId: string): Promise<Member[]> {
    return this.cached(`members:${projectId}`, async () => {
      const rows = await this.client.list<Record<string, any>>(`projects/${projectId}/members`);
      return rows.map((row) => {
        const person = (row.member ?? row) as Record<string, any>;
        return {
          id: String(person.id ?? row.member_id ?? row.id),
          display_name: String(
            person.display_name ?? person.name ?? person.email ?? person.id ?? "unknown"
          ),
          email: person.email,
          role: row.role,
        };
      });
    });
  }

  async member(projectId: string, ref: string): Promise<Member> {
    const members = await this.members(projectId);
    const needle = ref.trim().toLowerCase();

    const exact = members.find(
      (m) =>
        m.id === ref.trim() ||
        m.display_name.toLowerCase() === needle ||
        m.email?.toLowerCase() === needle
    );
    if (exact) return exact;

    const partial = members.filter((m) => m.display_name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0]!;

    throw new ResolveError(
      "member",
      ref,
      members.map((m) => m.display_name)
    );
  }

  // ------------------------------------------------------- cycles / modules

  cycles(projectId: string): Promise<Named[]> {
    return this.cached(`cycles:${projectId}`, () =>
      this.client.list<Named>(`projects/${projectId}/cycles`)
    );
  }

  async cycle(projectId: string, ref: string): Promise<Named> {
    return this.byName(await this.cycles(projectId), ref, "cycle");
  }

  modules(projectId: string): Promise<Named[]> {
    return this.cached(`modules:${projectId}`, () =>
      this.client.list<Named>(`projects/${projectId}/modules`)
    );
  }

  async module(projectId: string, ref: string): Promise<Named> {
    return this.byName(await this.modules(projectId), ref, "module");
  }

  // ------------------------------------------------------------- work items

  /**
   * Accepts a work item UUID, a human reference like `TUEZ-42`, or a bare
   * sequence number. Non-UUID refs are matched by scanning the project's items.
   */
  async issue(projectId: string, ref: string): Promise<Issue> {
    const trimmed = ref.trim();
    if (isUuid(trimmed)) {
      return this.client.get<Issue>(`projects/${projectId}/issues/${trimmed}`);
    }

    const match = /(\d+)$/.exec(trimmed);
    if (!match) {
      throw new Error(
        `"${ref}" is not a work item id, a reference like TUEZ-42, or a sequence number.`
      );
    }
    const sequence = Number(match[1]);

    const issues = await this.client.list<Issue>(`projects/${projectId}/issues`, {}, 1000);
    const found = issues.find((issue) => issue.sequence_id === sequence);
    if (!found) {
      throw new Error(
        `No work item with sequence ${sequence} in this project (scanned ${issues.length} items).`
      );
    }
    return found;
  }

  /** Resolve many refs at once — used for assignee and label arrays. */
  async all<T>(refs: string[] | undefined, resolve: (ref: string) => Promise<T>): Promise<T[] | undefined> {
    if (!refs) return undefined;
    return Promise.all(refs.map(resolve));
  }

  private byName<T extends Named>(items: T[], ref: string, kind: string): T {
    const needle = ref.trim().toLowerCase();

    const exact = items.find((item) => item.id === ref.trim() || item.name.toLowerCase() === needle);
    if (exact) return exact;

    const partial = items.filter((item) => item.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0]!;

    throw new ResolveError(
      kind,
      ref,
      items.map((item) => item.name)
    );
  }
}
