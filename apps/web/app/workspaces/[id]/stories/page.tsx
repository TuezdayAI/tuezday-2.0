"use client";

import { TopBarActions } from "@/src/components/top-bar";
import { EmptyState } from "@/src/components/empty-state";
import { Button } from "@/src/components/ui/button";
import { Card, CardHeader } from "@/src/components/ui/card";
import { Badge, CountBadge } from "@/src/components/ui/badge";
import { Icon } from "@/src/components/ui/icon";
import styles from "./stories.module.css";

import { API_URL, apiFetch } from "@/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type {
  CanonicalStory,
  StoryBackfillResult,
  StoryDetail,
  StoryOccurrence,
  Workspace,
} from "@tuezday/contracts";

const PAGE_SIZE = 20;

/** Badge tone per story status — active stories read as live, archived as muted. */
function statusTone(status: CanonicalStory["status"]): "approved" | "neutral" {
  return status === "active" ? "approved" : "neutral";
}

/** Badge tone per relationship confidence (exact keys are 100). */
function confidenceTone(confidence: number): "approved" | "edited" {
  return confidence >= 90 ? "approved" : "edited";
}

function OccurrenceRow({ occ, detached }: { occ: StoryOccurrence; detached?: boolean }) {
  return (
    <li className={styles.occurrence}>
      <div className={styles.occurrenceHead}>
        <span className={styles.kindMark} title={occ.sourceType}>
          <Icon name="signal" size="compact" />
        </span>
        <span className={styles.occurrenceSource}>{occ.sourceName}</span>
        <span className="layer-badge">{occ.sourceType}</span>
        <Badge tone={detached ? "neutral" : confidenceTone(occ.relationship.confidence)}>
          {occ.relationship.kind} · {occ.relationship.confidence}%
        </Badge>
        <span className="section-tokens">
          observed {new Date(occ.observedAt).toLocaleDateString()}
        </span>
      </div>
      <p className={styles.occurrenceTitle}>
        {occ.url ? (
          <a href={occ.url} target="_blank" rel="noreferrer">
            {occ.title}
          </a>
        ) : (
          occ.title
        )}
      </p>
      {occ.excerpt && (
        <p className="meta" style={{ whiteSpace: "pre-wrap" }}>
          {occ.excerpt.slice(0, 280)}
          {occ.excerpt.length > 280 ? "…" : ""}
        </p>
      )}
      {detached && occ.relationship.detachedAt !== null && (
        <p className={styles.detachNote}>
          Detached {new Date(occ.relationship.detachedAt).toLocaleDateString()}
          {occ.relationship.detachReason ? ` — ${occ.relationship.detachReason}` : ""}
        </p>
      )}
    </li>
  );
}

