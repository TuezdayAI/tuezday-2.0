"use client";

// Legacy route: the Inbox now lives inside the unified Review workspace.
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { reviewHref } from "@/lib/review-workspace";

export default function LegacyInboxRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(reviewHref(id, { tab: "inbox" }));
  }, [id, router]);

  return null;
}
