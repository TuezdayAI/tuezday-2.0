/**
 * Response shaping. Plane work items carry large rich-text blobs and raw UUID
 * references; tools return a compact, human-readable projection instead so the
 * model sees names rather than ids.
 */

import type { PlaneClient } from "./client.js";
import type { Issue, Member, Named, Project, Resolver } from "./resolve.js";

const nameOf = (items: Named[], id: string | undefined): string | undefined =>
  id ? (items.find((item) => item.id === id)?.name ?? id) : undefined;

export interface IssueView {
  ref: string;
  id: string;
  name: string;
  state?: string;
  priority?: string;
  assignees?: string[];
  labels?: string[];
  start_date?: string;
  target_date?: string;
  created_at?: string;
  updated_at?: string;
  url: string;
}

/**
 * Builds a summarizer bound to one project, loading its states/labels/members
 * once so a list of 200 work items costs three extra requests, not 600.
 */
export async function issueViewer(
  client: PlaneClient,
  resolver: Resolver,
  project: Project
): Promise<(issue: Issue) => IssueView> {
  const [states, labels, members] = await Promise.all([
    resolver.states(project.id).catch(() => [] as Named[]),
    resolver.labels(project.id).catch(() => [] as Named[]),
    resolver.members(project.id).catch(() => [] as Member[]),
  ]);

  return (issue) => ({
    ref: issue.sequence_id
      ? `${project.identifier ?? project.name}-${issue.sequence_id}`
      : issue.id,
    id: issue.id,
    name: issue.name,
    state: nameOf(states, issue.state),
    priority: issue.priority,
    assignees: issue.assignees?.map(
      (id) => members.find((m) => m.id === id)?.display_name ?? id
    ),
    labels: issue.labels?.map((id) => nameOf(labels, id) ?? id),
    start_date: issue.start_date as string | undefined,
    target_date: issue.target_date as string | undefined,
    created_at: issue.created_at as string | undefined,
    updated_at: issue.updated_at as string | undefined,
    url: client.webUrl(project.id, "issues", issue.id),
  });
}

/** Strip HTML so descriptions and comments read as plain text in tool output. */
export function stripHtml(html: unknown): string | undefined {
  if (typeof html !== "string" || !html) return undefined;
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plane stores rich text as HTML; accept plain text from callers and wrap it. */
export function toHtml(text: string): string {
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});
