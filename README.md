# Hopshot — product pack

Everything needed to build and launch **Hopshot** with Claude Code: a small Mac + Windows app where screenshots land on a floating shelf, drag into any website, open on your phone, and delete themselves after 24 hours.

| File | What it's for |
|---|---|
| `PRD.md` | Product requirements: problem, users, features with acceptance criteria, pricing, metrics, risks |
| `docs/ARCHITECTURE.md` | Technical spec: stack, repo layout, local store, encryption format, API, database, packaging/signing, testing, costs |
| `docs/DESIGN.md` | Design system: tokens, components, every screen and state, microcopy, icon brief |
| `design/mockups.html` | Clickable mockups; open in any browser (toggle macOS/Windows, Lifetime/Sync, light/dark) |
| `CLAUDE.md` | Standing instructions Claude Code reads in every session |
| `BUILD_PLAN.md` | 4-week, phase-by-phase plan with copy-paste Claude Code prompts |
| `docs/LAUNCH.md` | QA checklist, launch assets, channel plan, post templates |
| `marketing/site/` | Live landing page for hopshot.xyz (Cloudflare Pages deploys this folder on every push to `main`) |
| `marketing/` (rest) | Demo video/GIF, share image, post drafts, tracker, setup guide, demo source |

## Start here

1. Create an empty folder, copy this pack into it, and run `git init && git add . && git commit -m "Product pack"`.
2. Do **Day 0** in `BUILD_PLAN.md` (Apple, Microsoft Partner Center, Cloudflare, Stripe, Resend), because some approvals take days.
3. Open the folder in Claude Code and paste **Prompt 0.1** from `BUILD_PLAN.md`.

Product name: **Hopshot** · domain: **hopshot.xyz**.
# hopshot
