import { XMLParser } from "fast-xml-parser";
import type { SourceConnector, CandidateUrl, RawPageData, PartialLeadRecord, SearchCriteria } from "./types.js";

const xmlParser = new XMLParser({ ignoreAttributes: false });

/**
 * Sitemap-based connector — one of the two safest compliance postures in the
 * architecture (public_sitemap), since sitemap.xml is explicitly published
 * by the site owner for the purpose of being crawled/indexed. This connector
 * doesn't decide which site to point at — that's the discovery
 * orchestrator's job (Phase 5) — it just knows how to walk a given sitemap
 * and extract candidate pages, then structured business data from them.
 */
export function createSitemapConnector(baseUrl: string): SourceConnector {
  return {
    id: `sitemap:${baseUrl}`,
    type: "sitemap",
    complianceMode: "public_sitemap",
    capabilities: {
      supportsSearch: false,
      supportsPagination: true,
      supportsSitemap: true,
      supportsStructuredData: true,
      supportsJSRendering: false,
      requiresAIExtraction: false, // structured data first; AI fallback wired in Phase 4
    },
    rateLimit: { requestsPerMinute: 20, concurrent: 2 },

    async *discover(_criteria: SearchCriteria): AsyncGenerator<CandidateUrl> {
      const sitemapUrl = new URL("/sitemap.xml", baseUrl).toString();
      const res = await fetch(sitemapUrl, { headers: { "User-Agent": "LeadIntelBot/0.1 (+compliant sitemap crawler)" } });
      if (!res.ok) return;
      const xml = await res.text();
      yield* parseSitemapXml(xml, sitemapUrl);
    },

    async fetch(url: string): Promise<RawPageData> {
      const res = await fetch(url, { headers: { "User-Agent": "LeadIntelBot/0.1 (+compliant sitemap crawler)" } });
      const body = await res.text();
      return {
        url,
        fetchedAt: new Date().toISOString(),
        status: res.status,
        contentType: res.headers.get("content-type"),
        body,
      };
    },

    async parse(raw: RawPageData): Promise<PartialLeadRecord | null> {
      return parseBusinessPage(raw);
    },
  };
}

// Exported separately so it can be exercised against a fixture without a
// live network call — this is what got tested in this session.
export function* parseSitemapXml(xml: string, sourceUrl: string): Generator<CandidateUrl> {
  let parsed: any;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return;
  }

  const urlset = parsed?.urlset?.url;
  if (!urlset) return;
  const entries = Array.isArray(urlset) ? urlset : [urlset];
  for (const entry of entries) {
    const loc = entry?.loc;
    if (typeof loc === "string" && loc.startsWith("http")) {
      yield { url: loc, discoveredVia: `sitemap:${sourceUrl}` };
    }
  }
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

// Deterministic-first extraction: try schema.org JSON-LD structured data,
// fall back to plain-HTML pattern extraction (mailto/tel links, regex scan
// of visible text). AI extraction only kicks in later (Phase 4) when this
// still leaves required fields empty.
export function parseBusinessPage(raw: RawPageData): PartialLeadRecord | null {
  if (raw.status !== 200 || !raw.body) return null;

  const jsonLdMatches = [...raw.body.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const type = entry["@type"];
        const isOrg = type === "Organization" || type === "LocalBusiness" || (Array.isArray(type) && type.includes("LocalBusiness"));
        if (isOrg && entry.name) {
          return {
            companyName: entry.name,
            website: entry.url ?? raw.url,
            description: entry.description,
            emails: entry.email ? [entry.email] : extractEmails(raw.body),
            phones: entry.telephone ? [entry.telephone] : extractPhones(raw.body),
            addressText: formatAddress(entry.address),
            sourceUrl: raw.url,
            extractionMethod: "structured_data",
            fieldConfidence: { companyName: 0.98, website: 0.98 },
          };
        }
      }
    } catch {
      // malformed JSON-LD — fall through to deterministic parse
    }
  }

  // No structured data — deterministic pattern extraction from raw HTML.
  const emails = extractEmails(raw.body);
  const phones = extractPhones(raw.body);
  const titleMatch = raw.body.match(/<title[^>]*>([^<]+)<\/title>/i);

  if (!titleMatch && emails.length === 0) return null; // nothing usable

  return {
    companyName: titleMatch ? titleMatch[1].trim() : undefined,
    website: raw.url,
    emails,
    phones,
    sourceUrl: raw.url,
    extractionMethod: "deterministic_parse",
    fieldConfidence: titleMatch ? { companyName: 0.4 } : undefined, // low confidence — <title> is a weak signal, may trigger AI fallback in Phase 4
  };
}

function extractEmails(html: string): string[] {
  const mailtoMatches = [...html.matchAll(/mailto:([^"'\s?]+)/gi)].map((m) => m[1]);
  const textMatches = html.match(EMAIL_RE) ?? [];
  return [...new Set([...mailtoMatches, ...textMatches])].filter((e) => !e.includes(".png") && !e.includes(".jpg"));
}

function extractPhones(html: string): string[] {
  const telMatches = [...html.matchAll(/tel:([^"'\s]+)/gi)].map((m) => m[1]);
  return [...new Set(telMatches)];
}

function formatAddress(address: any): string | undefined {
  if (!address) return undefined;
  if (typeof address === "string") return address;
  const parts = [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry];
  return parts.filter(Boolean).join(", ");
}
