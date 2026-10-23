# Deploying Hopshot

What has to exist on Cloudflare before `services/api` can run anywhere but your laptop, and
in what order.

Nothing here is needed for local development — `pnpm -F api dev`, `pnpm -F api test` and
`db:migrate:local` all run against miniflare and never touch your account.

> **The marketing site is already live and deploys itself.** The root `wrangler.jsonc`
> publishes `marketing/site` to hopshot.xyz on every push to `main`. It is a *separate*
> config from `services/api/wrangler.toml` and nothing in this document touches it. Don't
> run deploy commands from the repo root.

---

## 1. Sign in

```bash
npx wrangler login
```

Opens a browser for OAuth. Check it worked:

```bash
npx wrangler whoami
```

---

## 2. Create the D1 database

The `database_id` does not exist until you create the database — there is nowhere to copy
it from beforehand.

```bash
npx wrangler d1 create hopshot
```

It prints a config block:

```toml
[[d1_databases]]
binding = "DB"
database_name = "hopshot"
database_id = "a1b2c3d4-5678-90ab-cdef-1234567890ab"
```

Copy that `database_id` into `services/api/wrangler.toml`, replacing `REPLACE_ME`. Leave
`binding`, `database_name` and `migrations_dir` as they are.

Already created it? `npx wrangler d1 list`, or the dashboard under
**Storage & Databases → D1 → hopshot**.

---

## 3. Create the R2 bucket

`wrangler.toml` binds `hopshot-blobs`; deploying without it fails.

```bash
npx wrangler r2 bucket create hopshot-blobs
```

### Lifecycle rule (do this now, not later)

ARCHITECTURE §7.8 wants a safety net behind the 15-minute cron: delete objects under the
`d/` and `v/` prefixes **8 days** after upload, one day past the longest TTL. This is bucket
configuration, not code — the repo cannot set it up for you.

Dashboard → **R2 → hopshot-blobs → Settings → Object lifecycle rules** → add a rule per
prefix, "delete 8 days after upload".

Without it, any object the cron misses (a failed run, a row deleted out from under it) bills
forever.

---

## 4. Apply the schema

```bash
pnpm -F api db:migrate:remote
```

This writes all 16 tables from `migrations/0001_init.sql` to the real database. Verify:

```bash
npx wrangler d1 execute hopshot --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

---

## 5. Secrets

Secrets are write-only. Cloudflare encrypts on write and never returns the value — not
through the CLI, not in the dashboard. Lost one? Overwrite it.

### Needed now (Phase 3.2)

| Secret | Why |
|---|---|
| `IP_HASH_SECRET` | Salts the per-IP rate-limit hash (ARCHITECTURE §7.9) |

```bash
npx wrangler secret put IP_HASH_SECRET
```

Use something long and random, e.g. `openssl rand -base64 32`.

**This one fails silently if you skip it.** `hashIp` falls back to an empty salt, so the API
keeps working and nothing logs — but the hash becomes reproducible by anyone who knows the
date, which defeats the point of not storing raw IPs. Rotating it later is safe: it only
invalidates that day's rate-limit counters.

### Needed in Phase 4 (billing and email, ARCHITECTURE §7.6)

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `REMINDER_TOKEN_SECRET`,
`ADMIN_TOKEN` — with test-mode values in a separate wrangler environment.

### Listing what is set

```bash
npx wrangler secret list
```

Names and types only, never values.

### Locally

Wrangler reads `services/api/.dev.vars` instead of Cloudflare:

```
IP_HASH_SECRET=some-long-random-string
```

That file is gitignored (`.dev.vars`, `.dev.vars.*`). Never commit one.

---

## 6. Deploy

```bash
pnpm -F api run deploy
```

`run` is not optional: `pnpm -F api deploy` collides with pnpm's own `deploy` command and
fails with `ERR_PNPM_INVALID_DEPLOY_TARGET`.

Then:

```bash
curl https://<your-worker>.workers.dev/health
```

Expect `{"ok":true}`.

### Custom domain

ARCHITECTURE §7 puts the API at `https://api.hopshot.xyz/v1`, but `wrangler.toml` declares
no route yet, so the first deploy lands on a `workers.dev` subdomain. Add the custom domain
in the dashboard (**Workers → hopshot-api → Settings → Domains & Routes**) or add a `routes`
block to `wrangler.toml` once the DNS record exists.

### Watching it

```bash
npx wrangler tail hopshot-api
```

The retention sweep logs only when it actually removed something, so a quiet log is the
healthy state.

---

## 7. The web app

The Astro Cloudflare adapter builds a **Worker with static assets**, not a Pages project —
`wrangler pages deploy` is the wrong command. Config lives in `apps/web/wrangler.jsonc`,
which the adapter merges over the one it generates at build time.

It binds a `SESSION` KV namespace unconditionally (Astro sessions), and deploy fails without
an id even though nothing uses it yet:

```bash
npx wrangler kv namespace create SESSION
```

Put the id in `apps/web/wrangler.jsonc`, point the build at an API with
`apps/web/.env.production`:

```
PUBLIC_HOPSHOT_API=https://hopshot-api.<account>.workers.dev/v1
```

then build and deploy from `apps/web`:

```bash
npx wrangler deploy
```

### CORS

The viewer and the API are on different origins, so **every** call the browser makes is
cross-origin. `services/api/src/lib/cors.ts` allows hopshot.xyz, localhost:4321 and
`*.workers.dev` / `*.pages.dev` under this account.

`X-Hopshot-Meta` must stay in `exposeHeaders`: a cross-origin response hides every header
outside the CORS safelist, so the viewer would receive the metadata envelope and be unable
to read it.

---

## What this does *not* cover

- **Apple notarization and the Microsoft Store MSIX** (ARCHITECTURE §9). Those secrets live
  in GitHub Actions, not Cloudflare.

  The Windows release *is* wired up: tag `v*` runs `.github/workflows/release.yml`, which
  tests, builds the NSIS installer, signs the update archive with `TAURI_SIGNING_PRIVATE_KEY`
  and drafts a GitHub release holding the `.exe`, its `.sha256` and `latest.json`. For NSIS,
  Tauri signs the installer itself — there is no separate update archive. **Publishing that draft is what releases the update** — the updater endpoint
  is `releases/latest/download/latest.json`, and a draft is never "latest".
- **`api-deploy.yml` / `web-deploy.yml`** — the CI deploy workflows from ARCHITECTURE §3 do
  not exist yet; `ci.yml` only builds and tests.
- **Custom domains are already set up**, contrary to what §6 implies: `api.hopshot.xyz`
  (declared in `services/api/wrangler.toml`), `app.hopshot.xyz` (`apps/web/wrangler.jsonc`)
  and the apex `hopshot.xyz` for the marketing Worker, which deploys from the root
  `wrangler.jsonc` on every push. The apex serves static files only — `/download` lives on
  `app.hopshot.xyz`.

---

## Rolling back

```bash
npx wrangler rollback hopshot-api
```

Reverts the Worker to its previous version. It does **not** undo a migration — D1 has no
down-migrations here, so a schema change needs a forward fix.

To remove everything created above:

```bash
npx wrangler d1 delete hopshot
```

```bash
npx wrangler r2 bucket delete hopshot-blobs
```

Both destroy data permanently.
