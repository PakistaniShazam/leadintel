import { pool } from "../lib/db.js";
import { getAIProvider, withCostTracking, AIBudgetExceededError } from "../ai/factory.js";

/**
 * Architecture V2 §25: four scores, never collapsed.
 *   Lead Score        — permanent, cross-campaign usefulness
 *   Data Confidence    — accuracy of collected data
 *   Campaign Relevance — fit to a specific campaign (separate function below, per-lead-per-campaign)
 *   Source Confidence  — reliability of contributing source(s)
 *
 * All deterministic (no AI) — matches the Tier 1/2 classification in §23:
 * scoring from already-collected, already-classified data is a rules
 * operation, not a language-understanding one.
 */

export interface ScoreBreakdown {
  leadScore: number;
  dataConfidence: number;
  factors: Record<string, number>;
}

const TRACKED_FIELDS = ["company_name", "website", "country_code", "city", "industry_id"] as const;

export async function computeLeadScore(leadId: string): Promise<ScoreBreakdown> {
  const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1", [leadId]);
  if (leadResult.rows.length === 0) throw new Error("Lead not found");
  const lead = leadResult.rows[0];

  const emailsResult = await pool.query("SELECT count(*)::int AS c FROM lead_emails WHERE lead_id = $1", [leadId]);
  const contactsResult = await pool.query("SELECT count(*)::int AS c FROM lead_contacts WHERE lead_id = $1", [leadId]);
  const sourcesResult = await pool.query("SELECT count(*)::int AS c FROM lead_sources WHERE lead_id = $1", [leadId]);
  const provenanceResult = await pool.query(
    "SELECT AVG(confidence) AS avg_conf, COUNT(*) FILTER (WHERE confidence IS NOT NULL) AS n FROM lead_field_provenance WHERE lead_id = $1",
    [leadId]
  );

  const hasEmail = emailsResult.rows[0].c > 0;
  const hasContact = contactsResult.rows[0].c > 0;
  const sourceCount = sourcesResult.rows[0].c;
  const avgFieldConfidence = provenanceResult.rows[0].avg_conf !== null ? parseFloat(provenanceResult.rows[0].avg_conf) : null;

  const fieldsPresent = TRACKED_FIELDS.filter((f) => lead[f] !== null && lead[f] !== "").length;
  const completeness = fieldsPresent / TRACKED_FIELDS.length; // 0-1

  const contactAvailability = (hasEmail ? 0.6 : 0) + (hasContact ? 0.4 : 0); // 0-1

  const verificationBonus =
    lead.verification_status === "VERIFIED" ? 1 :
    lead.verification_status === "PARTIALLY_VERIFIED" ? 0.5 :
    lead.verification_status === "INVALID" ? -1 : 0; // -1..1

  // Multiple independent sources confirming the same lead is a real
  // strengthening signal (§12/§19's source-overlap intelligence) — capped
  // so a single source can't be the whole score, and floored at zero so a
  // lead with no sources at all (e.g. manual entry) isn't penalized.
  const sourceOverlapBonus = Math.max(0, Math.min(sourceCount - 1, 3)) * 0.05; // 0 for 0-1 sources, up to 0.15 for 4+

  const factors: Record<string, number> = {
    completeness: round2(completeness),
    contactAvailability: round2(contactAvailability),
    verificationBonus: round2(verificationBonus),
    sourceOverlapBonus: round2(sourceOverlapBonus),
  };

  const leadScoreRaw =
    factors.completeness * 30 +
    factors.contactAvailability * 30 +
    factors.verificationBonus * 25 +
    factors.sourceOverlapBonus * 100; // sourceOverlapBonus maxes at 0.15 -> contributes up to 15 pts
  const leadScore = clamp(Math.round(leadScoreRaw), 0, 100);

  const dataConfidenceRaw =
    (avgFieldConfidence ?? 0.5) * 0.6 +
    completeness * 0.2 +
    (lead.verification_status === "VERIFIED" ? 0.2 : lead.verification_status === "INVALID" ? -0.2 : 0);
  const dataConfidence = clamp(round2(dataConfidenceRaw), 0, 1);

  await pool.query(
    `UPDATE leads SET lead_score = $1, data_confidence = $2, updated_at = now() WHERE id = $3`,
    [leadScore, dataConfidence, leadId]
  );
  await pool.query(
    `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'score_change', $2)`,
    [leadId, JSON.stringify({ leadScore, dataConfidence, factors })]
  );

  return { leadScore, dataConfidence, factors };
}

/**
 * Source Confidence — computed on demand for a source (not stored on the
 * lead, since a lead can have multiple sources). Backed by real
 * source_runs stats where they exist; falls back to a compliance-mode-based
 * prior when a source has no run history yet (Phase 3/4 has no
 * source_performance_history rows — that's Phase 6 — so this is
 * deliberately the simpler of the two, not a placeholder pretending to be
 * the full ranking system).
 */
