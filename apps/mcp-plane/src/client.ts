/**
 * Thin HTTP client for the Plane REST API (https://api.plane.so/api/v1).
 *
 * Every path passed in here is workspace-relative — the client prefixes
 * `/workspaces/<slug>` and enforces Plane's trailing-slash convention.
 */

export interface PlaneClientOptions {
  apiKey: string;
  workspaceSlug: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export type Query = Record<string, string | number | boolean | undefined>;

export class PlaneError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string
  ) {
    super(`Plane API ${status} on ${method} ${url}: ${body.slice(0, 500)}`);
    this.name = "PlaneError";
  }
}

/** Plane paginates with an opaque `next_cursor`; unpaginated endpoints return a bare array. */
interface Page<T> {
  results?: T[];
  next_cursor?: string | null;
  next_page_results?: boolean;
  total_count?: number;
}

export class PlaneClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  readonly workspaceSlug: string;

  constructor(options: PlaneClientOptions) {
    this.apiKey = options.apiKey;
    this.workspaceSlug = options.workspaceSlug;
    this.baseUrl = (options.baseUrl ?? "https://api.plane.so/api/v1").replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Absolute URL for a workspace-relative path, with a forced trailing slash. */
  url(path: string, query: Query = {}): string {
    const clean = path.replace(/^\//, "").replace(/\/$/, "");
    const url = new URL(`${this.baseUrl}/workspaces/${this.workspaceSlug}/${clean}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(url, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw new PlaneError(response.status, method, url, await response.text());
    }
    if (response.status === 204) return null as T;

    const text = await response.text();
    if (!text) return null as T;
    return JSON.parse(text) as T;
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", this.url(path, query));
  }

  /** GET an absolute URL — used to follow pagination cursors and by the raw-get tool. */
  getAbsolute<T>(url: string): Promise<T> {
    return this.request<T>("GET", url);
  }

  post<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
    return this.request<T>("POST", this.url(path, query), body);
  }

  patch<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
    return this.request<T>("PATCH", this.url(path, query), body);
  }

  /**
   * Walk every page of a list endpoint. `maxItems` bounds the walk so a large
   * project can never flood the model's context.
   */
  async list<T>(path: string, query: Query = {}, maxItems = 250): Promise<T[]> {
    const perPage = Math.min(100, Math.max(1, maxItems));
    let url: string | null = this.url(path, { per_page: perPage, ...query });
    const collected: T[] = [];

    while (url && collected.length < maxItems) {
      const page: T[] | Page<T> = await this.getAbsolute<T[] | Page<T>>(url);

      if (Array.isArray(page)) {
        collected.push(...page);
        break;
      }

      collected.push(...(page.results ?? []));

      const more: boolean = Boolean(page.next_page_results && page.next_cursor);
      url = more ? this.url(path, { per_page: perPage, ...query, cursor: page.next_cursor! }) : null;
    }

    return collected.slice(0, maxItems);
  }

  /** Deep link to an object in the Plane web app. */
  webUrl(projectId: string, kind: "issues" | "cycles" | "modules", id: string): string {
    return `https://app.plane.so/${this.workspaceSlug}/projects/${projectId}/${kind}/${id}`;
  }
}
