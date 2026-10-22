import { pool } from "./db.js";
import { normalizeCompanyName, normalizeDomain } from "./normalize.js";
import { checkForDuplicates } from "./dedup.js";
import { flagForReview } from "./reviewQueue.js";
import { reconcileLeadWithRecord } from "./changeDetection.js";
import { writeAuditLog } from "./audit.js";
import type { PartialLeadRecord } from "../connectors/types.js";

export interface IngestResult {
  leadId: string;
  created: boolean;
  deduplicated: boolean;
  needsReview: boolean;
}

/**
 * Single entry point for turning a company name (+ optional fields) into a
 * stored lead, applying dedup (§19) before insert. Used by POST /leads
 * (manual/user-import path) and by extraction workers (connector path) so
 * dedup behavior can't drift between the two.
 */
export async function ingestLead(params: {
  organizationId: string;
  companyName: string;
  website?: string | null;
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
  sourceId?: string | null;
  sourceUrl?: string | null;
}): Promise<IngestResult> {
  const { organizationId, companyName, website, country, countryCode, city, sourceId, sourceUrl } = params;
  const normalizedName = normalizeCompanyName(companyName);
  const domain = website ? normalizeDomain(website) : null;

  const dupCheck = await checkForDuplicates(organizationId, companyName, website ?? null);

  let leadId: string;
  let created: boolean;

  if (dupCheck.isDuplicate) {
    const existing = dupCheck.candidates[0];
    await pool.query(`UPDATE leads SET last_discovered = now(), updated_at = now() WHERE id = $1`, [existing.leadId]);
    await pool.query(
      `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'duplicate_submission_merged', $2)`,
      [existing.leadId, JSON.stringify({ matchedOn: existing.matchReasons, similarity: existing.similarity, sourceId })]
    );
    // Auto-merge is an automated write that changes what a lead "is" without
    // a human confirming it — exactly the highest-risk category §39 calls
    // out for audit logging.
    await writeAuditLog({
      organizationId,
      action: "auto_merge_duplicate",
      entityType: "lead",
      entityId: existing.leadId,
      details: { incomingCompanyName: companyName, matchedOn: existing.matchReasons, similarity: existing.similarity, sourceId },
    });
    leadId = existing.leadId;
    created = false;
  } else {
    const result = await pool.query(
      `INSERT INTO leads (organization_id, company_name, normalized_name, website, domain, country, country_code, city)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [organizationId, companyName, normalizedName, website ?? null, domain, country ?? null, countryCode ?? null, city ?? null]
    );
    leadId = result.rows[0].id;
    created = true;
    await pool.query(
      `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'created', $2)`,
      [leadId, JSON.stringify({ source: sourceId ? "connector" : "manual_entry", sourceId })]
    );
    if (dupCheck.needsReview) {
      await pool.query(
        `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'possible_duplicate_flagged', $2)`,
        [leadId, JSON.stringify({ candidates: dupCheck.candidates.slice(0, 3) })]
      );
      await flagForReview({
        leadId,
        reason: "duplicate_candidate_ambiguous",
        priority: "HIGH", // §16: duplicate ambiguity is explicitly a HIGH-priority reason
        details: { candidates: dupCheck.candidates.slice(0, 3) },
      });
    }
  }

  // Record source attribution regardless of created/merged — this is what
  // makes source-overlap intelligence (§19/§12 of the architecture) work:
  // the same lead confirmed by multiple sources strengthens confidence
  // rather than producing duplicate rows.
  if (sourceId) {
    await pool.query(
      `INSERT INTO lead_sources (lead_id, source_id, source_url)
       VALUES ($1,$2,$3)
       ON CONFLICT (lead_id, source_id) DO UPDATE SET last_seen_at = now()`,
      [leadId, sourceId, sourceUrl ?? null]
    );
  }

  return { leadId, created, deduplicated: dupCheck.isDuplicate, needsReview: dupCheck.needsReview };
}

/**
 * Applies an extracted PartialLeadRecord (from a connector's parse() output)
 * to the ingestion pipeline, plus records field-level provenance (§17) for
 * every field the extraction actually populated — this is what backs the
 * "why does the system believe this" view.
 */
export async function ingestExtractedRecord(params: {
  organizationId: string;
  sourceId: string;
  record: PartialLeadRecord;
}): Promise<IngestResult | null> {
  const { organizationId, sourceId, record } = params;
  if (!record.companyName) return null; // nothing usable to key a lead on

  const result = await ingestLead({
    organizationId,
    companyName: record.companyName,
    website: record.website ?? null,
    sourceId,
    sourceUrl: record.sourceUrl,
  });

  const provenanceRows: { field: string; value: string; confidence: number | null }[] = [];
  if (record.companyName) provenanceRows.push({ field: "companyName", value: record.companyName, confidence: record.fieldConfidence?.companyName ?? null });
  if (record.website) provenanceRows.push({ field: "website", value: record.website, confidence: record.fieldConfidence?.website ?? null });
  for (const email of record.emails ?? []) provenanceRows.push({ field: "email", value: email, confidence: record.fieldConfidence?.email ?? null });
  for (const phone of record.phones ?? []) provenanceRows.push({ field: "phone", value: phone, confidence: record.fieldConfidence?.phone ?? null });

  for (const row of provenanceRows) {
    await pool.query(
      `INSERT INTO lead_field_provenance (lead_id, field, value, source_url, source_name, confidence, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [result.leadId, row.field, row.value, record.sourceUrl, sourceId, row.confidence, `extracted via ${record.extractionMethod}`]
    );
  }

  if (result.deduplicated) {
    // Re-discovery of an existing lead — compare against what's stored
    // rather than blindly re-inserting (§19/§22 change detection). Handles
    // its own (dedup-checked) email insertion, so skip the generic block below.
    await reconcileLeadWithRecord(result.leadId, record);
  } else {
    // Brand-new lead — nothing to reconcile against, just store what was found.
    for (const email of record.emails ?? []) {
      await pool.query(
        `INSERT INTO lead_emails (lead_id, email, domain, source, confidence)
         VALUES ($1,$2,$3,$4,$5)`,
        [result.leadId, email, email.split("@")[1] ?? null, sourceId, record.fieldConfidence?.email ?? null]
      );
    }
  }

  return result;
}
