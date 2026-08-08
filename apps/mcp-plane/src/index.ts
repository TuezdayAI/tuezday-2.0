import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { PlaneClient } from "./client.js";
import { issueViewer, ok, stripHtml, toHtml } from "./format.js";
import { Resolver, type Issue, type Named, type Project } from "./resolve.js";

/**
 * Read the repo-root `.env` so the token lives in the same place as every other
 * secret in this project. Real environment variables always win, and dotenv is
 * not a dependency here — the MCP server has to start standalone under any client.
 */
function loadRepoEnv(): void {
  const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
  let contents: string;
  try {
    contents = readFileSync(resolvePath(root, ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key!]) continue;
    process.env[key!] = rawValue!.trim().replace(/^(['"])(.*)\1$/s, "$2");
  }
}

loadRepoEnv();

const API_KEY = process.env.PLANE_API_KEY;
const WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG || "tuezday-ai";
const BASE_URL = process.env.PLANE_API_BASE_URL || "https://api.plane.so/api/v1";

if (!API_KEY) {
  console.error(
    "PLANE_API_KEY is required. Create one in Plane under Workspace Settings → API Tokens."
  );
  process.exit(1);
}

const client = new PlaneClient({ apiKey: API_KEY, workspaceSlug: WORKSPACE_SLUG, baseUrl: BASE_URL });
const resolver = new Resolver(client);

const server = new McpServer({ name: "plane-mcp", version: "1.0.0" });

/** Surface errors as tool results rather than protocol failures, so the model can recover. */
function guard<A>(handler: (args: A) => Promise<ReturnType<typeof ok>>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error: unknown) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (error as Error).message }],
      };
    }
  };
}

const projectArg = z
  .string()
  .describe("Project name, identifier (e.g. TUEZ), or UUID");
const limitArg = z
  .number()
  .int()
  .min(1)
  .max(250)
  .optional()
  .describe("Max items to return (default 50)");
const priorityArg = z
  .enum(["urgent", "high", "medium", "low", "none"])
  .describe("Work item priority");

// --------------------------------------------------------------- discovery

server.registerTool(
  "plane_list_projects",
  {
    title: "List Plane projects",
    description: `List all projects in the "${WORKSPACE_SLUG}" Plane workspace.`,
    inputSchema: {},
  },
  guard(async () => {
    const projects = await resolver.projects();
    return ok(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        identifier: p.identifier,
        description: p.description || undefined,
      }))
    );
  })
);

server.registerTool(
  "plane_create_project",
  {
    title: "Create a project",
    description:
      "Create a project in the workspace. The identifier is the short prefix Plane puts on work item references (e.g. TAP-1); it is uppercased and must be unique.",
    inputSchema: {
      name: z.string().describe("Project name"),
      identifier: z
        .string()
        .min(1)
        .max(12)
        .describe("Short reference prefix, e.g. TAP — uppercased, unique in the workspace"),
      description: z.string().optional().describe("Project description"),
      private: z
        .boolean()
        .optional()
        .describe("Visible only to invited members (default false — visible workspace-wide)"),
    },
  },
  guard(async (args) => {
    const created = await client.post<Project>("projects", {
      name: args.name,
      identifier: args.identifier.toUpperCase(),
      description: args.description,
      network: args.private ? 0 : 2,
    });

    // Plane creates projects with modules and cycles switched off; posting to
    // either endpoint then fails with "Modules are not enabled for this project".
    // Turn them on here so a freshly created project is immediately usable.
    await client.patch(`projects/${created.id}`, {
      module_view: true,
      cycle_view: true,
      issue_views_view: true,
      page_view: true,
    });

    resolver.invalidate();
    return ok({
      created: {
        id: created.id,
        name: created.name,
        identifier: created.identifier,
        url: `https://app.plane.so/${WORKSPACE_SLUG}/projects/${created.id}/issues`,
      },
    });
  })
);

server.registerTool(
  "plane_list_states",
  {
    title: "List work item states",
    description: "List the workflow states (Backlog, Todo, In Progress, Done, …) of a project.",
    inputSchema: { project: projectArg },
  },
  guard(async ({ project }) => {
    const target = await resolver.project(project);
    const states = await resolver.states(target.id);
    return ok(states.map((s) => ({ id: s.id, name: s.name, group: s.group })));
  })
);

