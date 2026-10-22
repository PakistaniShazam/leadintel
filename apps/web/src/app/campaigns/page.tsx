"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, LoadingState, ErrorState, EmptyState, Card, Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

function statusTone(status: string): "slate" | "verified" | "alert" | "signal" {
  if (status === "ACTIVE") return "verified";
  if (status === "DRAFT") return "slate";
  if (status === "PAUSED") return "alert";
  return "signal";
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    api
      .listCampaigns()
      .then((res) => setCampaigns(res.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load campaigns."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <AppShell>
      <PageHeader
        title="Campaigns"
        description="Create and manage lead-generation campaigns."
        actions={
          <Link href="/campaigns/new">
            <Button>New campaign</Button>
          </Link>
        }
      />
      <div className="px-4 sm:px-6 lg:px-8 py-6">
        {loading && <LoadingState label="Loading campaigns…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {campaigns && campaigns.length === 0 && (
          <EmptyState
            title="No campaigns yet"
            description="Create your first campaign to start discovering leads automatically."
            action={
              <Link href="/campaigns/new">
                <Button>New campaign</Button>
              </Link>
            }
          />
        )}
        {campaigns && campaigns.length > 0 && (
          <div className="grid gap-3">
            {campaigns.map((c) => (
              <Link key={c.id} href={`/campaigns/${c.id}`}>
                <Card className="p-4 hover:border-signal/40 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-display font-semibold text-ink truncate">{c.name}</p>
                      <p className="text-xs text-slate mt-1">
                        {c.include_countries?.length ? c.include_countries.join(", ") : "Any country"} · Target {c.target_leads || "unspecified"} leads
                      </p>
                    </div>
                    <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
