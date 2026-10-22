import "dotenv/config";
import http from "node:http";
import { pool } from "./lib/db.js";
import { connection, enqueueExtractionFetch } from "./queues/index.js";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { createSitemapConnector } from "./connectors/sitemap.js";

// This exercises the real pipeline (queue -> worker -> connector -> ingestion
// -> DB -> chained verification job -> DB) against a local fixture server,
// since this sandbox can't reach arbitrary third-party sites. Everything
// downstream of "fetch the URL" is the actual production code path.

const FIXTURE_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Fixture Dental Clinic",
 "url":"http://localhost:__PORT__/business","description":"General dentistry.",
 "email":"contact@fixturedental.test","telephone":"+61298765432",
 "address":{"streetAddress":"1 Test St","addressLocality":"Sydney","addressRegion":"NSW","postalCode":"2000","addressCountry":"AU"}}
</script></head><body>Fixture business page</body></html>`;

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>http://localhost:${port}/business</loc></url>
      </urlset>`);
    } else if (req.url === "/business") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FIXTURE_HTML.replace(/__PORT__/g, String(port)));
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
  console.log(`Fixture server listening on 127.0.0.1:${port}`);

  // Set up org + source rows directly (bypassing HTTP layer — this test is
  // about the queue/worker/connector pipeline, not the API surface, which
  // was already tested live in Phases 1-2).
  const orgResult = await pool.query("INSERT INTO organizations (name) VALUES ('E2E Test Org') RETURNING id");
  const organizationId = orgResult.rows[0].id;
  const sourceResult = await pool.query(
    `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url)
     VALUES ($1, 'Fixture Sitemap', 'SITEMAP', 'PUBLIC_SITEMAP', $2) RETURNING id`,
    [organizationId, `http://127.0.0.1:${port}`]
  );
  const sourceId = sourceResult.rows[0].id;

  // Real workers, real BullMQ, real Redis.
  const extractionWorker = startExtractionWorker();
  const verificationWorker = startVerificationWorker();

  const extractionDone = new Promise<void>((resolve) => {
    extractionWorker.on("completed", () => resolve());
  });
  const verificationDone = new Promise<void>((resolve) => {
    verificationWorker.on("completed", () => resolve());
  });

  // Discover the candidate URL via the real connector (walks the fixture
  // sitemap exactly as it would a real one), then enqueue it exactly as the
  // orchestrator does.
  const connector = createSitemapConnector(`http://127.0.0.1:${port}`);
  let enqueued = 0;
  for await (const candidate of connector.discover({})) {
    console.log("Discovered candidate:", candidate.url);
    await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: candidate.url });
    enqueued++;
  }
  console.log(`Enqueued ${enqueued} extraction job(s)`);

  await Promise.race([
    Promise.all([extractionDone, verificationDone]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for jobs")), 15000)),
  ]);

  const leads = await pool.query("SELECT * FROM leads WHERE organization_id = $1", [organizationId]);
  console.log("\n=== Resulting lead(s) ===");
  console.log(JSON.stringify(leads.rows, null, 2));

  const leadId = leads.rows[0]?.id;
  if (leadId) {
    const provenance = await pool.query("SELECT field, value, confidence, source_name FROM lead_field_provenance WHERE lead_id = $1", [leadId]);
    console.log("\n=== Field provenance ===");
    console.log(JSON.stringify(provenance.rows, null, 2));

    const verifications = await pool.query("SELECT check_type, result, details FROM verification_results WHERE lead_id = $1", [leadId]);
    console.log("\n=== Verification results ===");
    console.log(JSON.stringify(verifications.rows, null, 2));

    const emails = await pool.query("SELECT email, domain, source FROM lead_emails WHERE lead_id = $1", [leadId]);
    console.log("\n=== Lead emails ===");
    console.log(JSON.stringify(emails.rows, null, 2));
  }

  console.log(`\nASSERT leads.length === 1: ${leads.rows.length === 1 ? "PASS" : "FAIL (" + leads.rows.length + ")"}`);
  console.log(`ASSERT company name correct: ${leads.rows[0]?.company_name === "Fixture Dental Clinic" ? "PASS" : "FAIL"}`);
  console.log(`ASSERT verification_status set: ${leads.rows[0]?.verification_status !== "UNVERIFIED" ? "PASS (" + leads.rows[0]?.verification_status + ")" : "FAIL"}`);

  await extractionWorker.close();
  await verificationWorker.close();
  await connection.quit();
  server.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E TEST FAILED:", err);
  process.exit(1);
});
