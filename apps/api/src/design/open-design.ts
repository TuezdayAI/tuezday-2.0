import {
  DesignProviderError,
  extractPlaceholders,
  type AuthoredTemplate,
  type AuthorTemplateInput,
  type DesignProvider,
} from "./provider";

type Fetcher = typeof fetch;

/**
 * Client for a self-hosted Open Design daemon (github.com/nexu-io/open-design,
 * deployed via infra/open-design/compose.yaml). The daemon is bound to an
 * internal network, bearer-authed via OD_API_TOKEN, and is never exposed to
 * browsers, customers, or workspaces — Tuezday's API is its only caller.
 *
 * Authoring is the ONLY thing this client does (umbrella Decision 3): one
 * throwaway project + one byok-opencode chat per template, then the generated
 * HTML/CSS is read back and cached in design_templates. The per-post hot path
 * never touches this class.
 *
 * byokProvider is run-scoped on the daemon and never persisted there. Protocol
 * selection follows the platform's Part 1 primary: "google" (verified path)
 * when the Gemini key is present, else an OpenAI-compatible entry pointed at
 * OpenRouter (to be verified against the deployed daemon — see the part spec's
 * Known limitations; if unsupported, authoring pins to the Gemini key).
 */
export class OpenDesignProvider implements DesignProvider {
  private readonly baseUrl: string;
  private readonly apiToken: string | undefined;
  private readonly byok: { protocol: string; apiKey: string; baseUrl?: string } | undefined;

  constructor(
    baseUrl?: string,
    apiToken?: string,
    private readonly fetcher: Fetcher = fetch,
    byok?: { protocol: string; apiKey: string; baseUrl?: string },
  ) {
    const fromEnv = process.env.OPEN_DESIGN_BASE_URL?.trim();
    this.baseUrl = (baseUrl ?? (fromEnv || "http://localhost:7456")).replace(/\/$/, "");
    this.apiToken = (apiToken ?? process.env.OPEN_DESIGN_API_TOKEN)?.trim() || undefined;
    this.byok = byok ?? OpenDesignProvider.byokFromEnv();
  }

  /** Platform LLM credential for the authoring run — never a subscriber's. */
  static byokFromEnv():
    | { protocol: string; apiKey: string; baseUrl?: string }
    | undefined {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
    const primary = process.env.LLM_PROVIDER?.trim() || "gemini";
    if (primary === "openrouter" && openRouterKey) {
      return {
        protocol: "openai-compatible",
        apiKey: openRouterKey,
        baseUrl: "https://openrouter.ai/api/v1",
      };
    }
    if (geminiKey) return { protocol: "google", apiKey: geminiKey };
    if (openRouterKey) {
      return {
        protocol: "openai-compatible",
        apiKey: openRouterKey,
        baseUrl: "https://openrouter.ai/api/v1",
      };
    }
    return undefined;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new DesignProviderError(
        `Could not reach the Open Design daemon at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DesignProviderError(
        `Open Design daemon returned ${res.status} for ${path}: ${body.slice(0, 300) || "no body"}`,
      );
    }
    return res;
  }

  async authorTemplate(input: AuthorTemplateInput): Promise<AuthoredTemplate> {
    // 1. One throwaway, orchestrator-tagged project per authoring call —
    //    Tuezday owns writeback; the project is never handed to a workspace.
    const projectRes = await this.request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: `tuezday-template-${input.slideShape}`,
        orchestratorWorkspace: {
          kind: "scratch",
          sourceLabel: "tuezday:design-template",
          writeback: "external",
        },
      }),
    });
    const project = (await projectRes.json()) as { id?: string };
    if (!project.id) {
      throw new DesignProviderError("Open Design project creation returned no id.");
    }

    // 2. Author via the free byok-opencode runtime on Tuezday's credentials.
    const chatRes = await this.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        agentId: "byok-opencode",
        skillId: input.skillId,
        ...(this.byok ? { byokProvider: this.byok } : {}),
        message: [
          input.brief,
          "",
          "Produce exactly two files: template.html and template.css.",
          "Leave {{placeholder}} tokens where real copy will be substituted —",
          "do not fill them with sample text. The design system to follow:",
          "",
          input.designSystemMarkdown,
        ].join("\n"),
      }),
    });
    await chatRes.text().catch(() => ""); // run is synchronous; body content unused

    // 3. Read back the generated artifacts through the project files API.
    const html = await this.readFile(project.id, "template.html");
    const css = await this.readFile(project.id, "template.css");
    if (!html.trim()) {
      throw new DesignProviderError("Open Design produced an empty template.html.");
    }

    const placeholders = extractPlaceholders(html);
    if (placeholders.length === 0) {
      throw new DesignProviderError(
        "Open Design produced a template with no {{placeholder}} tokens — refusing to cache an unusable template.",
      );
    }
    return { html, css, placeholders };
  }

  private async readFile(projectId: string, path: string): Promise<string> {
    const res = await this.request(
      `/api/projects/${projectId}/files/${encodeURIComponent(path)}`,
      { method: "GET" },
    );
    return res.text();
  }
}
