"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth, ApiError } from "@/lib/auth";
import { Button } from "@/components/ui";

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't sign in. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-display font-semibold text-lg text-ink">Lead Intelligence Platform</p>
          <p className="text-sm text-slate mt-1">Sign in to your workspace</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-panel border border-border rounded-md p-6 space-y-4">
          {error && <div className="rounded-sm bg-risk-soft text-risk text-sm px-3 py-2">{error}</div>}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
              autoComplete="email"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="text-center text-sm text-slate mt-4">
          No account?{" "}
          <Link href="/register" className="text-signal font-medium focus-ring">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
