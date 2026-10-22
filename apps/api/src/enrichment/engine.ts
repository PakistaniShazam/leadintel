import { pool } from "../lib/db.js";
import { parseBusinessPage } from "../connectors/sitemap.js";
import { flagForReview } from "../lib/reviewQueue.js";
import { writeAuditLog } from "../lib/audit.js";

/**
 * Enrichment Engine (§20) — for ONE lead, not a campaign-wide crawl. Only
 * attempts to fill fields that are currently missing; never overwrites a
 * field that already has a value (that's change detection's job, and it
 * flags for review rather than auto-applying — see changeDetection.ts).
 *
 * Phase 6 scope: re-fetches the lead's own website (the one source that's
 * unambiguously "about this lead" without needing a new discovery step).
 * Discovering additional *new* sources to enrich from is future work — this
 * is deliberately the narrower, safer version.
 */
export async function enrichLead(leadId: string): Promise<{ applied: string[]; flaggedForReview: string[] }> {
  const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1", [leadId]);
  if (leadResult.rows.length === 0) throw new Error("Lead not found");
  const lead = leadResult.rows[0];

  if (!lead.website) {
    return { applied: [], flaggedForReview: [] }; // nothing to fetch — nothing to do
  }

  const applied: string[] = [];
  const flaggedForReview: string[] = [];

  let raw: { url: string; fetchedAt: string; status: number; contentType: string | null; body: string };
  try {
    const res = await fetch(lead.website, { headers: { "User-Agent": "LeadIntelBot/0.1 (+compliant enrichment fetch)" } });
    raw = { url: lead.website, fetchedAt: new Date().toISOString(), status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
  } catch (err: any) {
    await pool.query(
      `INSERT INTO lead_enrichment_runs (lead_id, field, source, method, applied) VALUES ($1, 'website_fetch', $2, 'http_fetch', false)`,
      [leadId, lead.website]
    );
    return { applied: [], flaggedForReview: [] }; // network failure — not a data problem, don't flag the lead for it
  }

  const record = parseBusinessPage(raw);
  if (!record) {
    await pool.query(
      `INSERT INTO lead_enrichment_runs (lead_id, field, source, method, applied) VALUES ($1, 'website_fetch', $2, 'http_fetch', false)`,
      [leadId, lead.website]
    );
    return { applied: [], flaggedForReview: [] };
  }

  const emailsResult = await pool.query("SELECT count(*)::int AS c FROM lead_emails WHERE lead_id = $1", [leadId]);
  const hasEmail = emailsResult.rows[0].c > 0;

  if (!hasEmail && record.emails && record.emails.length > 0) {
    for (const email of record.emails) {
      await pool.query(
        `INSERT INTO lead_emails (lead_id, email, domain, source, confidence) VALUES ($1,$2,$3,'enrichment',$4)`,
        [leadId, email, email.split("@")[1] ?? null, record.fieldConfidence?.email ?? null]
      );
    }
    await pool.query(
      `INSERT INTO lead_enrichment_runs (lead_id, field, previous_value, new_value, source, method, confidence, applied)
       VALUES ($1, 'email', NULL, $2, $3, $4, $5, true)`,
      [leadId, record.emails.join(", "), lead.website, "http_fetch:" + record.extractionMethod, record.fieldConfidence?.email ?? null]
    );
    await writeAuditLog({
      organizationId: lead.organization_id,
      action: "enrichment_auto_apply",
      entityType: "lead",
      entityId: leadId,
      details: { field: "email", newValue: record.emails, source: lead.website },
    });
    applied.push("email");
  }

  if (!lead.city && record.addressText) {
    // Address text is unstructured — confident enough to record as an
    // enrichment attempt, not confident enough to blindly parse into
    // city/region/postal without NLP (Tier 3 AI territory, not this
    // phase's scope) — so it's recorded and flagged, not auto-applied.
    await pool.query(
      `INSERT INTO lead_enrichment_runs (lead_id, field, previous_value, new_value, source, method, confidence, applied)
       VALUES ($1, 'address', NULL, $2, $3, $4, $5, false)`,
      [leadId, record.addressText, lead.website, "http_fetch:" + record.extractionMethod, 0.4]
    );
    await flagForReview({
      leadId,
      reason: "enrichment_address_needs_parsing",
      priority: "LOW",
      details: { addressText: record.addressText },
    });
    flaggedForReview.push("address");
  }

  await pool.query(`UPDATE leads SET last_enriched = now(), updated_at = now() WHERE id = $1`, [leadId]);

  return { applied, flaggedForReview };
}
