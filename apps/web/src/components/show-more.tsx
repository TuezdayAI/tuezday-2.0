"use client";

import { useState } from "react";
import { Button } from "./ui/button";

/**
 * Caps how many rows a long list renders (scroll-perf: unbounded lists are
 * what make wheel scrolling stutter). Returns the visible slice plus
 * show-more controls; pair with <ShowMoreButton />.
 */
export function useShowMore<T>(items: T[], step = 50) {
  const [count, setCount] = useState(step);
  return {
    visible: items.slice(0, count),
    hasMore: items.length > count,
    remaining: Math.max(0, items.length - count),
    showMore: () => setCount((c) => c + step),
  };
}

export function ShowMoreButton(props: { hasMore: boolean; remaining: number; onClick: () => void; step?: number }) {
  if (!props.hasMore) return null;
  const step = props.step ?? 50;
  return (
    <div className="editor-actions" style={{ marginTop: 12 }}>
      <Button type="button" variant="secondary" size="standard" onClick={props.onClick}>
        Show {Math.min(props.remaining, step)} more ({props.remaining} hidden)
      </Button>
    </div>
  );
}
