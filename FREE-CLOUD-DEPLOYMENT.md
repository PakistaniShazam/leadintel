# Free cloud deployment: Render + Supabase + Upstash

This setup is intended for testing and a small demo. It is not production-grade:
Render free services sleep when idle, the free database services have quotas, and
the API runs the queue workers in the same process (`RUN_WORKERS=true`).

## 1. Create the free services

1. Create a Supabase project and copy its **direct Postgres connection string**.
   Use the database password you created; do not paste it into chat.
2. In Supabase SQL Editor, run these files in order:
   - `packages/db/migrations/001_init.sql`
   - `packages/db/migrations/002_ai_usage_org_scope.sql`
   - `packages/db/migrations/003_campaign_sources.sql`
   - `packages/db/migrations/004_review_flags.sql`
   - `packages/db/seed.sql`
3. Create an Upstash Redis database and copy its Redis connection URL.
4. Create a Render account and choose **New → Blueprint**.
5. Connect this repository and select `render.yaml`.

## 2. Enter Render variables

For `leadintel-api`:

- `DATABASE_URL`: Supabase Postgres URL
- `REDIS_URL`: Upstash Redis URL
- `JWT_SECRET`: let Render generate it
- `ALLOWED_ORIGINS`: leave blank initially, then set it to the web service URL
- `ANTHROPIC_API_KEY`: optional; without it the app uses its deterministic mock provider

For `leadintel-web`:

- `NEXT_PUBLIC_API_URL`: the public URL of `leadintel-api`, ending without a slash

After the first deploy, update `ALLOWED_ORIGINS` with the web URL and redeploy the API.

## 3. Verify

1. Open `https://YOUR-API.onrender.com/health`; it should report `db: connected`.
2. Open `https://YOUR-WEB.onrender.com`.
3. Register a test account.
4. Create a test lead and campaign.
5. Use a permitted sitemap source for the first pipeline test.

Never commit `.env` files, database passwords, Redis URLs, or API keys.
