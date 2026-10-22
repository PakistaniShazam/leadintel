export function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "verified" | "alert" | "risk" | "signal" }) {
  const toneClasses: Record<string, string> = {
    slate: "bg-slate-soft text-slate",
    verified: "bg-verified-soft text-verified",
    alert: "bg-alert-soft text-alert",
    risk: "bg-risk-soft text-risk",
    signal: "bg-signal-soft text-signal",
  };
  return <span className={`inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium ${toneClasses[tone]}`}>{children}</span>;
}

export function verificationTone(status: string): "slate" | "verified" | "alert" | "risk" {
  switch (status) {
    case "VERIFIED":
      return "verified";
    case "PARTIALLY_VERIFIED":
      return "alert";
    case "INVALID":
      return "risk";
    case "NEEDS_REVIEW":
      return "alert";
    default:
      return "slate";
  }
}

export function priorityTone(priority: string): "risk" | "alert" | "slate" {
  if (priority === "HIGH") return "risk";
  if (priority === "MEDIUM") return "alert";
  return "slate";
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-slate text-sm py-8 justify-center" role="status" aria-live="polite">
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-md border border-risk/30 bg-risk-soft px-4 py-3 text-sm text-risk">
      <p className="font-medium">Something went wrong.</p>
      <p className="mt-1 opacity-90">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 text-sm font-medium underline underline-offset-2 focus-ring">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="text-center py-12 px-4 border border-dashed border-border rounded-md">
      <p className="font-display font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 text-sm text-slate max-w-sm mx-auto">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-panel border border-border rounded-md ${className}`}>{children}</div>;
}

export function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-slate font-medium">{label}</p>
      <p className="mt-1.5 text-2xl font-display font-semibold text-ink tabular-nums font-mono">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate">{sub}</p>}
    </Card>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const variants: Record<string, string> = {
    primary: "bg-signal text-white hover:bg-signal-dark disabled:opacity-50",
    secondary: "bg-white border border-border text-ink hover:bg-slate-soft disabled:opacity-50",
    danger: "bg-risk text-white hover:opacity-90 disabled:opacity-50",
    ghost: "text-slate hover:text-ink hover:bg-slate-soft",
  };
  return (
    <button
      className={`focus-ring inline-flex items-center justify-center gap-1.5 rounded-sm px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
