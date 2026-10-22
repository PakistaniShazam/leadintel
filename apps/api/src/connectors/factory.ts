import type { SourceConnector } from "./types.js";
import { createSitemapConnector } from "./sitemap.js";
import { createRssConnector } from "./rss.js";

/**
 * Single dispatch point from a `sources.type` DB value (uppercase, per the
 * Postgres enum: SITEMAP/RSS/API/...) to a connector instance. Both the
 * orchestrator (needs discover()) and the extraction worker (needs
 * fetch()/parse()) go through this instead of each hardcoding which
 * connector to instantiate — adding a third connector type means adding
 * one case here, not touching the orchestrator or worker.
 */
export function createConnectorForSource(source: { type: string; baseUrl: string }): SourceConnector {
  switch (source.type) {
    case "SITEMAP":
      return createSitemapConnector(source.baseUrl);
    case "RSS":
      return createRssConnector(source.baseUrl);
    default:
      throw new Error(
        `Connector type "${source.type}" not implemented yet. Implemented: SITEMAP, RSS. ` +
          `(API, STATIC_WEB, BROWSER, USER_IMPORT, SEARCH_DISCOVERY are typed in the schema but have no connector implementation yet.)`
      );
  }
}
