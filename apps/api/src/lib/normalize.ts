// Deterministic normalization (Architecture V2 §11). Runs before dedup and
// before storage — everything downstream (dedup blocking, source-overlap
// matching) depends on this being consistent and cheap (no AI).

const LEGAL_SUFFIXES = [
  "ltd", "limited", "llc", "l.l.c", "inc", "incorporated", "corp", "corporation",
  "co", "company", "plc", "gmbh", "sa", "s.a", "bv", "b.v", "pty", "pty ltd",
  "pvt", "pvt ltd", "srl", "spa",
];

export function normalizeCompanyName(raw: string): string {
  let name = raw.trim().toLowerCase();
  name = name.replace(/[.,]/g, " ");
  name = name.replace(/\s+/g, " ").trim();

  // Strip a trailing legal suffix (longest match first so "pty ltd" beats "ltd")
  const sorted = [...LEGAL_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suffix of sorted) {
    const re = new RegExp(`\\s+${suffix.replace(/\s+/g, "\\s+")}$`, "i");
    if (re.test(name)) {
      name = name.replace(re, "").trim();
      break;
    }
  }
  return name;
}

export function normalizeDomain(input: string): string | null {
  try {
    const url = input.includes("://") ? input : `https://${input}`;
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Very small E.164-ish normalizer: strips everything but leading + and digits.
// Full validation (real libphonenumber-style country-aware parsing) belongs
// in the verification pipeline (Phase 4), not here — normalization just
// makes values comparable, it doesn't assert correctness.
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  return hasPlus ? `+${digits}` : digits;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// Jaro-Winkler similarity for fuzzy company-name matching (dedup scoring stage).
// Pure implementation, no dependency — small enough to own outright and keeps
// the dedup path free of an external library's behavior changing under us.
export function jaroWinklerSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const s1 = a, s2 = b;
  const len1 = s1.length, len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}
