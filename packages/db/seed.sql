-- Base reference data (§5 of the deployment request: "taxonomy initialization,
-- country data"). Idempotent — safe to run multiple times (ON CONFLICT DO NOTHING).
-- This is starter data, not exhaustive; the admin endpoints (POST /industries,
-- /industries/:id/categories, /countries) let you extend it without touching code.

INSERT INTO industries (name) VALUES
  ('Healthcare'), ('Education'), ('Real Estate'), ('Technology'),
  ('Professional Services'), ('Retail'), ('Hospitality'), ('Construction'),
  ('Manufacturing'), ('Financial Services')
ON CONFLICT (name) DO NOTHING;

INSERT INTO categories (industry_id, name)
SELECT id, cat FROM industries, unnest(ARRAY['Dental', 'Medical Clinic', 'Physiotherapy', 'Veterinary']) AS cat
WHERE industries.name = 'Healthcare'
ON CONFLICT (industry_id, name) DO NOTHING;

INSERT INTO categories (industry_id, name)
SELECT id, cat FROM industries, unnest(ARRAY['Education Consultancy', 'Tutoring', 'Language School', 'Vocational Training']) AS cat
WHERE industries.name = 'Education'
ON CONFLICT (industry_id, name) DO NOTHING;

INSERT INTO categories (industry_id, name)
SELECT id, cat FROM industries, unnest(ARRAY['Commercial Real Estate', 'Residential Real Estate', 'Property Management']) AS cat
WHERE industries.name = 'Real Estate'
ON CONFLICT (industry_id, name) DO NOTHING;

INSERT INTO categories (industry_id, name)
SELECT id, cat FROM industries, unnest(ARRAY['Software', 'SaaS', 'IT Services', 'Web Design']) AS cat
WHERE industries.name = 'Technology'
ON CONFLICT (industry_id, name) DO NOTHING;

INSERT INTO categories (industry_id, name)
SELECT id, cat FROM industries, unnest(ARRAY['Legal', 'Accounting', 'Consulting', 'Marketing Agency']) AS cat
WHERE industries.name = 'Professional Services'
ON CONFLICT (industry_id, name) DO NOTHING;

-- Countries: a reasonable common-target starter set, not all 195. Add more
-- via POST /countries as needed — this seed just gets you unblocked.
INSERT INTO countries (name, code, phone_code, tld) VALUES
  ('Australia', 'AU', '+61', '.au'),
  ('United Kingdom', 'GB', '+44', '.uk'),
  ('United States', 'US', '+1', '.us'),
  ('Canada', 'CA', '+1', '.ca'),
  ('New Zealand', 'NZ', '+64', '.nz'),
  ('Ireland', 'IE', '+353', '.ie'),
  ('Singapore', 'SG', '+65', '.sg'),
  ('Germany', 'DE', '+49', '.de'),
  ('France', 'FR', '+33', '.fr'),
  ('India', 'IN', '+91', '.in')
ON CONFLICT (code) DO NOTHING;
