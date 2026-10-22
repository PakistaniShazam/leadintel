import type {
  AIProvider, ExtractionResult, ClassificationResult, CountryDetectionResult,
  RelevanceResult, SummaryResult, DiscoveryStrategy, SourceEvaluationResult, AIUsageRecord,
} from "./types.js";

// Real implementation against api.anthropic.com. Requires ANTHROPIC_API_KEY.
// Pricing constants below are for cost *estimation* only (ai_usage.estimated_cost_usd) —
// approximate, not billing-accurate; swap in real per-model rates before relying on them
// for the daily-spend cap (§31/§24 of the architecture).
const PRICE_PER_1K_INPUT_USD = 0.003;
const PRICE_PER_1K_OUTPUT_USD = 0.015;

function estimateCost(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1000) * PRICE_PER_1K_INPUT_USD + (tokensOut / 1000) * PRICE_PER_1K_OUTPUT_USD;
}

async function callClaude(apiKey: string, model: string, system: string, userMessage: string): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const text = data.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
  return {
    text,
    tokensIn: data.usage?.input_tokens ?? 0,
    tokensOut: data.usage?.output_tokens ?? 0,
  };
}

function parseJsonResponse<T>(text: string): T {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned) as T;
}

export function createAnthropicProvider(apiKey: string, model = "claude-sonnet-4-6"): AIProvider {
  async function run<T>(operation: string, tier: 1 | 2 | 3 | 4, system: string, userMessage: string): Promise<{ result: T; usage: AIUsageRecord }> {
    const { text, tokensIn, tokensOut } = await callClaude(apiKey, model, system, userMessage);
    const result = parseJsonResponse<T>(text);
    return {
      result,
      usage: { operation, tier, tokensIn, tokensOut, estimatedCostUsd: estimateCost(tokensIn, tokensOut) },
    };
  }

  return {
    name: "anthropic",
    model,

    extract(html, schemaDescription) {
      return run<ExtractionResult>(
        "extract", 3,
        "You extract structured business data from HTML. Respond ONLY with JSON matching this shape: " +
          `${schemaDescription}. Include a top-level "confidence" field (0-1) reflecting your certainty. ` +
          "Never invent data not present in the HTML.",
        html.slice(0, 8000)
      );
    },

    classifyIndustry(text, taxonomyOptions) {
      return run<ClassificationResult>(
        "classify_industry", 3,
        `Classify the business into exactly one of these categories: ${taxonomyOptions.join(", ")}. ` +
          'Respond ONLY with JSON: {"value": "...", "confidence": 0-1, "reasoning": "..."}',
        text.slice(0, 4000)
      );
    },

    detectCountry(signals) {
      return run<CountryDetectionResult>(
        "detect_country", 3,
        "Determine the country of this business from the provided signals (address, phone, domain, content). " +
          'Respond ONLY with JSON: {"country": "...", "countryCode": "ISO 3166-1 alpha-2", "confidence": 0-1, "evidence": "..."}',
        signals.slice(0, 2000)
      );
    },

    analyzeRelevance(leadText, campaignObjective) {
      return run<RelevanceResult>(
        "analyze_relevance", 3,
        `Campaign objective: "${campaignObjective}". Score how relevant this lead is to that objective (0-100) ` +
          'and list the supporting signals. Respond ONLY with JSON: {"score": 0-100, "signals": ["...", ...]}',
        leadText.slice(0, 4000)
      );
    },

    summarize(leadFacts) {
      return run<SummaryResult>(
        "summarize", 3,
        "Write a short (2-3 sentence) factual summary of this business using ONLY the facts provided. " +
          'Do not invent details. Respond ONLY with JSON: {"summary": "...", "citedEvidence": ["...", ...]}',
        leadFacts.slice(0, 4000)
      );
    },

    generateSearchStrategy(campaignDescription) {
      return run<DiscoveryStrategy[]>(
        "generate_search_strategy", 4,
        "Given a lead-generation campaign objective, propose 2-5 discovery strategies using only " +
          "compliant public source types (sitemap, rss, api, static_web, user_import — never anything " +
          "requiring bypassing access controls). Respond ONLY with a JSON array: " +
          '[{"name": "...", "description": "...", "sourceTypes": ["sitemap"], "searchQueries": ["...", ...]}]',
        campaignDescription
      );
    },

    evaluateSource(sampleText) {
      return run<SourceEvaluationResult>(
        "evaluate_source", 4,
        "Evaluate this sample of extracted records for data richness and business relevance. " +
          'Respond ONLY with JSON: {"qualityScore": 0-100, "reasoning": "..."}',
        sampleText.slice(0, 4000)
      );
    },
  };
}
