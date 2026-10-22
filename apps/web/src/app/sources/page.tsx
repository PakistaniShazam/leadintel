"use client";

import { useEffect, useState, useCallback } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, LoadingState, ErrorState, EmptyState, Card, Button } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, ApiError } from "@/lib/api";

const CONNECTOR_TYPES = ["SITEMAP", "RSS"]; // only these are actually implemented end-to-end (see backend README)
const COMPLIANCE_MODES = ["PUBLIC_SITEMAP", "PUBLIC_RSS", "OFFICIAL_API", "USER_PROVIDED", "DIRECT_CRAWL_ROBOTS_RESPECTED"];

function healthTone(status: string): "verified" | "alert" | "risk" | "slate" {
  if (status === "healthy") return "verified";
  if (status === "degraded") return "alert";
  if (status === "needs_attention") return "risk";
  return "slate";
}

export default function SourcesPage() {
  const { notify } = useToast();
  const [sources, setSources] = useState<any[] | null>(null);
  const [health, setHealth] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", type: "SITEMAP", complianceMode: "PUBLIC_SITEMAP", baseUrl: "" });
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSources();
      setSources(res.data);
      const healthResults = await Promise.all(res.data.map((s: any) => api.sourceHealth(s.id).catch(() => null)));
      const map: Record<string, any> = {};
      res.data.forEach((s: any, i: number) => (map[s.id] = healthResults[i]));
      setHealth(map);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load sources.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.createSource(form);
      notify("success", `Source "${form.name}" created.`);
      setShowForm(false);
      setForm({ name: "", type: "SITEMAP", complianceMode: "PUBLIC_SITEMAP", baseUrl: "" });
      await load();
    } catch (err) {
      notify("error", err instanceof ApiError ? err.message : "Couldn't create the source.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        title="Sources"
        description="Where the platform discovers leads from. Only sitemap and RSS connectors are implemented so far."
        actions={<Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "Add source"}</Button>}
      />
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {showForm && (
          <Card className="p-5">
            <form onSubmit={handleCreate} className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Name</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Base URL</label>
                <input
                  required
                  type="url"
                  placeholder="https://example.com"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
                />
                <p className="text-xs text-slate mt-1">
                  For a sitemap source, this is the site root — the connector looks for <code>/sitemap.xml</code>. For RSS, use the full feed URL.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Connector type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm bg-white"
                >
                  {CONNECTOR_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-1">Compliance posture</label>
                <select
                  value={form.complianceMode}
                  onChange={(e) => setForm({ ...form, complianceMode: e.target.value })}
                  className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm bg-white"
                >
                  {COMPLIANCE_MODES.map((m) => (
                    <option key={m} value={m}>{m.replace(/_/g, " ")}</option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create source"}</Button>
              </div>
            </form>
          </Card>
        )}

        {loading && <LoadingState label="Loading sources…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {sources && sources.length === 0 && !showForm && (
          <EmptyState title="No sources yet" description="Add a compliant source (sitemap or RSS feed) to start discovering leads." action={<Button onClick={() => setShowForm(true)}>Add source</Button>} />
        )}
        {sources && sources.length > 0 && (
          <div className="grid gap-3">
            {sources.map((s) => {
              const h = health[s.id];
              return (
                <Card key={s.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{s.name}</p>
                      <p className="text-xs text-slate mt-0.5">{s.type} · {s.compliance_mode.replace(/_/g, " ")} · {s.base_url}</p>
                    </div>
                    {h && <Badge tone={healthTone(h.status)}>{h.status.replace(/_/g, " ")}</Badge>}
                  </div>
                  {h && h.totalRuns > 0 && (
                    <div className="mt-3 pt-3 border-t border-border grid grid-cols-3 gap-3 text-xs text-slate">
                      <span>Runs: <span className="font-mono text-ink">{h.totalRuns}</span></span>
                      <span>Success rate: <span className="font-mono text-ink">{h.successRate !== null ? `${Math.round(h.successRate * 100)}%` : "—"}</span></span>
                      <span>Leads found: <span className="font-mono text-ink">{h.leadsFound}</span></span>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
