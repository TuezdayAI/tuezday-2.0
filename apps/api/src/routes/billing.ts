import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { checkoutInputSchema } from "@tuezday/contracts";
import type { Db } from "../db";
import { getPlan, getUsage, getEntitlements } from "../services/entitlements";
import { upsertFromStripe } from "../services/subscriptions";
import { getWorkspace } from "../services/workspaces";
import { createCheckoutSession, constructWebhookEvent } from "../services/stripe";
import { getUser } from "../services/auth";
import { subscriptions } from "../db/schema";
import { eq } from "drizzle-orm";

function ownerOr403(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.actor.system || request.actor.role === "owner") return true;
  void reply.status(403).send({ error: "owner_only" });
  return false;
}

export function registerBillingRoutes(app: FastifyInstance, db: Db): void {
  app.get<{ Params: { id: string } }>("/workspaces/:id/billing", async (request, reply) => {
    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) return reply.status(404).send({ error: "workspace_not_found" });

    return {
      plan: getPlan(db, request.params.id),
      entitlements: getEntitlements(db, request.params.id),
      usage: getUsage(db, request.params.id),
    };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/billing/checkout", async (request, reply) => {
    if (!ownerOr403(request, reply)) return reply;

    const workspace = getWorkspace(db, request.params.id);
    if (!workspace) return reply.status(404).send({ error: "workspace_not_found" });

    const parsed = checkoutInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_input",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      });
    }

    if (!request.actor.userId) return reply.status(401).send({ error: "unauthenticated" });
    const user = getUser(db, request.actor.userId);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });

    // Use current request URL origin to construct success/cancel
    const origin = request.headers.origin || `http://${request.headers.host}`;
    const successUrl = `${origin}/workspaces/${workspace.id}/settings/billing?checkout=success`;
    const cancelUrl = `${origin}/workspaces/${workspace.id}/settings/billing?checkout=cancel`;

    try {
      const url = await createCheckoutSession(
        workspace.id,
        parsed.data.plan,
        user.email,
        successUrl,
        cancelUrl
      );
      return reply.send({ url });
    } catch (err) {
      app.log.error(err, "Stripe checkout error:");
      return reply.status(502).send({ error: "checkout_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function registerStripeWebhookRoute(app: FastifyInstance, db: Db): void {
  // Stripe webhooks require the raw body, so we turn off Fastify's body parser for this route
  app.post(
    "/webhooks/stripe",
    { config: { rawBody: true } },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string") {
        return reply.status(400).send({ error: "missing_signature" });
      }

      let event;
      try {
        // request.rawBody is populated by fastify-raw-body
        // fallback to request.body for fastify app.inject string payloads in tests
        const raw = (request as any).rawBody || request.body;
        if (!raw) throw new Error("Missing raw body");
        event = constructWebhookEvent(raw, signature);
      } catch (err) {
        app.log.warn(`⚠️ Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`);
        return reply.status(400).send({ error: "invalid_signature" });
      }

      try {
        if (event.type === "checkout.session.completed") {
          const session = event.data.object as any;
          const workspaceId = session.metadata?.workspaceId;
          const plan = session.metadata?.plan;
          
          if (workspaceId && plan) {
            upsertFromStripe(db, workspaceId, {
              plan,
              status: "active",
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
            });
          }
        } else if (
          event.type === "customer.subscription.updated" ||
          event.type === "customer.subscription.deleted"
        ) {
          const subscription = event.data.object as any;
          // In real implementation we should lookup the workspaceId by stripeSubscriptionId.
          // For simplicity we will assume it's stored in metadata of the subscription if possible, 
          // but we can query by stripeSubscriptionId using db.
          const sub = db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.stripeSubscriptionId, subscription.id))
            .get();

          if (sub) {
            upsertFromStripe(db, sub.workspaceId, {
              plan: sub.plan,
              status: subscription.status,
              currentPeriodEnd: subscription.current_period_end,
            });
          }
        }
      } catch (err) {
        app.log.error(`Stripe webhook handler failed: ${err}`);
        return reply.status(500).send({ error: "webhook_handler_failed" });
      }

      return reply.send({ received: true });
    }
  );
}
