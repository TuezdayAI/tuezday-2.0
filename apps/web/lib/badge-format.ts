// Pure formatting for CountBadge — kept in lib so it is unit-tested (node env).
export function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function formatProgress(done: number, total: number): string {
  return `${Math.min(done, total)}/${total}`;
}
