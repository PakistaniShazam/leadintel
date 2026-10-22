// Source Connector interface — Architecture V2 §7.
// A connector's job is narrow: given a discovery query, produce candidate
// URLs; given a URL, fetch + parse it into a PartialLeadRecord. Everything
// downstream (dedup, classification, scoring, storage) is connector-agnostic
// and lives outside this file.

export type SourceConnectorType =
  | "api"
  | "sitemap"
  | "rss"
  | "static_web"
  | "browser"
  | "user_import"
  | "search_discovery";

export type ComplianceMode =
  | "official_api"
  | "public_sitemap"
  | "public_rss"
  | "direct_crawl_robots_respected"
  | "user_provided";

export interface ConnectorCapabilities {
  supportsSearch: boolean;
  supportsPagination: boolean;
  supportsSitemap: boolean;
  supportsStructuredData: boolean;
  supportsJSRendering: boolean;
  requiresAIExtraction: boolean;
}

export interface SearchCriteria {
  countryCodes?: string[];
  industryKeywords?: string[];
  requiredFields?: string[];
  maxCandidates?: number;
}

export interface CandidateUrl {
  url: string;
  discoveredVia: string; // e.g. "sitemap:https://example.com/sitemap.xml"
}

export interface RawPageData {
  url: string;
  fetchedAt: string;
  status: number;
  contentType: string | null;
  body: string;
}

export interface PartialLeadRecord {
  companyName?: string;
  website?: string;
  description?: string;
  emails?: string[];
  phones?: string[];
  addressText?: string;
  sourceUrl: string;
  extractionMethod: "structured_data" | "deterministic_parse" | "ai_extraction";
  fieldConfidence?: Record<string, number>;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  concurrent: number;
}

export interface SourceHealth {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  status: "healthy" | "degraded" | "needs_attention";
}

export interface SourceConnector {
  id: string;
  type: SourceConnectorType;
  complianceMode: ComplianceMode;
  capabilities: ConnectorCapabilities;
  rateLimit: RateLimitConfig;

  discover(criteria: SearchCriteria): AsyncGenerator<CandidateUrl>;
  fetch(url: string): Promise<RawPageData>;
  parse(raw: RawPageData): Promise<PartialLeadRecord | null>;
}
