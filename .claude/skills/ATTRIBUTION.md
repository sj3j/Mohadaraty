# Attribution — vendored skills

The two adapted skills here come from upstream open-source sources, fetched and customized
on **2026-08-29**.

## Reproducing the installed skills

`diagnosing-bugs` and `improve-codebase-architecture` live in `.agents/skills/` (gitignored,
re-installable) and are symlinked into `.claude/skills/`. The symlinks are absolute paths, so
they will not resolve on another machine. To restore them:

```bash
npx skills add mattpocock/skills@diagnosing-bugs -y
npx skills add mattpocock/skills@improve-codebase-architecture -y
```

`verify-firestore/` is written for this repo and is committed directly.

## `mylecture-setup-recommender/`

- **Upstream**: `claude-automation-recommender`, from the `claude-code-setup` plugin
- **Source**: https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup
- **Raw**: `plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md`
- **Upstream form**: a *plugin* (`.claude-plugin/plugin.json` v1.0.0, author Anthropic)
- **License**: see `LICENSE` in the upstream plugin directory

### Why it was vendored rather than installed as a plugin

A marketplace plugin's instructions cannot be edited locally. Customizing the analysis to
MyLecture's architecture — the requirement — is only possible on a vendored copy. Renamed to
`mylecture-setup-recommender` so it does not shadow the upstream skill if the plugin is ever
also installed.

### Changes from upstream

- Phase 1 stack detection **replaced** with MyLecture's known stack, so the skill stops
  re-sniffing `package.json` / `pyproject.toml` / `Cargo.toml` on every run.
- Added **Phase 1b hard constraints**: dual-API drift, the occupied `PreToolUse` graphify
  slot, the offline-to-APK chain, the release-blocking payment-surface gate, the absence of
  a linter/formatter, and the cost of the Firestore emulator.
- Reference tables rewritten around Firebase / Capacitor / Workbox signals.
- Added a **Non-Applicable** section so the skill stops recommending Prisma, Supabase,
  Postgres, FastAPI, Flutter, three.js, Prettier, ESLint and Jest automations.
- Removed upstream's `See references/*.md` links (`references/mcp-servers.md`,
  `hooks-patterns.md`, `skills-reference.md`, `subagent-templates.md`,
  `plugins-reference.md`). Those files were not vendored; the relevant content is inlined.
- Output report template gained two required fields: **Dual-API impact** and **Graphify
  collision check**.

## `find-skills/`

- **Upstream**: `find-skills`
- **Source**: https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md
- **Publisher**: Vercel Labs
- **Name kept** as `find-skills` (requested explicitly).

### Changes from upstream

- Added **Step 0: check what is already installed**, listing the `firebase:*` pack,
  `code-review`, `simplify`, `security-review`, `store-submission-prep` and `graphify`, so
  the skill recommends adopting an installed skill instead of re-installing it.
- Added **Step 2: scope filter** with explicit in-scope and out-of-scope domains.
  Out-of-scope entries carry the reason, since the skills.sh leaderboard's highest-install
  entries (Supabase 376K, Prisma 246K) are exactly the ones that do not apply here.
- Quality bar extended with a fourth criterion, **MyLecture fit**.
- Category query table rewritten for Firestore / Capacitor / Workbox / i18n.
- Added a network-failure note: distinguish "no results" from "registry unreachable".
- "When no skills are found" now steers toward a **project-local** skill under
  `.claude/skills/` rather than `npx skills init`, for needs with no registry equivalent.

## Verified facts these customizations encode

Checked against the repo on 2026-08-29:

- 38 top-level collections in `firestore.rules`; 10 composite indexes across 9 collection
  groups in `firestore.indexes.json`
- 13 Cloud Function exports in `functions/index.js`
- `vite-plugin-pwa` + Workbox 7, `registerType: 'autoUpdate'` in `vite.config.ts`
- Capacitor 7; `android:aab` gated by `scripts/assert-no-payment-surface.mjs`
- `npm run lint` is `tsc --noEmit`; no ESLint, no Prettier
- Subject enum `pharmacology | pharmacognosy | organic_chemistry | biochemistry | cosmetics`
  (`firestore.rules`)
- **No 3D code**: zero matches for `three` / `babylon` / `webgl` / `gltf` as identifiers or
  dependencies
- **Python is one file**: `scripts/sync_telegram.py`
