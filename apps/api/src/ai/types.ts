// AI Provider abstraction — Architecture V2 §23. Every AI-touching
// operation in the platform goes through this interface so the provider
// (Claude/OpenAI/mock) is swappable and every call is logged for cost
// tracking (§24) without each caller having to remember to do it.

export interface ExtractionResult {
  data: Record<string, unknown>;
  confidence: number;
}

export interface ClassificationResult {
  value: string;
  confidence: number;
  reasoning: string;
}

export interface CountryDetectionResult {
  country: string;
  countryCode: string;
  confidence: number;
  evidence: string;
}

export interface RelevanceResult {
  score: number; // 0-100
  signals: string[];
}

export interface SummaryResult {
  summary: string;
  citedEvidence: string[];
}

export interface DiscoveryStrategy {
  name: string;
  description: string;
  sourceTypes: string[]; // e.g. ["sitemap", "rss", "api"]
  searchQueries: string[];
}

export interface SourceEvaluationResult {
  qualityScore: number; // 0-100
  reasoning: string;
}

export interface AIUsageRecord {
  operation: string;
  tier: 1 | 2 | 3 | 4;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
}

export interface AIProvider {
  readonly name: string;
  readonly model: string;

  extract(html: string, schemaDescription: string): Promise<{ result: ExtractionResult; usage: AIUsageRecord }>;
  classifyIndustry(text: string, taxonomyOptions: string[]): Promise<{ result: ClassificationResult; usage: AIUsageRecord }>;
  detectCountry(signals: string): Promise<{ result: CountryDetectionResult; usage: AIUsageRecord }>;
  analyzeRelevance(leadText: string, campaignObjective: string): Promise<{ result: RelevanceResult; usage: AIUsageRecord }>;
  summarize(leadFacts: string): Promise<{ result: SummaryResult; usage: AIUsageRecord }>;
  generateSearchStrategy(campaignDescription: string): Promise<{ result: DiscoveryStrategy[]; usage: AIUsageRecord }>;
  evaluateSource(sampleText: string): Promise<{ result: SourceEvaluationResult; usage: AIUsageRecord }>;
}
