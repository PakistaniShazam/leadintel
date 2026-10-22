# Deployment Guide

## Recommended platform: Railway

One platform, as requested. Railway is the right fit here specifically because:
- It builds directly from a GitHub repo using the Dockerfiles already in this project — no
  separate CI/CD setup needed.
- It offers managed Postgres and Redis as one-click "plugins" in the same project — no
  separate database hosting account.
- Environment variables (including secrets) are set in its dashboard, not in code.
- It's usable by someone who has never used a terminal.

(Render and Fly.io are comparable alternatives if you already have a preference — the
Dockerfiles and docker-compose.yml work the same way there. Railway is the one recommendation
since you asked for one, not several.)

---

## What's deployment-ready right now

- `apps/api/Dockerfile` — builds and runs the API. Not tested against a real Docker daemon in
  this sandbox (none is available here) — it's a standard two-stage Node build, but "docker
  build" itself has not been run. Verify it once, the first time you deploy.
- `apps/web/Dockerfile` — same caveat. The build steps it runs (`npm install && npm run build`)
  **were** verified directly, just not inside an actual container.
- `docker-compose.yml` — five services (Postgres, Redis, API, worker, web), health checks,
  automatic restarts, seed data loaded on first startup.
- `packages/db/migrations/*.sql` + `packages/db/seed.sql` — run automatically when Postgres
  first starts via `docker-compose.yml`'s volume mounts. No manual migration step.
- `.env.example` (root) and `apps/api/.env.example` — every required variable documented.

## What Railway-specific steps look like (once you have an account)

1. Push this project to a GitHub repository (I can prepare this if you want — it's a `git init`
   + push, and I can do the init/commit locally; the actual GitHub account and push destination
   need to be yours).
2. In Railway: "New Project" → "Deploy from GitHub repo" → select the repo.
3. Add the Postgres and Redis plugins from Railway's plugin catalog (one click each).
4. Railway will detect the four remaining services from `docker-compose.yml`/Dockerfiles
   (api, worker, web) — or if it doesn't auto-detect multi-service, add them manually as three
   services pointing at `apps/api/Dockerfile`, `apps/api/Dockerfile` (command override to
   `node dist/worker.js`), and `apps/web/Dockerfile` respectively.
5. Set environment variables in Railway's dashboard (not in code): `JWT_SECRET`,
   `ANTHROPIC_API_KEY`, `DATABASE_URL`/`REDIS_URL` (Railway can inject these automatically from
   the plugins), `NEXT_PUBLIC_API_URL` (the API service's Railway-provided public URL).
6. Deploy. Railway gives you a live URL for the web service.

I'm not able to perform these steps myself — they require your Railway account and your
GitHub repo. What I *can* do: prepare the repo locally (git init, commit, `.gitignore` already
excludes secrets), and write out the exact environment variable values to paste (never the
secrets themselves in plain view longer than necessary — you'd paste your own
`ANTHROPIC_API_KEY` directly into Railway's dashboard).

---

## Required user actions (unchanged from the earlier audit, now more concrete)

| # | Action | Where |
|---|---|---|
| 1 | Create a Railway account | railway.app |
| 2 | Add billing (Railway's free tier is limited; a real, continuously-running system needs a paid plan) | Railway dashboard |
| 3 | Create a GitHub account (if you don't have one) and let me push this project to a repo there | github.com |
| 4 | Paste your Anthropic API key into Railway's environment variables (already have it — same key used for local testing) | Railway dashboard → service → Variables |
| 5 | (Optional) Connect a custom domain | Railway dashboard → service → Settings → Domains, once you own one |

Nothing else. Migrations, seed data, worker/scheduler startup, health checks, and the build
itself are all automated in the code already committed to this project.
