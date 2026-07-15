import {
  expect,
  test as base,
  type BrowserContext,
  type Route,
} from "@playwright/test";

export { expect };

export const IDS = {
  workspace: "00000000-0000-4000-8000-000000000001",
  user: "00000000-0000-4000-8000-000000000002",
  action: "00000000-0000-4000-8000-000000000003",
  batch: "00000000-0000-4000-8000-000000000004",
  batchItem: "00000000-0000-4000-8000-000000000005",
  lead: "00000000-0000-4000-8000-000000000006",
  draft: "00000000-0000-4000-8000-000000000007",
  campaign: "00000000-0000-4000-8000-000000000008",
  account: "00000000-0000-4000-8000-000000000009",
  launch: "00000000-0000-4000-8000-000000000010",
  creative: "00000000-0000-4000-8000-000000000011",
  persona: "00000000-0000-4000-8000-000000000016",
  connection: "00000000-0000-4000-8000-000000000017",
} as const;

const now = 1_750_000_000_000;
const fingerprint = "a".repeat(64);

const workspace = {
  id: IDS.workspace,
  name: "Desktop Acceptance",
  websiteUrl: "https://example.com",
  onboardingStep: "done",
  createdAt: now - 86_400_000,
  updatedAt: now,
};

const policy = {
  effective: "human_required",
  contributingRules: [
    {
      scope: "workspace",
      scopeId: IDS.workspace,
      scopeLabel: "Desktop Acceptance",
      rule: "human_required",
    },
  ],
};

const action = {
  id: IDS.action,
  workspaceId: IDS.workspace,
  kind: "send",
  status: "authorization_required",
  subject: {
    kind: "draft",
    id: IDS.draft,
    title: "Send launch follow-up",
    summary: "Subject: A useful follow-up\n\nA deterministic acceptance-test email.",
    channel: "email",
    destination: "asha@example.com",
  },
  context: {
    campaignId: IDS.campaign,
    campaignName: "Desktop launch",
    personaId: null,
    personaName: null,
    connectionId: null,
    connectionName: "Verified sender",
    laneRevisionId: null,
    laneName: "Outbound email",
  },
  requestedFor: null,
  idempotencyKey: "desktop-action",
  fingerprint,
  policy,
  blocker: null,
  supersedesActionId: null,
  supersededByActionId: null,
  execution: null,
  proposedBy: { userId: IDS.user, label: "Acceptance fixture" },
  createdAt: now - 60_000,
  updatedAt: now - 60_000,
  authorizedAt: null,
  dispatchedAt: null,
  completedAt: null,
};

const previewBatch = {
  batch: {
    id: IDS.batch,
    workspaceId: IDS.workspace,
    requestId: "00000000-0000-4000-8000-000000000012",
    selection: { mode: "selected", actionIds: [IDS.action] },
    status: "preview",
    continuationCount: 0,
    includedCount: 1,
    excludedCount: 0,
    createdBy: { userId: IDS.user, label: "Acceptance fixture" },
    createdAt: now,
    confirmedAt: null,
    completedAt: null,
  },
  items: [
    {
      id: IDS.batchItem,
      workspaceId: IDS.workspace,
      batchId: IDS.batch,
      actionId: IDS.action,
      actionFingerprint: fingerprint,
      actionUpdatedAt: action.updatedAt,
      kind: "send",
      campaignId: IDS.campaign,
      impact: "Send one approved email to asha@example.com.",
      eligible: true,
      exclusionReason: null,
      status: "pending",
      error: null,
      submission: null,
      processedAt: null,
    },
  ],
};

const partialBatch = {
  batch: {
    ...previewBatch.batch,
    status: "partially_completed",
    confirmedAt: now + 1,
    completedAt: now + 2,
  },
  items: [
    {
      ...previewBatch.items[0],
      status: "failed",
      error: "Provider rejected the deterministic fixture send.",
      processedAt: now + 2,
    },
  ],
};

const deliveredAction = {
  ...action,
  status: "succeeded",
  execution: {
    kind: "email_delivery",
    id: "00000000-0000-4000-8000-000000000013",
    status: "accepted",
    url: null,
    error: null,
  },
  authorizedAt: now,
  dispatchedAt: now,
  completedAt: now,
};

const policyKinds = [
  "publish",
  "send",
  "reply",
  "paid_launch",
  "budget_change",
  "targeting_change",
] as const;

const policyView = {
  scope: "workspace",
  scopeId: IDS.workspace,
  scopeLabel: "Desktop Acceptance",
  rules: policyKinds.map((actionKind, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
    workspaceId: IDS.workspace,
    scope: "workspace",
    scopeId: IDS.workspace,
    actionKind,
    rule: "human_required",
    createdBy: IDS.user,
    createdAt: now,
    updatedAt: now,
  })),
  effective: policyKinds.map((actionKind) => ({ actionKind, policy })),
  updatedAt: now,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    },
    body: JSON.stringify(body),
  });
}

