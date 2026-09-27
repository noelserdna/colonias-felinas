# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PWA for Spanish town councils to train, accredit and coordinate feline-colony caretakers (course → unit tests →
final exam graded by JEV → digital carnet → colony registry, census, cat records, notices). Built for the
Ayuntamiento de San Román de los Montes; shared under EUPL-1.2. UI text, code comments and commit messages are in
**Spanish**. Guides: `README.md` (users/costs), `docs/TECNICO.md` (architecture reference), `AGENTS.md` (step-by-step
for installing a new municipality — follow it when asked to deploy for someone else).

## Commands

```bash
npm run dev                      # astro dev on :4321 (wipes node_modules/.vite first)
npx astro check                  # type check (there is no lint script)
npm test                         # vitest, tests/unit/**/*.test.ts
npx vitest run tests/unit/webpush.test.ts        # one file
npx vitest run -t "rechaza cualquier otra"       # one test by name
npx playwright test              # E2E (Pixel 7 emulation) against the running dev server; includes axe WCAG 2.1 AA
npx playwright test -g "alta de colonia"         # one E2E test
npm run db:generate              # drizzle-kit: new SQL migration from src/lib/db/schema.ts → migrations/
npm run db:migrate:local | db:migrate:remote | db:migrate:demo
npm run db:seed:local  | db:seed:remote  | db:seed:demo      # builds seed/seed.sql (idempotent) and applies it
npm run db:local:sanroman:local  # San Román preload (programa, textos, documents) into the local D1
npm run deploy                   # production (sanroman.colonia.dev)
npm run deploy:demo              # demo instance (CLOUDFLARE_ENV=demo build → demo.colonia.dev)
```

Local demo mode (separate local D1/R2, secrets from `.dev.vars.demo`): `CLOUDFLARE_ENV=demo npx astro dev --port 4322`.
Only one `astro dev` can run at a time (`npx astro dev stop`). Remote SQL: `npx wrangler d1 execute colonias --remote
--command "…"` (demo: `colonias-demo --remote --env demo`).

## Architecture

**Request path.** `src/worker.ts` is the Worker entry: `fetch` is Astro's handler; `scheduled` dispatches by cron
string (`*/5` retries pending JEV grading, `0 8` daily reminders, `0 3` demo reset — the last only when `DEMO=1`).
`src/middleware.ts` loads the session user, branding and `hasCarnet` into `Astro.locals`, runs the demo gate, enforces
login (allow-list `PUBLIC`) and admin-only `/admin`/`/api/admin`. Pages are SSR `.astro` files that usually handle
their own form POST in the frontmatter (POST → mutate → render with a message); JSON endpoints live in `src/pages/api/`.
Interactive parts are React islands (`Quiz.tsx`, `SolicitudForm.tsx`, `BajaColonia.tsx`) loaded `client:only`.

**Testability split.** Anything importing `cloudflare:workers` (env) or the DB cannot run in vitest. Logic is kept in
pure modules that the unit tests import: `selection`, `grading`, `baja`, `notice-text`, `mail-provider`,
`demo-personas`, `webpush`, `push-endpoint`, `questions-io`, `anexos-pdf`, `programa-config`, `pages-config`, `winansi`,
`carnet-vigencia`, `temarios-config`
(and the census logic in `colonies`). When adding logic, put the decision part
in a pure module and keep the DB/env wiring in its sibling (`exam`, `notices`, `email`, `demo-data`, `push`…).

**Carnet validity.** `carnet_validity_months` 0/empty = indefinite (the default; valid while collaborating, withdrawn
by revoking). «No expiry» is the sentinel `SIN_CADUCIDAD` (9999-12-31) in the NOT NULL `carnets.expires_at`, so every
`expires_at > now` query keeps working; show dates with `textoCaducidad`/`esIndefinido` (`carnet-vigencia.ts`).
Admin → Carnets «Aplicar esta vigencia a los carnets vigentes» recalculates existing ones (`planVigencia`).

**Exams.** `attempts` + `attempt_items`; each item stores a frozen `snapshot` of the question and `optionOrder`
(shown index → original index). The client sends *shown* indices; grading is server-side only (`exam.ts`,
`grading.ts`) and correct answers never reach the browser. Written answers go to JEV (`jev.ts`); the attempt stays
`grading` until all are scored (cron retries), then a pass issues the carnet (`carnet.ts`). Without a JEV key,
written questions are replaced by objective ones.

**Temarios.** Several course syllabi (`temarios` table; `units.temario_id`, slugs unique only per temario) with one
active (`settings.temario_activo`, default `toledo-2025`; tolerant read `elegirTemarioActivo` in `temarios-config.ts`,
exposed as `Astro.locals.temario`). Student-facing code uses `activeUnits`/`findActiveUnitBySlug` (`temarios.ts`),
never `units` unfiltered; admin code resolves topics inside an explicit temario (`resolveUnit(units, temario, tema)`,
never by global `orden`). Progress is per unit, so each temario keeps its own. Admin → Temarios: activate (impact
page), create, edit, hide (never delete: FKs without cascade), export/import JSON packages. Seed manifest
`seed/temarios.json`; the seed never changes the active temario.

