-- Lead Intelligence Platform — initial schema
-- Raw SQL (Prisma engine binaries unreachable in this sandbox's network allowlist;
-- pivoted to plain SQL + `pg` driver, which needs no binary download).

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE role_name AS ENUM ('OWNER','ADMIN','MEMBER','VIEWER');

CREATE TABLE memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  role role_name NOT NULL DEFAULT 'MEMBER',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);

CREATE TABLE industries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  industry_id UUID NOT NULL REFERENCES industries(id),
  name TEXT NOT NULL,
  UNIQUE (industry_id, name)
);

CREATE TABLE subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  UNIQUE (category_id, name)
);

CREATE TABLE countries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  phone_code TEXT,
  tld TEXT
);

CREATE TYPE source_type AS ENUM ('API','SITEMAP','RSS','STATIC_WEB','BROWSER','USER_IMPORT','SEARCH_DISCOVERY');
CREATE TYPE compliance_mode AS ENUM ('OFFICIAL_API','PUBLIC_SITEMAP','PUBLIC_RSS','DIRECT_CRAWL_ROBOTS_RESPECTED','USER_PROVIDED');

CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  type source_type NOT NULL,
  compliance_mode compliance_mode NOT NULL,
  base_url TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  rate_limit_per_min INT NOT NULL DEFAULT 30,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sources_org ON sources(organization_id);

CREATE TABLE source_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id),
  campaign_run_id UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  requests INT NOT NULL DEFAULT 0,
  successes INT NOT NULL DEFAULT 0,
  failures INT NOT NULL DEFAULT 0,
  leads_found INT NOT NULL DEFAULT 0,
  error_summary TEXT
);
CREATE INDEX idx_source_runs_source ON source_runs(source_id);

CREATE TABLE source_quality_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id),
  quality_score INT NOT NULL,
  data_completeness REAL NOT NULL,
  contact_availability REAL NOT NULL,
  industry_relevance REAL NOT NULL,
  country_relevance REAL NOT NULL,
  compliance_score REAL NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sqm_source ON source_quality_metrics(source_id);

CREATE TABLE source_performance_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  leads_discovered INT NOT NULL DEFAULT 0,
  valid_leads INT NOT NULL DEFAULT 0,
  verified_leads INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  average_score REAL NOT NULL DEFAULT 0,
  ai_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_sph_source ON source_performance_history(source_id);

CREATE TYPE verification_status AS ENUM ('VERIFIED','PARTIALLY_VERIFIED','UNVERIFIED','INVALID','NEEDS_REVIEW');
CREATE TYPE lead_status AS ENUM ('NEW','REVIEWED','CONTACTED','INTERESTED','NOT_INTERESTED','CONVERTED','ARCHIVED');
CREATE TYPE freshness AS ENUM ('FRESH','AGING','STALE','VERY_STALE');
CREATE TYPE email_type AS ENUM ('GENERIC_BUSINESS','DEPARTMENT','PROFESSIONAL_INDIVIDUAL','UNKNOWN');

CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  company_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website TEXT,
  domain TEXT,
  description TEXT,
  country TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  postal_code TEXT,
  industry_id UUID REFERENCES industries(id),
  category_id UUID REFERENCES categories(id),
  subcategory_id UUID REFERENCES subcategories(id),
  lead_score INT,
  data_confidence REAL,
  status lead_status NOT NULL DEFAULT 'NEW',
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  freshness freshness NOT NULL DEFAULT 'FRESH',
  ai_summary TEXT,
  first_discovered TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_discovered TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified TIMESTAMPTZ,
  last_enriched TIMESTAMPTZ,
  last_meaningful_change TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_org ON leads(organization_id);
CREATE INDEX idx_leads_norm_name ON leads(normalized_name);
CREATE INDEX idx_leads_domain ON leads(domain);
CREATE INDEX idx_leads_country ON leads(country_code);

CREATE TABLE lead_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  tag TEXT NOT NULL,
  UNIQUE (lead_id, tag)
);

CREATE TABLE lead_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  source_id UUID NOT NULL REFERENCES sources(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url TEXT,
  UNIQUE (lead_id, source_id)
);

CREATE TABLE lead_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  job_title TEXT,
  department TEXT,
  profile_url TEXT,
  source TEXT,
  confidence REAL,
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  first_discovered TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified TIMESTAMPTZ
);
CREATE INDEX idx_lead_contacts_lead ON lead_contacts(lead_id);

