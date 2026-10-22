import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { getOrgId } from "../lib/org.js";
import { generateStrategyForCampaign, runCampaignAgainstSource, runCampaignAgainstApprovedSources, AIBudgetExceededError } from "../orchestrator/discovery.js";
import { enableCampaignSchedule, disableCampaignSchedule } from "../scheduler/index.js";
import { rankSourcesForCampaign } from "../orchestrator/sourceRanking.js";
import { writeAuditLog } from "../lib/audit.js";

const createCampaignSchema = z.object({
  name: z.string().min(1),
  includeCountries: z.array(z.string()).default([]),
  excludeCountries: z.array(z.string()).default([]),
  requiredFields: z.array(z.string()).default([]),
  qualityBar: z.number().min(0).max(100).default(0),
  targetLeads: z.number().min(0).default(0),
  scheduleCron: z.string().nullable().optional(),
  maxRuntimeMin: z.number().min(1).default(60),
  maxRequests: z.number().min(1).default(5000),
  maxAiCostUsd: z.number().min(0).default(5.0),
});

export async function campaignRoutes(app: FastifyInstance) {
  app.post("/campaigns", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const c = parsed.data;
    const orgId = await getOrgId(req);

    const result = await pool.query(
      `INSERT INTO campaigns
         (organization_id, name, include_countries, exclude_countries, required_fields,
          quality_bar, target_leads, schedule_cron, max_runtime_min, max_requests, max_ai_cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        orgId, c.name, c.includeCountries, c.excludeCountries, c.requiredFields,
        c.qualityBar, c.targetLeads, c.scheduleCron ?? null, c.maxRuntimeMin, c.maxRequests, c.maxAiCostUsd,
      ]
    );

    return reply.code(201).send({ campaign: result.rows[0] });
  });

  app.get("/campaigns", { preHandler: requireAuth }, async (req, reply) => {
    const orgId = await getOrgId(req);
    const result = await pool.query(
      "SELECT * FROM campaigns WHERE organization_id = $1 ORDER BY created_at DESC",
      [orgId]
    );
    return reply.send({ data: result.rows });
  });

  app.get("/campaigns/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaignResult = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2",
      [id, orgId]
    );
    if (campaignResult.rows.length === 0) {
      return reply.code(404).send({ error: "Campaign not found" });
    }
    const runsResult = await pool.query(
      "SELECT * FROM campaign_runs WHERE campaign_id = $1 ORDER BY started_at DESC LIMIT 20",
      [id]
    );
    return reply.send({ campaign: campaignResult.rows[0], runs: runsResult.rows });
  });

  // Generate (or regenerate) the AI-proposed discovery strategy — reviewable
  // by the user before approval, per §11/§26's "user reviews before launch".
  app.post("/campaigns/:id/strategy", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });

    try {
      const { strategy, costIncurred } = await generateStrategyForCampaign(id);
      return reply.send({ strategy, aiProviderUsed: costIncurred ? "live" : "mock (no ANTHROPIC_API_KEY configured)" });
    } catch (err) {
      if (err instanceof AIBudgetExceededError) {
        return reply.code(429).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/campaigns/:id/approve", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaign = await pool.query("SELECT id, search_strategy FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });
    if (!campaign.rows[0].search_strategy) {
      return reply.code(400).send({ error: "Generate a strategy before approving (POST /campaigns/:id/strategy)" });
    }
    const result = await pool.query(
      `UPDATE campaigns SET status = 'ACTIVE', strategy_approved_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    await writeAuditLog({
      organizationId: orgId,
      actorUserId: (req as any).user?.userId,
      action: "campaign_approved",
      entityType: "campaign",
      entityId: id,
    });
    return reply.send({ campaign: result.rows[0] });
  });

  const runSchema = z.object({ sourceId: z.string().uuid().optional() });
  app.post("/campaigns/:id/run", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const orgId = await getOrgId(req);

    const campaign = await pool.query("SELECT id, status FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });
    if (campaign.rows[0].status !== "ACTIVE") {
      return reply.code(400).send({ error: "Campaign must be approved (ACTIVE) before running" });
    }

    try {
      // sourceId given -> run just that one (useful for a manual retry of a
      // single source); omitted -> run the full approved source pool (§5/§6).
      const result = parsed.data.sourceId
        ? await runCampaignAgainstSource(id, parsed.data.sourceId)
        : await runCampaignAgainstApprovedSources(id);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // Approved source pool (§5's "Approved Source Pool" stage) — attach a
  // source this campaign is allowed to run against. Attaching implies the
  // compliance review for that source already happened when it was
  // registered via POST /sources; this is "yes, use it for this campaign,"
  // not a second compliance check.
  const attachSourceSchema = z.object({ sourceId: z.string().uuid(), priority: z.number().int().default(0) });
  app.post("/campaigns/:id/sources", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = attachSourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const orgId = await getOrgId(req);

    const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });
    const source = await pool.query("SELECT id FROM sources WHERE id = $1 AND organization_id = $2", [parsed.data.sourceId, orgId]);
    if (source.rows.length === 0) return reply.code(404).send({ error: "Source not found" });

    const result = await pool.query(
      `INSERT INTO campaign_sources (campaign_id, source_id, priority) VALUES ($1,$2,$3)
       ON CONFLICT (campaign_id, source_id) DO UPDATE SET priority = $3
       RETURNING *`,
      [id, parsed.data.sourceId, parsed.data.priority]
    );
    return reply.code(201).send({ campaignSource: result.rows[0] });
  });

  app.get("/campaigns/:id/sources", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });

    const result = await pool.query(
      `SELECT cs.id, cs.priority, cs.approved_at, s.id AS source_id, s.name, s.type, s.compliance_mode, s.base_url
       FROM campaign_sources cs JOIN sources s ON s.id = cs.source_id
       WHERE cs.campaign_id = $1 ORDER BY cs.priority DESC, cs.approved_at ASC`,
      [id]
    );
    return reply.send({ data: result.rows });
  });

  // Source ranking (§8/§27) — recompute campaign_sources.priority from real
  // historical performance. Call after a campaign has accumulated some
  // source_runs history; on a brand-new campaign this just applies the
  // compliance-mode priors (§8's fallback), which is still a real ranking,
  // just not a historically-informed one yet.
  app.post("/campaigns/:id/sources/rank", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });

    const ranking = await rankSourcesForCampaign(id);
    return reply.send({ data: ranking });
  });

  // Scheduler (§29) — recurring runs via BullMQ repeatable jobs. Accepts
  // either a real cron expression or, for testing/simple cases, a plain
  // interval in milliseconds.
  const scheduleSchema = z.object({ cron: z.string().optional(), everyMs: z.number().min(1000).optional() });
  app.post("/campaigns/:id/schedule", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!parsed.data.cron && !parsed.data.everyMs) return reply.code(400).send({ error: "Provide either cron or everyMs" });
    const orgId = await getOrgId(req);

    const campaign = await pool.query("SELECT id, status FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });
    if (campaign.rows[0].status !== "ACTIVE") {
      return reply.code(400).send({ error: "Campaign must be approved (ACTIVE) before scheduling" });
    }

    await enableCampaignSchedule(id, parsed.data);
    return reply.send({ scheduled: true });
  });

  app.delete("/campaigns/:id/schedule", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });

    await disableCampaignSchedule(id);
    return reply.send({ scheduled: false });
  });

  // Campaign-specific view of leads — relevance is stored per (campaign, lead),
  // never on the permanent lead row (§10/§15/§25).
  app.get("/campaigns/:id/leads", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const campaign = await pool.query("SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (campaign.rows.length === 0) return reply.code(404).send({ error: "Campaign not found" });

    const result = await pool.query(
      `SELECT l.id, l.company_name, l.website, l.country_code, l.lead_score, l.data_confidence,
              l.verification_status, cl.campaign_relevance, cl.signals, cl.created_at AS evaluated_at
       FROM campaign_leads cl
       JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = $1
       ORDER BY cl.campaign_relevance DESC NULLS LAST`,
      [id]
    );
    return reply.send({ data: result.rows });
  });
}
