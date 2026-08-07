import type { Launch, LaunchDetail } from "@tuezday/contracts";

export const LAUNCH_GENERATION_POLL_MS = 1_000;

export function mergeLaunchAdmission(rows: Launch[], admitted: Launch): Launch[] {
  const index = rows.findIndex((row) => row.id === admitted.id);
  if (index < 0) return [admitted, ...rows];
  return rows.map((row, rowIndex) => rowIndex === index ? admitted : row);
}

export function shouldPollLaunchGeneration(
  openLaunchId: string | null,
  detail: LaunchDetail | null,
): boolean {
  return Boolean(
    openLaunchId &&
    detail?.launch.id === openLaunchId &&
    detail.launch.status === "generating",
  );
}
