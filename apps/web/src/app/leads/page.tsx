"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, verificationTone, LoadingState, ErrorState, EmptyState, Button } from "@/components/ui";
import { ScoreCompass } from "@/components/ScoreCompass";
import { useToast } from "@/components/Toast";
import { api, downloadExport, ApiError } from "@/lib/api";

export default function LeadsPage() {
  const { notify } = useToast();
  const [leads, setLeads] = useState<any[] | null>(null);
  const [pagination, setPagination] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [search, setSearch] = useState("");
  const [country, setCountry] = useState("");
  const [verificationStatus, setVerificationStatus] = useState("");
  const [hasEmail, setHasEmail] = useState(false);
  const [minScore, setMinScore] = useState("");
  const [page, setPage] = useState(1);

  const filters = { search, country, verificationStatus, hasEmail: hasEmail || undefined, minScore: minScore || undefined, page, pageSize: 25 };

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .listLeads(filters)
      .then((res) => {
        setLeads(res.data);
        setPagination(res.pagination);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load leads."))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, country, verificationStatus, hasEmail, minScore, page]);

  useEffect(load, [load]);

  async function handleExport(format: "csv" | "xlsx" | "json") {
    setExporting(true);
    try {
      await downloadExport({ ...filters, format });
      notify("success", `Export downloaded (${format.toUpperCase()}).`);
    } catch (err) {
      notify("error", "Export failed. Check your connection and try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        title="Lead database"
        description={pagination ? `${pagination.total} leads matching your filters` : undefined}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" disabled={exporting} onClick={() => handleExport("csv")}>
              Export CSV
            </Button>
            <Button variant="secondary" disabled={exporting} onClick={() => handleExport("xlsx")}>
              Export Excel
            </Button>
          </div>
        }
      />
      <div className="px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-wrap gap-2 mb-4">
          <input
            placeholder="Search company, website, city…"
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            className="focus-ring flex-1 min-w-[200px] rounded-sm border border-border px-3 py-2 text-sm"
          />
          <input
            placeholder="Country code (e.g. AU)"
            value={country}
            onChange={(e) => {
              setPage(1);
              setCountry(e.target.value.toUpperCase());
            }}
            className="focus-ring w-40 rounded-sm border border-border px-3 py-2 text-sm"
          />
          <select
            value={verificationStatus}
            onChange={(e) => {
              setPage(1);
              setVerificationStatus(e.target.value);
            }}
            className="focus-ring rounded-sm border border-border px-3 py-2 text-sm bg-white"
          >
            <option value="">Any verification status</option>
            <option value="VERIFIED">Verified</option>
            <option value="PARTIALLY_VERIFIED">Partially verified</option>
            <option value="UNVERIFIED">Unverified</option>
            <option value="INVALID">Invalid</option>
            <option value="NEEDS_REVIEW">Needs review</option>
          </select>
          <input
            placeholder="Min score"
            type="number"
            value={minScore}
            onChange={(e) => {
              setPage(1);
              setMinScore(e.target.value);
            }}
            className="focus-ring w-28 rounded-sm border border-border px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-1.5 text-sm text-ink px-1">
            <input
              type="checkbox"
              checked={hasEmail}
              onChange={(e) => {
                setPage(1);
                setHasEmail(e.target.checked);
              }}
              className="focus-ring"
            />
            Has email
          </label>
        </div>

        {loading && <LoadingState label="Loading leads…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {leads && leads.length === 0 && (
          <EmptyState title="No leads match these filters" description="Try widening your filters, or create a campaign to start discovering leads." />
        )}
        {leads && leads.length > 0 && (
          <div className="bg-panel border border-border rounded-md overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-soft">
                  <tr className="text-left text-xs text-slate uppercase tracking-wide">
                    <th className="px-4 py-2.5">Company</th>
                    <th className="px-4 py-2.5">Country</th>
                    <th className="px-4 py-2.5">Verification</th>
                    <th className="px-4 py-2.5">Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {leads.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-soft/50">
                      <td className="px-4 py-3">
                        <Link href={`/leads/${l.id}`} className="font-medium text-ink hover:text-signal focus-ring">
                          {l.company_name}
                        </Link>
                        {l.website && <p className="text-xs text-slate mt-0.5 truncate max-w-[220px]">{l.website}</p>}
                      </td>
                      <td className="px-4 py-3 text-slate">{l.country ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge tone={verificationTone(l.verification_status)}>{l.verification_status}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <ScoreCompass leadScore={l.lead_score} dataConfidence={l.data_confidence} size={40} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-border text-sm">
                <span className="text-slate">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <Button variant="secondary" disabled={page >= pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