CREATE TABLE lead_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  email TEXT NOT NULL,
  type email_type NOT NULL DEFAULT 'UNKNOWN',
  domain TEXT,
  domain_status TEXT,
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  verified_at TIMESTAMPTZ,
  source TEXT,
  confidence REAL
);
CREATE INDEX idx_lead_emails_lead ON lead_emails(lead_id);

CREATE TABLE contact_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES lead_contacts(id),
  email TEXT NOT NULL,
  type email_type NOT NULL DEFAULT 'UNKNOWN',
  domain TEXT,
  domain_status TEXT,
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  verified_at TIMESTAMPTZ,
  source TEXT,
  confidence REAL
);
CREATE INDEX idx_contact_emails_contact ON contact_emails(contact_id);

CREATE TABLE contact_phones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES lead_contacts(id),
  phone TEXT NOT NULL,
  verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  source TEXT,
  confidence REAL
);
CREATE INDEX idx_contact_phones_contact ON contact_phones(contact_id);

CREATE TABLE lead_history_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  event_type TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lhe_lead ON lead_history_events(lead_id);

CREATE TABLE lead_change_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lce_lead ON lead_change_events(lead_id);

CREATE TABLE lead_field_provenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  source_name TEXT,
  confidence REAL,
  evidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lfp_lead_field ON lead_field_provenance(lead_id, field);

CREATE TABLE lead_enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  field TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  source TEXT,
  method TEXT,
  confidence REAL,
  applied BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ler_lead ON lead_enrichment_runs(lead_id);

CREATE TABLE ai_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT,
  model_version TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_aic_lead ON ai_classifications(lead_id);

CREATE TABLE classification_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classification_id UUID REFERENCES ai_classifications(id),
  lead_id UUID NOT NULL,
  field TEXT NOT NULL,
  original_value TEXT NOT NULL,
  corrected_value TEXT NOT NULL,
  reason TEXT,
  user_id UUID NOT NULL REFERENCES users(id),
  model_version TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id),
  check_type TEXT NOT NULL,
  result TEXT NOT NULL,
  details JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vr_lead ON verification_results(lead_id);

CREATE TYPE campaign_status AS ENUM ('DRAFT','ACTIVE','PAUSED','COMPLETED');

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  status campaign_status NOT NULL DEFAULT 'DRAFT',
  include_countries TEXT[] NOT NULL DEFAULT '{}',
  exclude_countries TEXT[] NOT NULL DEFAULT '{}',
  industry_id UUID REFERENCES industries(id),
  category_id UUID REFERENCES categories(id),
  subcategory_id UUID REFERENCES subcategories(id),
  required_fields TEXT[] NOT NULL DEFAULT '{}',
  quality_bar INT NOT NULL DEFAULT 0,
  target_leads INT NOT NULL DEFAULT 0,
  schedule_cron TEXT,
  max_runtime_min INT NOT NULL DEFAULT 60,
  max_requests INT NOT NULL DEFAULT 5000,
  max_ai_cost_usd REAL NOT NULL DEFAULT 5.0,
  search_strategy JSONB,
  strategy_approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaigns_org ON campaigns(organization_id);

CREATE TABLE campaign_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  discovered INT NOT NULL DEFAULT 0,
  new_leads INT NOT NULL DEFAULT 0,
  duplicates INT NOT NULL DEFAULT 0,
  invalid INT NOT NULL DEFAULT 0,
  verified INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  ai_cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_campaign_runs_campaign ON campaign_runs(campaign_id);

ALTER TABLE source_runs ADD CONSTRAINT fk_source_runs_campaign_run
  FOREIGN KEY (campaign_run_id) REFERENCES campaign_runs(id);

CREATE TABLE campaign_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  lead_id UUID NOT NULL REFERENCES leads(id),
  campaign_relevance REAL,
  signals JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX idx_cl_campaign ON campaign_leads(campaign_id);
CREATE INDEX idx_cl_lead ON campaign_leads(lead_id);

CREATE TABLE scoring_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  weights JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation TEXT NOT NULL,
  tier INT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  campaign_id UUID,
  source_id UUID,
  lead_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_campaign ON ai_usage(campaign_id);
CREATE INDEX idx_ai_usage_created ON ai_usage(created_at);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org ON audit_logs(organization_id);
