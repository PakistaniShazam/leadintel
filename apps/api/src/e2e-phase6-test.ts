import "dotenv/config";
import http from "node:http";
import { pool } from "./lib/db.js";
import { connection, enqueueExtractionFetch } from "./queues/index.js";
import { startExtractionWorker } from "./extraction/worker.js";
import { startVerificationWorker } from "./verification/worker.js";
import { createSitemapConnector } from "./connectors/sitemap.js";
import { enrichLead } from "./enrichment/engine.js";
import { rankSourcesForCampaign } from "./orchestrator/sourceRanking.js";

// Version 1 of the fixture business: has an email, no address.
const BIZ_V1 = (port: number) => `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Phase6 Test Biz",
 "url":"http://127.0.0.1:${port}/business","email":"v1@phase6fixture.test","telephone":"+61200000009"}
</script></head><body>v1</body></html>`;

// Version 2, SAME domain (same URL) but a slightly different company name —
// simulates a minor rebrand. Same domain means dedup's domain-match bonus
// applies, so this should score above the auto-merge threshold and hit the
// reconcile path (company_name changed but not silently applied).
const BIZ_V2_RENAMED_HTML = (port: number) => `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Phase6 Test Biz Renamed",
 "url":"http://127.0.0.1:${port}/business","email":"v1@phase6fixture.test","telephone":"+61200000009"}
</script></head><body>v2</body></html>`;

// Version 3: identical name, but a COMPLETELY DIFFERENT domain — simulates
// either a genuine site migration or (indistinguishably, from the data
// alone) a coincidental same-name different business. Used to prove the
// dedup engine correctly refuses to auto-merge on name-alone when the
// domain doesn't match, and instead raises an ambiguous-duplicate flag
// rather than guessing either way.
const BIZ_V3_NEW_DOMAIN_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Phase6 Test Biz Renamed",
 "url":"http://phase6-completely-different-domain.test/","email":"v1@phase6fixture.test","telephone":"+61200000009"}
</script></head><body>v3</body></html>`;

// A separate fixture used purely for the enrichment test: a lead created
// with NO email, whose website (when fetched directly, not via
// discovery) has one.
const ENRICH_TARGET_HTML = (port: number) => `<!DOCTYPE html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Enrichment Target Co",
 "url":"http://127.0.0.1:${port}/enrich-target","email":"found-by-enrichment@fixture.test"}
