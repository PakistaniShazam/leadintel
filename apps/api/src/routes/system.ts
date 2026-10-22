import type { FastifyInstance } from "fastify";
import { pool } from "../lib/db.js";
import { connection as redisConnection } from "../queues/index.js";
import { requireAuth } from "../lib/auth.js";
import { getAIProvider } from "../ai/factory.js";

/**
 * System health (§15/§19 of the original spec, and directly requested for
 * the frontend's system-status page). Real checks, not hardcoded "ok"s:
 * an actual `SELECT 1`, an actual Redis PING, and the AI provider's
 * actual configured/mock status (never a live-billed call on every
 * dashboard load — that's what the separate test-connection endpoint is for,
 * triggered explicitly by the user).
 */
export async function systemRoutes(app: FastifyInstance) {
  app.get("/system/health", { preHandler: requireAuth }, async (_req, reply) => {
    const checks: Record<string, { status: string; detail?: string }> = {};

    try {
      await pool.query("SELECT 1");
      checks.database = { status: "healthy" };
    } catch (err: any) {
      checks.database = { status: "unhealthy", detail: err.message };
    }

    try {
      const pong = await redisConnection.ping();
      checks.redis = { status: pong === "PONG" ? "healthy" : "unhealthy" };
    } catch (err: any) {
      checks.redis = { status: "unhealthy", detail: err.message };
    }

    const provider = getAIProvider();
    checks.aiProvider = {
      status: provider.name === "mock" ? "mock" : "configured",
      detail: provider.name === "mock" ? "ANTHROPIC_API_KEY not set — using placeholder responses" : `${provider.name}:${provider.model}`,
    };

    const overall = Object.values(checks).every((c) => c.status === "healthy" || c.status === "configured" || c.status === "mock")
      ? Object.values(checks).some((c) => c.status === "unhealthy")
        ? "degraded"
        : "healthy"
      : "unhealthy";

    return reply.send({ status: overall, checks, checkedAt: new Date().toISOString() });
  });

  // Explicit, user-triggered live test — this is the ONE place a real
  // (billed) AI call happens just to prove connectivity, never automatically.
  app.post("/system/test-ai-connection", { preHandler: requireAuth }, async (_req, reply) => {
    const provider = getAIProvider();
    if (provider.name === "mock") {
      return reply.send({ success: false, provider: "mock", message: "ANTHROPIC_API_KEY is not configured — set it to test a real connection." });
    }

    const startedAt = Date.now();
    try {
      const { result } = await provider.classifyIndustry("Connection test.", ["Test"]);
      return reply.send({
        success: true,
        provider: provider.name,
        model: provider.model,
        responseTimeMs: Date.now() - startedAt,
        sample: result,
      });
    } catch (err: any) {
      return reply.code(502).send({ success: false, provider: provider.name, error: err.message, responseTimeMs: Date.now() - startedAt });
    }
  });
}
