import { pool } from "./db.js";
import { jaroWinklerSimilarity, normalizeCompanyName, normalizeDomain } from "./normalize.js";

export interface DuplicateCandidate {
  leadId: string;
  companyName: string;
  domain: string | null;
  similarity: number;
  matchReasons: string[];
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;      // above high-confidence auto-merge threshold
  needsReview: boolean;      // mid-range — goes to review queue, not auto-merged
  candidates: DuplicateCandidate[];
}

const AUTO_MERGE_THRESHOLD = 0.93;
const REVIEW_THRESHOLD = 0.75;

/**
 * Stage 1 (blocking): find candidates via cheap, indexed lookups only —
 * exact domain match or normalized-name match. This keeps the expensive
 * stage 2 scoring limited to a small candidate set instead of scanning
 * every lead in the org.
 */
async function findBlockingCandidates(
  organizationId: string,
  normalizedName: string,
  domain: string | null
): Promise<{ id: string; company_name: string; domain: string | null }[]> {
  const conditions: string[] = ["organization_id = $1"];
  const params: any[] = [organizationId];
  let i = 2;

  const orClauses: string[] = [];
  orClauses.push(`normalized_name = $${i++}`);
  params.push(normalizedName);
  if (domain) {
    orClauses.push(`domain = $${i++}`);
    params.push(domain);
  }

  const sql = `
    SELECT id, company_name, domain FROM leads
    WHERE ${conditions.join(" AND ")} AND (${orClauses.join(" OR ")})
    LIMIT 25
  `;
  const result = await pool.query(sql, params);
  return result.rows;
}

/**
 * Stage 2 (scoring): weighted combination of name similarity + domain match.
 * Deterministic and explainable — no AI call. Per the architecture, an AI
 * similarity call is reserved for genuinely ambiguous pairs, which this
 * function doesn't attempt on its own; the caller can escalate borderline
 * cases (candidates in the REVIEW_THRESHOLD..AUTO_MERGE_THRESHOLD band) to
 * an AI check later if desired.
 */
function scoreCandidate(
  candidateNormalizedName: string,
  candidateDomain: string | null,
  targetNormalizedName: string,
  targetDomain: string | null
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const nameSim = jaroWinklerSimilarity(candidateNormalizedName, targetNormalizedName);
  if (nameSim > 0.85) reasons.push(`name similarity ${(nameSim * 100).toFixed(0)}%`);

  const domainMatch = !!candidateDomain && !!targetDomain && candidateDomain === targetDomain;
  if (domainMatch) reasons.push("exact domain match");

  // Domain match is a very strong signal on its own; name similarity alone
  // needs to be high to count for much (avoids "Smith Dental" == "Smith Auto").
  let score: number;
  if (domainMatch && nameSim > 0.5) {
    score = 0.6 + 0.4 * nameSim; // domain match anchors confidence high
  } else if (domainMatch) {
    score = 0.7; // same domain, dissimilar names — still notable, flagged not auto-merged
  } else {
    score = nameSim * 0.85; // name-only match capped below auto-merge threshold
  }

  return { score, reasons };
}

export async function checkForDuplicates(
  organizationId: string,
  companyName: string,
  website: string | null
): Promise<DuplicateCheckResult> {
  const normalizedName = normalizeCompanyName(companyName);
  const domain = website ? normalizeDomain(website) : null;

  const blocked = await findBlockingCandidates(organizationId, normalizedName, domain);

  const candidates: DuplicateCandidate[] = blocked.map((row) => {
    const candNormalized = normalizeCompanyName(row.company_name);
    const { score, reasons } = scoreCandidate(candNormalized, row.domain, normalizedName, domain);
    return {
      leadId: row.id,
      companyName: row.company_name,
      domain: row.domain,
      similarity: score,
      matchReasons: reasons,
    };
  });

  candidates.sort((a, b) => b.similarity - a.similarity);
  const top = candidates[0];

  return {
    isDuplicate: !!top && top.similarity >= AUTO_MERGE_THRESHOLD,
    needsReview: !!top && top.similarity >= REVIEW_THRESHOLD && top.similarity < AUTO_MERGE_THRESHOLD,
    candidates,
  };
}
