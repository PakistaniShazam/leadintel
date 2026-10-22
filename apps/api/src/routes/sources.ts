import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { getOrgId } from "../lib/org.js";
import { writeAuditLog } from "../lib/audit.js";

const createSourceSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["API", "SITEMAP", "RSS", "STATIC_WEB", "BROWSER", "USER_IMPORT", "SEARCH_DISCOVERY"]),
  complianceMode: z.enum(["OFFICIAL_API", "PUBLIC_SITEMAP", "PUBLIC_RSS", "DIRECT_CRAWL_ROBOTS_RESPECTED", "USER_PROVIDED"]),
  baseUrl: z.string().url().optional(),
  rateLimitPerMin: z.number().min(1).default(30),
});

export async function sourceRoutes(app: FastifyInstance) {
  app.post("/sources", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createSourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const s = parsed.data;
    const orgId = await getOrgId(req);

    // Compliance guardrail (§40): direct-crawl sources require an explicit
    // acknowledgement in the request today (the FE would surface a robots.txt
    // check here in a fuller build) — refusing silent activation of the
    // highest-risk connector type.
    if (s.complianceMode === "DIRECT_CRAWL_ROBOTS_RESPECTED" && !s.baseUrl) {
      return reply.code(400).send({ error: "Direct-crawl sources require a baseUrl for robots.txt review" });
    }

    const result = await pool.query(
      `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url, rate_limit_per_min)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [orgId, s.name, s.type, s.complianceMode, s.baseUrl ?? null, s.rateLimitPerMin]
    );
    await writeAuditLog({
      organizationId: orgId,
      actorUserId: (req as any).user?.userId,
      action: "source_created",
      entityType: "source",
      entityId: result.rows[0].id,
      details: { name: s.name, type: s.type, complianceMode: s.complianceMode, baseUrl: s.baseUrl },
    });
    return reply.code(201).send({ source: result.rows[0] });
  });

  app.get("/sources", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query("SELECT * FROM sources WHERE organization_id = $1 ORDER BY created_at DESC", [orgId]);
    return reply.send({ data: result.rows });
  });

  app.get("/sources/:id/health", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const source = await pool.query("SELECT id FROM sources WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (source.rows.length === 0) return reply.code(404).send({ error: "Source not found" });

    const runs = await pool.query(
      `SELECT
         COUNT(*) AS total_runs,
         COALESCE(SUM(requests), 0) AS total_requests,
         COALESCE(SUM(successes), 0) AS total_successes,
         COALESCE(SUM(failures), 0) AS total_failures,
         COALESCE(SUM(leads_found), 0) AS total_leads,
         MAX(started_at) FILTER (WHERE failures = 0) AS last_success_at,
         MAX(started_at) FILTER (WHERE failures > 0) AS last_failure_at
       FROM source_runs WHERE source_id = $1`,
      [id]
    );
    const row = runs.rows[0];
    const successRate = row.total_requests > 0 ? row.total_successes / row.total_requests : null;
    return reply.send({
      sourceId: id,
      totalRuns: parseInt(row.total_runs, 10),
      successRate,
      leadsFound: parseInt(row.total_leads, 10),
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      status: successRate === null ? "unknown" : successRate > 0.7 ? "healthy" : successRate > 0.3 ? "degraded" : "needs_attention",
    });
  });
}
