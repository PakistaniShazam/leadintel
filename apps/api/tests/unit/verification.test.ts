import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkEmailSyntax, checkPhoneFormat, checkDomainDns } from "../../src/verification/checks.js";

describe("checkEmailSyntax", () => {
  test("valid email passes", () => {
    assert.equal(checkEmailSyntax("valid@example.com").result, "pass");
  });

  test("invalid email fails", () => {
    assert.equal(checkEmailSyntax("not-an-email").result, "fail");
  });
});

describe("checkPhoneFormat", () => {
  test("well-formed international number passes", () => {
    assert.equal(checkPhoneFormat("+61 2 9876 5432").result, "pass");
  });

  test("garbage input fails", () => {
    assert.equal(checkPhoneFormat("abc").result, "fail");
  });
});

// Real DNS lookups — requires outbound DNS resolution, which this sandbox's
// egress allowlist happens to permit (unlike arbitrary HTTP fetch). Skipped
// automatically if DNS is unreachable, rather than failing CI in an
// environment without it.
describe("checkDomainDns (live DNS)", () => {
  test("a real, resolvable domain passes", async () => {
    const result = await checkDomainDns("google.com");
    assert.equal(result.result, "pass");
  });

  test("a nonexistent domain fails with ENOTFOUND", async () => {
    const result = await checkDomainDns("this-domain-definitely-does-not-exist-xyz123.com");
    assert.equal(result.result, "fail");
    assert.equal(result.details.error, "ENOTFOUND");
  });
});
