"use client";

import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from "recharts";
import { AppShell, PageHeader } from "@/components/AppShell";
import { LoadingState, ErrorState, Card } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

const PIE_COLORS = ["#1F7A5C", "#B5730A", "#B23B3B", "#5B6472"];

export default function AnalyticsPage() {
  const [byCountry, setByCountry] = useState<any[] | null>(null);
  const [byIndustry, setByIndustry] = useState<any[] | null>(null);
  const [byDay, setByDay] = useState<any[] | null>(null);
  const [verification, setVerification] = useState<any[] | null>(null);
  const [quality, setQuality] = useState<any>(null);
  const [aiCost, setAiCost] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      api.leadsByCountry(),
      api.leadsByIndustry(),
      api.leadsByDay(30),
      api.verificationRate(),
      api.qualityDistribution(),
      api.aiCost("operation"),
    ])
      .then(([country, industry, day, ver, qual, cost]) => {
        setByCountry(country.data);
        setByIndustry(industry.data);
        setByDay(day.data);
        setVerification(ver.data);
        setQuality(qual);
        setAiCost(cost);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load analytics."))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <AppShell>
      <PageHeader title="Analytics" description="Trends across every lead the platform has discovered." />
      <div className="px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {loading && <LoadingState label="Loading analytics…" />}
        {error && <ErrorState message={error} onRetry={load} />}

        {!loading && !error && (
          <div className="grid lg:grid-cols-2 gap-6">
            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-4">Leads discovered (last 30 days)</p>
              {byDay && byDay.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={byDay}>
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#2151A8" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-slate py-8 text-center">No leads discovered in this window yet.</p>
              )}
            </Card>

            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-4">Leads by country</p>
              {byCountry && byCountry.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={byCountry.slice(0, 10)}>
                    <XAxis dataKey="country_code" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#2151A8" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-slate py-8 text-center">No country data yet.</p>
              )}
            </Card>

            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-4">Leads by industry</p>
              {byIndustry && byIndustry.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={byIndustry} layout="vertical">
                    <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <YAxis type="category" dataKey="industry" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#2151A8" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-slate py-8 text-center">No industry-classified leads yet.</p>
              )}
            </Card>

            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-4">Quality distribution</p>
              {quality && (quality.high + quality.medium + quality.low + quality.unscored > 0) ? (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: "High (≥80)", value: quality.high },
                        { name: "Medium (50-79)", value: quality.medium },
                        { name: "Low (<50)", value: quality.low },
                        { name: "Unscored", value: quality.unscored },
                      ]}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={80}
                    >
                      {PIE_COLORS.map((c, i) => (
                        <Cell key={i} fill={c} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-slate py-8 text-center">No scored leads yet.</p>
              )}
            </Card>

            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-4">Verification status</p>
              <ul className="space-y-2">
                {verification?.map((v: any) => (
                  <li key={v.verification_status} className="flex items-center justify-between text-sm">
                    <span className="text-ink">{v.verification_status.replace(/_/g, " ")}</span>
                    <span className="font-mono text-slate">{v.count}</span>
                  </li>
                ))}
                {(!verification || verification.length === 0) && <p className="text-sm text-slate">No leads yet.</p>}
              </ul>
            </Card>

            <Card className="p-5">
              <p className="font-display font-semibold text-ink mb-1">AI cost by operation</p>
              <p className="text-xs text-slate mb-4">Today's total: <span className="font-mono text-ink">${aiCost?.todayTotalUsd?.toFixed(4) ?? "0.0000"}</span></p>
              <ul className="space-y-2">
                {aiCost?.data?.map((r: any) => (
                  <li key={r.group_key} className="flex items-center justify-between text-sm">
                    <span className="text-ink">{String(r.group_key).replace(/_/g, " ")}</span>
                    <span className="font-mono text-slate">{r.call_count} calls · ${Number(r.total_cost_usd).toFixed(4)}</span>
                  </li>
                ))}
                {(!aiCost?.data || aiCost.data.length === 0) && <p className="text-sm text-slate">No AI calls recorded yet.</p>}
              </ul>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
