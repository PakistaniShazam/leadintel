-- Adds organization scoping to ai_usage so the daily-spend cap (§24/§31)
-- can be enforced per-organization instead of platform-wide. Discovered as
-- a gap while wiring the cost-tracking wrapper in Phase 3 — fixed rather
-- than left as a known limitation, since it's a one-column, backward
-- compatible addition (nullable, indexed).

ALTER TABLE ai_usage ADD COLUMN organization_id UUID REFERENCES organizations(id);
CREATE INDEX idx_ai_usage_org ON ai_usage(organization_id);
