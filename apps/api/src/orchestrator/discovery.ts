import { pool } from "../lib/db.js";
import { getAIProvider } from "../ai/factory.js";
import { withCostTracking, AIBudgetExceededError } from "../ai/factory.js";
import { enqueueExtractionFetch } from "../queues/index.js";
import { createConnectorForSource } from "../connectors/factory.js";

/**
 * Basic Discovery Orchestrator (Phase 3 scope, per Architecture V2 §6/§45's
 * MVP note: "simple version — AI strategy generation → query generation →
 * source discovery → basic quality scoring, no historical ranking yet").
 *
 * What this does NOT do yet (later phases, not stubbed-and-hidden — just
 * not built): rank sources against source_performance_history (no history
 * exists yet at this phase), evaluate/score discovered sources before use,
 * or run the full iterative discovery loop with mid-run re-prioritization.
 * Those need real campaign history to be meaningful and are Phase 6 work
 * per the original phase plan.
 */

export async function generateStrategyForCampaign(campaignId: string): Promise<{ strategy: unknown; costIncurred: boolean }> {
  const campaignResult = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
  if (campaignResult.rows.length === 0) throw new Error("Campaign not found");
  const campaign = campaignResult.rows[0];

  const provider = getAIProvider();
  const description = `Campaign "${campaign.name}". Include countries: ${campaign.include_countries.join(", ") || "any"}. ` +
    `Exclude countries: ${campaign.exclude_countries.join(", ") || "none"}. Required fields: ${campaign.required_fields.join(", ") || "none"}. ` +
    `Target leads: ${campaign.target_leads}.`;

  const strategy = await withCostTracking(
    campaign.organization_id,
    campaign.max_ai_cost_usd,
    campaignId,
    () => provider.generateSearchStrategy(description)
  );

  await pool.query(
    `UPDATE campaigns SET search_strategy = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(strategy), campaignId]
  );

  return { strategy, costIncurred: provider.name !== "mock" };
}

/**
 * Runs a campaign against ONE approved source — the building block both
 * runCampaignAgainstApprovedSources (below) and a scheduled run use. Kept
 * as its own exported function since it's also useful directly (e.g. a
 * manual "retry just this source" action).
 */
export async function runCampaignAgainstSource(campaignId: string, sourceId: string, campaignRunId?: string): Promise<{ campaignRunId: string; candidatesEnqueued: number }> {
  const campaignResult = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
  const sourceResult = await pool.query("SELECT * FROM sources WHERE id = $1", [sourceId]);
  if (campaignResult.rows.length === 0) throw new Error("Campaign not found");
  if (sourceResult.rows.length === 0) throw new Error("Source not found");
  const campaign = campaignResult.rows[0];
  const source = sourceResult.rows[0];

  const connector = createConnectorForSource({ type: source.type, baseUrl: source.base_url }); // throws for unimplemented types — surfaced to the caller, not swallowed

  const runId = campaignRunId ?? (await pool.query(
    `INSERT INTO campaign_runs (campaign_id, status) VALUES ($1, 'running') RETURNING id`,
    [campaignId]
  )).rows[0].id;

  let count = 0;
  const maxCandidates = Math.min(campaign.max_requests, 50); // hard local cap regardless of campaign config — safety net until the scheduler-level bound (§29) is wired

  for await (const candidate of connector.discover({})) {
    if (count >= maxCandidates) break;
    await enqueueExtractionFetch({
      organizationId: campaign.organization_id,
      sourceId,
      sourceType: source.type,
      sourceBaseUrl: source.base_url,
      url: candidate.url,
      campaignId,
      campaignRunId: runId,
    });
    count++;
  }

  await pool.query(`UPDATE campaign_runs SET discovered = discovered + $1 WHERE id = $2`, [count, runId]);

  return { campaignRunId: runId, candidatesEnqueued: count };
}

/**
 * Runs a campaign against its full approved source pool (§5/§6's "Approved
 * Source Pool" stage) — one campaign_run row covers all sources, with
 * per-source enqueue counts summed into it. A source whose connector type
 * isn't implemented yet is skipped with an error recorded on the run
 * rather than failing the whole campaign run.
 */
export async function runCampaignAgainstApprovedSources(campaignId: string): Promise<{ campaignRunId: string; totalCandidatesEnqueued: number; perSource: Record<string, number | string> }> {
  const campaignResult = await pool.query("SELECT organization_id FROM campaigns WHERE id = $1", [campaignId]);
  if (campaignResult.rows.length === 0) throw new Error("Campaign not found");

  const approvedSources = await pool.query(
    `SELECT source_id FROM campaign_sources WHERE campaign_id = $1 ORDER BY priority DESC, approved_at ASC`,
    [campaignId]
  );
  if (approvedSources.rows.length === 0) {
    throw new Error("Campaign has no approved sources — attach one via POST /campaigns/:id/sources first");
  }

  const runResult = await pool.query(
    `INSERT INTO campaign_runs (campaign_id, status) VALUES ($1, 'running') RETURNING id`,
    [campaignId]
  );
  const campaignRunId = runResult.rows[0].id;

  let total = 0;
  const perSource: Record<string, number | string> = {};

  for (const row of approvedSources.rows) {
    try {
      const result = await runCampaignAgainstSource(campaignId, row.source_id, campaignRunId);
      perSource[row.source_id] = result.candidatesEnqueued;
      total += result.candidatesEnqueued;
    } catch (err: any) {
      perSource[row.source_id] = `error: ${err.message}`;
      await pool.query(`UPDATE campaign_runs SET errors = errors + 1 WHERE id = $1`, [campaignRunId]);
    }
  }

  await pool.query(`UPDATE campaign_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [campaignRunId]);

  return { campaignRunId, totalCandidatesEnqueued: total, perSource };
}

export { AIBudgetExceededError };
