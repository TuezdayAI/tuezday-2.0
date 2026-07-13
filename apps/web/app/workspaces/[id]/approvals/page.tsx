"use client";

// Legacy route: Approvals now lives inside the unified Review workspace.
// Redirect preserves the campaign filter deep links pass along.
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { reviewHref } from "@/lib/review-workspace";

export default function LegacyApprovalsRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    router.replace(
      reviewHref(id, { tab: "approvals", campaign: searchParams.get("campaign") ?? undefined }),
    );
  }, [id, router, searchParams]);

  return null;
}
