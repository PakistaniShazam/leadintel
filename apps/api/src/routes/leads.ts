import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { getOrgId } from "../lib/org.js";
import { ingestLead } from "../lib/ingestion.js";
import { computeLeadScore } from "../scoring/engine.js";
import { enrichLead } from "../enrichment/engine.js";
import { leadFilterSchema, buildLeadFilterClause } from "../lib/leadFilters.js";
import { exportLeadsToCsv, exportLeadsToXlsx } from "../lib/export.js";

const listQuerySchema = leadFilterSchema.extend({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(25),
});

export async function leadRoutes(app: FastifyInstance) {
  app.get("/leads", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const q = parsed.data;
    const orgId = await getOrgId(req);

    const { where, params, nextIndex: i } = buildLeadFilterClause(orgId, q);
    const offset = (q.page - 1) * q.pageSize;

    const countResult = await pool.query(`SELECT COUNT(*) FROM leads l WHERE ${where}`, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await pool.query(
      `SELECT l.id, l.company_name, l.website, l.country, l.city, l.industry_id,
              l.lead_score, l.data_confidence, l.status, l.verification_status,
              l.freshness, l.first_discovered, l.last_verified
       FROM leads l
       WHERE ${where}
       ORDER BY l.lead_score DESC NULLS LAST, l.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, q.pageSize, offset]
    );

    return reply.send({
      data: dataResult.rows,
      pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) },
    });
  });

  // Export — same filters as the list view above (§23: exports must respect
  // currently selected filters), no pagination limit (capped at 10k rows as
  // a sane safety net rather than an unbounded query).
  const exportQuerySchema = leadFilterSchema.extend({ format: z.enum(["csv", "xlsx", "json"]).default("csv") });
  app.get("/leads/export", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { format, ...filters } = parsed.data;
    const orgId = await getOrgId(req);

    const { where, params } = buildLeadFilterClause(orgId, filters);
    const result = await pool.query(
      `SELECT l.company_name, l.website, l.country, l.country_code, l.city, i.name AS industry,
              l.lead_score, l.data_confidence, l.status, l.verification_status,
              (SELECT string_agg(DISTINCT email, '; ') FROM lead_emails WHERE lead_id = l.id) AS emails,
              l.first_discovered, l.last_verified
       FROM leads l
       LEFT JOIN industries i ON i.id = l.industry_id
       WHERE ${where}
       ORDER BY l.lead_score DESC NULLS LAST
       LIMIT 10000`,
      params
    );

    if (format === "json") {
      reply.header("Content-Disposition", 'attachment; filename="leads-export.json"');
      return reply.type("application/json").send(result.rows);
    }
    if (format === "xlsx") {
      const buffer = exportLeadsToXlsx(result.rows);
      reply.header("Content-Disposition", 'attachment; filename="leads-export.xlsx"');
      return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buffer);
    }
    const csv = exportLeadsToCsv(result.rows);
    reply.header("Content-Disposition", 'attachment; filename="leads-export.csv"');
    return reply.type("text/csv").send(csv);
  });

  app.get("/leads/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);

    const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (leadResult.rows.length === 0) {
      return reply.code(404).send({ error: "Lead not found" });
    }
    const lead = leadResult.rows[0];

    const [contacts, emails, provenance, history, verifications, classifications] = await Promise.all([
      pool.query("SELECT * FROM lead_contacts WHERE lead_id = $1", [id]),
      pool.query("SELECT * FROM lead_emails WHERE lead_id = $1", [id]),
      pool.query("SELECT * FROM lead_field_provenance WHERE lead_id = $1 ORDER BY created_at DESC", [id]),
      pool.query("SELECT * FROM lead_history_events WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 50", [id]),
      pool.query("SELECT * FROM verification_results WHERE lead_id = $1 ORDER BY checked_at DESC", [id]),
      pool.query("SELECT * FROM ai_classifications WHERE lead_id = $1 ORDER BY created_at DESC", [id]),
    ]);

    return reply.send({
      lead,
      contacts: contacts.rows,
      emails: emails.rows,
      provenance: provenance.rows,
      history: history.rows,
      verifications: verifications.rows,
      classifications: classifications.rows,
    });
  });

  // Manual lead creation — useful for testing the pipeline and for user-imported leads (§ USER_IMPORT connector)
  const createLeadSchema = z.object({
    companyName: z.string().min(1),
    website: z.string().url().optional(),
    country: z.string().optional(),
    countryCode: z.string().optional(),
    city: z.string().optional(),
  });

  app.post("/leads", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { companyName, website, country, countryCode, city } = parsed.data;
    const orgId = await getOrgId(req);

    const result = await ingestLead({
      organizationId: orgId,
      companyName,
      website: website ?? null,
      country: country ?? null,
      countryCode: countryCode ?? null,
      city: city ?? null,
    });

    const leadResult = await pool.query("SELECT * FROM leads WHERE id = $1", [result.leadId]);

    return reply.code(result.created ? 201 : 200).send({
      lead: leadResult.rows[0],
      deduplicated: result.deduplicated,
      needsReview: result.needsReview,
    });
  });

  // Manual scoring trigger — useful for leads that entered outside a campaign
  // context (e.g. manual entry) where the extraction worker's automatic
  // scoring never ran, and for re-scoring after a correction.
  app.post("/leads/:id/rescore", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const lead = await pool.query("SELECT id FROM leads WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (lead.rows.length === 0) return reply.code(404).send({ error: "Lead not found" });

    const breakdown = await computeLeadScore(id);
    return reply.send(breakdown);
  });

  // Enrichment (§20) — targeted gap-filling for one lead, not a campaign-wide crawl.
  app.post("/leads/:id/enrich", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = await getOrgId(req);
    const lead = await pool.query("SELECT id FROM leads WHERE id = $1 AND organization_id = $2", [id, orgId]);
    if (lead.rows.length === 0) return reply.code(404).send({ error: "Lead not found" });

    const result = await enrichLead(id);
    return reply.send(result);
  });
}