server.registerTool(
  "plane_list_labels",
  {
    title: "List labels",
    description: "List the labels defined in a project.",
    inputSchema: { project: projectArg },
  },
  guard(async ({ project }) => {
    const target = await resolver.project(project);
    const labels = await resolver.labels(target.id);
    return ok(labels.map((l) => ({ id: l.id, name: l.name })));
  })
);

server.registerTool(
  "plane_create_label",
  {
    title: "Create a label",
    description: "Create a label in a project. Returns the existing label if the name is already taken.",
    inputSchema: {
      project: projectArg,
      name: z.string().describe("Label name"),
      color: z.string().optional().describe("Hex colour, e.g. #E11D48"),
    },
  },
  guard(async ({ project, name, color }) => {
    const target = await resolver.project(project);

    // Plane rejects duplicate label names per project; treat create as idempotent.
    const existing = (await resolver.labels(target.id)).find(
      (l) => l.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (existing) return ok({ existing: { id: existing.id, name: existing.name } });

    const created = await client.post<Named>(`projects/${target.id}/labels`, { name, color });
    resolver.invalidate();
    return ok({ created: { id: created.id, name: created.name } });
  })
);

server.registerTool(
  "plane_list_members",
  {
    title: "List project members",
    description: "List the members of a project, for use as work item assignees.",
    inputSchema: { project: projectArg },
  },
  guard(async ({ project }) => {
    const target = await resolver.project(project);
    return ok(await resolver.members(target.id));
  })
);

// -------------------------------------------------------------- work items

server.registerTool(
  "plane_list_work_items",
  {
    title: "List work items",
    description:
      "List work items (issues) in a project, optionally filtered by state, priority, assignee, label, or a text search over titles.",
    inputSchema: {
      project: projectArg,
      state: z.string().optional().describe("Filter by state name or UUID"),
      priority: priorityArg.optional(),
      assignee: z.string().optional().describe("Filter by member name, email, or UUID"),
      label: z.string().optional().describe("Filter by label name or UUID"),
      search: z.string().optional().describe("Case-insensitive substring match on the title"),
      limit: limitArg,
    },
  },
  guard(async ({ project, state, priority, assignee, label, search, limit }) => {
    const target = await resolver.project(project);

    const [stateId, assigneeId, labelId] = await Promise.all([
      state ? resolver.state(target.id, state).then((s) => s.id) : undefined,
      assignee ? resolver.member(target.id, assignee).then((m) => m.id) : undefined,
      label ? resolver.label(target.id, label).then((l) => l.id) : undefined,
    ]);

    const issues = await client.list<Issue>(`projects/${target.id}/issues`, {}, 1000);
    const needle = search?.toLowerCase();

    const filtered = issues.filter(
      (issue) =>
        (!stateId || issue.state === stateId) &&
        (!priority || issue.priority === priority) &&
        (!assigneeId || issue.assignees?.includes(assigneeId)) &&
        (!labelId || issue.labels?.includes(labelId)) &&
        (!needle || issue.name.toLowerCase().includes(needle))
    );

    const view = await issueViewer(client, resolver, target);
    return ok({
      project: target.name,
      matched: filtered.length,
      items: filtered.slice(0, limit ?? 50).map(view),
    });
  })
);

server.registerTool(
  "plane_get_work_item",
  {
    title: "Get a work item",
    description:
      "Fetch one work item in full, including its description. Accepts a UUID, a reference like TUEZ-42, or a bare sequence number.",
    inputSchema: {
      project: projectArg,
      work_item: z.string().describe("Work item UUID, reference (TUEZ-42), or sequence number"),
    },
  },
  guard(async ({ project, work_item }) => {
    const target = await resolver.project(project);
    const issue = await resolver.issue(target.id, work_item);
    const view = await issueViewer(client, resolver, target);
    return ok({ ...view(issue), description: stripHtml(issue.description_html) });
  })
);

server.registerTool(
  "plane_create_work_item",
  {
    title: "Create a work item",
    description: "Create a work item in a project. State, assignees, labels, and parent accept names or UUIDs.",
    inputSchema: {
      project: projectArg,
      name: z.string().describe("Work item title"),
      description: z.string().optional().describe("Body text (plain text or HTML)"),
      state: z.string().optional().describe("State name or UUID; defaults to the project's default state"),
      priority: priorityArg.optional(),
      assignees: z.array(z.string()).optional().describe("Member names, emails, or UUIDs"),
      labels: z.array(z.string()).optional().describe("Label names or UUIDs"),
      parent: z.string().optional().describe("Parent work item reference, for sub-items"),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      target_date: z.string().optional().describe("YYYY-MM-DD"),
    },
  },
  guard(async (args) => {
    const target = await resolver.project(args.project);

    const [state, assignees, labels, parent] = await Promise.all([
      args.state ? resolver.state(target.id, args.state) : undefined,
      resolver.all(args.assignees, (ref) => resolver.member(target.id, ref)),
      resolver.all(args.labels, (ref) => resolver.label(target.id, ref)),
      args.parent ? resolver.issue(target.id, args.parent) : undefined,
    ]);

    const created = await client.post<Issue>(`projects/${target.id}/issues`, {
      name: args.name,
      description_html: args.description ? toHtml(args.description) : undefined,
      state: state?.id,
      priority: args.priority,
      assignees: assignees?.map((m) => m.id),
      labels: labels?.map((l) => l.id),
      parent: parent?.id,
      start_date: args.start_date,
      target_date: args.target_date,
    });

    resolver.invalidate();
    const view = await issueViewer(client, resolver, target);
    return ok({ created: view(created) });
  })
);

server.registerTool(
  "plane_update_work_item",
  {
    title: "Update a work item",
    description:
      "Update fields on an existing work item. Only the fields you pass are changed — this is a partial update.",
    inputSchema: {
      project: projectArg,
      work_item: z.string().describe("Work item UUID, reference (TUEZ-42), or sequence number"),
      name: z.string().optional().describe("New title"),
      description: z.string().optional().describe("Replacement body text (plain text or HTML)"),
      state: z.string().optional().describe("New state name or UUID"),
      priority: priorityArg.optional(),
      assignees: z.array(z.string()).optional().describe("Replaces the assignee list entirely"),
      labels: z.array(z.string()).optional().describe("Replaces the label list entirely"),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      target_date: z.string().optional().describe("YYYY-MM-DD"),
    },
  },
  guard(async (args) => {
    const target = await resolver.project(args.project);
    const issue = await resolver.issue(target.id, args.work_item);

    const [state, assignees, labels] = await Promise.all([
      args.state ? resolver.state(target.id, args.state) : undefined,
      resolver.all(args.assignees, (ref) => resolver.member(target.id, ref)),
      resolver.all(args.labels, (ref) => resolver.label(target.id, ref)),
    ]);

    const patch: Record<string, unknown> = {
      name: args.name,
      description_html: args.description ? toHtml(args.description) : undefined,
      state: state?.id,
      priority: args.priority,
      assignees: assignees?.map((m) => m.id),
      labels: labels?.map((l) => l.id),
      start_date: args.start_date,
      target_date: args.target_date,
    };
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) delete patch[key];
    }
    if (Object.keys(patch).length === 0) {
      throw new Error("No fields to update — pass at least one field to change.");
    }

    const updated = await client.patch<Issue>(`projects/${target.id}/issues/${issue.id}`, patch);
    resolver.invalidate();
    const view = await issueViewer(client, resolver, target);
    return ok({ updated: view(updated ?? issue), changed: Object.keys(patch) });
  })
);

