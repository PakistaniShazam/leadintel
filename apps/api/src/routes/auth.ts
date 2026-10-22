import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../lib/db.js";
import { hashPassword, verifyPassword, signToken, requireAuth } from "../lib/auth.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1),
  organizationName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function authRoutes(app: FastifyInstance) {
  // Tighter rate limit specifically on login — the actual credential-guessing
  // target — separate from the global 200/min baseline registered in index.ts.
  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/auth/register", authRateLimit, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { email, password, name, organizationName } = parsed.data;

    const client = await pool.connect();
    try {
      const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: "An account with this email already exists" });
      }

      await client.query("BEGIN");

      const passwordHash = await hashPassword(password);
      const userResult = await client.query(
        "INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name",
        [email, passwordHash, name]
      );
      const user = userResult.rows[0];

      const orgResult = await client.query(
        "INSERT INTO organizations (name) VALUES ($1) RETURNING id, name",
        [organizationName]
      );
      const org = orgResult.rows[0];

      await client.query(
        "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,'OWNER')",
        [user.id, org.id]
      );

      await client.query("COMMIT");

      const token = signToken({ userId: user.id, email: user.email });
      return reply.code(201).send({
        token,
        user: { id: user.id, email: user.email, name: user.name },
        organization: org,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      req.log.error(err);
      return reply.code(500).send({ error: "Registration failed" });
    } finally {
      client.release();
    }
  });

  app.post("/auth/login", authRateLimit, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const result = await pool.query(
      "SELECT id, email, password_hash, name FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];
    if (!user) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const token = signToken({ userId: user.id, email: user.email });
    return reply.send({ token, user: { id: user.id, email: user.email, name: user.name } });
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (req, reply) => {
    const { userId } = (req as any).user;
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, m.organization_id, o.name as organization_name, m.role
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
       WHERE u.id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: "User not found" });
    }
    return reply.send({ user: result.rows[0] });
  });
}
