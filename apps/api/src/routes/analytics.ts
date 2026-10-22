import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { getOrgId } from "../lib/org.js";

/**
 * Architecture V2 §33/§37/§38 — dashboard metrics, geo/industry/source
 * analytics, AI cost reporting. All real aggregation over the tables every
 * prior phase has been writing to — no separate "analytics" data store,
 * since at this scale (and honestly, well past it) a materialized/cached
 * layer would be premature optimization, not architecture.
 */
export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/dashboard", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);

    const [totals, campaigns, jobs, countries, industries] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total_leads,
           COUNT(*) FILTER (WHERE first_discovered >= date_trunc('day', now()))::int AS new_today,
           COUNT(*) FILTER (WHERE first_discovered >= now() - interval '7 days')::int AS new_this_week,
           COUNT(*) FILTER (WHERE verification_status = 'VERIFIED')::int AS verified_leads,
           COUNT(*) FILTER (WHERE lead_score >= 80)::int AS high_quality_leads
         FROM leads WHERE organization_id = $1`,
        [orgId]
      ),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_campaigns FROM campaigns WHERE organization_id = $1`, [orgId]),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE cr.status = 'running')::int AS running_jobs,
           COUNT(*) FILTER (WHERE cr.status = 'failed' OR cr.errors > 0)::int AS failed_jobs
         FROM campaign_runs cr JOIN campaigns c ON c.id = cr.campaign_id WHERE c.organization_id = $1`,
        [orgId]
      ),
      pool.query(`SELECT COUNT(DISTINCT country_code)::int AS countries FROM leads WHERE organization_id = $1 AND country_code IS NOT NULL`, [orgId]),
      pool.query(`SELECT COUNT(DISTINCT industry_id)::int AS industries FROM leads WHERE organization_id = $1 AND industry_id IS NOT NULL`, [orgId]),
    ]);

    return reply.send({
      ...totals.rows[0],
      ...campaigns.rows[0],
      ...jobs.rows[0],
      ...countries.rows[0],
      ...industries.rows[0],
    });
  });

  app.get("/analytics/leads-by-country", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT country, country_code, COUNT(*)::int AS count
       FROM leads WHERE organization_id = $1 AND country_code IS NOT NULL
       GROUP BY country, country_code ORDER BY count DESC`,
      [orgId]
    );
    return reply.send({ data: result.rows });
  });

  app.get("/analytics/leads-by-industry", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT i.name AS industry, COUNT(*)::int AS count
       FROM leads l JOIN industries i ON i.id = l.industry_id
       WHERE l.organization_id = $1
       GROUP BY i.name ORDER BY count DESC`,
      [orgId]
    );
    return reply.send({ data: result.rows });
  });

  app.get("/analytics/leads-by-source", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT s.id AS source_id, s.name AS source_name, COUNT(DISTINCT ls.lead_id)::int AS lead_count
       FROM lead_sources ls
       JOIN sources s ON s.id = ls.source_id
       WHERE s.organization_id = $1
       GROUP BY s.id, s.name ORDER BY lead_count DESC`,
      [orgId]
    );
    return reply.send({ data: result.rows });
  });

  const daysSchema = z.object({ days: z.coerce.number().min(1).max(365).default(30) });
  app.get("/analytics/leads-by-day", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = daysSchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT date_trunc('day', first_discovered)::date AS day, COUNT(*)::int AS count
       FROM leads WHERE organization_id = $1 AND first_discovered >= now() - ($2 || ' days')::interval
       GROUP BY day ORDER BY day`,
      [orgId, parsed.data.days]
    );
    return reply.send({ data: result.rows });
  });

  app.get("/analytics/verification-rate", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT verification_status, COUNT(*)::int AS count
       FROM leads WHERE organization_id = $1 GROUP BY verification_status`,
      [orgId]
    );
    return reply.send({ data: result.rows });
  });

  app.get("/analytics/quality-distribution", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE lead_score >= 80)::int AS high,
         COUNT(*) FILTER (WHERE lead_score >= 50 AND lead_score < 80)::int AS medium,
         COUNT(*) FILTER (WHERE lead_score < 50 AND lead_score IS NOT NULL)::int AS low,
         COUNT(*) FILTER (WHERE lead_score IS NULL)::int AS unscored
       FROM leads WHERE organization_id = $1`,
      [orgId]
    );
    return reply.send(result.rows[0]);
  });

  // Campaign performance — completion vs. target, source breakdown per campaign.
  app.get("/analytics/campaign-performance", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      `SELECT c.id, c.name, c.target_leads, c.status,
              COUNT(DISTINCT cl.lead_id)::int AS leads_evaluated,
              COALESCE(AVG(cl.campaign_relevance), 0)::float AS avg_relevance,
              COALESCE(SUM(cr.discovered), 0)::int AS total_discovered,
              COALESCE(SUM(cr.errors), 0)::int AS total_errors
       FROM campaigns c
       LEFT JOIN campaign_leads cl ON cl.campaign_id = c.id
       LEFT JOIN campaign_runs cr ON cr.campaign_id = c.id
       WHERE c.organization_id = $1
       GROUP BY c.id, c.name, c.target_leads, c.status
       ORDER BY c.created_at DESC`,
      [orgId]
    );
    return reply.send({ data: result.rows });
  });

  // AI cost reporting (§31) — by campaign, by operation, and a running
  // today's-total so the admin panel can show spend against the cap
  // withCostTracking is already enforcing.
  const groupBySchema = z.object({ groupBy: z.enum(["campaign", "operation", "tier"]).default("campaign") });
  app.get("/analytics/ai-cost", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = groupBySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const orgId = await getOrgId(req);

    const groupColumn = { campaign: "u.campaign_id", operation: "u.operation", tier: "u.tier" }[parsed.data.groupBy];
    const result = await pool.query(
      `SELECT ${groupColumn} AS group_key, COUNT(*)::int AS call_count,
              SUM(u.tokens_in)::int AS total_tokens_in, SUM(u.tokens_out)::int AS total_tokens_out,
              SUM(u.estimated_cost_usd)::float AS total_cost_usd
       FROM ai_usage u WHERE u.organization_id = $1
       GROUP BY ${groupColumn} ORDER BY total_cost_usd DESC`,
      [orgId]
    );

    const todayResult = await pool.query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)::float AS today_total
       FROM ai_usage WHERE organization_id = $1 AND created_at >= date_trunc('day', now())`,
      [orgId]
    );

    return reply.send({ data: result.rows, todayTotalUsd: todayResult.rows[0].today_total });
  });
}
