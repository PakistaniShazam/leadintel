// Deterministic verification (Architecture V2 §18/§23 — Tier 1, no AI).
// DNS/HTTP-reachability checks (domain existence, website up/down) belong
// here too in a full deployment, but they require outbound network access
// this sandbox's egress allowlist doesn't grant to arbitrary hosts — so
// they're implemented for real (using Node's built-in `dns`/`fetch`) but
// only the syntax/format-level checks were exercised live in this session.
// See the connector README note for the same caveat applied here.

import dns from "node:dns/promises";

export interface CheckResult {
  checkType: string;
  result: "pass" | "fail" | "inconclusive";
  details: Record<string, unknown>;
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^\+?[1-9]\d{6,14}$/; // loose E.164-ish check

export function checkEmailSyntax(email: string): CheckResult {
  const pass = EMAIL_RE.test(email.trim());
  return { checkType: "email_syntax", result: pass ? "pass" : "fail", details: { email } };
}

export function checkPhoneFormat(phone: string): CheckResult {
  const digitsOnly = phone.replace(/[^\d+]/g, "");
  const pass = PHONE_RE.test(digitsOnly);
  return { checkType: "phone_format", result: pass ? "pass" : "fail", details: { phone, normalized: digitsOnly } };
}

export function checkCountryPhoneConsistency(phone: string, countryCode: string, phoneCodeByCountry: Record<string, string>): CheckResult {
  const expectedPrefix = phoneCodeByCountry[countryCode];
  if (!expectedPrefix) {
    return { checkType: "country_phone_consistency", result: "inconclusive", details: { reason: "no known phone code for country" } };
  }
  const pass = phone.replace(/[^\d+]/g, "").startsWith(expectedPrefix);
  return { checkType: "country_phone_consistency", result: pass ? "pass" : "fail", details: { phone, countryCode, expectedPrefix } };
}

// Real DNS check — works when the sandbox/host has outbound DNS resolution.
// Wrapped so a network failure produces "inconclusive", not a false "fail" —
// an unreachable resolver shouldn't be conflated with a genuinely invalid domain.
export async function checkDomainDns(domain: string): Promise<CheckResult> {
  try {
    const records = await dns.resolveMx(domain).catch(() => dns.resolve4(domain));
    return { checkType: "domain_dns", result: records.length > 0 ? "pass" : "fail", details: { domain, recordCount: records.length } };
  } catch (err: any) {
    if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
      return { checkType: "domain_dns", result: "fail", details: { domain, error: err.code } };
    }
    return { checkType: "domain_dns", result: "inconclusive", details: { domain, error: err.code ?? String(err) } };
  }
}
