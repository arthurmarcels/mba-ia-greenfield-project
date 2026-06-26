---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T06:45:50-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T07:05:41-03:00"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-06-26T06:45:50-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-06-26T06:45:50-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-26T06:45:50-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**
_(literal, `docs/project-plan.md`)_

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Frontend (video UI is a later phase — this is a backend-only phase per the engagement brief); video management/editing, visibility/publish flow, watch page, categories, and social interactions (Fases 04+).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas — with storage, queue, and worker running in Docker Compose.

**Affected subprojects:** `nestjs-project/` (API + video worker share the same codebase).

**Deferred subprojects:** `next-frontend/` — no video UI in this phase.

**Sequencing notes:** Depends on Fase 01 (config/TypeORM/migration foundation) and Fase 02 (auth, JWT guard, channel entity, domain exception filter, validation pipe, throttler).

**Neighbors (for boundary detection only):**
- **Phase 02:** (prior) provides auth, the global JWT guard, `Channel` entity (videos belong to a channel), the standardized `{ statusCode, error, message }` error format, `@Public()` opt-out, and the global `ValidationPipe`.
- **Phase 04:** (next) consumes the `videos` table (drafts/publish, visibility, management panel, channel page). Phase 03 should not pre-build editing/publish endpoints.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Queue / Background-Processing Technology | decided | A (Redis + BullMQ via @nestjs/bullmq) | @nestjs/bullmq@^11, bullmq@^5, ioredis@^5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Strategy for Videos up to 10GB | decided | B (Presigned multipart upload) | minio@^8 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime, Metadata & Thumbnail | decided | A (Separate NestJS worker container + fluent-ffmpeg) | fluent-ffmpeg@^2 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (nanoid short slug, DB-unique, retry) | nanoid@^5 |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Streaming & Download Strategy | decided | A (API range-proxy, 206 Partial Content) | minio@^8 |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Object-Storage Usage (Buckets & Key Layout) | decided | A (Single bucket, channel-scoped keys by type) | minio@^8 |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (Five-state: draft→uploading→processing→ready/error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-06 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (Redis + BullMQ via @nestjs/bullmq) — It is the documented NestJS queue pattern, gives retries/backoff/failed-state out of the box (which maps directly onto the video `error` status), and runs the worker as a second NestJS container reusing the existing codebase, config, and entities. RabbitMQ's routing power is unused by a single consumer queue, and SQS breaks the local-first model. Redis AOF persistence + idempotent re-enqueue from the DB cover the durability concern.

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`

### phase-03-videos/TD-02

**Recommendation:** Option B (Presigned multipart upload) — It is the only option that genuinely supports 10GB (single PUT is capped at 5GB), it never streams bytes through the API, and per-part retry delivers resume-on-failure. It uses the native S3 multipart protocol, which MinIO implements identically to S3 — zero rewrite for production. The API's role stays cheap: create draft → issue presigned part URLs → confirm completion → enqueue processing.

**Libraries:** `minio@^8`

### phase-03-videos/TD-03

**Recommendation:** Option A (Separate NestJS worker container + fluent-ffmpeg) — It reuses the existing NestJS codebase (config, entities, repositories, storage service) instead of duplicating it, isolates CPU-heavy FFmpeg work in its own container, and is the natural BullMQ consumer from TD-01. `fluent-ffmpeg` provides a clean, promise-able API for both `ffprobe` (metadata/duration) and single-frame thumbnail extraction. The only cost is an `ffmpeg` install in the worker image.

**Libraries:** `fluent-ffmpeg@^2`

### phase-03-videos/TD-04

**Recommendation:** Option A (nanoid short slug) — It produces short, URL-safe, non-enumerable handles ideal for a sharing platform, and the DB unique index + regenerate-on-collision gives an absolute uniqueness guarantee. The dependency is trivial. Non-monotonic ordering is irrelevant since discovery/listing is a later phase.

**Libraries:** `nanoid@^5`

### phase-03-videos/TD-05

**Recommendation:** Option A (API range-proxy) — It delivers true streaming (players get `206` over `Range`), keeps a single stable URL per video keyed by the unique slug, and reuses one endpoint for both streaming and download. Access control and error handling stay consistent. Presigned URLs break the stable-URL requirement and leak the storage host; HLS is out of scope.

**Libraries:** `minio@^8` (getObject range streaming)

### phase-03-videos/TD-06

**Recommendation:** Option A (Single bucket, channel-scoped keys by type) — One bucket is simplest to provision and policy, the `<channelId>/<videoId>/<type>` key scheme is collision-free and deterministic, and it keeps original vs. thumbnail distinct while staying channel-grouped. The `videos` row stores storage **keys**, never URLs — URLs are derived (presigned / streamed) from the key on demand.

**Libraries:** `minio@^8`

### phase-03-videos/TD-07

**Recommendation:** Option A (Five-state lifecycle) — It honors the brief's `rascunho → processando → pronto/erro` cycle while making the in-progress upload window explicit (`uploading`) and giving failures a debuggable home (`error` + `error_message`). The states map cleanly onto BullMQ job outcomes. Transitions are enforced by an enum column guarded in the service layer.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — Backend-only project (no shared schemas with frontend); class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI).

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Machine-readable error codes that the frontend can switch on, in the shape `{ statusCode, error, message }`, established as the project-wide HTTP error contract from the first HTTP-exposing phase onward.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration via the guard system, scoping rate limiting per module via module-level `APP_GUARD`.

**Libraries:** `@nestjs/throttler@^6.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true`, `synchronize: false`; migrations versioned under `src/database/migrations/`. _(from phase 01)_
- Entities: UUID PKs (`@PrimaryGeneratedColumn('uuid')`), `@CreateDateColumn`/`@UpdateDateColumn`, explicit table names, `select: false` on sensitive fields, both sides of relations defined, explicit relation loading. _(from phase 01/02)_
- **HTTP error contract (load-bearing for Phase 03 endpoints):** all responses use the shape `{ statusCode: number, error: string, message: string }`; `error` carries the domain error code, validated by a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) and a `DomainExceptionFilter` + `ValidationExceptionFilter`. _(from phase 02)_
- **Auth (load-bearing):** a global JWT access-token guard (`APP_GUARD`) protects all endpoints by default; `@Public()` is the opt-out for anonymous-accessible endpoints (e.g., streaming/watching). Authenticated requests carry `Authorization: Bearer <access_token>`. _(from phase 02)_
- Rate limiting via `@nestjs/throttler` (module-scoped). _(from phase 02)_
- Each domain gets its own module with controllers (HTTP routing) + services (business logic), repositories scoped to their module; `ChannelsModule`/`UsersModule` are the structural reference. _(from phase 01/02)_
- Docker Compose is the only runtime; inter-service hosts use the Compose service name (`db`, `mailpit`), never `localhost`. _(from phase 01/02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._ (Phase 02 deferred only the frontend auth screens; Phase 03's own deferred capability — the video UI — is recorded below.)

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Video UI (upload screen, player, watch page) | deferred | This is a backend-only phase; the video frontend surfaces are deferred to a later phase when `next-frontend/` adds them. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces a new domain module (`videos`), a second process entrypoint (the worker), new external infra dependencies (Redis, MinIO), and an async-processing flow — each exercised across the test pyramid:

| Artifact type | Required layers |
|---------------|-----------------|
| `videos` service / repository logic | Unit (`*.spec.ts`) for pure logic + nanoid/collision + status-transition guards; Integration (`*.integration-spec.ts`) against real Postgres + real MinIO for entity constraints and storage-key writes |
| `videos` controller (upload init/complete, stream, download) | E2E (`*.e2e-spec.ts` via supertest) for the full HTTP cycle incl. range-request streaming (206), auth (`@Public` vs authenticated), and the standardized error contract |
| Worker processor (FFmpeg metadata + thumbnail) | Unit for the ffprobe/ffmpeg orchestration (mock `fluent-ffmpeg`); Integration against a real FFmpeg binary on a real sample video in the worker container |
| Queue producer/consumer (BullMQ + Redis) | Integration against a real Redis (Compose service) — assert job is enqueued on upload-complete and consumed to a terminal `ready`/`error` state; **never mock what the Compose infra can run for real** |
| Migration (`CreateVideos`) | Integration — `migration:run`/revert against a real DB, plus entity/table coherence |

Integration and E2E suites share the test DB and must run with `--runInBand`. Per the engagement brief: "Não mocke o que dá para testar de verdade com a infra do Compose" — Redis, MinIO, and FFmpeg are exercised through real Compose services, not mocks.
