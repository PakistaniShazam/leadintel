import { pool } from "../lib/db.js";
import { getAIProvider, withCostTracking } from "./factory.js";
import { flagForReview } from "../lib/reviewQueue.js";

/**
 * Tier 3 AI classification (Architecture V2 §23/§24) — only called when
 * deterministic extraction left the field empty. Callers (the extraction
 * worker) are responsible for checking that first; this module doesn't
 * re-check, to keep it a pure "classify this text" utility.
 */

export async function classifyLeadIndustry(params: {
  leadId: string;
  organizationId: string;
  campaignId: string | null;
  maxDailySpendUsd: number;
  text: string; // company name + description + any extracted text to classify from
}): Promise<{ industryId: string | null; confidence: number } | null> {
  const { leadId, organizationId, campaignId, maxDailySpendUsd, text } = params;

  const industries = await pool.query("SELECT id, name FROM industries ORDER BY name");
  if (industries.rows.length === 0) return null; // nothing to classify against — taxonomy not seeded yet

  const provider = getAIProvider();
  const options = industries.rows.map((r) => r.name);

  const classification = await withCostTracking(organizationId, maxDailySpendUsd, campaignId, () =>
    provider.classifyIndustry(text, options)
  );

  const matched = industries.rows.find((r) => r.name.toLowerCase() === classification.value.toLowerCase());

  await pool.query(
    `INSERT INTO ai_classifications (lead_id, field, value, confidence, reasoning, model_version)
     VALUES ($1, 'industry', $2, $3, $4, $5)`,
    [leadId, classification.value, classification.confidence, classification.reasoning, provider.model]
  );

  if (matched) {
    await pool.query(`UPDATE leads SET industry_id = $1, updated_at = now() WHERE id = $2`, [matched.id, leadId]);
    await pool.query(
      `INSERT INTO lead_field_provenance (lead_id, field, value, confidence, evidence, source_name)
       VALUES ($1, 'industry', $2, $3, $4, $5)`,
      [leadId, matched.name, classification.confidence, classification.reasoning, `ai:${provider.name}`]
    );
    return { industryId: matched.id, confidence: classification.confidence };
  }

  // AI returned a value that doesn't match the taxonomy exactly — don't
  // force a wrong mapping. This is exactly the kind of thing that should
  // land in the review queue rather than being silently dropped or forced
  // onto the nearest taxonomy entry.
  await pool.query(
    `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'classification_unmapped', $2)`,
    [leadId, JSON.stringify({ field: "industry", aiValue: classification.value, taxonomyOptions: options })]
  );
  await flagForReview({
    leadId,
    reason: "classification_unmapped",
    priority: "MEDIUM",
    details: { field: "industry", aiValue: classification.value, taxonomyOptions: options },
  });
  return { industryId: null, confidence: classification.confidence };
}

export async function classifyLeadCountry(params: {
  leadId: string;
  organizationId: string;
  campaignId: string | null;
  maxDailySpendUsd: number;
  signals: string; // address text, phone, domain TLD, page content excerpt
}): Promise<{ countryCode: string; confidence: number } | null> {
  const { leadId, organizationId, campaignId, maxDailySpendUsd, signals } = params;
  if (!signals.trim()) return null;

  const provider = getAIProvider();
  const detection = await withCostTracking(organizationId, maxDailySpendUsd, campaignId, () =>
    provider.detectCountry(signals)
  );

  await pool.query(
    `INSERT INTO ai_classifications (lead_id, field, value, confidence, reasoning, model_version)
     VALUES ($1, 'country', $2, $3, $4, $5)`,
    [leadId, detection.countryCode, detection.confidence, detection.evidence, provider.model]
  );

  // Low-confidence detections update the field but get flagged rather than
  // silently trusted — matches §8's "if signals conflict, mark uncertain"
  // and §29's review-queue-priority criteria (country conflict = HIGH).
  await pool.query(
    `UPDATE leads SET country = $1, country_code = $2, updated_at = now() WHERE id = $3`,
    [detection.country, detection.countryCode, leadId]
  );
  await pool.query(
    `INSERT INTO lead_field_provenance (lead_id, field, value, confidence, evidence, source_name)
     VALUES ($1, 'country', $2, $3, $4, $5)`,
    [leadId, detection.countryCode, detection.confidence, detection.evidence, `ai:${provider.name}`]
  );

  if (detection.confidence < 0.6) {
    await pool.query(
      `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'low_confidence_country_flagged', $2)`,
      [leadId, JSON.stringify({ countryCode: detection.countryCode, confidence: detection.confidence })]
    );
    await flagForReview({
      leadId,
      reason: "low_confidence_country",
      priority: "HIGH", // §16: country conflict/uncertainty is explicitly HIGH priority
      details: { countryCode: detection.countryCode, confidence: detection.confidence, evidence: detection.evidence },
    });
  }

  return { countryCode: detection.countryCode, confidence: detection.confidence };
}
