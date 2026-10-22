import { pool } from "../lib/db.js";
import { computeSourceConfidence } from "../scoring/engine.js";

/**
 * Source Ranking (§8/§27) — "gradually prioritize sources that historically
 * perform well," implemented as transparent statistics over real
 * source_runs data (via computeSourceConfidence), not ML. Writes the
 * resulting order into campaign_sources.priority so the next
 * runCampaignAgainstApprovedSources call (which orders by priority DESC)
 * actually uses the ranking — this is the "campaigns prioritize
 * historically-better sources" requirement made real, not just computed
 * and displayed.
 */
export async function rankSourcesForCampaign(campaignId: string): Promise<{ sourceId: string; confidence: number; priority: number }[]> {
  const sources = await pool.query("SELECT source_id FROM campaign_sources WHERE campaign_id = $1", [campaignId]);
  if (sources.rows.length === 0) return [];

  const scored = await Promise.all(
    sources.rows.map(async (row: { source_id: string }) => ({
      sourceId: row.source_id,
      confidence: await computeSourceConfidence(row.source_id),
    }))
  );

  scored.sort((a: { confidence: number }, b: { confidence: number }) => b.confidence - a.confidence);

  const results: { sourceId: string; confidence: number; priority: number }[] = [];
  for (let idx = 0; idx < scored.length; idx++) {
    const priority = scored.length - idx; // highest confidence -> highest priority number -> runs first
    await pool.query(`UPDATE campaign_sources SET priority = $1 WHERE campaign_id = $2 AND source_id = $3`, [priority, campaignId, scored[idx].sourceId]);
    results.push({ ...scored[idx], priority });
  }

  return results;
}
