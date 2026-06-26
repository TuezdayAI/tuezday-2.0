import Stripe from "stripe";
import { PLANS, type PlanId } from "@tuezday/contracts";

let _stripe: Stripe | undefined;

export function getStripe(): Stripe | undefined {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) return undefined;
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-10-16",
    appInfo: { name: "Tuezday", version: "2.0.1" },
  });
  return _stripe;
}

export async function createCheckoutSession(
  workspaceId: string,
  planId: PlanId,
  customerEmail: string,
  successUrl: string,
  cancelUrl: string
): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe is not configured in this environment.");

  const priceEnv = PLANS[planId].priceEnv;
  if (!priceEnv) throw new Error(`Plan ${planId} is free and cannot be checked out.`);

  const priceId = process.env[priceEnv];
  if (!priceId) throw new Error(`Missing environment variable ${priceEnv} for plan ${planId}`);

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    customer_email: customerEmail,
    client_reference_id: workspaceId,
    metadata: { workspaceId, plan: planId },
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  if (!session.url) throw new Error("Failed to create Stripe checkout session URL.");
  return session.url;
}

export function constructWebhookEvent(body: string | Buffer, signature: string): Stripe.Event {
  const stripe = getStripe();
  if (!stripe) throw new Error("Stripe is not configured in this environment.");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing STRIPE_WEBHOOK_SECRET environment variable.");

  return stripe.webhooks.constructEvent(body, signature, secret);
}
