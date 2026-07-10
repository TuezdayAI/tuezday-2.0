"use client";

import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import { TopBarActions } from "@/src/components/top-bar";
import { CadenceManager } from "./cadence-manager";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

export default function CadencePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  return (
    <>
      <TopBarActions>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => router.push(`/workspaces/${id}/calendar`)}
        >
          <Icon name="calendar" size="sm" /> View calendar
        </Button>
      </TopBarActions>

      <div className="page-header">
        <div>
          <h1>Posting cadence</h1>
          <p className="subtitle">
            Recurring posting slots. Approved drafts in the matching campaign + channel auto-fill
            the next open slots and publish on schedule. See them on the{" "}
            <Link href={`/workspaces/${id}/calendar`}>calendar</Link>.
          </p>
        </div>
      </div>

      <CadenceManager workspaceId={id} framed />
    </>
  );
}
