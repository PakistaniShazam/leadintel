import { Queue } from "bullmq";
import Redis from "ioredis";

export const connection = new (Redis as any)(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null, // required by BullMQ
});

// One queue per pipeline stage (Architecture V2 §28) so each stage gets its
// own concurrency/rate-limit/retry policy instead of a single queue where a
// slow AI call head-of-line-blocks fast extraction jobs.
export const discoveryStrategyQueue = new Queue("discovery.strategy", { connection });
export const discoveryQueryQueue = new Queue("discovery.query", { connection });
export const extractionFetchQueue = new Queue("extraction.fetch", { connection });
export const extractionParseQueue = new Queue("extraction.parse", { connection });
export const verificationQueue = new Queue("verification", { connection });
export const campaignScheduledRunQueue = new Queue("campaign.scheduled-run", { connection });

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 }, // kept longer — acts as the dead-letter record (§17 job architecture)
};

export interface ExtractionFetchJobData {
  organizationId: string;
  sourceId: string;
  sourceType: string;
  sourceBaseUrl: string;
  url: string;
  campaignId?: string;
  campaignRunId?: string;
}

export async function enqueueExtractionFetch(data: ExtractionFetchJobData) {
  return extractionFetchQueue.add("fetch", data, DEFAULT_JOB_OPTIONS);
}

export interface VerificationJobData {
  leadId: string;
}

export async function enqueueVerification(data: VerificationJobData) {
  return verificationQueue.add("verify", data, DEFAULT_JOB_OPTIONS);
}
