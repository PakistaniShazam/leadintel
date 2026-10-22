"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth, ApiError } from "@/lib/auth";
import { Button } from "@/components/ui";

export default function RegisterPage() {
  const { register } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", password: "", organizationName: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(form);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create your account. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-paper flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-display font-semibold text-lg text-ink">Lead Intelligence Platform</p>
          <p className="text-sm text-slate mt-1">Create your workspace</p>
        </div>
        <form onSubmit={handleSubmit} className="bg-panel border border-border rounded-md p-6 space-y-4">
          {error && <div className="rounded-sm bg-risk-soft text-risk text-sm px-3 py-2">{error}</div>}
          <div>
            <label htmlFor="organizationName" className="block text-sm font-medium text-ink mb-1">
              Organization name
            </label>
            <input
              id="organizationName"
              required
              value={form.organizationName}
              onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
              className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-ink mb-1">
              Your name
            </label>
            <input
              id="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
              autoComplete="name"
            />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
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
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="focus-ring w-full rounded-sm border border-border px-3 py-2 text-sm"
              autoComplete="new-password"
            />
            <p className="text-xs text-slate mt-1">At least 8 characters.</p>
          </div>
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Creating your workspace…" : "Create workspace"}
          </Button>
        </form>
        <p className="text-center text-sm text-slate mt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-signal font-medium focus-ring">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
