import { pool } from "./db.js";

export type ReviewPriority = "HIGH" | "MEDIUM" | "LOW";

/**
 * Review Queue (§16/§29) — a single entry point for flagging a lead as
 * needing human attention, called from the exact points in the pipeline
 * that already detect the condition (dedup ambiguity, low-confidence
 * classification, unmapped taxonomy value, budget-skipped classification,
 * a changed field on re-discovery) rather than inferred later by scanning
 * history events.
 */
export async function flagForReview(params: {
  leadId: string;
  reason: string;
  priority: ReviewPriority;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO review_flags (lead_id, reason, priority, details) VALUES ($1,$2,$3,$4)`,
    [params.leadId, params.reason, params.priority, params.details ? JSON.stringify(params.details) : null]
  );
}

export async function resolveFlag(params: {
  flagId: string;
  resolvedBy: string;
  resolution: "approved" | "rejected" | "corrected";
  note?: string;
}): Promise<void> {
  await pool.query(
    `UPDATE review_flags SET status = 'RESOLVED', resolved_at = now(), resolved_by = $1,
       resolution = $2 WHERE id = $3`,
    [params.resolvedBy, params.note ? `${params.resolution}: ${params.note}` : params.resolution, params.flagId]
  );
}
