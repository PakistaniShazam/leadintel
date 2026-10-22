"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, priorityTone, LoadingState, ErrorState, EmptyState, Card, Button } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, ApiError } from "@/lib/api";

export default function ReviewQueuePage() {
  const { notify } = useToast();
  const [flags, setFlags] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [priority, setPriority] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([api.reviewQueue(priority || undefined), api.reviewQueueSummary()])
      .then(([q, s]) => {
        setFlags(q.data);
        setSummary(s);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load the review queue."))
      .finally(() => setLoading(false));
  }, [priority]);

  useEffect(load, [load]);

  async function resolve(flagId: string, resolution: "approved" | "rejected") {
    setBusy(flagId);
    try {
      await api.resolveFlag(flagId, resolution);
      notify("success", resolution === "approved" ? "Marked as approved." : "Marked as rejected.");
      await load();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Couldn't resolve this flag.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AppShell>
      <PageHeader title="Review queue" description="Records flagged for human attention — ambiguous duplicates, low-confidence classifications, changed fields." />
      <div className="px-4 sm:px-6 lg:px-8 py-6">
        {summary && (
          <div className="flex gap-2 mb-4">
            {(["HIGH", "MEDIUM", "LOW"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(priority === p ? "" : p)}
                className={`focus-ring rounded-sm px-3 py-1.5 text-sm font-medium border transition-colors ${
                  priority === p ? "bg-signal text-white border-signal" : "bg-white border-border text-ink hover:border-signal/50"
                }`}
              >
                {p} · {summary[p] ?? 0}
              </button>
            ))}
          </div>
        )}

        {loading && <LoadingState label="Loading review queue…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {flags && flags.length === 0 && <EmptyState title="Nothing to review" description="All flagged records have been resolved." />}
        {flags && flags.length > 0 && (
          <div className="space-y-3">
            {flags.map((f) => (
              <Card key={f.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge tone={priorityTone(f.priority)}>{f.priority}</Badge>
                      <span className="text-xs text-slate">{f.reason.replace(/_/g, " ")}</span>
                    </div>
                    <Link href={`/leads/${f.lead_id}`} className="font-medium text-ink hover:text-signal focus-ring">
                      {f.company_name}
                    </Link>
                    {f.details && <pre className="text-xs text-slate mt-1 whitespace-pre-wrap">{JSON.stringify(f.details, null, 2).slice(0, 300)}</pre>}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="secondary" disabled={busy === f.id} onClick={() => resolve(f.id, "rejected")}>
                      Reject
                    </Button>
                    <Button disabled={busy === f.id} onClick={() => resolve(f.id, "approved")}>
                      Approve
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
