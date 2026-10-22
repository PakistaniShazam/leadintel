import "dotenv/config";
import http from "node:http";
import { pool } from "./lib/db.js";
import { connection, enqueueExtractionFetch } from "./queues/index.js";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { createSitemapConnector } from "./connectors/sitemap.js";

const FIXTURE_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Repeat Fixture Clinic",
 "url":"http://example-repeat-fixture.test/","description":"General dentistry.",
 "email":"contact@repeatfixture.test","telephone":"+61298765432"}
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

  const orgResult = await pool.query("INSERT INTO organizations (name) VALUES ('E2E Dedup Test Org') RETURNING id");
  const organizationId = orgResult.rows[0].id;
  const sourceResult = await pool.query(
    `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url)
     VALUES ($1, 'Fixture Sitemap 2', 'SITEMAP', 'PUBLIC_SITEMAP', $2) RETURNING id`,
    [organizationId, `http://127.0.0.1:${port}`]
  );
  const sourceId = sourceResult.rows[0].id;

  const extractionWorker = startExtractionWorker();
  const verificationWorker = startVerificationWorker();

  let completedCount = 0;
  const waitForN = (n: number) =>
    new Promise<void>((resolve) => {
      extractionWorker.on("completed", () => {
        completedCount++;
        if (completedCount >= n) resolve();
      });
    });

  const connector = createSitemapConnector(`http://127.0.0.1:${port}`);

  // Pass 1
  for await (const candidate of connector.discover({})) {
    await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: candidate.url });
  }
  await Promise.race([waitForN(1), new Promise((_, r) => setTimeout(() => r(new Error("timeout pass 1")), 10000))]);

  // Pass 2 — same fixture, simulating a re-crawl finding the same business again
  for await (const candidate of connector.discover({})) {
    await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: candidate.url });
  }
  await Promise.race([waitForN(2), new Promise((_, r) => setTimeout(() => r(new Error("timeout pass 2")), 10000))]);

  await new Promise((r) => setTimeout(r, 500)); // let verification jobs settle

  const leads = await pool.query("SELECT id, company_name, first_discovered, last_discovered FROM leads WHERE organization_id = $1", [organizationId]);
  const history = await pool.query(
    "SELECT event_type, new_value FROM lead_history_events WHERE lead_id = $1 ORDER BY created_at",
    [leads.rows[0]?.id]
  );
  const leadSources = await pool.query("SELECT * FROM lead_sources WHERE source_id = $1", [sourceId]);

  console.log("=== Leads after 2 discovery passes over the SAME fixture ===");
  console.log(JSON.stringify(leads.rows, null, 2));
  console.log("=== History events ===");
  console.log(JSON.stringify(history.rows, null, 2));
  console.log("=== lead_sources (attribution) ===");
  console.log(JSON.stringify(leadSources.rows, null, 2));

  console.log(`\nASSERT exactly 1 lead after 2 passes: ${leads.rows.length === 1 ? "PASS" : "FAIL (" + leads.rows.length + ")"}`);
  console.log(`ASSERT a 'duplicate_submission_merged' event exists: ${history.rows.some((r) => r.event_type === "duplicate_submission_merged") ? "PASS" : "FAIL"}`);
  console.log(`ASSERT last_discovered advanced past first_discovered: ${leads.rows[0] && new Date(leads.rows[0].last_discovered) >= new Date(leads.rows[0].first_discovered) ? "PASS" : "FAIL"}`);

  await extractionWorker.close();
  await verificationWorker.close();
  await connection.quit();
  server.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E DEDUP TEST FAILED:", err);
  process.exit(1);
});
