import type { FastifyRequest } from "fastify";
import { pool } from "./db.js";

// Resolves the org for the authenticated user. Phase 1 assumes one org per
// user (the one created at registration); multi-org switching is a
// straightforward extension (add an X-Organization-Id header + membership
// check) once a user can belong to more than one org's UI needs it.
export async function getOrgId(req: FastifyRequest): Promise<string> {
  const { userId } = (req as any).user;
  const result = await pool.query(
    "SELECT organization_id FROM memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
    [userId]
  );
  if (result.rows.length === 0) {
    throw new Error("User has no organization membership");
  }
  return result.rows[0].organization_id;
}
