import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSitemapXml, parseBusinessPage } from "../../src/connectors/sitemap.js";
import { parseRssFeed } from "../../src/connectors/rss.js";

describe("sitemap XML parsing", () => {
  const sampleSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example-dental.com.au/</loc></url>
  <url><loc>https://example-dental.com.au/about</loc></url>
  <url><loc>https://example-dental.com.au/contact</loc></url>
</urlset>`;

  test("yields all candidate URLs from a valid sitemap", () => {
    const urls = [...parseSitemapXml(sampleSitemap, "https://example-dental.com.au/sitemap.xml")];
    assert.equal(urls.length, 3);
    assert.equal(urls[0].url, "https://example-dental.com.au/");
    assert.ok(urls[0].discoveredVia.startsWith("sitemap:"));
  });

  test("malformed XML degrades to zero candidates without throwing", () => {
    const urls = [...parseSitemapXml("<not valid xml", "x")];
    assert.equal(urls.length, 0);
  });
});

describe("business page extraction — structured data (JSON-LD)", () => {
  const jsonLdHtml = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"LocalBusiness","name":"Example Dental Clinic",
 "url":"https://example-dental.com.au","description":"General and cosmetic dentistry in Sydney.",
 "email":"contact@example-dental.com.au","telephone":"+61 2 9000 0000",
 "address":{"streetAddress":"1 Smith St","addressLocality":"Sydney","addressRegion":"NSW","postalCode":"2000","addressCountry":"AU"}}
</script>
</head><body>Some content <a href="mailto:info@example-dental.com.au">Email us</a></body></html>`;

  const structured = parseBusinessPage({
    url: "https://example-dental.com.au/",
    fetchedAt: new Date().toISOString(),
    status: 200,
    contentType: "text/html",
    body: jsonLdHtml,
  });

  test("extracts company name from JSON-LD", () => {
    assert.equal(structured?.companyName, "Example Dental Clinic");
  });

  test("tags the extraction method as structured_data (deterministic, no AI)", () => {
    assert.equal(structured?.extractionMethod, "structured_data");
  });

  test("extracts email from JSON-LD", () => {
    assert.ok(structured?.emails?.includes("contact@example-dental.com.au"));
  });

  test("formats address from the JSON-LD address object", () => {
    assert.ok(structured?.addressText?.includes("Sydney"));
  });

  test("assigns high field confidence to structured data", () => {
    assert.ok((structured?.fieldConfidence?.companyName ?? 0) > 0.9);
  });
});

describe("business page extraction — deterministic HTML fallback (no JSON-LD)", () => {
  const plainHtml = `<html><head><title>Bob's Plumbing | Sydney</title></head>
<body>Call us at <a href="tel:+61298765432">+61 2 9876 5432</a> or email
<a href="mailto:info@bobsplumbing.com.au">info@bobsplumbing.com.au</a></body></html>`;

  const fallback = parseBusinessPage({
    url: "https://bobsplumbing.com.au/",
    fetchedAt: new Date().toISOString(),
    status: 200,
    contentType: "text/html",
    body: plainHtml,
  });

  test("tags the extraction method as deterministic_parse", () => {
    assert.equal(fallback?.extractionMethod, "deterministic_parse");
  });

  test("extracts email from a mailto: link", () => {
    assert.ok(fallback?.emails?.includes("info@bobsplumbing.com.au"));
  });

  test("extracts phone from a tel: link", () => {
    assert.ok(fallback?.phones?.includes("+61298765432"));
  });

  test("flags a <title>-derived company name as low confidence", () => {
    assert.ok((fallback?.fieldConfidence?.companyName ?? 1) < 0.5);
  });
});

describe("business page extraction — no usable data", () => {
  test("404 response yields no partial record", () => {
    const result = parseBusinessPage({ url: "https://dead.example.com/", fetchedAt: new Date().toISOString(), status: 404, contentType: null, body: "" });
    assert.equal(result, null);
  });

  test("page with no title/email/JSON-LD yields no record rather than a hallucinated one", () => {
    const result = parseBusinessPage({ url: "https://example.com/", fetchedAt: new Date().toISOString(), status: 200, contentType: "text/html", body: "<html><body>nothing here</body></html>" });
    assert.equal(result, null);
  });
});

describe("RSS/Atom feed parsing", () => {
  test("RSS 2.0 feed yields all item links", () => {
    const feed = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>New listing: Acme Plumbing</title><link>https://directory.example/acme-plumbing</link></item>
  <item><title>New listing: Beta Dental</title><link>https://directory.example/beta-dental</link></item>
</channel></rss>`;
    const urls = [...parseRssFeed(feed, "https://directory.example/feed.xml")];
    assert.equal(urls.length, 2);
    assert.equal(urls[0].url, "https://directory.example/acme-plumbing");
    assert.ok(urls[0].discoveredVia.startsWith("rss:"));
  });

  test("Atom feed yields entry links from href attribute", () => {
    const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Gamma Consulting</title><link href="https://directory.example/gamma-consulting"/></entry>
</feed>`;
    const urls = [...parseRssFeed(feed, "https://directory.example/atom.xml")];
    assert.equal(urls.length, 1);
    assert.equal(urls[0].url, "https://directory.example/gamma-consulting");
  });

  test("malformed RSS XML degrades to zero candidates without throwing", () => {
    const urls = [...parseRssFeed("<not valid", "x")];
    assert.equal(urls.length, 0);
  });

  test("RSS feed with no items yields zero candidates", () => {
    const urls = [...parseRssFeed("<?xml version='1.0'?><rss version='2.0'><channel></channel></rss>", "x")];
    assert.equal(urls.length, 0);
  });
});
