"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { LoadingState } from "./ui";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/leads", label: "Leads" },
  { href: "/review-queue", label: "Review Queue" },
  { href: "/sources", label: "Sources" },
  { href: "/analytics", label: "Analytics" },
  { href: "/system", label: "System Health" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper">
        <LoadingState label="Loading your workspace…" />
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="min-h-screen bg-paper flex flex-col md:flex-row">
      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-panel">
        <span className="font-display font-semibold text-ink">Lead Intelligence</span>
        <button onClick={logout} className="text-sm text-slate focus-ring">
          Sign out
        </button>
      </div>

      <aside className="hidden md:flex md:w-56 md:flex-col border-r border-border bg-panel shrink-0">
        <div className="px-5 py-5 border-b border-border">
          <p className="font-display font-semibold text-ink text-[15px] leading-tight">Lead Intelligence</p>
          <p className="text-xs text-slate mt-0.5 truncate">{user.organization_name ?? "Workspace"}</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname?.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`focus-ring block rounded-sm px-3 py-2 text-sm font-medium transition-colors ${
                  active ? "bg-signal-soft text-signal" : "text-slate hover:bg-slate-soft hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-3 py-4 border-t border-border">
          <p className="px-2 text-xs text-slate truncate">{user.email}</p>
          <button onClick={logout} className="focus-ring mt-1 w-full text-left px-2 py-1.5 text-sm text-slate hover:text-ink rounded-sm">
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-panel border-t border-border flex overflow-x-auto">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`focus-ring flex-1 min-w-[72px] text-center py-2.5 text-[11px] font-medium ${active ? "text-signal" : "text-slate"}`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-6 pb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border bg-paper">
      <div>
        <h1 className="font-display font-semibold text-xl text-ink">{title}</h1>
        {description && <p className="text-sm text-slate mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
