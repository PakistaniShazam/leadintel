import { pool } from "../lib/db.js";
import { campaignScheduledRunQueue } from "../queues/index.js";

/**
 * Scheduler (Architecture V2 §29) — cron-like triggering of campaign runs
 * via BullMQ v6's Job Scheduler API (`upsertJobScheduler`/`getJobSchedulers`/
 * `removeJobScheduler` — the successor to the older `add({repeat})` pattern
 * used in BullMQ v5 and earlier, which this installed version replaced).
 * Each campaign gets exactly one scheduler, keyed by a deterministic id
 * (`campaign-<id>`) so re-enabling upserts rather than creating a second one.
 *
 * Accepts either a real cron expression (production use) or a millisecond
 * interval via `everyMs` (used in this session's live test — waiting for a
 * real cron tick, e.g. "every day at 2am", isn't practical to verify inside
 * a test run, so `every` proves the exact same scheduler mechanism fires
 * correctly on a timescale that's actually observable).
 */

function schedulerId(campaignId: string): string {
  return `campaign-${campaignId}`;
}

export async function enableCampaignSchedule(campaignId: string, opts: { cron?: string; everyMs?: number }): Promise<void> {
  if (!opts.cron && !opts.everyMs) throw new Error("Must provide either cron or everyMs");

  await campaignScheduledRunQueue.upsertJobScheduler(
    schedulerId(campaignId),
    opts.cron ? { pattern: opts.cron } : { every: opts.everyMs },
    { name: "run", data: { campaignId } }
  );

  await pool.query(
    `UPDATE campaigns SET schedule_cron = $1, updated_at = now() WHERE id = $2`,
    [opts.cron ?? `every:${opts.everyMs}ms`, campaignId]
  );
}

export async function disableCampaignSchedule(campaignId: string): Promise<void> {
  await campaignScheduledRunQueue.removeJobScheduler(schedulerId(campaignId));
  await pool.query(`UPDATE campaigns SET schedule_cron = NULL, updated_at = now() WHERE id = $1`, [campaignId]);
}

export async function listSchedules(): Promise<{ campaignId: string | undefined; pattern: string | undefined; every: number | undefined; next: number | undefined }[]> {
  const schedulers = await campaignScheduledRunQueue.getJobSchedulers();
  return schedulers.map((s) => ({
    campaignId: s.key?.startsWith("campaign-") ? s.key.slice("campaign-".length) : undefined,
    pattern: s.pattern ?? undefined,
    every: s.every ? Number(s.every) : undefined,
    next: s.next,
  }));
}
