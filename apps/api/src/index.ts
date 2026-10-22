import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { validateEnv } from "./lib/env.js";
import { authRoutes } from "./routes/auth.js";
import { leadRoutes } from "./routes/leads.js";
import { campaignRoutes } from "./routes/campaigns.js";
import { taxonomyRoutes } from "./routes/taxonomy.js";
import { sourceRoutes } from "./routes/sources.js";
import { reviewQueueRoutes } from "./routes/reviewQueue.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { systemRoutes } from "./routes/system.js";
import { pool } from "./lib/db.js";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { startSchedulerWorker } from "./scheduler/worker.js";

validateEnv(); // fail fast on missing/insecure config, before anything else runs

const app = Fastify({ logger: true });

// Security headers (§33) — sane defaults; contentSecurityPolicy disabled
// since this is a pure JSON API with no HTML responses to protect.
await app.register(helmet, { contentSecurityPolicy: false });

// CORS — configurable via ALLOWED_ORIGINS (comma-separated). Defaults to
// allow-all only because this is a dev-mode-friendly default; validateEnv()
// above already warns loudly if this is still the case in production.
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim());
await app.register(cors, { origin: allowedOrigins ?? true });

// Rate limiting (§33) — global baseline plus a stricter limit on auth
// endpoints specifically, since those are the credential-guessing target.
await app.register(rateLimit, {
  global: true,
  max: 200,
  timeWindow: "1 minute",
});

app.get("/health", async (_req, reply) => {
  try {
    await pool.query("SELECT 1");
    return reply.send({ status: "ok", db: "connected" });
  } catch (err) {
    return reply.code(503).send({ status: "error", db: "unreachable" });
  }
});

await app.register(authRoutes);
await app.register(leadRoutes);
await app.register(campaignRoutes);
await app.register(taxonomyRoutes);
await app.register(sourceRoutes);
await app.register(reviewQueueRoutes);
await app.register(analyticsRoutes);
await app.register(systemRoutes);

// Free Render services cannot run a separate always-on worker economically.
// When enabled, run the workers in this API process for small demos. Keep it
// opt-in so a normal API deployment does not accidentally create duplicate
// consumers when a dedicated worker is deployed separately.
const embeddedWorkers = process.env.RUN_WORKERS === "true";
const workers = embeddedWorkers
  ? [
      startExtractionWorker(),
      startVerificationWorker(),
      startSchedulerWorker(),
    ]
  : [];
if (embeddedWorkers) app.log.info("Embedded workers enabled: extraction, verification, scheduler");

const port = Number(process.env.PORT) || 4000;
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

const shutdown = async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
