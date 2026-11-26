# 🐛 Earthworm (english-for-fun)

**English** | [简体中文](./README.zh-CN.md)

> Learn English by typing: course videos are split into sentences, and you type each Chinese sentence out in English (or take dictation) while listening to the original audio.

## ✨ What it does

- **Typing-based learning game** — two modes: Chinese → English (default) and dictation. A custom per-character input field with typing sounds, each sentence split into Question / Answer phases, scored live.
- **Shadowing with original video audio** — when a sentence carries start/end timestamps, playback seeks to that exact video clip (speed control and repeat supported); without video it falls back to Microsoft Edge neural TTS.
- **Course pack management** — create/edit course packs in the browser, edit sentence lists, bulk-import JSON, upload videos (2 GB limit).
- **One-click "video → course" (Course Forge)** — upload a video or download from Bilibili (QR login) → mark cut points on the timeline → word-level ASR → LLM splits sentences and generates Chinese translations → auto-import. Failed sentences can be deleted or retried per sentence and the run resumes from a checkpoint (LangGraph orchestration, optional Langfuse / LangSmith tracing).
- **Learning stats** — study time and calendar heatmap, recent course packs, completion history, mastered sentences.
- **Single-user private deployment** — no sign-up; the username and password live in environment variables, and every page redirects to the login screen when signed out.

## 🧱 Stack

A pnpm monorepo with two apps and four shared packages:

| Path                        | Description                                                                   |
| --------------------------- | ----------------------------------------------------------------------------- |
| `apps/client`               | Frontend: Nuxt 3 pure SPA (`ssr: false`) + Vue 3 + Nuxt UI / Tailwind + Pinia |
| `apps/api`                  | Backend: NestJS 10 + Drizzle ORM + Postgres, Swagger at `/swagger`            |
| `packages/schema`           | Single source of truth for all Drizzle table definitions                      |
| `packages/storage`          | S3-compatible object storage wrapper (MinIO in dev, Alibaba OSS in prod)      |
| `packages/game-data-sdk`    | Course-pack write layer (transactional writes incl. video timestamps)         |
| `packages/xingrong-courses` | Bundled sample course "Xingrong English from Zero" and its import script      |

Rough dependency direction: `client → api → game-data-sdk → schema`. The video pipeline (forge), the Bilibili download kernel (bilidown) and DB migrations all live inside `apps/api`.

## 🚀 Run locally

**Prerequisites**: Node.js ≥ 20 (CI uses 22.x; use `20.12.2` for the static frontend build, see `.node-version`), pnpm 9 (`corepack enable`), and a running Docker.

> All commands below run from the **repository root**.

```bash
# 1. Install dependencies
pnpm install

# 2. Prepare env files
cp apps/api/.env.example apps/api/.env       # required: AUTH_TFGZSDVU / AUTH_PASSWORD / SECRET
cp apps/client/.env.example apps/client/.env # defaults to API_BASE=http://localhost:3001

# 3. Start Postgres (5433) + MinIO (9000, console 9001)
pnpm docker:start

# 4. Create tables (drizzle-kit push)
pnpm db:init

# 5. Import the sample course (first run only)
pnpm db:upload

# 6. Start the API on http://localhost:3001
pnpm dev:serve

# 7. In a second terminal, start the client on http://localhost:3000
pnpm dev:client
```

Open <http://localhost:3000> and sign in with `AUTH_TFGZSDVU` / `AUTH_PASSWORD` from `apps/api/.env`.

**Troubleshooting**: `relation "user_course_progress" does not exist` means the schema was never pushed (or you are pointed at the wrong database) — rerun steps 3 → 4 → 5 → 6. The API also self-checks required tables at startup and fails fast with a hint.

**Optional**:

- The "import video" pipeline needs an Alibaba Bailian API key (`FORGE_ASR_API_KEY` / `FORGE_LLM_API_KEY`); every variable is documented in [local env variables](./docs/env/README.env.dev.md).
- A local Langfuse UI starts alongside `pnpm docker:start`: <http://localhost:3002> (`dev@local.test` / `langfuse1234`).
- `pnpm docker:stop` stops services; `pnpm docker:down` removes containers but keeps data volumes.

## ☁️ Deploy

Production is a static frontend plus a single backend host — media never flows through the API:

```
Browser → Cloudflare Pages (Nuxt static output)
        → https://api.<your-domain> (Cloudflare-issued certificate)
        → Cloudflare Tunnel (outbound only; no inbound ports on the server)
        → api container on ECS (NestJS :3001) + Postgres container
Media: the browser plays directly from Alibaba OSS via presigned URLs.
```

| Part     | How                                                              | Command              |
| -------- | ---------------------------------------------------------------- | -------------------- |
| Frontend | Build the static output and push it to Cloudflare Pages          | `pnpm deploy:client` |
| Backend  | Build a linux/amd64 image → push to Alibaba ACR → remote restart | `pnpm deploy:serve`  |

The first deployment needs one-time setup: an ECS instance (2 vCPU / 2 GB and up, with public egress), a domain hosted on Cloudflare, an Alibaba ACR personal instance, an OSS bucket with RAM access keys, and a Cloudflare Tunnel. **The one-command scripts only update an existing deployment** — they will not create any of those resources, so do the first deployment by hand and verify it.

Production env vars (`DATABASE_URL`, `SECRET`, `AUTH_*`, `S3_*`, …) and the OSS setup are covered in [production env variables](./docs/env/README.env.prod.md). `apps/client/.env.prod` is baked into the browser bundle — public values such as `API_BASE` only, never secrets.

**Deployment docs** (written in Chinese):

- [First backend deployment: ECS / ACR / Cloudflare Tunnel](./docs/deploy/README.backend.md)
- [Frontend deployment: Cloudflare Pages](./docs/deploy/README.frontend.md)
- [Routine one-command deploys and the two env sets](./docs/deploy/README.deploy.md)
- [Production env variables, item by item](./docs/env/README.env.prod.md)

## 🧪 Tests

Please run the tests before committing.

```bash
pnpm test          # backend Jest unit tests + frontend Vitest
pnpm test:ci       # CI mode (starts the dev server for the client)
```

Frontend E2E: `cd apps/client && pnpm test:e2e:run` (Cypress).
Backend E2E needs the test database: `docker compose --profile test up -d` for testdb (host port 5480), and copy `apps/api/.env.test.example` to `.env.test`.

## 📚 More docs

| Doc                                                        | Contents                                             |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| [docs/README.instruction.md](./docs/README.instruction.md) | Local ports and default credentials cheat sheet      |
| [docs/README.login.md](./docs/README.login.md)             | Single-user login and credential configuration       |
| [docs/env/README.env.dev.md](./docs/env/README.env.dev.md) | Every local development env variable                 |
| [apps/api/README.md](./apps/api/README.md)                 | Backend modules, endpoint list, startup self-check   |
| [apps/client/README.md](./apps/client/README.md)           | Pages, state management, audio playback, Forge GUI   |
| [AGENTS.md](./AGENTS.md)                                   | How to use the code knowledge graph with an AI agent |

## 📄 License

[AGPL-3.0](./LICENSE)
