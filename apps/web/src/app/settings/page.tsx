"use client";

import { useEffect, useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Card, Button, LoadingState } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";

export default function SettingsPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const [industries, setIndustries] = useState<any[]>([]);
  const [newIndustry, setNewIndustry] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  function loadTaxonomy() {
    setLoading(true);
    api
      .taxonomyTree()
      .then((res) => setIndustries(res.data))
      .finally(() => setLoading(false));
  }

  useEffect(loadTaxonomy, []);

  async function addIndustry(e: React.FormEvent) {
    e.preventDefault();
    if (!newIndustry.trim()) return;
    setSubmitting(true);
    try {
      await api.createIndustry(newIndustry.trim());
      notify("success", `Added industry "${newIndustry.trim()}".`);
      setNewIndustry("");
      loadTaxonomy();
    } catch (err) {
      notify("error", "Couldn't add that industry — it may already exist.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader title="Settings" description="Workspace and reference-data configuration." />
      <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-2xl space-y-6">
        <Card className="p-5">
          <p className="font-display font-semibold text-ink mb-3">Workspace</p>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-slate">Organization</dt><dd className="text-ink">{user?.organization_name}</dd></div>
            <div className="flex justify-between"><dt className="text-slate">Your role</dt><dd className="text-ink">{user?.role}</dd></div>
            <div className="flex justify-between"><dt className="text-slate">Signed in as</dt><dd className="text-ink">{user?.email}</dd></div>
          </dl>
        </Card>

        <Card className="p-5">
          <p className="font-display font-semibold text-ink mb-1">Industry taxonomy</p>
          <p className="text-xs text-slate mb-3">Industries available when targeting campaigns and classifying leads.</p>
          {loading ? (
            <LoadingState label="Loading…" />
          ) : (
            <ul className="flex flex-wrap gap-2 mb-4">
              {industries.map((i) => (
                <li key={i.id} className="rounded-sm bg-slate-soft px-2.5 py-1 text-xs text-ink">
                  {i.name}
                </li>
              ))}
              {industries.length === 0 && <p className="text-sm text-slate">No industries added yet.</p>}
            </ul>
          )}
          <form onSubmit={addIndustry} className="flex gap-2">
            <input
              value={newIndustry}
              onChange={(e) => setNewIndustry(e.target.value)}
              placeholder="e.g. Legal Services"
              className="focus-ring flex-1 rounded-sm border border-border px-3 py-2 text-sm"
            />
            <Button type="submit" disabled={submitting}>Add</Button>
          </form>
        </Card>

        <Card className="p-5">
          <p className="font-display font-semibold text-ink mb-1">API integration</p>
          <p className="text-sm text-slate">AI provider status and connection testing live on the <a href="/system" className="text-signal font-medium">System Health</a> page.</p>
        </Card>
      </div>
    </AppShell>
  );
}
