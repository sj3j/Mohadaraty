---
name: find-skill
description: Discover and install agent skills that fit the MyLecture stack (React 19, Firebase/Firestore, Express-on-Vercel, Capacitor Android, Workbox offline). Use when the user asks "how do I do X", "find a skill for X", "is there a skill that can...", or wants to extend agent capabilities for this project.
---

# Find Skills — MyLecture

Discover and install skills from the open agent-skills ecosystem, filtered against **this
project's actual stack**.

Adapted from `vercel-labs/skills`. See `../ATTRIBUTION.md`.

## When to Use This Skill

- The user asks "how do I do X" where X might be a common task with an existing skill
- The user says "find a skill for X" or "is there a skill for X"
- The user asks "can you do X" where X is a specialized capability
- The user wants to extend agent capabilities, or search for tools/templates/workflows

## What is the Skills CLI?

`npx skills` is the package manager for the open agent-skills ecosystem.

- `npx skills find [query] [--owner <owner>]` — search interactively or by keyword
- `npx skills add <package>` — install a skill
- `npx skills update` — update installed skills

Browse at https://skills.sh/

**Network required.** `npx skills` needs registry access. On this machine some hosts are
blocked (astral.sh is, per the graphify toolchain notes). If the CLI fails to reach the
registry, say so explicitly and fall back to the leaderboard via WebFetch or to direct help
— do **not** silently report "no skills found" when the real problem was the network.

## Process

### Step 0 (MyLecture-specific): Check what is already installed — FIRST

This is the most common failure mode here. This environment **already ships** a large set of
skills. Recommending a re-install of something already present wastes the user's time and
makes the recommendation look unresearched.

Already available, do not recommend installing:

| Domain | Already present |
| --- | --- |
| Firebase | the whole `firebase:*` pack — `firebase-firestore`, `firebase-security-rules-auditor`, `firebase-auth-basics`, `firebase-hosting-basics`, `firebase-app-hosting-basics`, `firebase-remote-config-basics`, `firebase-crashlytics`, `firebase-data-connect-basics`, `firebase-ai-logic-basics` |
| Code quality | `code-review`, `simplify`, `security-review` |
| Store release | `store-submission-prep` (Capacitor wrapping, icons, store graphics, policy declarations) |
| Codebase Q&A | `graphify` |
| Config | `update-config`, `fewer-permission-prompts`, `keybindings-help` |
| 3D | the `threejs-*` pack — **installed but irrelevant here**, see Out of Scope |

If an installed skill covers the need, **recommend using it** and note that it costs nothing
to adopt. That is a better answer than an install command.

### Step 1: Identify domain and task

Name the domain and the specific task. Then check it against scope below before searching.

### Step 2 (MyLecture-specific): Apply the scope filter

**In scope — this repo genuinely uses these:**

- Firestore data modeling, security rules, composite indexes, emulator testing
- Firebase Auth, Storage, Cloud Messaging, Cloud Functions (13 exports in `functions/index.js`)
- React 19, TypeScript 5.8, Vite 6, Tailwind 4
- Express on Vercel serverless — note the **dual API surface**, `server.ts` (dev) vs
  `api/index.ts` (prod)
- Capacitor 7 Android packaging, APK/AAB release, Play Store compliance
- Workbox 7 / `vite-plugin-pwa` offline caching and service workers
- Arabic/English i18n
- AWS S3 SDK, `@google/genai`, Telegraf

**Out of scope — filter these out of results, do not surface them:**

- **3D, WebGL, three.js, babylon, glTF** — there is no 3D code in this repo. Verified: zero
  matches for `three`, `babylon`, `webgl`, `gltf` outside the English word "three" in date
  comments. If asked for 3D skills, say plainly that this repo has no 3D surface rather than
  recommending anything.
- **Postgres, Prisma, Supabase, MySQL, Drizzle** — no relational database. This matters
  because the skills.sh leaderboard is *dominated* by these (supabase-postgres-best-practices
  at 376K installs, prisma-database-setup at 246K). They will be the top hits for any generic
  "database" query and they are all noise here.
- **Flutter, Dart** — this is Capacitor, not Flutter.
- **Python backends** (FastAPI, Django, Flask) — Python here is exactly one script,
  `scripts/sync_telegram.py`.
- **Prettier / ESLint** — neither is configured; `npm run lint` is `tsc --noEmit`.
- **Jest / Vitest** — tests are plain `tsx` and `node` scripts run under
  `firebase-tools emulators:exec`.

### Step 3: Check the leaderboard

Check https://skills.sh/ for an established skill in the domain, then apply the Step 2
filter to what comes back. The leaderboard ranks by total installs, which is why its top
entries skew toward stacks this project does not use.

### Step 4: Search the CLI

    npx skills find [query] [--owner <owner>]

Prefer queries that name this stack specifically — `firestore rules`, `capacitor android`,
`service worker offline`, `react 19` — over generic ones like `database` or `testing`, which
return out-of-scope results here.

### Step 5: Verify quality before recommending

Do not recommend based on search results alone:

1. **Install count** — prefer 1K+. Treat anything under 100 with caution.
2. **Source reputation** — official publishers (`vercel-labs`, `anthropics`, `firebase`,
   `microsoft`) over unknown authors.
3. **GitHub stars** — a skill from a repo with under 100 stars deserves skepticism.
4. **MyLecture fit** — a popular skill that assumes Postgres or Flutter is worse than no
   skill. State the fit explicitly.

### Step 6: Present options

Give the skill name and what it does, the install count and source, the install command, a
skills.sh link, and **one line on how it applies to this codebase** — naming a real file or
constraint, not a generic benefit.

Example:

    The firebase/agent-skills pack covers Firestore rules and indexes.
    (141K installs, official Firebase publisher)

    npx skills add firebase/agent-skills

    Fit: targets firestore.rules directly — 38 top-level collections here are
    hand-maintained against only 10 composite indexes.

    NOTE: the firebase:* pack is already installed in this environment.
    Use it rather than re-installing.

### Step 7: Offer to install

    npx skills add <owner/repo@skill> -g -y

`-g` installs at user level, `-y` skips prompts. **Ask before installing** — this writes
outside the repo.

## Category Queries for This Project

| Category | Useful queries here |
| --- | --- |
| Firestore | firestore rules, firestore indexes, firestore emulator, nosql modeling |
| Firebase platform | firebase functions, fcm push, firebase auth, firebase storage |
| Frontend | react 19, vite, tailwind 4, typescript |
| Native/offline | capacitor, android release, service worker, workbox, pwa offline |
| Serverless API | vercel functions, express serverless |
| Code quality | refactor, debugging, code review, architecture |
| i18n | i18n, localization, rtl arabic |

## When No Skills Are Found

1. Say clearly that nothing matched — and distinguish "no results" from "the registry was
   unreachable".
2. Offer to help with the task directly.
3. Suggest a **project-local** skill under `.claude/skills/` rather than `npx skills init`,
   when the need is specific to this repo's architecture. Several needs here (route-parity
   between the dual API surfaces, the Firestore index-drift check, the APK release chain)
   have no registry equivalent and should be built locally.