async function installApiFixture(context: BrowserContext) {
  await context.addInitScript(
    ({ workspaceId }) => {
      localStorage.setItem("tuezday_token", "desktop-acceptance-token");
      sessionStorage.setItem(`tuezday_landed_${workspaceId}`, "1");
    },
    { workspaceId: IDS.workspace },
  );

  await context.route("http://127.0.0.1:3001/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return json(route, {});
    const url = new URL(request.url());
    const path = `${url.pathname}${url.search}`;

    if (url.pathname === "/auth/me") {
      return json(route, {
        user: { id: IDS.user, name: "Desktop Reviewer", email: "reviewer@example.com" },
      });
    }
    if (url.pathname === `/workspaces/${IDS.workspace}`) return json(route, workspace);
    if (url.pathname.endsWith("/capabilities")) {
      return json(route, {
        hasAds: true,
        hasInsights: true,
        hasCrm: true,
        hasConnections: true,
        draftCount: 1,
        generationCount: 2,
        integrationsConnected: 1,
        integrationsTotal: 4,
      });
    }
    if (url.pathname.endsWith("/analytics-optout")) return json(route, { optOut: true });
    if (url.pathname.endsWith("/next-action")) {
      return json(route, {
        state: {
          checklist: {
            brain_reviewed: true,
            channel_connected: true,
            first_campaign: true,
            first_approval: true,
            insights_live: true,
            team_invited: true,
          },
          generatingCount: 0,
        },
        nextAction: { kind: "none", module: null, checklistItem: null, reason: "All clear" },
        checklist: { done: 6, total: 6, complete: true },
      });
    }
    if (url.pathname.endsWith("/priorities")) {
      return json(route, {
        generatedAt: now,
        items: [
          {
            id: "00000000-0000-4000-8000-000000000014",
            kind: "authorization",
            status: "authorization_required",
            title: "Authorize the launch follow-up",
            reason: "The approved email is ready for a final authorization.",
            consequence: "The recipient will not be contacted until you decide.",
            href: `/workspaces/${IDS.workspace}/review?tab=authorizations&action=${IDS.action}`,
            campaignId: IDS.campaign,
            campaignName: "Desktop launch",
            dueAt: now + 3_600_000,
            createdAt: now,
          },
        ],
      });
    }
    if (path.includes("/discovery/items")) return json(route, [{ id: "signal" }]);
    if (url.pathname.endsWith("/learning/syntheses")) return json(route, []);
    if (url.pathname.endsWith("/campaigns")) {
      return json(route, [
        {
          id: IDS.campaign,
          workspaceId: IDS.workspace,
          name: "Desktop launch",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    if (path.includes("/external-actions?") || url.pathname.endsWith("/external-actions")) {
      return json(route, { actions: [action] });
    }
    if (url.pathname.endsWith(`/external-actions/${IDS.action}`)) {
      return json(route, { action, decisions: [] });
    }
    if (url.pathname.endsWith("/external-action-batches") && request.method() === "POST") {
      return json(route, previewBatch);
    }
    if (url.pathname.endsWith(`/external-action-batches/${IDS.batch}/authorize`)) {
      return json(route, partialBatch);
    }
    if (path.includes("/external-action-policies?")) return json(route, policyView);
    if (url.pathname.endsWith("/automation/settings")) {
      return json(route, {
        workspaceId: IDS.workspace,
        killSwitch: false,
        perConnectionDailyCap: 8,
        perCampaignDailyCap: 4,
        autoReplyEnabled: false,
        matchThreshold: 70,
        updatedAt: now,
      });
    }
    if (url.pathname.endsWith("/connectors")) {
      return json(route, {
        providers: [
          {
            key: "linkedin",
            label: "LinkedIn",
            nangoProvider: "linkedin",
            authMode: "oauth",
            categories: ["social"],
            oauthConfigured: true,
          },
        ],
        connections: [
          {
            id: IDS.connection,
            workspaceId: IDS.workspace,
            providerKey: "linkedin",
            nangoConnectionId: "desktop-linkedin",
            config: {},
            contentProfile: { topics: ["GTM systems"], guidance: "Keep it practical." },
            displayName: "Founder account",
            externalAccountId: "linkedin-founder",
            externalAccountName: "Desktop Founder",
            externalAccountHandle: "desktop-founder",
            externalAccountUrl: "https://linkedin.com/in/desktop-founder",
            status: "connected",
            lastCheckedAt: now,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        fabric: { healthy: true },
      });
    }
    if (url.pathname.endsWith("/webhooks")) return json(route, []);
    if (url.pathname.endsWith("/email-sender")) {
      return json(route, {
        workspaceId: IDS.workspace,
        domain: "example.com",
        fromLocalPart: "hello",
        fromName: "Desktop Acceptance",
        fromAddress: "hello@example.com",
        replyTo: "founder@example.com",
        status: "verified",
        provider: "resend",
        providerDomainId: "domain_desktop",
        dnsRecords: [
          {
            type: "TXT",
            name: "resend._domainkey.example.com",
            value: "deterministic-verification-record",
            priority: null,
            status: "verified",
          },
        ],
        killSwitch: false,
        dailyCap: 100,
        lastCheckedAt: now,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (url.pathname.endsWith("/leads")) {
      return json(route, [
        {
          id: IDS.lead,
          workspaceId: IDS.workspace,
          name: "Asha Patel",
          email: "asha@example.com",
          company: "Acme",
          role: "Head of Growth",
          notes: "Asked for a concise follow-up.",
          xHandle: null,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    if (url.pathname.endsWith("/personas")) {
      return json(route, [
        {
          id: IDS.persona,
          workspaceId: IDS.workspace,
          name: "CEO voice",
          description: "Founder-led product narrative",
          overlay: "Speak in the first person.",
          topics: ["GTM systems"],
          tone: "Direct",
          styleRules: "Use short sentences.",
          avoid: "Avoid hype.",
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    if (url.pathname.endsWith(`/personas/${IDS.persona}/social-accounts`)) return json(route, []);
    if (url.pathname.endsWith("/drafts")) {
      return json(route, [
        {
          id: IDS.draft,
          workspaceId: IDS.workspace,
          sourceGenerationId: null,
          sourceSignalId: null,
          campaignId: IDS.campaign,
          leadId: IDS.lead,
          mediaContactId: null,
          taskType: "outbound_email",
          channel: "email",
          personaId: null,
          originalContent: "Subject: A useful follow-up\n\nA deterministic acceptance-test email.",
          content: "Subject: A useful follow-up\n\nA deterministic acceptance-test email.",
          state: "approved",
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    if (path.includes("/drafts?state=approved")) return json(route, []);
    if (path.includes("/drafts?state=pending_review")) return json(route, []);
    if (url.pathname.includes("/email-permissions/")) {
      return json(route, {
        workspaceId: IDS.workspace,
        normalizedEmail: "asha@example.com",
        status: "allowed",
        createdAt: now,
        updatedAt: now,
      });
    }
    if (url.pathname.endsWith(`/outbound/drafts/${IDS.draft}/send`)) {
      return json(route, { action: deliveredAction, execution: deliveredAction.execution });
    }
    if (url.pathname.endsWith("/ads/accounts")) {
      return json(route, [
        {
          id: IDS.account,
          name: "Meta Desktop",
          currency: "USD",
          connectionId: "00000000-0000-4000-8000-000000000015",
          connectionStatus: "connected",
        },
      ]);
    }
    if (url.pathname.endsWith("/ads/settings")) {
      return json(route, { workspaceId: IDS.workspace, dailyCapCents: 20_000, killSwitch: false, updatedAt: now });
    }
    if (url.pathname.endsWith("/ads/launches")) {
      return json(route, [
        {
          id: IDS.launch,
          workspaceId: IDS.workspace,
          adAccountId: IDS.account,
          campaignId: IDS.campaign,
          creativeDraftId: IDS.creative,
          name: "Desktop Meta launch",
          objective: "OUTCOME_TRAFFIC",
          pageId: "123",
          linkUrl: "https://example.com/launch",
          dailyBudgetCents: 5_000,
          startAt: null,
          endAt: null,
          countries: ["US"],
          ageMin: 25,
          ageMax: 55,
          status: "launched",
          externalCampaignId: "campaign_meta",
          externalAdSetId: "adset_meta",
          externalCreativeId: "creative_meta",
          externalAdId: "ad_meta",
          metaImageHash: null,
          adCampaignId: null,
          platformStatus: "ACTIVE",
          launchedAt: now,
          lastError: null,
          externalActionId: null,
          account: { name: "Meta Desktop", currency: "USD" },
          creative: { primaryText: "Meet your next campaign.", headline: "Desktop launch", description: "" },
          createdAt: now,
          updatedAt: now,
        },
      ]);
    }
    if (url.pathname.endsWith(`/ads/launches/${IDS.launch}/provider-state`)) {
      return json(route, {
        externalAdSetId: "adset_meta",
        dailyBudgetCents: 5_000,
        countries: ["US"],
        ageMin: 25,
        ageMax: 55,
        updatedAt: now,
      });
    }
    if (url.pathname.endsWith("/inbox")) return json(route, []);

    return json(route, request.method() === "GET" ? [] : {});
  });
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await installApiFixture(context);
    await use(context);
  },
});

export async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => ({
    html: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.html, `html overflowed by ${overflow.html}px`).toBeLessThanOrEqual(1);
  expect(overflow.body, `body overflowed by ${overflow.body}px`).toBeLessThanOrEqual(1);
}

export async function expectControlHeight(
  locator: import("@playwright/test").Locator,
  minimum: number,
) {
  const box = await locator.boundingBox();
  expect(box, "control should have a rendered bounding box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(minimum - 0.01);
}