// ---------------------------------------------------------------- comments

server.registerTool(
  "plane_list_comments",
  {
    title: "List work item comments",
    description: "List the comments on a work item.",
    inputSchema: {
      project: projectArg,
      work_item: z.string().describe("Work item UUID, reference (TUEZ-42), or sequence number"),
      limit: limitArg,
    },
  },
  guard(async ({ project, work_item, limit }) => {
    const target = await resolver.project(project);
    const issue = await resolver.issue(target.id, work_item);
    const comments = await client.list<Record<string, any>>(
      `projects/${target.id}/issues/${issue.id}/comments`,
      {},
      limit ?? 50
    );
    return ok(
      comments.map((c) => ({
        id: c.id,
        created_at: c.created_at,
        actor: c.actor_detail?.display_name ?? c.actor,
        comment: stripHtml(c.comment_html),
      }))
    );
  })
);

server.registerTool(
  "plane_add_comment",
  {
    title: "Comment on a work item",
    description: "Add a comment to a work item.",
    inputSchema: {
      project: projectArg,
      work_item: z.string().describe("Work item UUID, reference (TUEZ-42), or sequence number"),
      comment: z.string().describe("Comment body (plain text or HTML)"),
    },
  },
  guard(async ({ project, work_item, comment }) => {
    const target = await resolver.project(project);
    const issue = await resolver.issue(target.id, work_item);
    const created = await client.post<Record<string, any>>(
      `projects/${target.id}/issues/${issue.id}/comments`,
      { comment_html: toHtml(comment) }
    );
    return ok({ id: created?.id, work_item: client.webUrl(target.id, "issues", issue.id) });
  })
);

