import type { AIProvider, AIUsageRecord } from "./types.js";

// Deterministic mock provider — no network call, zero cost. Used in tests
// (contract-tests the AIProvider interface itself, per §42 of the
// architecture) and as the default when ANTHROPIC_API_KEY isn't configured,
// so the system degrades to something inspectable rather than crashing.
function usage(operation: string, tier: 1 | 2 | 3 | 4): AIUsageRecord {
  return { operation, tier, tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 };
}

export function createMockProvider(): AIProvider {
  return {
    name: "mock",
    model: "mock-deterministic-v1",

    async extract(html) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return {
        result: { data: { companyName: titleMatch?.[1]?.trim() ?? null }, confidence: titleMatch ? 0.5 : 0.1 },
        usage: usage("extract", 3),
      };
    },

    async classifyIndustry(_text, taxonomyOptions) {
      return {
        result: { value: taxonomyOptions[0] ?? "Unknown", confidence: 0.3, reasoning: "mock provider — first taxonomy option, not a real classification" },
        usage: usage("classify_industry", 3),
      };
    },

    async detectCountry() {
      return {
        result: { country: "Unknown", countryCode: "XX", confidence: 0, evidence: "mock provider — no real detection performed" },
        usage: usage("detect_country", 3),
      };
    },

    async analyzeRelevance() {
      return {
        result: { score: 50, signals: ["mock provider — neutral score, no real analysis performed"] },
        usage: usage("analyze_relevance", 3),
      };
    },

    async summarize(leadFacts) {
      return {
        result: { summary: leadFacts.slice(0, 140), citedEvidence: [] },
        usage: usage("summarize", 3),
      };
    },

    async generateSearchStrategy(campaignDescription) {
      return {
        result: [
          {
            name: "Sitemap discovery (mock)",
            description: `Placeholder strategy for: ${campaignDescription.slice(0, 100)}`,
            sourceTypes: ["sitemap"],
            searchQueries: [],
          },
        ],
        usage: usage("generate_search_strategy", 4),
      };
    },

    async evaluateSource() {
      return {
        result: { qualityScore: 50, reasoning: "mock provider — placeholder score" },
        usage: usage("evaluate_source", 4),
      };
    },
  };
}
