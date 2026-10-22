import { Worker } from "bullmq";
import { connection, type VerificationJobData } from "../queues/index.js";
import { pool } from "../lib/db.js";
import { checkEmailSyntax, checkPhoneFormat, checkDomainDns } from "./checks.js";
import { computeLeadScore } from "../scoring/engine.js";

export function startVerificationWorker(): Worker {
  return new Worker<VerificationJobData>(
    "verification",
    async (job) => {
      const { leadId } = job.data;

      const lead = await pool.query("SELECT id, domain FROM leads WHERE id = $1", [leadId]);
      if (lead.rows.length === 0) return { skipped: "lead not found" };

      const emails = await pool.query("SELECT email FROM lead_emails WHERE lead_id = $1", [leadId]);
      const results: { checkType: string; result: string }[] = [];

      for (const row of emails.rows) {
        const check = checkEmailSyntax(row.email);
        await pool.query(
          `INSERT INTO verification_results (lead_id, check_type, result, details) VALUES ($1,$2,$3,$4)`,
          [leadId, check.checkType, check.result, JSON.stringify(check.details)]
        );
        results.push(check);
      }

      const domain = lead.rows[0].domain;
      if (domain) {
        const dnsCheck = await checkDomainDns(domain);
        await pool.query(
          `INSERT INTO verification_results (lead_id, check_type, result, details) VALUES ($1,$2,$3,$4)`,
          [leadId, dnsCheck.checkType, dnsCheck.result, JSON.stringify(dnsCheck.details)]
        );
        results.push(dnsCheck);
      }

      // Roll up into an overall verification_status (deterministic rule, no AI —
      // matches the Tier 1/2 vs Tier 3/4 split in §23).
      const anyFail = results.some((r) => r.result === "fail");
      const allPass = results.length > 0 && results.every((r) => r.result === "pass");
      const status = anyFail ? "INVALID" : allPass ? "VERIFIED" : "PARTIALLY_VERIFIED";

      await pool.query(
        `UPDATE leads SET verification_status = $1, last_verified = now(), updated_at = now() WHERE id = $2`,
        [status, leadId]
      );

      // Score after verification settles — verification_status feeds directly
      // into both Lead Score and Data Confidence (§25), so scoring runs after,
      // not before or in parallel with, the verification rollup above.
      const scoreBreakdown = await computeLeadScore(leadId);

      return { checksRun: results.length, status, scoreBreakdown };
    },
    { connection, concurrency: 5 }
  );
}