// -------------------------------------------------------- cycles & modules

/** Cycle/module membership rows reference work items by id; join them against the project list. */
async function groupedItems(
  projectId: string,
  path: string,
  rows: Record<string, any>[]
): Promise<Issue[]> {
  const ids = new Set(rows.map((row) => String(row.issue ?? row.issue_id ?? row.id)));
  const issues = await client.list<Issue>(`projects/${projectId}/issues`, {}, 1000);
  const matched = issues.filter((issue) => ids.has(issue.id));
  if (matched.length === 0 && ids.size > 0) {
    throw new Error(`Fetched ${ids.size} membership rows from ${path} but matched no work items.`);
  }
  return matched;
}

server.registerTool(
  "plane_list_cycles",
  {
    title: "List cycles",
    description: "List a project's cycles (sprints), with their date ranges.",
    inputSchema: { project: projectArg },
  },
  guard(async ({ project }) => {
    const target = await resolver.project(project);
    const cycles = await resolver.cycles(target.id);
    return ok(
      cycles.map((c) => ({
        id: c.id,
        name: c.name,
        start_date: c.start_date,
        end_date: c.end_date,
        url: client.webUrl(target.id, "cycles", c.id),
      }))
    );
  })
);

server.registerTool(
  "plane_create_cycle",
  {
    title: "Create a cycle",
    description: "Create a cycle (sprint) in a project. Dates are optional; a cycle without them is a backlog bucket.",
    inputSchema: {
      project: projectArg,
      name: z.string().describe("Cycle name"),
      description: z.string().optional().describe("Cycle description"),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
    },
  },
  guard(async (args) => {
    const target = await resolver.project(args.project);
    const created = await client.post<Named>(`projects/${target.id}/cycles`, {
      name: args.name,
      description: args.description,
      start_date: args.start_date,
      end_date: args.end_date,
    });

    resolver.invalidate();
    return ok({
      created: { id: created.id, name: created.name, url: client.webUrl(target.id, "cycles", created.id) },
    });
  })
);

server.registerTool(
  "plane_get_cycle_work_items",
  {
    title: "List work items in a cycle",
    description: "List the work items assigned to a cycle (sprint).",
    inputSchema: {
      project: projectArg,
      cycle: z.string().describe("Cycle name or UUID"),
      limit: limitArg,
    },
  },
  guard(async ({ project, cycle, limit }) => {
    const target = await resolver.project(project);
    const found = await resolver.cycle(target.id, cycle);
    const path = `projects/${target.id}/cycles/${found.id}/cycle-issues`;
    const rows = await client.list<Record<string, any>>(path, {}, 1000);
    const issues = await groupedItems(target.id, path, rows);
    const view = await issueViewer(client, resolver, target);
    return ok({ cycle: found.name, count: issues.length, items: issues.slice(0, limit ?? 50).map(view) });
  })
);

