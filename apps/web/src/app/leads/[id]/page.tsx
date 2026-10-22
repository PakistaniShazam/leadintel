"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, verificationTone, LoadingState, ErrorState, Card, Button } from "@/components/ui";
import { ScoreCompass, ScoreLegend } from "@/components/ScoreCompass";
import { useToast } from "@/components/Toast";
import { api, ApiError } from "@/lib/api";

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { notify } = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getLead(id)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this lead."))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  async function handleRescore() {
    setBusy("rescore");
    try {
      await api.rescoreLead(id);
      notify("success", "Lead re-scored.");
      await load();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Rescoring failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleEnrich() {
    setBusy("enrich");
    try {
      const res = await api.enrichLead(id);
      if (res.applied?.length > 0) {
        notify("success", `Enrichment found and applied: ${res.applied.join(", ")}.`);
      } else if (res.flaggedForReview?.length > 0) {
        notify("info", "Enrichment found ambiguous data — sent to the review queue.");
      } else {
        notify("info", "No new information found to enrich this lead.");
      }
      await load();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Enrichment failed.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="px-6 py-8">
          <LoadingState label="Loading lead…" />
        </div>
      </AppShell>
    );
  }
  if (error) {
    return (
      <AppShell>
        <div className="px-6 py-8">
          <ErrorState message={error} onRetry={load} />
        </div>
      </AppShell>
    );
  }
  if (!data) return null;

  const { lead, contacts, emails, provenance, history, verifications, classifications } = data;

  return (
    <AppShell>
      <PageHeader
        title={lead.company_name}
        description={lead.website ?? "No website on file"}
        actions={<Badge tone={verificationTone(lead.verification_status)}>{lead.verification_status}</Badge>}
      />
      <div className="px-4 sm:px-6 lg:px-8 py-6 grid lg:grid-cols-3 gap-6 max-w-5xl">
        <div className="lg:col-span-2 space-y-6">
          {/* Core facts */}
          <Card className="p-5">
            <p className="font-display font-semibold text-ink mb-3">Company details</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <div><dt className="text-slate">Country</dt><dd className="text-ink">{lead.country ?? "Unknown"}</dd></div>
              <div><dt className="text-slate">City</dt><dd className="text-ink">{lead.city ?? "—"}</dd></div>
              <div><dt className="text-slate">Status</dt><dd className="text-ink">{lead.status}</dd></div>
              <div><dt className="text-slate">Freshness</dt><dd className="text-ink">{lead.freshness}</dd></div>
              <div><dt className="text-slate">First discovered</dt><dd className="text-ink font-mono text-xs">{new Date(lead.first_discovered).toLocaleDateString()}</dd></div>
              <div><dt className="text-slate">Last verified</dt><dd className="text-ink font-mono text-xs">{lead.last_verified ? new Date(lead.last_verified).toLocaleDateString() : "Never"}</dd></div>
            </dl>
            {lead.ai_summary && (
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs uppercase tracking-wide text-slate mb-1">AI summary</p>
                <p className="text-sm text-ink">{lead.ai_summary}</p>
              </div>
            )}
          </Card>

          {/* Contacts & emails */}
          <Card className="p-5">
            <p className="font-display font-semibold text-ink mb-3">Contact information</p>
            {emails.length === 0 && contacts.length === 0 && <p className="text-sm text-slate">No public contact information found yet.</p>}
            {emails.length > 0 && (
              <ul className="space-y-1.5 mb-3">
                {emails.map((e: any) => (
                  <li key={e.id} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-ink">{e.email}</span>
                    <Badge tone="slate">{e.type}</Badge>
                    <Badge tone={verificationTone(e.verification_status)}>{e.verification_status}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {contacts.length > 0 && (
              <ul className="divide-y divide-border">
                {contacts.map((c: any) => (
                  <li key={c.id} className="py-2 text-sm">
                    <p className="font-medium text-ink">{c.full_name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unnamed contact")}</p>
                    <p className="text-slate text-xs">{[c.job_title, c.department].filter(Boolean).join(" · ")}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 pt-4 border-t border-border">
              <Button variant="secondary" disabled={busy === "enrich"} onClick={handleEnrich}>
                {busy === "enrich" ? "Enriching…" : "Find more contact info"}
              </Button>
            </div>
          </Card>

          {/* Verification results */}
          <Card className="p-5">
            <p className="font-display font-semibold text-ink mb-3">Verification checks</p>
            {verifications.length === 0 && <p className="text-sm text-slate">No verification checks have run yet.</p>}
            {verifications.length > 0 && (
              <ul className="divide-y divide-border">
                {verifications.map((v: any) => (
                  <li key={v.id} className="py-2 flex items-center justify-between text-sm">
                    <span className="text-ink">{v.check_type.replace(/_/g, " ")}</span>
                    <Badge tone={v.result === "pass" ? "verified" : v.result === "fail" ? "risk" : "alert"}>{v.result}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Evidence / provenance */}
          <Card className="p-5">
            <p className="font-display font-semibold text-ink mb-1">Evidence &amp; provenance</p>
            <p className="text-xs text-slate mb-3">Why the system believes what it believes about this lead.</p>
            {provenance.length === 0 && <p className="text-sm text-slate">No field-level evidence recorded yet.</p>}
            {provenance.length > 0 && (
              <ul className="divide-y divide-border">
                {provenance.map((p: any) => (
                  <li key={p.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ink capitalize">{p.field}</span>
                      {p.confidence !== null && <span className="font-mono text-xs text-slate">{Math.round(p.confidence * 100)}% confidence</span>}
                    </div>
                    <p className="text-ink text-xs mt-0.5">{p.value}</p>
                    {p.evidence && <p className="text-slate text-xs mt-0.5 italic">{p.evidence}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* AI classifications */}
          {classifications.length > 0 && (
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-3">AI classifications</p>
              <ul className="divide-y divide-border">
                {classifications.map((c: any) => (
                  <li key={c.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ink capitalize">{c.field}: {c.value}</span>
                      <span className="font-mono text-xs text-slate">{Math.round(c.confidence * 100)}%</span>
                    </div>
                    {c.reasoning && <p className="text-slate text-xs mt-0.5">{c.reasoning}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* History */}
          <Card className="p-5">
            <p className="font-display font-semibold text-ink mb-3">History</p>
            {history.length === 0 && <p className="text-sm text-slate">No history events yet.</p>}
            {history.length > 0 && (
              <ul className="space-y-1.5">
                {history.slice(0, 20).map((h: any) => (
                  <li key={h.id} className="text-xs text-slate flex items-center gap-2">
                    <span className="font-mono">{new Date(h.created_at).toLocaleString()}</span>
                    <span className="text-ink">{h.event_type.replace(/_/g, " ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Sidebar: scoring */}
        <div className="space-y-6">
          <Card className="p-5">
            <p className="font-display font-semibold text-ink mb-3">Scoring</p>
            <div className="flex justify-center mb-4">
              <ScoreCompass leadScore={lead.lead_score} dataConfidence={lead.data_confidence} size={96} />
            </div>
            <ScoreLegend leadScore={lead.lead_score} dataConfidence={lead.data_confidence} />
            <Button variant="secondary" className="w-full mt-4" disabled={busy === "rescore"} onClick={handleRescore}>
              {busy === "rescore" ? "Re-scoring…" : "Re-score now"}
            </Button>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