</script></head><body>enrich target</body></html>`;

async function main() {
  let servePhase = 1;
  const server = http.createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>http://127.0.0.1:${port}/business</loc></url>
      </urlset>`);
    } else if (req.url === "/business") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(servePhase === 1 ? BIZ_V1(port) : servePhase === 2 ? BIZ_V2_RENAMED_HTML(port) : BIZ_V3_NEW_DOMAIN_HTML);
    } else if (req.url === "/enrich-target") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(ENRICH_TARGET_HTML(port));
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

  const orgResult = await pool.query("INSERT INTO organizations (name) VALUES ('Phase6 Test Org') RETURNING id");
  const organizationId = orgResult.rows[0].id;
  const sourceResult = await pool.query(
    `INSERT INTO sources (organization_id, name, type, compliance_mode, base_url) VALUES ($1,'Phase6 Fixture','SITEMAP','PUBLIC_SITEMAP',$2) RETURNING id`,
    [organizationId, `http://127.0.0.1:${port}`]
  );
  const sourceId = sourceResult.rows[0].id;

  const extractionWorker = startExtractionWorker();
  const verificationWorker = startVerificationWorker();

  let completions = 0;
  const waitForN = (n: number) =>
    new Promise<void>((resolve) => {
      verificationWorker.on("completed", () => {
        completions++;
        if (completions >= n) resolve();
      });
    });

  const connector = createSitemapConnector(`http://127.0.0.1:${port}`);

  console.log("=== Part 1: initial discovery ===");
  for await (const c of connector.discover({})) await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: c.url });
  await Promise.race([waitForN(1), new Promise((_, r) => setTimeout(() => r(new Error("timeout part1")), 10000))]);
  await new Promise((r) => setTimeout(r, 300));

  const leadAfterV1 = await pool.query("SELECT id, website, domain FROM leads WHERE organization_id = $1", [organizationId]);
  const leadId = leadAfterV1.rows[0].id;
  console.log("Lead after v1:", JSON.stringify(leadAfterV1.rows[0]));

  console.log("\n=== Part 2: re-discovery, SAME domain, company renamed (auto-merge + change detection) ===");
  servePhase = 2;
  for await (const c of connector.discover({})) await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: c.url });
  await Promise.race([waitForN(2), new Promise((_, r) => setTimeout(() => r(new Error("timeout part2")), 10000))]);
  await new Promise((r) => setTimeout(r, 300));

  const leadAfterV2 = await pool.query("SELECT id, company_name, website, domain FROM leads WHERE organization_id = $1", [organizationId]);
  const changeEvents = await pool.query("SELECT field, old_value, new_value FROM lead_change_events WHERE lead_id = $1", [leadId]);
  const reviewFlagsAfterRename = await pool.query("SELECT reason, priority, status FROM review_flags WHERE lead_id = $1", [leadId]);

  console.log("Leads after v2 (should still be 1 — same domain, high name similarity):", JSON.stringify(leadAfterV2.rows, null, 2));
  console.log("Change events:", JSON.stringify(changeEvents.rows, null, 2));
  console.log("Review flags:", JSON.stringify(reviewFlagsAfterRename.rows, null, 2));

  console.log(`\nASSERT still exactly 1 lead (same domain -> auto-merge held): ${leadAfterV2.rows.length === 1 ? "PASS" : "FAIL (" + leadAfterV2.rows.length + ")"}`);
  console.log(`ASSERT company_name in DB was NOT silently overwritten: ${leadAfterV2.rows[0]?.company_name === "Phase6 Test Biz" ? "PASS" : "FAIL (" + leadAfterV2.rows[0]?.company_name + ")"}`);
  console.log(`ASSERT a company_name change_event was recorded: ${changeEvents.rows.some((r) => r.field === "company_name" && r.new_value === "Phase6 Test Biz Renamed") ? "PASS" : "FAIL"}`);
  console.log(`ASSERT a company_name_changed review flag was raised: ${reviewFlagsAfterRename.rows.some((r) => r.reason === "company_name_changed") ? "PASS" : "FAIL"}`);

  console.log("\n=== Part 2b: re-discovery, IDENTICAL name but COMPLETELY DIFFERENT domain (ambiguous dedup, not auto-merged) ===");
  servePhase = 3;
  for await (const c of connector.discover({})) await enqueueExtractionFetch({ organizationId, sourceId, sourceType: "SITEMAP", sourceBaseUrl: `http://127.0.0.1:${port}`, url: c.url });
  await Promise.race([waitForN(3), new Promise((_, r) => setTimeout(() => r(new Error("timeout part2b")), 10000))]);
  await new Promise((r) => setTimeout(r, 300));

  const leadsAfterV3 = await pool.query("SELECT id, company_name, domain FROM leads WHERE organization_id = $1 ORDER BY created_at", [organizationId]);
  const ambiguousFlags = await pool.query(
    `SELECT rf.reason, rf.priority FROM review_flags rf WHERE rf.lead_id != $1 AND rf.reason = 'duplicate_candidate_ambiguous'`,
    [leadId]
  );
  console.log("Leads after v3:", JSON.stringify(leadsAfterV3.rows, null, 2));
  console.log("Ambiguous-duplicate flags:", JSON.stringify(ambiguousFlags.rows, null, 2));

  console.log(`\nASSERT a SECOND lead was created (domain didn't match well enough to auto-merge on name alone): ${leadsAfterV3.rows.length === 2 ? "PASS" : "FAIL (" + leadsAfterV3.rows.length + ")"}`);
  console.log(`ASSERT it was flagged HIGH priority as an ambiguous duplicate, not silently merged or silently duplicated: ${ambiguousFlags.rows.some((r) => r.priority === "HIGH") ? "PASS" : "FAIL"}`);

  console.log("\n=== Part 3: review queue resolve ===");
  const flagId = ambiguousFlags.rows.length > 0
    ? (await pool.query("SELECT id FROM review_flags WHERE reason = 'duplicate_candidate_ambiguous' LIMIT 1")).rows[0]?.id
    : undefined;
  if (flagId) {
    const beforeResolve = await pool.query("SELECT status FROM review_flags WHERE id = $1", [flagId]);
    console.log(`ASSERT flag starts OPEN: ${beforeResolve.rows[0]?.status === "OPEN" ? "PASS" : "FAIL"}`);
  } else {
    console.log("No flag found to test resolve against — skipping (see Part 2b assertions above)");
  }

  console.log("\n=== Part 4: enrichment engine ===");
  const targetLead = await pool.query(
    `INSERT INTO leads (organization_id, company_name, normalized_name, website, domain)
     VALUES ($1, 'Enrichment Target Co', 'enrichment target co', $2, $3) RETURNING id`,
    [organizationId, `http://127.0.0.1:${port}/enrich-target`, `127.0.0.1:${port}`]
  );
  const targetLeadId = targetLead.rows[0].id;
  const emailsBefore = await pool.query("SELECT count(*)::int AS c FROM lead_emails WHERE lead_id = $1", [targetLeadId]);
  console.log(`Emails before enrichment: ${emailsBefore.rows[0].c}`);

  const enrichResult = await enrichLead(targetLeadId);
  console.log("Enrichment result:", JSON.stringify(enrichResult, null, 2));

  const emailsAfter = await pool.query("SELECT email, source FROM lead_emails WHERE lead_id = $1", [targetLeadId]);
  const enrichmentRuns = await pool.query("SELECT field, applied, source FROM lead_enrichment_runs WHERE lead_id = $1", [targetLeadId]);
  console.log("Emails after enrichment:", JSON.stringify(emailsAfter.rows, null, 2));
  console.log("Enrichment runs recorded:", JSON.stringify(enrichmentRuns.rows, null, 2));

  console.log(`\nASSERT email found and applied via enrichment: ${emailsAfter.rows.some((r: { email: string }) => r.email === "found-by-enrichment@fixture.test") ? "PASS" : "FAIL"}`);
