import { Worker } from "bullmq";
import { connection } from "../queues/index.js";
import { runCampaignAgainstApprovedSources } from "../orchestrator/discovery.js";
import { pool } from "../lib/db.js";

export function startSchedulerWorker(): Worker {
  return new Worker(
    "campaign.scheduled-run",
    async (job) => {
      const { campaignId } = job.data as { campaignId: string };

      const campaign = await pool.query("SELECT status FROM campaigns WHERE id = $1", [campaignId]);
      if (campaign.rows.length === 0) {
        return { skipped: "campaign not found (may have been deleted)" };
      }
      if (campaign.rows[0].status !== "ACTIVE") {
        return { skipped: `campaign status is ${campaign.rows[0].status}, not ACTIVE — skipping scheduled run` };
      }

      return runCampaignAgainstApprovedSources(campaignId);
    },
    { connection, concurrency: 2 }
  );
}
