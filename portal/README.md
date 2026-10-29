# Reekon Systems — Sales Portal

This folder is the sales portal. It runs on **Cloudflare Pages**, not GitHub Pages
(it needs Cloudflare for logins and the D1 database).

Cloudflare Pages settings for this repo:
- Production branch: `main`
- Build command: *(leave empty)*
- Build output directory: `portal`
- Bindings: D1 database named `DB`, secret `SETUP_CODE`

Every push to `main` redeploys the portal automatically.
