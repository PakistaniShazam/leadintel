import { pool } from "../lib/db.js";
import { createAnthropicProvider } from "./anthropicProvider.js";
import { createMockProvider } from "./mockProvider.js";
import type { AIProvider, AIUsageRecord } from "./types.js";

export function getAIProvider(): AIProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return createAnthropicProvider(apiKey);
  // No key configured — fall back to the mock provider rather than throwing,
  // so the rest of the pipeline (queues, ingestion, scoring plumbing) stays
  // exercisable without live AI spend. Every real deployment should set
  // ANTHROPIC_API_KEY; this is a development/testing fallback, not a
  // silent production behavior — callers can check provider.name === "mock".
  return createMockProvider();
}

/**
 * Wraps a provider call with cost logging (writes to ai_usage) and enforces
 * the daily spend cap (Architecture V2 §24/§31): checks cumulative spend
 * for the organization today before making a Tier 3/4 call, and refuses if
 * the cap set on ai_usage would be exceeded. Tier 1/2 (deterministic/rules)
 * never go through here at all — only AI-tier calls have a cost to cap.
 */
export async function withCostTracking<T>(
  organizationId: string,
  maxDailySpendUsd: number,
  campaignId: string | null,
  call: () => Promise<{ result: T; usage: AIUsageRecord }>
): Promise<T> {
  const spentToday = await getTodaySpend(organizationId);
  if (spentToday >= maxDailySpendUsd) {
    throw new AIBudgetExceededError(organizationId, spentToday, maxDailySpendUsd);
  }

  const { result, usage } = await call();

  await pool.query(
    `INSERT INTO ai_usage (operation, tier, provider, model, tokens_in, tokens_out, estimated_cost_usd, campaign_id, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [usage.operation, usage.tier, "n/a", "n/a", usage.tokensIn, usage.tokensOut, usage.estimatedCostUsd, campaignId, organizationId]
  );

  return result;
}

export class AIBudgetExceededError extends Error {
  constructor(public organizationId: string, public spentToday: number, public cap: number) {
    super(`AI daily spend cap reached for organization ${organizationId}: $${spentToday.toFixed(4)} spent of $${cap.toFixed(2)} cap`);
    this.name = "AIBudgetExceededError";
  }
}

async function getTodaySpend(organizationId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM ai_usage
     WHERE organization_id = $1 AND created_at >= date_trunc('day', now())`,
    [organizationId]
  );
  return parseFloat(result.rows[0].total);
}
