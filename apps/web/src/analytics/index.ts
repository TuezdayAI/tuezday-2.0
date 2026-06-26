import posthog from "posthog-js";

let initialized = false;

export function initAnalytics(workspaceId: string, optOut: boolean): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || optOut) return;
  if (initialized) return;

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
  });
  
  posthog.group("workspace", workspaceId);
  initialized = true;
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

export function identify(userId: string): void {
  if (!initialized) return;
  posthog.identify(userId);
}
