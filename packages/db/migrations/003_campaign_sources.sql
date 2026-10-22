-- Multi-source campaigns (Phase 5): a campaign's "approved source pool"
-- (Architecture V2 §5/§6) rather than the single source Phase 3's
-- runCampaignAgainstSource took directly.

CREATE TABLE campaign_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  source_id UUID NOT NULL REFERENCES sources(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  priority INT NOT NULL DEFAULT 0, -- higher runs first; source ranking (§8/§27) will write here in Phase 6
  UNIQUE (campaign_id, source_id)
);
CREATE INDEX idx_campaign_sources_campaign ON campaign_sources(campaign_id);
CREATE INDEX idx_campaign_sources_source ON campaign_sources(source_id);
