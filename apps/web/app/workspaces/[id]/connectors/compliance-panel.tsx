"use client";

// Sprint 49 — Compliance & suppression panel on the Integrations hub. A
// workspace's CAN-SPAM postal address (required before an outreach sequence can
// activate; appended to every send's footer alongside the unsubscribe link),
// plus a paste-to-block suppression-list import. Lives next to the outreach
// mailboxes since both govern the owned email loop.

import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import { Textarea } from "@/src/components/ui/input";
import { toast } from "@/src/components/ui/toast";
import styles from "./connectors.module.css";

import { apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import type {
  ImportSuppressionsResult,
  WorkspaceCompliance,
} from "@tuezday/contracts";

const MAX_POSTAL_ADDRESS = 500;

/** One suppression row as returned by GET /suppressions (optional list). */
interface SuppressionRow {
  normalizedEmail: string;
  reason: string;
  createdAt: number;
}

/** Split a pasted blob (newline- or comma-separated) into a de-duped email list. */
function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\n,;]+/)) {
    const value = token.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function CompliancePanel({ workspaceId: id }: { workspaceId: string }) {
  const [postalAddress, setPostalAddress] = useState("");
  const [savedAddress, setSavedAddress] = useState("");
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  const [pasted, setPasted] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSuppressionsResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const [suppressions, setSuppressions] = useState<SuppressionRow[] | null>(null);

  const loadSuppressions = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/suppressions`);
      // The list endpoint is optional — degrade to "hidden" on any non-200.
      setSuppressions(res.ok ? ((await res.json()) as SuppressionRow[]) : null);
    } catch {
      setSuppressions(null);
    }
  }, [id]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/workspaces/${id}/compliance`);
      // A 404 means the address is simply unset — treat it as empty.
      if (res.ok) {
        const body = (await res.json()) as WorkspaceCompliance;
        setPostalAddress(body.postalAddress ?? "");
        setSavedAddress(body.postalAddress ?? "");
      } else {
        setPostalAddress("");
        setSavedAddress("");
      }
    } catch {
      setPostalAddress("");
      setSavedAddress("");
    }
    await loadSuppressions();
  }, [id, loadSuppressions]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveAddress() {
    setSavingAddress(true);
    setAddressError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/compliance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postalAddress: postalAddress.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      const saved = (body as WorkspaceCompliance).postalAddress ?? postalAddress.trim();
      setPostalAddress(saved);
      setSavedAddress(saved);
      toast("Mailing address saved");
    } catch (err) {
      setAddressError(err instanceof Error ? err.message : "Could not save the mailing address");
    } finally {
      setSavingAddress(false);
    }
  }

  const parsed = parseEmails(pasted);

  async function importSuppressions() {
    if (parsed.length === 0) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/suppressions/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: parsed.slice(0, 1000) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `API returned ${res.status}`);
      setImportResult(body as ImportSuppressionsResult);
      setPasted("");
      toast("Suppression list imported");
      await loadSuppressions();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Could not import the suppression list");
    } finally {
      setImporting(false);
    }
  }

  const addressDirty = postalAddress.trim() !== savedAddress.trim();
  const hasAddress = savedAddress.trim().length > 0;

  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        <h2 className={styles.groupTitle}>Compliance &amp; suppression</h2>
        <span className={styles.groupUnlocks}>
          Required to activate outreach — every email footer carries it (CAN-SPAM)
        </span>
      </div>
      <Card className={styles.senderCard}>
        <div className={styles.senderSummary}>
          <div>
            <p className={styles.senderTitle}>Business mailing address</p>
            <p className={styles.hint}>
              A physical postal address is legally required on every cold email. It&apos;s appended
              to each send&apos;s footer next to the unsubscribe link, and an outreach sequence
              can&apos;t activate until it&apos;s set.
            </p>
          </div>
          <Badge tone={hasAddress ? "approved" : "edited"}>{hasAddress ? "set" : "not set"}</Badge>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <Textarea
            value={postalAddress}
            onChange={(e) => setPostalAddress(e.target.value.slice(0, MAX_POSTAL_ADDRESS))}
            placeholder="Acme Inc.&#10;123 Market St, Suite 400&#10;San Francisco, CA 94103, USA"
            rows={3}
            maxLength={MAX_POSTAL_ADDRESS}
            style={{ width: "100%" }}
          />
          <span className={styles.hint} style={{ justifySelf: "end" }}>
            {postalAddress.length}/{MAX_POSTAL_ADDRESS}
          </span>
        </div>

        {addressError && <p className={styles.accountError}>{addressError}</p>}

        <div className={styles.senderActions}>
          <Button
            variant="primary"
            loading={savingAddress}
            disabled={savingAddress || !addressDirty}
            onClick={() => void saveAddress()}
          >
            {hasAddress ? "Save address" : "Set address"}
          </Button>
        </div>

        <div className={styles.dnsSection}>
          <div className={styles.dnsHeading}>
            <h3>Suppression list</h3>
            {suppressions && (
              <CountBadge count={suppressions.length} label="suppressed addresses" />
            )}
          </div>
          <p className={styles.hint}>
            Paste addresses to block up front — one per line or comma-separated. Suppressed
            recipients never receive a send. Unsubscribes and hard bounces add themselves here
            automatically.
          </p>
          <Textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={"jane@example.com\njohn@example.com, no-reply@example.com"}
            rows={4}
            style={{ width: "100%" }}
          />
          {importError && <p className={styles.accountError}>{importError}</p>}
          {importResult && (
            <p className="section-reason">
              Imported {importResult.imported} address(es); skipped {importResult.skipped}{" "}
              duplicate(s) or invalid.
            </p>
          )}
          <div className={styles.senderActions}>
            <Button
              variant="primary"
              size="compact"
              loading={importing}
              disabled={importing || parsed.length === 0}
              onClick={() => void importSuppressions()}
            >
              <Icon name="add" size="compact" /> Import{" "}
              {parsed.length > 0 ? `(${parsed.length})` : ""}
            </Button>
          </div>

          {suppressions && suppressions.length > 0 && (
            <div className={styles.dnsTableWrap}>
              <table className={styles.dnsTable}>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Reason</th>
                    <th>Added</th>
                  </tr>
                </thead>
                <tbody>
                  {suppressions.slice(0, 200).map((row) => (
                    <tr key={row.normalizedEmail}>
                      <td>
                        <code>{row.normalizedEmail}</code>
                      </td>
                      <td>{row.reason}</td>
                      <td>{new Date(row.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
