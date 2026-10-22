"use client";

import { useEffect, useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Badge, LoadingState, ErrorState, Card, Button } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, ApiError } from "@/lib/api";

function statusTone(status: string): "verified" | "alert" | "risk" | "slate" {
  if (status === "healthy" || status === "configured") return "verified";
  if (status === "mock" || status === "degraded") return "alert";
  if (status === "unhealthy") return "risk";
  return "slate";
}

export default function SystemHealthPage() {
  const { notify } = useToast();
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  function load() {
    setLoading(true);
    setError(null);
    api
      .systemHealth()
      .then(setHealth)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't reach the API — the backend itself may be down."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function testAi() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testAiConnection();
      setTestResult(res);
      notify(res.success ? "success" : "error", res.success ? `AI connection working (${res.responseTimeMs}ms).` : res.message ?? "AI connection test failed.");
    } catch (err) {
      notify("error", "Couldn't run the AI connection test.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader title="System health" description="Live status of the platform's core services." actions={<Button variant="secondary" onClick={load}>Refresh</Button>} />
      <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-2xl space-y-6">
        {loading && <LoadingState label="Checking system health…" />}
        {error && <ErrorState message={error} onRetry={load} />}
        {health && (
          <>
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="font-display font-semibold text-ink">Overall status</p>
                <Badge tone={statusTone(health.status)}>{health.status}</Badge>
              </div>
              <ul className="divide-y divide-border">
                {Object.entries(health.checks).map(([name, check]: [string, any]) => (
                  <li key={name} className="py-2.5 flex items-center justify-between text-sm">
                    <div>
                      <p className="text-ink capitalize">{name.replace(/([A-Z])/g, " $1")}</p>
                      {check.detail && <p className="text-xs text-slate mt-0.5">{check.detail}</p>}
                    </div>
                    <Badge tone={statusTone(check.status)}>{check.status}</Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate mt-3">Last checked: {new Date(health.checkedAt).toLocaleString()}</p>
            </Card>

            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-1">Test AI connection</p>
              <p className="text-sm text-slate mb-3">Makes one real (billed) request to confirm the configured AI provider is reachable and responding correctly.</p>
              <Button disabled={testing} onClick={testAi}>{testing ? "Testing…" : "Run test"}</Button>
              {testResult && (
                <div className="mt-3 text-sm">
                  {testResult.success ? (
                    <p className="text-verified">✓ Connected to {testResult.provider} ({testResult.model}) in {testResult.responseTimeMs}ms.</p>
                  ) : (
                    <p className="text-risk">{testResult.message ?? testResult.error}</p>
                  )}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
