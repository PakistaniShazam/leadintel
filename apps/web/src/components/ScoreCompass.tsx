"use client";

/**
 * The one visual signature of this product: Lead Score, Data Confidence,
 * Campaign Relevance, and Source Confidence are never collapsed into a
 * single number (that's the actual architectural principle throughout the
 * backend — §25 of the design doc). This renders all four as independent
 * fills around a compass rather than one badge, so the distinction is
 * visible at a glance, not just true in the database.
 */

interface ScoreCompassProps {
  leadScore: number | null;
  dataConfidence: number | null; // 0-1
  campaignRelevance?: number | null; // 0-100, optional (only in campaign context)
  sourceConfidence?: number | null; // 0-1, optional
  size?: number;
}

function axisColor(v: number): string {
  if (v >= 0.7) return "#1F7A5C";
  if (v >= 0.4) return "#B5730A";
  return "#B23B3B";
}

export function ScoreCompass({ leadScore, dataConfidence, campaignRelevance, sourceConfidence, size = 56 }: ScoreCompassProps) {
  const axes = [
    { label: "Lead", value: leadScore !== null ? leadScore / 100 : null },
    { label: "Data", value: dataConfidence },
    ...(campaignRelevance !== undefined ? [{ label: "Rel", value: campaignRelevance !== null ? campaignRelevance / 100 : null }] : []),
    ...(sourceConfidence !== undefined ? [{ label: "Src", value: sourceConfidence }] : []),
  ];

  const n = axes.length;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  const points = axes.map((a, i) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const v = a.value ?? 0;
    return { x: cx + Math.cos(angle) * r * v, y: cy + Math.sin(angle) * r * v, full: { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r } };
  });

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + " Z";

  return (
    <div className="inline-flex items-center gap-2" title={axes.map((a) => `${a.label}: ${a.value !== null ? Math.round((a.value ?? 0) * 100) : "—"}`).join(" · ")}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {axes.map((_, i) => {
          const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#E4E4E1" strokeWidth={1} />;
        })}
        <path d={pathD} fill="#2151A8" fillOpacity={0.18} stroke="#2151A8" strokeWidth={1.5} strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={axisColor(axes[i].value ?? 0)} />
        ))}
      </svg>
    </div>
  );
}

export function ScoreLegend({ leadScore, dataConfidence, campaignRelevance, sourceConfidence }: ScoreCompassProps) {
  const rows = [
    { label: "Lead Score", value: leadScore !== null ? `${leadScore}/100` : "Not scored" },
    { label: "Data Confidence", value: dataConfidence !== null ? `${Math.round((dataConfidence ?? 0) * 100)}%` : "—" },
    ...(campaignRelevance !== undefined ? [{ label: "Campaign Relevance", value: campaignRelevance !== null ? `${campaignRelevance}/100` : "Not evaluated" }] : []),
    ...(sourceConfidence !== undefined ? [{ label: "Source Confidence", value: sourceConfidence !== null ? `${Math.round((sourceConfidence ?? 0) * 100)}%` : "—" }] : []),
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-2">
          <dt className="text-slate">{r.label}</dt>
          <dd className="font-mono text-ink tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
