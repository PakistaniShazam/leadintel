import { z } from "zod";

/**
 * Shared between GET /leads and GET /leads/export so filtering behavior
 * can't drift between the two — an export should show exactly what the
 * list view showed, per §23's "exports must respect currently selected
 * filters."
 */
export const leadFilterSchema = z.object({
  country: z.string().optional(),
  status: z.string().optional(),
  verificationStatus: z.string().optional(),
  minScore: z.coerce.number().optional(),
  maxScore: z.coerce.number().optional(),
  hasEmail: z.coerce.boolean().optional(),
  search: z.string().optional(),
});

export type LeadFilters = z.infer<typeof leadFilterSchema>;

export function buildLeadFilterClause(orgId: string, q: LeadFilters, startParamIndex = 2): { where: string; params: any[]; nextIndex: number } {
  const conditions: string[] = ["l.organization_id = $1"];
  const params: any[] = [orgId];
  let i = startParamIndex;

  if (q.country) {
    conditions.push(`l.country_code = $${i++}`);
    params.push(q.country);
  }
  if (q.status) {
    conditions.push(`l.status = $${i++}`);
    params.push(q.status);
  }
  if (q.verificationStatus) {
    conditions.push(`l.verification_status = $${i++}`);
    params.push(q.verificationStatus);
  }
  if (q.minScore !== undefined) {
    conditions.push(`l.lead_score >= $${i++}`);
    params.push(q.minScore);
  }
  if (q.maxScore !== undefined) {
    conditions.push(`l.lead_score <= $${i++}`);
    params.push(q.maxScore);
  }
  if (q.hasEmail) {
    conditions.push(`EXISTS (SELECT 1 FROM lead_emails le WHERE le.lead_id = l.id)`);
  }
  if (q.search) {
    conditions.push(`(l.company_name ILIKE $${i} OR l.website ILIKE $${i} OR l.city ILIKE $${i})`);
    params.push(`%${q.search}%`);
    i++;
  }

  return { where: conditions.join(" AND "), params, nextIndex: i };
}