export async function computeSourceConfidence(sourceId: string): Promise<number> {
  const source = await pool.query("SELECT compliance_mode FROM sources WHERE id = $1", [sourceId]);
  if (source.rows.length === 0) return 0.5;

  const runs = await pool.query(
    "SELECT COALESCE(SUM(successes),0) AS s, COALESCE(SUM(requests),0) AS r FROM source_runs WHERE source_id = $1",
    [sourceId]
  );
  const { s, r } = runs.rows[0];
  if (parseInt(r, 10) > 0) {
    return clamp(round2(parseInt(s, 10) / parseInt(r, 10)), 0, 1);
  }

  // No run history yet — prior based on compliance posture (official API/sitemap
  // sources are inherently more reliable than a direct crawl, per §8's ranking factors).
  const priorByMode: Record<string, number> = {
    OFFICIAL_API: 0.85,
    PUBLIC_SITEMAP: 0.75,
    PUBLIC_RSS: 0.7,
    USER_PROVIDED: 0.6,
    DIRECT_CRAWL_ROBOTS_RESPECTED: 0.5,
  };
  return priorByMode[source.rows[0].compliance_mode] ?? 0.5;
}

/**
 * Campaign Relevance — separate table (campaign_leads), never written back
 * to leads.lead_score (§10/§15/§25 of the architecture, verbatim requirement).
 * Uses cheap keyword matching first; escalates to AI only when the campaign
 * criteria are qualitative enough that keywords won't capture it — same
 * Tier 1→3 escalation pattern as classification.
 */
export async function computeCampaignRelevance(params: {
  campaignId: string;
  leadId: string;
  organizationId: string;
  maxDailySpendUsd: number;
}): Promise<{ score: number; signals: string[] }> {
  const { campaignId, leadId, organizationId, maxDailySpendUsd } = params;

  const campaignResult = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
  const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1", [leadId]);
  if (campaignResult.rows.length === 0 || leadResult.rows.length === 0) {
    throw new Error("Campaign or lead not found");
  }
  const campaign = campaignResult.rows[0];
  const lead = leadResult.rows[0];

  // Tier 1/2: deterministic country/required-field match — cheap, no AI.
  const signals: string[] = [];
  let ruleScore = 50; // neutral baseline

  if (campaign.include_countries.length > 0) {
    if (lead.country_code && campaign.include_countries.includes(lead.country_code)) {
      ruleScore += 20;
      signals.push(`country ${lead.country_code} matches campaign include list`);
    } else if (lead.country_code) {
      ruleScore -= 30;
      signals.push(`country ${lead.country_code} not in campaign include list`);
    }
  }
  if (campaign.exclude_countries.length > 0 && lead.country_code && campaign.exclude_countries.includes(lead.country_code)) {
    ruleScore -= 50;
    signals.push(`country ${lead.country_code} is explicitly excluded`);
  }

  if (campaign.required_fields.includes("email")) {
    const emails = await pool.query("SELECT count(*)::int AS c FROM lead_emails WHERE lead_id = $1", [leadId]);
    if (emails.rows[0].c > 0) {
      ruleScore += 15;
      signals.push("has required field: email");
    } else {
      ruleScore -= 25;
      signals.push("missing required field: email");
    }
  }

  const score = clamp(ruleScore, 0, 100);

  // Escalate to AI only when the deterministic rules didn't actually fire
  // (no country constraints, no required-field checks configured) — i.e.
  // exactly the "campaign criteria are qualitative" case from §15/§23 where
  // keyword/rule matching has nothing to go on. A campaign with real
  // country/field constraints never pays for an AI call here.
  let finalScore = score;
  let finalSignals = signals;
  if (signals.length === 0 && maxDailySpendUsd > 0) {
    try {
      const leadText = [lead.company_name, lead.description, lead.city, lead.country].filter(Boolean).join(". ");
      if (leadText.trim()) {
        const provider = getAIProvider();
        const relevance = await withCostTracking(organizationId, maxDailySpendUsd, campaignId, () =>
          provider.analyzeRelevance(leadText, campaign.name)
        );
        finalScore = clamp(Math.round((score + relevance.score) / 2), 0, 100);
        finalSignals = [...signals, ...relevance.signals, `ai-assisted (${provider.name})`];
      }
    } catch (err) {
      if (!(err instanceof AIBudgetExceededError)) throw err;
      finalSignals = [...signals, `ai relevance skipped: ${err.message}`];
    }
  }

  await pool.query(
    `INSERT INTO campaign_leads (campaign_id, lead_id, campaign_relevance, signals)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (campaign_id, lead_id) DO UPDATE SET campaign_relevance = $3, signals = $4`,
    [campaignId, leadId, finalScore, JSON.stringify(finalSignals)]
  );

  return { score: finalScore, signals: finalSignals };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
