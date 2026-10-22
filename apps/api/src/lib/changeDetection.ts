import { pool } from "./db.js";
import { normalizeDomain } from "./normalize.js";
import { flagForReview } from "./reviewQueue.js";
import type { PartialLeadRecord } from "../connectors/types.js";

/**
 * Change Detection (§19/§22) — runs when a re-discovery matches an existing
 * lead (the dedup merge path), comparing the freshly-extracted record
 * against what's currently stored. Two different behaviors depending on
 * what kind of difference is found, matching the "don't silently overwrite"
 * requirement:
 *
 *   - A field that was EMPTY and is now populated -> filled in directly
 *     (this is enrichment, not really a "change" — there's nothing to lose).
 *   - A field that had a DIFFERENT value already -> logged as a
 *     lead_change_events row and flagged for review, but NOT auto-applied.
 *     A website/company-name/email change could mean the business
 *     rebranded, or it could mean the dedup match was wrong — a human
 *     should decide, not a heuristic.
 */
export async function reconcileLeadWithRecord(leadId: string, record: PartialLeadRecord): Promise<void> {
  const leadResult = await pool.query("SELECT company_name, website, domain FROM leads WHERE id = $1", [leadId]);
  if (leadResult.rows.length === 0) return;
  const lead = leadResult.rows[0];

  // Website / domain
  if (record.website) {
    const incomingDomain = normalizeDomain(record.website);
    if (!lead.website) {
      await pool.query(`UPDATE leads SET website = $1, domain = $2, updated_at = now() WHERE id = $3`, [record.website, incomingDomain, leadId]);
      await logHistory(leadId, "field_filled", { field: "website", value: record.website });
    } else if (incomingDomain && incomingDomain !== lead.domain) {
      await recordChange(leadId, "website", lead.website, record.website);
      await flagForReview({
        leadId,
        reason: "website_domain_changed",
        priority: "MEDIUM", // §16: moderate confidence / minor-vs-major is context dependent; a domain change is notable but not as urgent as a country conflict
        details: { oldDomain: lead.domain, newDomain: incomingDomain, oldWebsite: lead.website, newWebsite: record.website },
      });
    }
  }

  // Company name (rebrand vs. bad dedup match — either way, don't silently rename)
  if (record.companyName && record.companyName !== lead.company_name) {
    await recordChange(leadId, "company_name", lead.company_name, record.companyName);
    await flagForReview({
      leadId,
      reason: "company_name_changed",
      priority: "LOW",
      details: { oldValue: lead.company_name, newValue: record.companyName },
    });
  }

  // Emails — additive only. A newly-seen email isn't a "change" to an
  // existing value (nothing is being overwritten), so no review flag; but
  // it IS worth a lightweight history record since it affects contact
  // availability (feeds into Lead Score on the next rescore).
  if (record.emails && record.emails.length > 0) {
    const existing = await pool.query("SELECT email FROM lead_emails WHERE lead_id = $1", [leadId]);
    const existingSet = new Set(existing.rows.map((r: { email: string }) => r.email.toLowerCase()));
    const newEmails = record.emails.filter((e) => !existingSet.has(e.toLowerCase()));
    for (const email of newEmails) {
      await pool.query(
        `INSERT INTO lead_emails (lead_id, email, domain, confidence) VALUES ($1,$2,$3,$4)`,
        [leadId, email, email.split("@")[1] ?? null, record.fieldConfidence?.email ?? null]
      );
    }
    if (newEmails.length > 0) {
      await logHistory(leadId, "new_emails_discovered", { emails: newEmails });
    }
  }
}

async function recordChange(leadId: string, field: string, oldValue: string | null, newValue: string): Promise<void> {
  await pool.query(
    `INSERT INTO lead_change_events (lead_id, field, old_value, new_value) VALUES ($1,$2,$3,$4)`,
    [leadId, field, oldValue, newValue]
  );
  await pool.query(`UPDATE leads SET last_meaningful_change = now(), updated_at = now() WHERE id = $1`, [leadId]);
}

async function logHistory(leadId: string, eventType: string, value: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1,$2,$3)`,
    [leadId, eventType, JSON.stringify(value)]
  );
}
