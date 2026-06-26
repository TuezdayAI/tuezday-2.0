import { Type } from "@sinclair/typebox";
import { type FastifyPluginAsync } from "fastify";
import { BRAIN_DOC_TEMPLATES } from "@tuezday/contracts";
import { getOnboarding, dismissOnboarding } from "../services/onboarding";
import type { Db } from "../db";

export const registerOnboardingRoutes = (db: Db): FastifyPluginAsync => {
  return async (app) => {
    app.get(
      "/workspaces/:id/onboarding",
      {
        schema: {
          params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        },
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return getOnboarding(db, id, req.actor.userId!);
      }
    );

    app.put(
      "/workspaces/:id/onboarding/dismiss",
      {
        schema: {
          params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        },
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        dismissOnboarding(db, id, req.actor.userId!);
        return reply.status(204).send();
      }
    );

    app.get("/brain/templates", async () => {
      return BRAIN_DOC_TEMPLATES;
    });
  };
};
