"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, LoadingState, ErrorState, Card, Button, EmptyState } from "@/components/ui";
import { ScoreCompass } from "@/components/ScoreCompass";
import { useToast } from "@/components/Toast";
import { api, ApiError } from "@/lib/api";
import Link from "next/link";

function statusTone(status: string): "slate" | "verified" | "alert" | "signal" {
  if (status === "ACTIVE") return "verified";
  if (status === "DRAFT") return "slate";
  if (status === "PAUSED") return "alert";
  return "signal";
}

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { notify } = useToast();

  const [campaign, setCampaign] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [sources, setSources] = useState<any[]>([]);
  const [allSources, setAllSources] = useState<any[]>([]);
  const [campaignLeads, setCampaignLeads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scheduleEveryMin, setScheduleEveryMin] = useState(60);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s, all, cl] = await Promise.all([
        api.getCampaign(id),
        api.campaignSources(id),
        api.listSources(),
        api.campaignLeads(id).catch(() => ({ data: [] })), // no leads yet is normal, not an error
      ]);
      setCampaign(c.campaign);
      setRuns(c.runs);
      setSources(s.data);
      setAllSources(all.data);
      setCampaignLeads(cl.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load this campaign.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "That action failed. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  const unattachedSources = allSources.filter((s) => !sources.some((cs) => cs.source_id === s.id));

  return (
    <AppShell>
      {loading && (
        <div className="px-6 py-8">
          <LoadingState label="Loading campaign…" />
        </div>
      )}
      {error && (
        <div className="px-6 py-8">
          <ErrorState message={error} onRetry={load} />
        </div>
      )}
      {campaign && (
        <>
          <PageHeader
            title={campaign.name}
            description={`${campaign.include_countries?.length ? campaign.include_countries.join(", ") : "Any country"} · Target ${campaign.target_leads || "unspecified"} leads`}
            actions={<Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>}
          />
          <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-6 max-w-4xl">
            {/* Strategy & approval */}
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-1">Discovery strategy</p>
              {!campaign.search_strategy && <p className="text-sm text-slate mb-3">No strategy generated yet. Generate one to review before this campaign can run.</p>}
              {campaign.search_strategy && (
                <pre className="text-xs bg-slate-soft rounded-sm p-3 overflow-x-auto mb-3 max-h-48 whitespace-pre-wrap">
                  {JSON.stringify(campaign.search_strategy, null, 2)}
                </pre>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={busy === "strategy"}
                  onClick={() =>
                    withBusy("strategy", async () => {
                      const res = await api.generateStrategy(id);
                      notify("success", `Strategy generated (${res.aiProviderUsed}).`);
                      await load();
                    })
                  }
                >
                  {busy === "strategy" ? "Generating…" : campaign.search_strategy ? "Regenerate strategy" : "Generate strategy"}
                </Button>
                {campaign.status === "DRAFT" && campaign.search_strategy && (
                  <Button
                    disabled={busy === "approve"}
                    onClick={() =>
                      withBusy("approve", async () => {
                        await api.approveCampaign(id);
                        notify("success", "Campaign approved — ready to run.");
                        await load();
                      })
                    }
                  >
                    {busy === "approve" ? "Approving…" : "Approve campaign"}
                  </Button>
                )}
              </div>
            </Card>

            {/* Sources */}
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-3">Approved sources</p>
              {sources.length === 0 && <p className="text-sm text-slate mb-3">No sources attached yet. Attach one below before running.</p>}
              <ul className="divide-y divide-border mb-3">
                {sources.map((s) => (
                  <li key={s.id} className="py-2 flex items-center justify-between text-sm">
                    <span>
                      {s.name} <span className="text-slate">· {s.type}</span>
                    </span>
                    <Badge tone="slate">priority {s.priority}</Badge>
                  </li>
                ))}
              </ul>
              {unattachedSources.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {unattachedSources.map((s) => (
                    <Button
                      key={s.id}
                      variant="secondary"
                      disabled={busy === `attach-${s.id}`}
                      onClick={() =>
                        withBusy(`attach-${s.id}`, async () => {
                          await api.attachSource(id, s.id);
                          notify("success", `Attached ${s.name}.`);
                          await load();
                        })
                      }
                    >
                      + Attach {s.name}
                    </Button>
                  ))}
                </div>
              )}
              {allSources.length === 0 && (
                <p className="text-sm text-slate">
                  No sources registered yet.{" "}
                  <Link href="/sources" className="text-signal font-medium">
                    Add one in Sources →
                  </Link>
                </p>
              )}
            </Card>

            {/* Run & schedule controls */}
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-3">Run this campaign</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={campaign.status !== "ACTIVE" || sources.length === 0 || busy === "run"}
                  onClick={() =>
                    withBusy("run", async () => {
                      const res = await api.runCampaign(id);
                      notify("success", `Run started — ${res.totalCandidatesEnqueued ?? res.candidatesEnqueued ?? 0} candidates queued.`);
                      await load();
                    })
                  }
                >
                  {busy === "run" ? "Starting…" : "Run now"}
                </Button>
                {campaign.status !== "ACTIVE" && <span className="text-xs text-slate">Approve the campaign before running.</span>}
              </div>

              <div className="mt-5 pt-5 border-t border-border">
                <p className="text-sm font-medium text-ink mb-2">Recurring schedule</p>
                {campaign.schedule_cron ? (
                  <div className="flex items-center gap-3">
                    <Badge tone="verified">Scheduled: {campaign.schedule_cron}</Badge>
                    <Button
                      variant="secondary"
                      disabled={busy === "unschedule"}
                      onClick={() =>
                        withBusy("unschedule", async () => {
                          await api.unscheduleCampaign(id);
                          notify("success", "Recurring schedule removed.");
                          await load();
                        })
                      }
                    >
                      Remove schedule
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-slate">Run every</span>
                    <input
                      type="number"
                      min={1}
                      value={scheduleEveryMin}
                      onChange={(e) => setScheduleEveryMin(Number(e.target.value))}
                      className="focus-ring w-20 rounded-sm border border-border px-2 py-1.5 text-sm"
                    />
                    <span className="text-sm text-slate">minutes</span>
                    <Button
                      variant="secondary"
                      disabled={campaign.status !== "ACTIVE" || busy === "schedule"}
                      onClick={() =>
                        withBusy("schedule", async () => {
                          await api.scheduleCampaign(id, { everyMs: scheduleEveryMin * 60_000 });
                          notify("success", "Recurring schedule enabled.");
                          await load();
                        })
                      }
                    >
                      {busy === "schedule" ? "Saving…" : "Enable schedule"}
                    </Button>
                  </div>
                )}
              </div>
            </Card>

            {/* Run history */}
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-3">Run history</p>
              {runs.length === 0 && <p className="text-sm text-slate">No runs yet.</p>}
              {runs.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate uppercase tracking-wide">
                        <th className="pb-2 pr-4">Started</th>
                        <th className="pb-2 pr-4">Status</th>
                        <th className="pb-2 pr-4">Discovered</th>
                        <th className="pb-2 pr-4">New</th>
                        <th className="pb-2 pr-4">Errors</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td className="py-2 pr-4 font-mono text-xs">{new Date(r.started_at).toLocaleString()}</td>
                          <td className="py-2 pr-4">
                            <Badge tone={r.status === "completed" ? "verified" : r.status === "failed" ? "risk" : "alert"}>{r.status}</Badge>
                          </td>
                          <td className="py-2 pr-4 font-mono">{r.discovered}</td>
                          <td className="py-2 pr-4 font-mono">{r.new_leads}</td>
                          <td className="py-2 pr-4 font-mono">{r.errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* Discovered leads for this campaign */}
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-3">Leads evaluated in this campaign</p>
              {campaignLeads.length === 0 && (
                <EmptyState title="No leads yet" description="Once this campaign runs, discovered leads and their relevance scores will show up here." />
              )}
              {campaignLeads.length > 0 && (
                <ul className="divide-y divide-border">
                  {campaignLeads.map((l) => (
                    <li key={l.id} className="py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <Link href={`/leads/${l.id}`} className="font-medium text-ink hover:text-signal truncate block focus-ring">
                          {l.company_name}
                        </Link>
                        <p className="text-xs text-slate mt-0.5">{l.country_code ?? "Unknown country"}</p>
                      </div>
                      <ScoreCompass leadScore={l.lead_score} dataConfidence={l.data_confidence} campaignRelevance={l.campaign_relevance} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </AppShell>
  );
}