export default function StoriesPage() {
  const { id } = useParams<{ id: string }>();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [stories, setStories] = useState<CanonicalStory[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, StoryDetail>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<StoryBackfillResult | null>(null);

  const load = useCallback(async () => {
    try {
      const [wsRes, sRes] = await Promise.all([
        apiFetch(`/workspaces/${id}`),
        apiFetch(`/workspaces/${id}/stories?limit=${PAGE_SIZE}&offset=0`),
      ]);
      if (!wsRes.ok || !sRes.ok) throw new Error("not found");
      setWorkspace(await wsRes.json());
      const body = await sRes.json();
      setStories(body.stories);
      setTotal(body.total);
      setError(null);
    } catch {
      setError(`Could not load this workspace from ${API_URL}. Is "npm run dev" running?`);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!stories) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/workspaces/${id}/stories?limit=${PAGE_SIZE}&offset=${stories.length}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setStories((prev) => [...(prev ?? []), ...body.stories]);
      setTotal(body.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more stories");
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggle(story: CanonicalStory) {
    const open = !expanded[story.id];
    setExpanded((x) => ({ ...x, [story.id]: open }));
    if (!open || details[story.id]) return;
    try {
      const res = await apiFetch(`/workspaces/${id}/stories/${story.id}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setDetails((d) => ({ ...d, [story.id]: body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load story detail");
    }
  }

  async function backfill() {
    setBackfilling(true);
    setError(null);
    try {
      const res = await apiFetch(`/workspaces/${id}/stories/backfill`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `API returned ${res.status}`);
      setBackfillResult(body);
      setDetails({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
  }

  if (error && !workspace) {
    return (
      <>
        <p className="error">{error}</p>
        <Link href="/">← Back to workspaces</Link>
      </>
    );
  }

  if (!workspace || !stories) return <EmptyState description="Loading…" />;

  const backfillButton = (
    <Button variant="secondary" size="compact" disabled={backfilling} onClick={backfill}>
      <Icon name="regenerate" size="compact" />
      {backfilling ? "Backfilling…" : "Backfill existing items"}
    </Button>
  );

  return (
    <>
      <TopBarActions>{backfillButton}</TopBarActions>

      <p className="subtitle">
        The canonical-story view of discovery: copies of the same piece across sources converge
        into one durable story with its full observation record. This layer runs in shadow beside
        the signal inbox — nothing here changes your triage.
      </p>

      {error && <p className="error">{error}</p>}

      {backfillResult && (
        <p className={styles.backfillNote}>
          Backfill complete — scanned {backfillResult.scanned.toLocaleString()} items, created{" "}
          {backfillResult.occurrencesCreated.toLocaleString()} occurrences,{" "}
          {backfillResult.storiesCreated.toLocaleString()} stories, and{" "}
          {backfillResult.membershipsCreated.toLocaleString()} memberships.
        </p>
      )}

      <Card>
        <CardHeader
          title={
            <span className={styles.head}>
              <Icon name="discover" size="compact" className={styles.headIcon} />
              Stories <CountBadge count={total} label="canonical stories" />
            </span>
          }
        />
        {stories.length === 0 ? (
          <EmptyState
            description={
              <>
                No stories yet. Stories appear automatically as discovery runs — or backfill your
                existing discovered items to build them now.
              </>
            }
            primaryAction={backfillButton}
            preview={
              <div className={styles.previewList}>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="signal" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>Competitor raises Series B</span>
                  <span className={styles.previewMeta}>3 sources · 5 occurrences</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="signal" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>New GTM benchmark report drops</span>
                  <span className={styles.previewMeta}>2 sources · 2 occurrences</span>
                </div>
                <div className={styles.previewCard}>
                  <span className={styles.kindMark}>
                    <Icon name="signal" size="compact" />
                  </span>
                  <span className={styles.previewTitle}>ICP thread trending on Reddit</span>
                  <span className={styles.previewMeta}>1 source · 1 occurrence</span>
                </div>
              </div>
            }
          />
        ) : (
          <ul className="section-list">
            {stories.map((story) => {
              const detail = details[story.id];
              const isOpen = Boolean(expanded[story.id]);
              return (
                <li key={story.id} className="section-card">
                  <div
                    className={`section-head ${styles.storyHead}`}
                    onClick={() => void toggle(story)}
                  >
                    <span className={styles.kindMark}>
                      <Icon name="signal" size="compact" />
                    </span>
                    <Badge tone={statusTone(story.status)}>{story.status}</Badge>
                    <span className="section-title">
                      <a
                        href={story.canonicalUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {story.title}
                        <Icon name="external" size="compact" className={styles.externalIcon} />
                      </a>
                    </span>
                    <span className="section-tokens">
                      {story.corroborationCount} source{story.corroborationCount === 1 ? "" : "s"} ·{" "}
                      {story.occurrenceCount} occurrence{story.occurrenceCount === 1 ? "" : "s"} ·{" "}
                      {new Date(story.firstObservedAt).toLocaleDateString()} –{" "}
                      {new Date(story.lastObservedAt).toLocaleDateString()}
                    </span>
                  </div>
                  {isOpen && !detail && <p className="meta">Loading story detail…</p>}
                  {isOpen && detail && (
                    <div className={styles.detail}>
                      {detail.enrichment && (
                        <p className={styles.enrichment}>
                          {detail.enrichment.payload.distinctSourceTypes.length > 0 && (
                            <>
                              Seen via{" "}
                              {detail.enrichment.payload.distinctSourceTypes.join(", ")}
                            </>
                          )}
                          {detail.enrichment.payload.titleVariants.length > 1 && (
                            <>
                              {" "}
                              · {detail.enrichment.payload.titleVariants.length} title variants:{" "}
                              {detail.enrichment.payload.titleVariants.join(" / ")}
                            </>
                          )}
                        </p>
                      )}
                      <ul className={styles.occurrenceList}>
                        {detail.occurrences.map((occ) => (
                          <OccurrenceRow key={occ.id} occ={occ} />
                        ))}
                      </ul>
                      {detail.history.length > 0 && (
                        <div className={styles.historySection}>
                          <p className={styles.historyHead}>
                            History — memberships closed by merge or split
                          </p>
                          <ul className={styles.occurrenceList}>
                            {detail.history.map((occ) => (
                              <OccurrenceRow key={occ.id} occ={occ} detached />
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {stories.length > 0 && stories.length < total && (
          <div className={styles.loadMoreRow}>
            <Button variant="secondary" size="compact" disabled={loadingMore} onClick={loadMore}>
              {loadingMore
                ? "Loading…"
                : `Load more (${(total - stories.length).toLocaleString()} remaining)`}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