**Configuration lives in the `settings` table** (key → JSON): course parameters (`settings.ts`, zod with defaults, incl.
`carnet_prefix` and `carnet_aviso_dias`), `branding` (`branding-schema.ts`: municipio, provincia, contact,
`credito_formativo`, the fallback when the active temario has no `credito`), `temario_activo`, `programa` (municipal programme, see below), `page:<slug>` (editable Markdown pages), `mail_from`, and
`secret:*` values encrypted with `APP_SECRET` (`secrets.ts` — JEV and Resend keys set from Admin → Ajustes take
priority over env secrets). The escudo is in the `assets` table.

**Notices.** `deliverNotices` (`notices.ts`) writes an in-app notice, sends email and Web Push in one call;
`notifyColony` wraps it for colony events and `reminders.ts` for the daily census/carnet cron. Email provider is chosen
by `chooseProvider` (`mail-provider.ts`): mock → Resend key from the panel → Cloudflare Email binding → Resend env
secret → none (then the mail, incl. magic links, is only logged — see it with `npx wrangler tail`). Web Push is
implemented with WebCrypto (`webpush.ts`, RFC 8291 + VAPID); the server only posts to known push hosts
(`push-endpoint.ts`).

**Demo instance** (`env.demo` in `wrangler.jsonc`, `DEMO=1`). `isDemo()` switches behaviour across the app: access
via `?codigo=` cookie gate and no email login (`demo.ts`), per-visitor persona copies (`demo-data.ts`,
`demo-personas.ts`), shortcuts in tests/exam, emails stored in `demo_outbox` instead of sent, content/settings
read-only, nightly reset (also `POST /api/demo/reset` with `DEMO_RESET_TOKEN` and an `Origin` header).

**PWA.** Dynamic manifest (`src/pages/manifest.webmanifest.ts`) and hand-written `public/sw.js`: network-first pages
with an offline copy of carnet/temario/colonia, push handling and badge. Bump `VERSION` in `sw.js` when changing
what it caches or how it behaves.

**Municipal programme (no ordinance hard-coded).** Defaults in code are neutral; everything tied to a municipality's
ordinance is configured from the panel. `programa` (Admin → Programa local): pure `programa-config.ts` (zod schema,
`DEFAULT_PROGRAMA`, `renderTemplate` with `{{var}}`/`{{#var}}…{{/var}}`/`{{^var}}…{{/var}}`, `programaVars`,
`textosAnexos`, `docsPdf`, `periodoTexto`, `etiqueta`) + `programa.ts` (DB; `getIdentidad` → `Astro.locals.branding`
and `Astro.locals.programa`). Tolerant per-field read, strict save; PDF texts must be WinAnsi (`winansi.ts`). Editable
pages (Admin → Textos): pure `pages-config.ts` (`mi-colonia`, `pautas-colonia`, `programa-local` → `/temario/local`;
`splitSteps`) + `pages.ts`. Form PDFs: `anexos-pdf.ts` takes `textos`; blank ones are generated by
`src/pages/docs/[archivo].ts` (old `anexo-*.pdf` names still work). Census: period and movements from `programa`
(`censusDue`, `validateCensus` — a mismatch is a warning with «Guardar igualmente», not a block). Census PDF:
`censoPdf` (`anexos-pdf.ts`) + `censoPdfDatos` (`colonies.ts`), served by `src/pages/colonia/[id]/censo/[censoId].pdf.ts`. Never reintroduce
«Anexo», «BOP», «San Román» or «seis meses» as literals: use `programa`/`branding`.

**Municipal preloads.** `seed/local/<slug>/` (programa.json, branding.json, settings.json, *.md, documents.json) →
`node scripts/build-local.mjs <slug>` → idempotent `seed/local/<slug>.sql`. San Román: `npm run db:local:sanroman:local`
(`:remote`/`:demo` only when the user authorises it; order: migrate → preload → deploy).

## Content and secrets not in git

- The course content comes from a veterinary association's manual and is **gitignored**: `seed/units/*.md`,
  `seed/questions/*.json`, `public/img/temario/`, `public/img/hero*.jpg` (temario `toledo-2025`). Without it the seed
  skips that temario and the app falls back to the free `propio` temario (`seed/temario-propio/`, images in
  `public/img/curso/`); the home page falls back to `public/img/portada.jpg`.
- Local secrets: `.dev.vars` (dev, `MAIL_MOCK=1` shows the magic link on the login page, `JEV_MOCK=1`),
  `.dev.vars.demo` (local demo mode), `.dev.vars.demo-remoto` (remote demo `DEMO_CODE` / `DEMO_RESET_TOKEN`).
  Production secrets are Wrangler secrets: `ADMIN_EMAILS`, `APP_SECRET`, `VAPID_PRIVATE_KEY`, `TYPESAFE_API_KEY`.

## Gotchas

- `_jsxDEV is not a function` or React islands not rendering in dev → stale Vite deps: restart `npm run dev`.
- Astro `security.checkOrigin`: form-type POSTs without a matching `Origin` header get 403 (add it in `curl`).
- E2E tests log in through the dev magic link (`MAIL_MOCK=1`) and use the first `ADMIN_EMAILS` entry from `.dev.vars`
  as admin; the login rate limit is 5/min per email, so tests reuse the admin cookies.
- Headless Chromium reports notifications as denied and has no push service; use `channel: "chromium"` for UI checks
  and a real device for actual push delivery.
- Global CSS has `[hidden] { display: none !important }`: toggle visibility with the `hidden` attribute.
- Cloudflare free plan is not viable in production (pages use 10–30 ms CPU vs. the 10 ms limit); the account runs
  Workers Paid, which also enables Cloudflare Email from `avisos.colonia.dev`.
