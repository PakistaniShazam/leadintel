-- Review Queue (Architecture V2 §16/§29) as a first-class table rather than
-- parsing lead_history_events by string match. Written explicitly at the
-- points that already detect review-worthy conditions (dedup ambiguity,
-- low-confidence classification, unmapped taxonomy values, budget-skipped
-- classification) instead of inferred after the fact.

CREATE TYPE review_priority AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE review_status AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

CREATE TABLE review_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  reason TEXT NOT NULL, -- e.g. 'duplicate_candidate_ambiguous', 'low_confidence_country', 'classification_unmapped', 'website_domain_changed'
  priority review_priority NOT NULL,
  status review_status NOT NULL DEFAULT 'OPEN',
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolution TEXT -- 'approved' | 'rejected' | 'corrected', free text explanation
);
CREATE INDEX idx_review_flags_lead ON review_flags(lead_id);
CREATE INDEX idx_review_flags_status_priority ON review_flags(status, priority);
