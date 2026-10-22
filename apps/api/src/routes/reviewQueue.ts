import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { getOrgId } from "../lib/org.js";
import { resolveFlag } from "../lib/reviewQueue.js";

const listQuerySchema = z.object({
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).default("OPEN"),
  reason: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export async function reviewQueueRoutes(app: FastifyInstance) {
  app.get("/review-queue", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;
    const orgId = await getOrgId(req);

    const conditions = ["l.organization_id = $1", "rf.status = $2"];
    const params: any[] = [orgId, q.status];
    let i = 3;
    if (q.priority) {
      conditions.push(`rf.priority = $${i++}`);
      params.push(q.priority);
    }
    if (q.reason) {
      conditions.push(`rf.reason = $${i++}`);
      params.push(q.reason);
    }
    const where = conditions.join(" AND ");
    const offset = (q.page - 1) * q.pageSize;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM review_flags rf JOIN leads l ON l.id = rf.lead_id WHERE ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // HIGH first, then MEDIUM, then LOW, newest-within-priority first —
    // exactly the §16 "prioritized" requirement, not just a flat list.
    const dataResult = await pool.query(
      `SELECT rf.id, rf.reason, rf.priority, rf.status, rf.details, rf.created_at,
              l.id AS lead_id, l.company_name, l.website, l.country_code, l.lead_score, l.verification_status
       FROM review_flags rf JOIN leads l ON l.id = rf.lead_id
       WHERE ${where}
       ORDER BY CASE rf.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, rf.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, q.pageSize, offset]
    );

    return reply.send({
      data: dataResult.rows,
      pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) },
    });
  });

  // Counts by priority — cheap summary for a dashboard badge, avoids the
  // frontend running three separate filtered list queries just to show counts.
  app.get("/review-queue/summary", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT rf.priority, COUNT(*)::int AS count
       FROM review_flags rf JOIN leads l ON l.id = rf.lead_id
       WHERE l.organization_id = $1 AND rf.status = 'OPEN'
       GROUP BY rf.priority`,
      [orgId]
    );
    const summary = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const row of result.rows) summary[row.priority as keyof typeof summary] = row.count;
    return reply.send(summary);
  });

  const resolveSchema = z.object({
    resolution: z.enum(["approved", "rejected", "corrected"]),
    note: z.string().optional(),
  });
  app.post("/review-queue/:id/resolve", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const orgId = await getOrgId(req);
    const { userId } = (req as any).user;

    const flag = await pool.query(
      `SELECT rf.id FROM review_flags rf JOIN leads l ON l.id = rf.lead_id WHERE rf.id = $1 AND l.organization_id = $2`,
      [id, orgId]
    );
    if (flag.rows.length === 0) return reply.code(404).send({ error: "Review flag not found" });

    await resolveFlag({ flagId: id, resolvedBy: userId, resolution: parsed.data.resolution, note: parsed.data.note });
    return reply.send({ resolved: true });
  });
}
