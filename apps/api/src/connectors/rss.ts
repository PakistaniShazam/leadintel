import { XMLParser } from "fast-xml-parser";
import type { SourceConnector, CandidateUrl, RawPageData, PartialLeadRecord, SearchCriteria } from "./types.js";
import { parseBusinessPage } from "./sitemap.js";

const xmlParser = new XMLParser({ ignoreAttributes: false });

/**
 * RSS/Atom connector — same compliance posture as sitemap (public_rss):
 * the feed is explicitly published by the site owner for consumption.
 * Reuses parseBusinessPage from the sitemap connector for the actual page
 * extraction, since "structured-data-first, deterministic-HTML-fallback"
 * doesn't change based on how the URL was discovered — only discover()
 * differs between connector types.
 */
export function createRssConnector(feedUrl: string): SourceConnector {
  return {
    id: `rss:${feedUrl}`,
    type: "rss",
    complianceMode: "public_rss",
    capabilities: {
      supportsSearch: false,
      supportsPagination: false,
      supportsSitemap: false,
      supportsStructuredData: true,
      supportsJSRendering: false,
      requiresAIExtraction: false,
    },
    rateLimit: { requestsPerMinute: 20, concurrent: 2 },

    async *discover(_criteria: SearchCriteria): AsyncGenerator<CandidateUrl> {
      const res = await fetch(feedUrl, { headers: { "User-Agent": "LeadIntelBot/0.1 (+compliant RSS reader)" } });
      if (!res.ok) return;
      const xml = await res.text();
      yield* parseRssFeed(xml, feedUrl);
    },

    async fetch(url: string): Promise<RawPageData> {
      const res = await fetch(url, { headers: { "User-Agent": "LeadIntelBot/0.1 (+compliant RSS reader)" } });
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

// Exported separately so it can be tested against a fixture without a live
// network call, same pattern as parseSitemapXml.
export function* parseRssFeed(xml: string, sourceUrl: string): Generator<CandidateUrl> {
  let parsed: any;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return;
  }

  // Support both RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>).
  const rssItems = parsed?.rss?.channel?.item;
  const atomEntries = parsed?.feed?.entry;

  if (rssItems) {
    const entries = Array.isArray(rssItems) ? rssItems : [rssItems];
    for (const entry of entries) {
      const link = typeof entry?.link === "string" ? entry.link : entry?.link?.["#text"];
      if (typeof link === "string" && link.startsWith("http")) {
        yield { url: link, discoveredVia: `rss:${sourceUrl}` };
      }
    }
    return;
  }

  if (atomEntries) {
    const entries = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    for (const entry of entries) {
      // Atom <link href="..."/> is an attribute, not text content.
      const link = entry?.link?.["@_href"] ?? (typeof entry?.link === "string" ? entry.link : undefined);
      if (typeof link === "string" && link.startsWith("http")) {
        yield { url: link, discoveredVia: `rss:${sourceUrl}` };
      }
    }
  }
}