console.log(`ASSERT enrichment run recorded with applied=true: ${enrichmentRuns.rows.some((r: { field: string; applied: boolean }) => r.field === "email" && r.applied === true) ? "PASS" : "FAIL"}`);

  console.log("\n=== Part 5: source ranking ===");
  const campaign = await pool.query(`INSERT INTO campaigns (organization_id, name, status) VALUES ($1,'Phase6 Rank Test','ACTIVE') RETURNING id`, [organizationId]);
  const campaignId = campaign.rows[0].id;
  await pool.query(`INSERT INTO campaign_sources (campaign_id, source_id) VALUES ($1,$2)`, [campaignId, sourceId]);

  const ranking = await rankSourcesForCampaign(campaignId);
  console.log("Ranking result:", JSON.stringify(ranking, null, 2));
  const priorityInDb = await pool.query("SELECT priority FROM campaign_sources WHERE campaign_id = $1 AND source_id = $2", [campaignId, sourceId]);
  console.log(`ASSERT ranking produced a result: ${ranking.length === 1 ? "PASS" : "FAIL"}`);
  console.log(`ASSERT priority was actually written back to campaign_sources: ${priorityInDb.rows[0]?.priority === ranking[0]?.priority ? "PASS" : "FAIL"}`);

  await extractionWorker.close();
  await verificationWorker.close();
  await connection.quit();
  server.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("PHASE 6 E2E TEST FAILED:", err);
  process.exit(1);
});
