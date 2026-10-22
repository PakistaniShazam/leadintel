import { Worker } from "bullmq";
import { connection, type ExtractionFetchJobData, enqueueVerification } from "../queues/index.js";
import { createConnectorForSource } from "../connectors/factory.js";
import { ingestExtractedRecord } from "../lib/ingestion.js";
import { pool } from "../lib/db.js";
import { classifyLeadIndustry, classifyLeadCountry } from "../ai/classification.js";
import { AIBudgetExceededError } from "../ai/factory.js";
import { computeCampaignRelevance } from "../scoring/engine.js";
import { flagForReview } from "../lib/reviewQueue.js";

export function startExtractionWorker(): Worker {
  return new Worker<ExtractionFetchJobData>(
    "extraction.fetch",
    async (job) => {
      const { organizationId, sourceId, sourceType, sourceBaseUrl, url, campaignId } = job.data;

      const connector = createConnectorForSource({ type: sourceType, baseUrl: sourceBaseUrl });
      const raw = await connector.fetch(url);
      const record = await connector.parse(raw);

      if (!record) {
        await pool.query(
          `INSERT INTO source_runs (source_id, requests, successes, failures, leads_found, error_summary)
           VALUES ($1, 1, 0, 1, 0, 'no extractable record')`,
          [sourceId]
        );
        return { extracted: false };
      }

      const result = await ingestExtractedRecord({ organizationId, sourceId, record });
      if (!result) return { extracted: false };

      await pool.query(
        `INSERT INTO source_runs (source_id, requests, successes, failures, leads_found)
         VALUES ($1, 1, 1, 0, $2)`,
        [sourceId, result.created ? 1 : 0]
      );

      // Tier 3 AI fallback (§23/§24): only for a lead newly created in this run,
      // only for fields deterministic parsing left empty, and only when a
      // campaign context supplies a spend cap to check against — a lead
      // ingested with no campaign (e.g. manual entry) doesn't have a
      // max_ai_cost_usd to enforce, so it's left for a human/Phase 6 review
      // path rather than silently using an unbounded default.
      if (result.created && campaignId) {
        const campaignResult = await pool.query("SELECT max_ai_cost_usd FROM campaigns WHERE id = $1", [campaignId]);
        const maxDailySpendUsd = campaignResult.rows[0]?.max_ai_cost_usd ?? 0;

        const lead = await pool.query("SELECT industry_id, country_code, description, company_name FROM leads WHERE id = $1", [result.leadId]);
        const leadRow = lead.rows[0];

        try {
          if (!leadRow.industry_id) {
            const classifyText = [leadRow.company_name, leadRow.description, record.description].filter(Boolean).join(". ");
            if (classifyText.trim()) {
              await classifyLeadIndustry({ leadId: result.leadId, organizationId, campaignId, maxDailySpendUsd, text: classifyText });
            }
          }
          if (!leadRow.country_code) {
            const signalsText = [record.addressText, record.website, ...(record.phones ?? [])].filter(Boolean).join(". ");
            if (signalsText.trim()) {
              await classifyLeadCountry({ leadId: result.leadId, organizationId, campaignId, maxDailySpendUsd, signals: signalsText });
            }
          }
        } catch (err) {
          if (err instanceof AIBudgetExceededError) {
            // Not a job failure — the extraction itself succeeded. Record it
            // and move on; the lead just doesn't get AI classification until
            // budget resets or a human reviews it (§29's review-queue path).
            await pool.query(
              `INSERT INTO lead_history_events (lead_id, event_type, new_value) VALUES ($1, 'ai_classification_skipped_budget', $2)`,
              [result.leadId, JSON.stringify({ reason: err.message })]
            );
            await flagForReview({
              leadId: result.leadId,
              reason: "ai_classification_skipped_budget",
              priority: "LOW", // §16: low-impact — the lead is still usable, just unclassified until budget resets
              details: { reason: err.message },
            });
          } else {
            throw err;
          }
        }
      }

      // Chain into verification — this is the queue-to-queue handoff the
      // architecture's pipeline diagram (§9/§50) describes.
      await enqueueVerification({ leadId: result.leadId });

      // Campaign Relevance (§15/§25) — per (lead, campaign), never written
      // back onto the permanent lead_score. Computed regardless of
      // created/deduplicated, since a re-discovered lead is still relevant
      // (or not) to this campaign even if it wasn't a new row.
      if (campaignId) {
        const campaignResult = await pool.query("SELECT max_ai_cost_usd FROM campaigns WHERE id = $1", [campaignId]);
        const maxDailySpendUsd = campaignResult.rows[0]?.max_ai_cost_usd ?? 0;
        await computeCampaignRelevance({ campaignId, leadId: result.leadId, organizationId, maxDailySpendUsd });
      }

      return { extracted: true, leadId: result.leadId, created: result.created, deduplicated: result.deduplicated };
    },
    { connection, concurrency: 3 } // matches the sitemap connector's conservative rateLimit
  );
}
