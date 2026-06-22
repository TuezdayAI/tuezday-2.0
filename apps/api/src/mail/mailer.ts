// Transactional email seam (Sprint 27). Integrate-behind-an-interface: Resend
// is the provider, but every consumer (invites now; email approvals + billing
// later) depends only on `Mailer`. The Console default means dev/tests never
// need a key and never hit the network.

type Fetcher = typeof fetch;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailResult {
  /** True when the provider accepted the message (or it was logged in dev). */
  delivered: boolean;
  /** Provider message id, when there is one. */
  id: string | null;
  /** Human-readable outcome for logs / the test-send UI. */
  detail: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
}

/**
 * The no-key default. Logs the message and reports success so onboarding /
 * invites / the test-send flow are demoable without a Resend account.
 */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<MailResult> {
    console.log(
      `[mail] (console) to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`,
    );
    return { delivered: true, id: null, detail: "Logged to the API console (no mailer configured)." };
  }
}

/** Resend-backed mailer. Failures never throw — they return delivered:false. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetcher: Fetcher,
  ) {}

  async send(message: MailMessage): Promise<MailResult> {
    try {
      const res = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });
      const bodyText = await res.text();
      if (res.status >= 200 && res.status < 300) {
        let id: string | null = null;
        try {
          id = (JSON.parse(bodyText) as { id?: string }).id ?? null;
        } catch {
          // A 2xx with an unparseable body still counts as delivered.
        }
        return { delivered: true, id, detail: `Resend accepted the message (${res.status}).` };
      }
      return {
        delivered: false,
        id: null,
        detail: `Resend returned ${res.status}: ${bodyText.slice(0, 200)}`,
      };
    } catch (err) {
      return {
        delivered: false,
        id: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * The real default for `buildApp`: Resend when RESEND_API_KEY + MAIL_FROM are
 * set in the environment, otherwise the Console mailer.
 */
export function createDefaultMailer(fetcher: Fetcher): Mailer {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();
  if (apiKey && from) return new ResendMailer(apiKey, from, fetcher);
  return new ConsoleMailer();
}

/** Base URL the web app is served from — used to build links inside emails. */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/$/, "");
}
