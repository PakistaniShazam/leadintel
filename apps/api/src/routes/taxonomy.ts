import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";

// Taxonomy is intentionally organization-agnostic (shared across all orgs) —
// matches §30/§9 of the architecture: industries/categories/countries are
// admin-configurable reference data, not per-tenant data. Any authenticated
// user can read; only admin-role users can write (checked per-route below
// once roles matter — Phase 1's single-org-per-user model means every OWNER
// is effectively an admin for now).

export async function taxonomyRoutes(app: FastifyInstance) {
  // ── Industries ──────────────────────────────────────────────
  app.get("/industries", { preHandler: requireAuth }, async (_req, reply) => {
    const result = await pool.query("SELECT * FROM industries ORDER BY name");
    return reply.send({ data: result.rows });
  });

  app.post("/industries", { preHandler: requireAuth }, async (req, reply) => {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    try {
      const result = await pool.query(
        "INSERT INTO industries (name) VALUES ($1) RETURNING *",
        [parsed.data.name]
      );
      return reply.code(201).send({ industry: result.rows[0] });
    } catch (err: any) {
      if (err.code === "23505") return reply.code(409).send({ error: "Industry already exists" });
      throw err;
    }
  });

  // ── Categories (nested under an industry) ──────────────────
  app.get("/industries/:industryId/categories", { preHandler: requireAuth }, async (req, reply) => {
    const { industryId } = req.params as { industryId: string };
    const result = await pool.query(
      "SELECT * FROM categories WHERE industry_id = $1 ORDER BY name",
      [industryId]
    );
    return reply.send({ data: result.rows });
  });

  app.post("/industries/:industryId/categories", { preHandler: requireAuth }, async (req, reply) => {
    const { industryId } = req.params as { industryId: string };
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const industry = await pool.query("SELECT id FROM industries WHERE id = $1", [industryId]);
    if (industry.rows.length === 0) return reply.code(404).send({ error: "Industry not found" });

    try {
      const result = await pool.query(
        "INSERT INTO categories (industry_id, name) VALUES ($1,$2) RETURNING *",
        [industryId, parsed.data.name]
      );
      return reply.code(201).send({ category: result.rows[0] });
    } catch (err: any) {
      if (err.code === "23505") return reply.code(409).send({ error: "Category already exists in this industry" });
      throw err;
    }
  });

  // ── Subcategories (nested under a category) ─────────────────
  app.get("/categories/:categoryId/subcategories", { preHandler: requireAuth }, async (req, reply) => {
    const { categoryId } = req.params as { categoryId: string };
    const result = await pool.query(
      "SELECT * FROM subcategories WHERE category_id = $1 ORDER BY name",
      [categoryId]
    );
    return reply.send({ data: result.rows });
  });

  app.post("/categories/:categoryId/subcategories", { preHandler: requireAuth }, async (req, reply) => {
    const { categoryId } = req.params as { categoryId: string };
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const category = await pool.query("SELECT id FROM categories WHERE id = $1", [categoryId]);
    if (category.rows.length === 0) return reply.code(404).send({ error: "Category not found" });

    try {
      const result = await pool.query(
        "INSERT INTO subcategories (category_id, name) VALUES ($1,$2) RETURNING *",
        [categoryId, parsed.data.name]
      );
      return reply.code(201).send({ subcategory: result.rows[0] });
    } catch (err: any) {
      if (err.code === "23505") return reply.code(409).send({ error: "Subcategory already exists in this category" });
      throw err;
    }
  });

  // Full tree in one call — the shape the frontend taxonomy picker actually wants,
  // avoids N+1 fan-out requests from the UI.
  app.get("/taxonomy/tree", { preHandler: requireAuth }, async (_req, reply) => {
    const result = await pool.query(`
      SELECT i.id AS industry_id, i.name AS industry_name,
             c.id AS category_id, c.name AS category_name,
             s.id AS subcategory_id, s.name AS subcategory_name
      FROM industries i
      LEFT JOIN categories c ON c.industry_id = i.id
      LEFT JOIN subcategories s ON s.category_id = c.id
      ORDER BY i.name, c.name, s.name
    `);

    const tree = new Map<string, any>();
    for (const row of result.rows) {
      if (!tree.has(row.industry_id)) {
        tree.set(row.industry_id, { id: row.industry_id, name: row.industry_name, categories: new Map() });
      }
      const industry = tree.get(row.industry_id);
      if (row.category_id && !industry.categories.has(row.category_id)) {
        industry.categories.set(row.category_id, { id: row.category_id, name: row.category_name, subcategories: [] });
      }
      if (row.category_id && row.subcategory_id) {
        industry.categories.get(row.category_id).subcategories.push({ id: row.subcategory_id, name: row.subcategory_name });
      }
    }
    const shaped = [...tree.values()].map((i) => ({ ...i, categories: [...i.categories.values()] }));
    return reply.send({ data: shaped });
  });

  // ── Countries ─────────────────────────────────────────────
  app.get("/countries", { preHandler: requireAuth }, async (_req, reply) => {
    const result = await pool.query("SELECT * FROM countries ORDER BY name");
    return reply.send({ data: result.rows });
  });

  app.post("/countries", { preHandler: requireAuth }, async (req, reply) => {
    const schema = z.object({
      name: z.string().min(1),
      code: z.string().length(2),
      phoneCode: z.string().optional(),
      tld: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const c = parsed.data;

    try {
      const result = await pool.query(
        "INSERT INTO countries (name, code, phone_code, tld) VALUES ($1,$2,$3,$4) RETURNING *",
        [c.name, c.code.toUpperCase(), c.phoneCode ?? null, c.tld ?? null]
      );
      return reply.code(201).send({ country: result.rows[0] });
    } catch (err: any) {
      if (err.code === "23505") return reply.code(409).send({ error: "Country already exists (by name or code)" });
      throw err;
    }
  });
}