server.registerTool(
  "plane_add_work_items_to_cycle",
  {
    title: "Add work items to a cycle",
    description: "Assign one or more existing work items to a cycle (sprint).",
    inputSchema: {
      project: projectArg,
      cycle: z.string().describe("Cycle name or UUID"),
      work_items: z.array(z.string()).min(1).describe("Work item UUIDs, references (TUEZ-42), or sequence numbers"),
    },
  },
  guard(async ({ project, cycle, work_items }) => {
    const target = await resolver.project(project);
    const found = await resolver.cycle(target.id, cycle);
    const issues = await Promise.all(work_items.map((ref) => resolver.issue(target.id, ref)));
    await client.post(`projects/${target.id}/cycles/${found.id}/cycle-issues`, {
      issues: issues.map((issue) => issue.id),
    });
    return ok({ cycle: found.name, added: issues.map((issue) => issue.name) });
  })
);

server.registerTool(
  "plane_list_modules",
  {
    title: "List modules",
    description: "List a project's modules (feature groupings).",
    inputSchema: { project: projectArg },
  },
  guard(async ({ project }) => {
    const target = await resolver.project(project);
    const modules = await resolver.modules(target.id);
    return ok(
      modules.map((m: Named) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        url: client.webUrl(target.id, "modules", m.id),
      }))
    );
  })
);

server.registerTool(
  "plane_create_module",
  {
    title: "Create a module",
    description: "Create a module (feature grouping) in a project.",
    inputSchema: {
      project: projectArg,
      name: z.string().describe("Module name"),
      description: z.string().optional().describe("Module description"),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      target_date: z.string().optional().describe("YYYY-MM-DD"),
    },
  },
  guard(async (args) => {
    const target = await resolver.project(args.project);
    const created = await client.post<Named>(`projects/${target.id}/modules`, {
      name: args.name,
      description: args.description,
      start_date: args.start_date,
      target_date: args.target_date,
    });

    resolver.invalidate();
    return ok({
      created: { id: created.id, name: created.name, url: client.webUrl(target.id, "modules", created.id) },
    });
  })
);

server.registerTool(
  "plane_get_module_work_items",
  {
    title: "List work items in a module",
    description: "List the work items assigned to a module.",
    inputSchema: {
      project: projectArg,
      module: z.string().describe("Module name or UUID"),
      limit: limitArg,
    },
  },
  guard(async ({ project, module, limit }) => {
    const target = await resolver.project(project);
    const found = await resolver.module(target.id, module);
    const path = `projects/${target.id}/modules/${found.id}/module-issues`;
    const rows = await client.list<Record<string, any>>(path, {}, 1000);
    const issues = await groupedItems(target.id, path, rows);
    const view = await issueViewer(client, resolver, target);
    return ok({ module: found.name, count: issues.length, items: issues.slice(0, limit ?? 50).map(view) });
  })
);

server.registerTool(
  "plane_add_work_items_to_module",
  {
    title: "Add work items to a module",
    description: "Assign one or more existing work items to a module.",
    inputSchema: {
      project: projectArg,
      module: z.string().describe("Module name or UUID"),
      work_items: z.array(z.string()).min(1).describe("Work item UUIDs, references (TUEZ-42), or sequence numbers"),
    },
  },
  guard(async ({ project, module, work_items }) => {
    const target = await resolver.project(project);
    const found = await resolver.module(target.id, module);
    const issues = await Promise.all(work_items.map((ref) => resolver.issue(target.id, ref)));
    await client.post(`projects/${target.id}/modules/${found.id}/module-issues`, {
      issues: issues.map((issue) => issue.id),
    });
    return ok({ module: found.name, added: issues.map((issue) => issue.name) });
  })
);

// --------------------------------------------------------------- escape hatch

server.registerTool(
  "plane_raw_get",
  {
    title: "Raw Plane GET",
    description:
      "Read-only escape hatch for Plane endpoints this server does not wrap. Path is workspace-relative, e.g. 'projects/<id>/issues' — it is prefixed with /workspaces/" +
      WORKSPACE_SLUG +
      "/. GET only; it cannot modify anything.",
    inputSchema: {
      path: z.string().describe("Workspace-relative API path, without leading or trailing slash"),
      query: z.record(z.string()).optional().describe("Query string parameters"),
    },
  },
  guard(async ({ path, query }) => ok(await client.get(path, query ?? {})))
);

async function run() {
  await server.connect(new StdioServerTransport());
  console.error(`Plane MCP server running on stdio (workspace: ${WORKSPACE_SLUG})`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
