"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell, PageHeader } from "@/components/AppShell";
import { StatCard, LoadingState, ErrorState } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

export default function DashboardPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    api
      .dashboard()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the dashboard."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <AppShell>
      <PageHeader
        title="Dashboard"
        description="An overview of everything the platform has discovered so far."
        actions={
          <Link href="/campaigns/new" className="focus-ring inline-flex items-center rounded-sm bg-signal text-white px-3 py-2 text-sm font-medium hover:bg-signal-dark">
            New campaign
          </Link>
        }
      />
      <div className="px-4 sm:px-6 lg:px-8 py-6">
        {loading && <LoadingState label="Loading dashboard…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {data && (
          <div className="space-y-8">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <StatCard label="Total Leads" value={data.total_leads} />
              <StatCard label="New Today" value={data.new_today} />
              <StatCard label="New This Week" value={data.new_this_week} />
              <StatCard label="Verified" value={data.verified_leads} />
              <StatCard label="High Quality" value={data.high_quality_leads} sub="Score ≥ 80" />
              <StatCard label="Active Campaigns" value={data.active_campaigns} />
              <StatCard label="Running Jobs" value={data.running_jobs} />
              <StatCard label="Failed Jobs" value={data.failed_jobs} />
              <StatCard label="Countries" value={data.countries} />
              <StatCard label="Industries" value={data.industries} />
            </div>

            <div className="flex flex-wrap gap-3">
              <Link href="/leads" className="text-sm font-medium text-signal focus-ring">
                View lead database →
              </Link>
              <Link href="/review-queue" className="text-sm font-medium text-signal focus-ring">
                Review queue →
              </Link>
              <Link href="/analytics" className="text-sm font-medium text-signal focus-ring">
                Full analytics →
              </Link>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
