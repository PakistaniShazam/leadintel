/**
 * Fail-fast environment validation. Missing required config crashes the
 * process on startup with a clear message, rather than the app running
 * and failing confusingly on the first request (or worse, running
 * "successfully" with an insecure default in production).
 */
export function validateEnv(): void {
  const errors: string[] = [];

  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is not set");
  }

  if (!process.env.REDIS_URL) {
    errors.push("REDIS_URL is not set");
  }

  const isProduction = process.env.NODE_ENV === "production";
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    errors.push("JWT_SECRET is not set");
  } else if (isProduction && jwtSecret === "dev-secret-change-me") {
    errors.push("JWT_SECRET is set to the insecure default — set a real secret before running in production");
  } else if (isProduction && jwtSecret.length < 32) {
    errors.push(`JWT_SECRET is only ${jwtSecret.length} characters — use at least 32 in production`);
  }

  if (isProduction && !process.env.ANTHROPIC_API_KEY) {
    // Not a hard error — the mock provider is a legitimate fallback for
    // testing — but production running on the mock provider silently is
    // exactly the kind of thing that should be loud, not discovered later.
    // eslint-disable-next-line no-console
    console.warn(
      "WARNING: NODE_ENV=production but ANTHROPIC_API_KEY is not set. " +
        "AI classification/strategy generation will use the mock provider (placeholder answers, zero cost). " +
        "This is fine for a dry run, not fine for real campaigns."
    );
  }

  if (isProduction && (!process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS === "*")) {
    console.warn(
      "WARNING: NODE_ENV=production but ALLOWED_ORIGINS is not set (or is '*') — CORS will accept requests from any origin. " +
        "Set ALLOWED_ORIGINS to a comma-separated list of allowed origins."
    );
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error("Startup validation failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }
}
