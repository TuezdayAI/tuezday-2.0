import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  renderErrorSchema,
  renderRequestSchema,
  type RenderErrorResponse,
  type RenderRequest,
} from "@tuezday/contracts";
import type { BrowserRenderer } from "./browser-renderer";

export type { BrowserRenderer } from "./browser-renderer";

// The shared contract permits 500k HTML + 500k CSS characters and up to
// 100 x 20k value characters. JSON escaping can expand those characters, so
// keep the transport bound above the largest valid contract payload.
const BODY_LIMIT_BYTES = 20 * 1024 * 1024;

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeError(error: RenderErrorResponse): RenderErrorResponse {
  return renderErrorSchema.parse(error);
}

export async function buildRendererApp(options: {
  renderer: BrowserRenderer;
  token: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: RenderRequest }>("/render", async (request, reply) => {
    if (!tokenMatches(request.headers.authorization, options.token)) {
      return reply.status(401).send(
        safeError({
          error: "unauthorized",
          message: "A valid renderer token is required.",
        }),
      );
    }

    const parsed = renderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => issue.message).join(" ").slice(0, 500);
      return reply.status(400).send(
        safeError({
          error: "invalid_render_request",
          message: message || "The render request is invalid.",
        }),
      );
    }

    try {
      const png = await options.renderer.render(parsed.data);
      return reply.type("image/png").send(Buffer.from(png));
    } catch (error) {
      if (error instanceof Error && error.message === "render_timeout") {
        return reply.status(504).send(
          safeError({
            error: "render_timeout",
            message: "The render exceeded its time limit.",
          }),
        );
      }
      return reply.status(503).send(
        safeError({
          error: "render_failed",
          message: "The renderer could not produce an image.",
        }),
      );
    }
  });

  app.addHook("onClose", async () => {
    await options.renderer.close();
  });

  return app;
}
