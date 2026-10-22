import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyName, normalizeDomain, normalizePhone, normalizeEmail, jaroWinklerSimilarity } from "../../src/lib/normalize.js";

describe("normalizeCompanyName", () => {
  test("strips a trailing legal suffix (Pty Ltd)", () => {
    assert.equal(normalizeCompanyName("ABC Dental Clinic Pty Ltd"), "abc dental clinic");
  });

  test("strips a trailing legal suffix (Ltd.)", () => {
    assert.equal(normalizeCompanyName("ABC Dental Clinic Ltd."), "abc dental clinic");
  });

  test("lowercases and collapses whitespace", () => {
    assert.equal(normalizeCompanyName("  ACME   Corp  "), "acme");
  });
});

describe("normalizeDomain", () => {
  test("lowercases, strips www, and drops the path", () => {
    assert.equal(normalizeDomain("https://www.Example.com/path"), "example.com");
  });

  test("invalid input returns null instead of throwing", () => {
    assert.equal(normalizeDomain("not a url"), null);
  });
});

describe("normalizePhone", () => {
  test("strips formatting but keeps a leading +", () => {
    assert.equal(normalizePhone("+61 2 9876 5432"), "+61298765432");
  });

  test("no leading + stays digits-only", () => {
    assert.equal(normalizePhone("(02) 9876-5432"), "0298765432");
  });
});

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    assert.equal(normalizeEmail("  John.Smith@EXAMPLE.com  "), "john.smith@example.com");
  });
});

describe("jaroWinklerSimilarity", () => {
  test("identical strings score 1.0", () => {
    assert.equal(jaroWinklerSimilarity("abc dental clinic", "abc dental clinic"), 1);
  });

  test("near-identical strings score high", () => {
    const sim = jaroWinklerSimilarity("abc dental clinic", "abc dental clinics");
    assert.ok(sim > 0.9, `expected > 0.9, got ${sim}`);
  });

  test("dissimilar strings score low", () => {
    const sim = jaroWinklerSimilarity("abc dental clinic", "xyz plumbing services");
    assert.ok(sim < 0.6, `expected < 0.6, got ${sim}`);
  });

  test("empty strings don't throw and score 0", () => {
    assert.equal(jaroWinklerSimilarity("", "something"), 0);
  });
});
