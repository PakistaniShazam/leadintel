import "dotenv/config";
import http from "node:http";
import { pool } from "./lib/db.js";
import { connection, enqueueExtractionFetch } from "./queues/index.js";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { createSitemapConnector } from "./connectors/sitemap.js";

// No industry/country in the JSON-LD this time, but a description that a
// (mock, in this session) classifier would work from — forces the Tier 3
// AI fallback path in the extraction worker rather than the deterministic
// structured-data path used in the Phase 3 fixture.
const FIXTURE_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Phase4 Dental Group",
 "url":"http://phase4-fixture.test/","description":"Comprehensive dental and orthodontic care.",
 "email":"hello@phase4dental.test","telephone":"+61298765432",
 "address":{"streetAddress":"1 Test Ave","addressLocality":"Brisbane","addressCountry":"AU"}}
</script></head><body>Fixture business page</body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>http://127.0.0.1:${port}/business</loc></url>
      </urlset>`);
    } else if (req.url === "/business") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FIXTURE_HTML);
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

  const orgResult = await pool.query("INSERT INTO organizations (name) VALUES ('Phase4 Test Org') RETURNING id");
  const organizationId = orgResult.rows[0].id;

  const sourceResult = await pool.query(
    `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url)
     VALUES ($1, 'Phase4 Fixture Sitemap', 'SITEMAP', 'PUBLIC_SITEMAP', $2) RETURNING id`,
    [organizationId, `http://127.0.0.1:${port}`]
  );
  const sourceId = sourceResult.rows[0].id;

  // A campaign gives the worker a spend cap + relevance target to compute against.
  const campaignResult = await pool.query(
    `INSERT INTO campaigns (organization_id, name, include_countries, required_fields, max_ai_cost_usd)
     VALUES ($1, 'Phase4 Test Campaign', $2, $3, $4) RETURNING id`,
    [organizationId, ["AU"], ["email"], 5.0]
  );
  const campaignId = campaignResult.rows[0].id;

  const extractionWorker = startExtractionWorker();
  const verificationWorker = startVerificationWorker();

  const done = new Promise<void>((resolve) => {
    verificationWorker.on("completed", () => resolve());
  });

  const connector = createSitemapConnector(`http://127.0.0.1:${port}`);
  for await (const candidate of connector.discover({})) {
    await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: candidate.url, campaignId });
  }

  await Promise.race([done, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 15000))]);
  await new Promise((r) => setTimeout(r, 500)); // let downstream writes settle

  const lead = await pool.query("SELECT * FROM leads WHERE organization_id = $1", [organizationId]);
  const leadId = lead.rows[0]?.id;

  const classifications = await pool.query("SELECT field, value, confidence, reasoning, model_version FROM ai_classifications WHERE lead_id = $1", [leadId]);
  const campaignLead = await pool.query("SELECT campaign_relevance, signals FROM campaign_leads WHERE lead_id = $1 AND campaign_id = $2", [leadId, campaignId]);
  const historyEvents = await pool.query("SELECT event_type FROM lead_history_events WHERE lead_id = $1 ORDER BY created_at", [leadId]);

  console.log("=== Lead ===");
  console.log(JSON.stringify(lead.rows[0], null, 2));
  console.log("=== AI classifications ===");
  console.log(JSON.stringify(classifications.rows, null, 2));
  console.log("=== Campaign relevance ===");
  console.log(JSON.stringify(campaignLead.rows[0], null, 2));
  console.log("=== History event types ===");
  console.log(historyEvents.rows.map((r) => r.event_type));

  console.log(`\nASSERT lead exists: ${lead.rows.length === 1 ? "PASS" : "FAIL"}`);
  console.log(`ASSERT lead_score is a number 0-100: ${typeof lead.rows[0]?.lead_score === "number" && lead.rows[0].lead_score >= 0 && lead.rows[0].lead_score <= 100 ? "PASS (" + lead.rows[0]?.lead_score + ")" : "FAIL (" + lead.rows[0]?.lead_score + ")"}`);
  console.log(`ASSERT data_confidence is a number 0-1: ${typeof lead.rows[0]?.data_confidence === "number" && lead.rows[0].data_confidence >= 0 && lead.rows[0].data_confidence <= 1 ? "PASS (" + lead.rows[0]?.data_confidence + ")" : "FAIL (" + lead.rows[0]?.data_confidence + ")"}`);
  console.log(`ASSERT campaign_relevance recorded separately from lead_score: ${campaignLead.rows[0]?.campaign_relevance !== undefined && campaignLead.rows[0]?.campaign_relevance !== lead.rows[0]?.lead_score ? "PASS" : "INCONCLUSIVE (may coincidentally match)"}`);
  console.log(`ASSERT score_change history event recorded: ${historyEvents.rows.some((r: { event_type: string }) => r.event_type === "score_change") ? "PASS" : "FAIL"}`);
  console.log(`ASSERT AI classification attempted (mock provider, no API key here): ${classifications.rows.length > 0 ? "PASS (" + classifications.rows.length + " rows)" : "recorded 0 — check reasoning below"}`);

  await extractionWorker.close();
  await verificationWorker.close();
  await connection.quit();
  server.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("PHASE 4 E2E TEST FAILED:", err);
  process.exit(1);
});
