"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Button, Card, LoadingState } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { api, ApiError } from "@/lib/api";

export default function NewCampaignPage() {
  const router = useRouter();
  const { notify } = useToast();

  const [countries, setCountries] = useState<any[]>([]);
  const [taxonomy, setTaxonomy] = useState<any[]>([]);
  const [loadingRefs, setLoadingRefs] = useState(true);

  const [name, setName] = useState("");
  const [includeCountries, setIncludeCountries] = useState<string[]>([]);
  const [industryId, setIndustryId] = useState("");
  const [requireEmail, setRequireEmail] = useState(true);
  const [requirePhone, setRequirePhone] = useState(false);
  const [targetLeads, setTargetLeads] = useState(500);
  const [maxAiCostUsd, setMaxAiCostUsd] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.countries(), api.taxonomyTree()])
      .then(([c, t]) => {
        setCountries(c.data);
        setTaxonomy(t.data);
      })
      .catch(() => {
        // Reference data failing to load isn't fatal to viewing the form —
        // the selects just render empty and the user can still name/target
        // a campaign; surfaced as a toast rather than blocking the page.
        notify("error", "Couldn't load countries/industries — you can still create the campaign and set these later.");
      })
      .finally(() => setLoadingRefs(false));
  }, [notify]);

  function toggleCountry(code: string) {
    setIncludeCountries((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const requiredFields: string[] = [];
      if (requireEmail) requiredFields.push("email");
      if (requirePhone) requiredFields.push("phone");

      const res = await api.createCampaign({
        name,
        includeCountries,
        requiredFields,
        targetLeads,
        maxAiCostUsd,
      });
      notify("success", "Campaign created. Next, generate a discovery strategy and approve it to run.");
      router.push(`/campaigns/${res.campaign.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the campaign. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <PageHeader title="New campaign" description="Define what kind of leads you want, then review the discovery plan before it runs." />
      <div className="px-4 sm:px-6 lg:px-8 py-6 max-w-2xl">
        {loadingRefs && <LoadingState label="Loading countries and industries…" />}
        {!loadingRefs && (
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && <div className="rounded-sm bg-risk-soft text-risk text-sm px-3 py-2">{error}</div>}

            <Card className="p-5 space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-ink mb-1">
                  Campaign name
                </label>
                <input
                  id="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Australian Dental Clinics"
                  className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <span className="block text-sm font-medium text-ink mb-1.5">Target countries</span>
                <p className="text-xs text-slate mb-2">Leave empty to allow any country.</p>
                <div className="flex flex-wrap gap-2">
                  {countries.map((c) => (
                    <button
                      type="button"
                      key={c.code}
                      onClick={() => toggleCountry(c.code)}
                      className={`focus-ring rounded-sm border px-2.5 py-1.5 text-sm transition-colors ${
                        includeCountries.includes(c.code) ? "bg-signal text-white border-signal" : "bg-white border-border text-ink hover:border-signal/50"
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                  {countries.length === 0 && <p className="text-sm text-slate">No countries available yet — add some in Settings.</p>}
                </div>
              </div>

              <div>
                <label htmlFor="industry" className="block text-sm font-medium text-ink mb-1">
                  Industry
                </label>
                <select
                  id="industry"
                  value={industryId}
                  onChange={(e) => setIndustryId(e.target.value)}
                  className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm bg-white"
                >
                  <option value="">Any industry</option>
                  {taxonomy.map((ind) => (
                    <option key={ind.id} value={ind.id}>
                      {ind.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate mt-1">
                  Category/subcategory targeting refines further once industries are seeded — this campaign will still classify every discovered
                  lead's industry automatically.
                </p>
              </div>
            </Card>

            <Card className="p-5 space-y-4">
              <p className="text-sm font-medium text-ink">Lead requirements</p>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={requireEmail} onChange={(e) => setRequireEmail(e.target.checked)} className="focus-ring" />
                Must have a public business email
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={requirePhone} onChange={(e) => setRequirePhone(e.target.checked)} className="focus-ring" />
                Must have a public business phone
              </label>

              <div>
                <label htmlFor="target" className="block text-sm font-medium text-ink mb-1">
                  Target number of leads
                </label>
                <input
                  id="target"
                  type="number"
                  min={1}
                  value={targetLeads}
                  onChange={(e) => setTargetLeads(Number(e.target.value))}
                  className="focus-ring w-40 rounded-sm border border-border px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label htmlFor="aicost" className="block text-sm font-medium text-ink mb-1">
                  Max AI spend per day (USD)
                </label>
                <input
                  id="aicost"
                  type="number"
                  min={0}
                  step={0.5}
                  value={maxAiCostUsd}
                  onChange={(e) => setMaxAiCostUsd(Number(e.target.value))}
                  className="focus-ring w-40 rounded-sm border border-border px-3 py-2 text-sm"
                />
                <p className="text-xs text-slate mt-1">Classification/strategy generation pauses automatically once this is reached each day.</p>
              </div>
            </Card>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create campaign"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </AppShell>
  );
}
