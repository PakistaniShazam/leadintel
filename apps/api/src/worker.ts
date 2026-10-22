import "dotenv/config";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { startSchedulerWorker } from "./scheduler/worker.js";

// Standalone worker process — separate from the API process (Architecture
// V2 §4's service boundaries). Run with `npm run worker`, scaled
// independently from the API in production.

const extractionWorker = startExtractionWorker();
const verificationWorker = startVerificationWorker();
const schedulerWorker = startSchedulerWorker();

console.log("Workers started: extraction.fetch, verification, campaign.scheduled-run");

for (const [name, worker] of [
  ["extraction", extractionWorker],
  ["verification", verificationWorker],
  ["scheduler", schedulerWorker],
] as const) {
  worker.on("completed", (job) => console.log(`[${name}] job ${job.id} completed`));
  worker.on("failed", (job, err) => console.error(`[${name}] job ${job?.id} failed:`, err.message));
}

process.on("SIGTERM", async () => {
  await Promise.all([extractionWorker.close(), verificationWorker.close(), schedulerWorker.close()]);
  process.exit(0);
});
