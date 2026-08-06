"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import type { ArtifactTrace, TraceSubjectKind } from "@tuezday/contracts";
import { apiFetch } from "@/lib/api";
import {
  PILLAR_CAVEAT,
  blockTitle,
  changedLabel,
  excludedSections,
  formatCost,
  formatTokens,
  includedSections,
  knobStateLabel,
  knobsByEffect,
  layerLabel,
  panelTitle,
  traceUrl,
  zoomBadge,
} from "@/lib/artifact-trace-view";
import styles from "./why-this-panel.module.css";

/**
 * "Why this" — Sprint 71. One panel, one `ArtifactTrace`, four artifact kinds.
 *
 * The trace is fetched on first open rather than with the list: a review queue
 * of forty drafts must not make forty trace calls nobody asked for. Everything
 * rendered here is read out of what the platform already recorded — this
 * component derives no facts of its own (D-71.1).
 */
export function WhyThisPanel({
  workspaceId,
  kind,
  subjectId,
}: {
  workspaceId: string;
  kind: TraceSubjectKind;
  subjectId: string;
}) {
  const [trace, setTrace] = useState<ArtifactTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (trace || loading) return;
    setLoading(true);
    setError(null);
    const res = await apiFetch(traceUrl(workspaceId, kind, subjectId)).catch(() => null);
    setLoading(false);
    if (!res?.ok) {
      setError("The reasoning behind this could not be loaded.");
      return;
    }
    setTrace((await res.json()) as ArtifactTrace);
  }, [kind, loading, subjectId, trace, workspaceId]);

  const included = trace ? includedSections(trace) : [];
  const excluded = trace ? excludedSections(trace) : [];

  return (
    <details
      className={styles.panel}
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className={styles.summary}>
        <span>{panelTitle(kind)}</span>
        <span className={styles.summaryHint}>
          {trace ? `${included.length} sources · ${trace.knobs.length} settings` : "Show the work"}
        </span>
      </summary>

      <div className={styles.body}>
        {loading && <p className={styles.empty}>Reading the record…</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {trace && (
          <>
            {trace.origin && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("origin")}</h4>
                <div className={styles.row}>
                  <div className={styles.rowHead}>
                    {trace.origin.href ? (
                      <Link href={trace.origin.href}>{trace.origin.label}</Link>
                    ) : (
                      <span>{trace.origin.label}</span>
                    )}
                  </div>
                  {trace.origin.detail && <p className={styles.excerpt}>{trace.origin.detail}</p>}
                </div>
              </section>
            )}

            {trace.plan && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("plan")}</h4>
                <div className={styles.row}>
                  <div className={styles.rowHead}>
                    <Link href={trace.plan.href}>{trace.plan.campaignName}</Link>
                    {trace.plan.kpi && <span className={styles.badge}>{trace.plan.kpi}</span>}
                  </div>
                  {trace.plan.objective && (
                    <p className={styles.reason}>{trace.plan.objective}</p>
                  )}
                  {trace.plan.closestPillar && (
                    <>
                      <p className={styles.reason}>Pillar: {trace.plan.closestPillar}</p>
                      {/* D-71.4: a match must never read as a recorded intent. */}
                      <p className={styles.caveat}>{PILLAR_CAVEAT}</p>
                    </>
                  )}
                </div>
              </section>
            )}

            <section className={styles.block}>
              <h4 className={styles.blockHead}>{blockTitle("context")}</h4>
              {trace.contextReason && <p className={styles.empty}>{trace.contextReason}</p>}
              {included.map((section) => (
                <div key={section.key} className={styles.row}>
                  <div className={styles.rowHead}>
                    <span className={styles.badge}>{layerLabel(section.layer)}</span>
                    {section.href ? (
                      <Link href={section.href}>{section.title}</Link>
                    ) : (
                      <strong>{section.title}</strong>
                    )}
                    {zoomBadge(section) && (
                      <span className={styles.badge}>{zoomBadge(section)}</span>
                    )}
                    <span className={styles.badge}>~{section.tokens} tok</span>
                  </div>
                  <p className={styles.reason}>{section.reason}</p>
                  <p className={styles.excerpt}>{section.excerpt}</p>
                </div>
              ))}
              {excluded.length > 0 && (
                <details>
                  <summary className={styles.summaryHint}>
                    What it did not read ({excluded.length})
                  </summary>
                  {excluded.map((section) => (
                    <div key={section.key} className={`${styles.row} ${styles.excluded}`}>
                      <div className={styles.rowHead}>
                        <span className={styles.badge}>{layerLabel(section.layer)}</span>
                        <span>{section.title}</span>
                      </div>
                      <p className={styles.reason}>{section.reason}</p>
                    </div>
                  ))}
                </details>
              )}
            </section>

            {trace.examples.length > 0 && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("examples")}</h4>
                {trace.examples.map((example, index) => (
                  <div key={`${example.kind}-${index}`} className={styles.row}>
                    <div className={styles.rowHead}>
                      <span className={styles.badge}>{example.label}</span>
                    </div>
                    <p className={styles.excerpt}>{example.excerpt}</p>
                    {example.why && <p className={styles.reason}>Why: {example.why}</p>}
                  </div>
                ))}
              </section>
            )}

            {trace.preferences.length > 0 && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("preferences")}</h4>
                {trace.preferences.map((rule, index) => (
                  <div key={rule.ruleId ?? `rule-${index}`} className={styles.row}>
                    <div className={styles.rowHead}>
                      <span className={styles.badge}>
                        {rule.polarity === "avoid" ? "Avoid" : "Do"}
                      </span>
                      <Link href={rule.href}>{rule.rule}</Link>
                      {rule.confidence !== null && (
                        <span className={styles.badge}>{rule.confidence}% confident</span>
                      )}
                    </div>
                    {rule.ruleId === null && (
                      <p className={styles.caveat}>This rule has since been retired.</p>
                    )}
                  </div>
                ))}
              </section>
            )}

            {trace.critic && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("critic")}</h4>
                <div className={styles.row}>
                  <div className={styles.rowHead}>
                    {trace.critic.score !== null && (
                      <span className={styles.badge}>{trace.critic.score}/100</span>
                    )}
                    <span className={styles.badge}>
                      {trace.critic.iterations} pass{trace.critic.iterations === 1 ? "" : "es"}
                    </span>
                    {trace.critic.href && <Link href={trace.critic.href}>Open the run</Link>}
                  </div>
                  {trace.critic.findings.map((finding, index) => (
                    <p key={index} className={styles.reason}>
                      {finding.issue} <em>— {finding.citation}</em>
                    </p>
                  ))}
                </div>
              </section>
            )}

            {trace.revisions.length > 0 && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("revisions")}</h4>
                {trace.revisions.map((revision) => (
                  <div key={revision.id} className={styles.row}>
                    <div className={styles.rowHead}>
                      <strong>{revision.instruction}</strong>
                      <span className={styles.badge}>{changedLabel(revision.changedShare)}</span>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {trace.cost && (
              <section className={styles.block}>
                <h4 className={styles.blockHead}>{blockTitle("cost")}</h4>
                <div className={styles.row}>
                  <div className={styles.rowHead}>
                    <Link href={trace.cost.href}>{formatCost(trace.cost)}</Link>
                    <span className={styles.badge}>{formatTokens(trace.cost)}</span>
                    <span className={styles.badge}>
                      {trace.cost.provider}/{trace.cost.model}
                    </span>
                  </div>
                </div>
              </section>
            )}

            <section className={styles.block}>
              <h4 className={styles.blockHead}>{blockTitle("knobs")}</h4>
              {/* All nine, always. Seeing the ones that did nothing is the
                  point of atlas conflict #4, not clutter to hide. */}
              {knobsByEffect(trace).map((knob) => (
                <div key={knob.key} className={styles.knobRow}>
                  <span className={knob.state === "applied" ? styles.knobApplied : undefined}>
                    <Link href={knob.href}>{knob.label}</Link>
                    <span className={styles.reason}> — {knob.detail}</span>
                  </span>
                  <span className={styles.badge}>{knobStateLabel(knob.state)}</span>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </details>
  );
}
