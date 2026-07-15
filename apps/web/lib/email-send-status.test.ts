import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  emailDeliveryCopy,
  emailDeliveryWorkflowStatus,
} from "./execution-results";

const component = readFileSync(
  new URL("../src/components/email-send-status.tsx", import.meta.url),
  "utf8",
);

describe("governed email permission and delivery status", () => {
  it("maps provider delivery states to canonical workflow states", () => {
    expect(emailDeliveryWorkflowStatus("queued")).toBe("sending");
    expect(emailDeliveryWorkflowStatus("accepted")).toBe("sending");
    expect(emailDeliveryWorkflowStatus("delivered")).toBe("completed");
    expect(emailDeliveryWorkflowStatus("bounced")).toBe("failed");
    expect(emailDeliveryWorkflowStatus("complained")).toBe("failed");
    expect(emailDeliveryWorkflowStatus("failed")).toBe("failed");
  });

  it("never presents provider acceptance as confirmed delivery", () => {
    expect(emailDeliveryCopy("accepted")).toContain("accepted by Resend");
    expect(emailDeliveryCopy("accepted")).not.toContain("delivered");
    expect(emailDeliveryCopy("delivered")).toContain("confirmed delivery");
    expect(emailDeliveryCopy("bounced")).toContain("bounced");
    expect(emailDeliveryCopy("complained")).toContain("spam complaint");
  });

  it("uses explicit permission actions and keeps unknown visibly unresolved", () => {
    expect(component).toContain("export function EmailPermissionControl");
    expect(component).toContain("Allow native email");
    expect(component).toContain("Suppress email");
    expect(component).toContain('unknown: { status: "setup_required"');
    expect(component).not.toContain('unknown: { status: "approved"');
  });

  it("announces delivery refreshes and keeps provider IDs as copyable metadata", () => {
    expect(component).toContain("export function EmailSendStatus");
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("providerMessageId");
    expect(component).toContain("navigator.clipboard.writeText");
    expect(component).toContain("Review action");
    expect(component).toContain("Fix and retry");
  });
});
