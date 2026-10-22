import "dotenv/config";
import http from "node:http";
import { pool } from "./lib/db.js";
import { connection } from "./queues/index.js";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { startSchedulerWorker } from "./scheduler/worker.js";
import { enableCampaignSchedule, disableCampaignSchedule, listSchedules } from "./scheduler/index.js";
import { runCampaignAgainstApprovedSources } from "./orchestrator/discovery.js";

// Two separate fixture businesses on two separate fixture "sources" (one
// sitemap, one RSS feed) to prove: (a) a campaign with multiple approved
// sources actually queries all of them, and (b) the RSS connector works
// end-to-end same as the sitemap one did in Phase 3.

const BIZ_A_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Sitemap Sourced Biz",
 "url":"http://sitemap-fixture.test/","email":"a@sitemapfixture.test","telephone":"+61200000001"}
</script></head><body>A</body></html>`;

const BIZ_B_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"RSS Sourced Biz",
 "url":"http://rss-fixture.test/","email":"b@rssfixture.test","telephone":"+61200000002"}
</script></head><body>B</body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>http://127.0.0.1:${port}/biz-a</loc></url>
      </urlset>`);
    } else if (req.url === "/feed.xml") {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel>
        <item><link>http://127.0.0.1:${port}/biz-b</link></item>
      </channel></rss>`);
    } else if (req.url === "/biz-a") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(BIZ_A_HTML);
    } else if (req.url === "/biz-b") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(BIZ_B_HTML);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;

  const orgResult = await pool.query("INSERT INTO organizations (name) VALUES ('Phase5 Test Org') RETURNING id");
  const organizationId = orgResult.rows[0].id;

  const sitemapSource = await pool.query(
    `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url) VALUES ($1,'Fixture Sitemap','SITEMAP','PUBLIC_SITEMAP',$2) RETURNING id`,
    [organizationId, base]
  );
  const rssSource = await pool.query(
    `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url) VALUES ($1,'Fixture RSS','RSS','PUBLIC_RSS',$2) RETURNING id`,
    [organizationId, `${base}/feed.xml`]
  );

  const campaignResult = await pool.query(
    `INSERT INTO campaigns (organization_id, name, status, max_ai_cost_usd) VALUES ($1,'Phase5 Multi-Source Campaign','ACTIVE',1.0) RETURNING id`,
    [organizationId]
  );
  const campaignId = campaignResult.rows[0].id;

  await pool.query(`INSERT INTO campaign_sources (campaign_id, source_id) VALUES ($1,$2),($1,$3)`, [campaignId, sitemapSource.rows[0].id, rssSource.rows[0].id]);

  const extractionWorker = startExtractionWorker();
  const verificationWorker = startVerificationWorker();
  const schedulerWorker = startSchedulerWorker();

  // ── Part 1: multi-source run (no scheduler yet) ──────────────
  console.log("=== Part 1: runCampaignAgainstApprovedSources (multi-source) ===");
  let verifiedCount = 0;
  const waitForVerified = (n: number) =>
    new Promise<void>((resolve) => {
      verificationWorker.on("completed", () => {
        verifiedCount++;
        if (verifiedCount >= n) resolve();
      });
    });

  const runResult = await runCampaignAgainstApprovedSources(campaignId);
  console.log("Run result:", JSON.stringify(runResult, null, 2));
  await Promise.race([waitForVerified(2), new Promise((_, r) => setTimeout(() => r(new Error("timeout part 1")), 10000))]);
  await new Promise((r) => setTimeout(r, 500));

  const leadsAfterPart1 = await pool.query("SELECT company_name, domain FROM leads WHERE organization_id = $1 ORDER BY company_name", [organizationId]);
  console.log("Leads after multi-source run:", JSON.stringify(leadsAfterPart1.rows, null, 2));
  console.log(`ASSERT 2 leads from 2 different sources: ${leadsAfterPart1.rows.length === 2 ? "PASS" : "FAIL (" + leadsAfterPart1.rows.length + ")"}`);
  console.log(`ASSERT per-source breakdown recorded both sources: ${Object.keys(runResult.perSource).length === 2 ? "PASS" : "FAIL"}`);

  // ── Part 2: real recurring scheduler ──────────────────────────
  console.log("\n=== Part 2: recurring scheduler (real BullMQ Job Scheduler, 1.5s interval) ===");
  let scheduledRunCount = 0;
  const schedulerCompletions: Promise<void> = new Promise((resolve) => {
    schedulerWorker.on("completed", () => {
      scheduledRunCount++;
      console.log(`  scheduled run #${scheduledRunCount} completed`);
      if (scheduledRunCount >= 3) resolve();
    });
  });

  await enableCampaignSchedule(campaignId, { everyMs: 1500 });
  const schedules = await listSchedules();
  console.log("Active schedules:", JSON.stringify(schedules, null, 2));
  console.log(`ASSERT schedule registered for this campaign: ${schedules.some((s) => s.campaignId === campaignId) ? "PASS" : "FAIL"}`);

  await Promise.race([schedulerCompletions, new Promise((_, r) => setTimeout(() => r(new Error("timeout waiting for 3 scheduled runs")), 12000))]);
  console.log(`ASSERT scheduler fired multiple times on its own (no manual trigger): ${scheduledRunCount >= 3 ? "PASS (" + scheduledRunCount + " runs)" : "FAIL"}`);

  await disableCampaignSchedule(campaignId);
  const schedulesAfterDisable = await listSchedules();
  console.log(`ASSERT schedule removed after disable: ${!schedulesAfterDisable.some((s) => s.campaignId === campaignId) ? "PASS" : "FAIL"}`);

  const runsForCampaign = await pool.query("SELECT status, discovered FROM campaign_runs WHERE campaign_id = $1 ORDER BY started_at", [campaignId]);
  console.log("\nAll campaign_runs for this campaign:", JSON.stringify(runsForCampaign.rows, null, 2));
  console.log(`ASSERT multiple campaign_runs rows recorded (1 manual + 3+ scheduled): ${runsForCampaign.rows.length >= 4 ? "PASS (" + runsForCampaign.rows.length + ")" : "FAIL (" + runsForCampaign.rows.length + ")"}`);

  await extractionWorker.close();
  await verificationWorker.close();
  await schedulerWorker.close();
  await connection.quit();
  server.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("PHASE 5 E2E TEST FAILED:", err);
  process.exit(1);
});
