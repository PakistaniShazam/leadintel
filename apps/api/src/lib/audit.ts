import { pool } from "./db.js";

/**
 * Audit logging (§39) — specifically for the highest-risk automated writes:
 * dedup auto-merges (two records treated as one company without a human
 * confirming it) and enrichment auto-applies (a field gets a new value
 * without a human reviewing it first). Both mutate data based on a
 * heuristic, not a human decision — exactly what audit trails are for.
 * Also covers explicit admin-type actions (source registration, campaign
 * approval) since those change what the system is allowed to do.
 */
export async function writeAuditLog(params: {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      params.organizationId,
      params.actorUserId ?? null,
      params.action,
      params.entityType,
      params.entityId,
      params.details ? JSON.stringify(params.details) : null,
    ]
  );
}
