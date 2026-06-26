# phase-03-videos — Progress

**Status:** implementation in progress — 2/9 SIs implemented (SI-03.1 ✅, SI-03.4 ✅), SI-03.2 ✅ just completed
**SIs:** 2/9 implemented (SI-03.1 ✅, SI-03.2 ✅, SI-03.4 ✅; SI-03.3/.5/.6/.7/.8/.9 not started)

> Planning pipeline complete and **approved by the board** on parent AMS-368. Git Flow set up by CTO: `dev` created from `main`, working branch `feature/AMS-368-phase-03-videos` from `dev`; planning artifacts committed as the first branch commit (durable spec for all 9 SIs). Implementation routed SI-by-SI per the Dependency Map — only advance when the current SI's suite is green.
>
> ⚠️ **Push gate:** repo write access for the agent service account is currently read-only — tracked in [AMS-371](/AMS/issues/AMS-371) (CEO-owned). Does not block engineering (SIs commit locally); gates only the final `git push` + PR.

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose
- **Status:** routed → Infrastructure Lead ([AMS-370](/AMS/issues/AMS-370)); no deps; blocks SI-03.2/.3/.4
- **Tests:** — (infra verification: `docker compose up -d` brings minio/redis/video-worker healthy; app boots; existing `GET /` E2E green)
- **Observations:** adds `minio`, `@nestjs/bullmq`/`bullmq`/`ioredis`, `fluent-ffmpeg`, `nanoid`; new `storage` + `queue` config namespaces; MinIO + Redis + `video-worker` services in Compose; worker image carries FFmpeg.

### SI-03.2 — Video Entity and Migration
- **Status:** ✅ **DONE** — issue [AMS-376](/AMS/issues/AMS-376) (Backend Lead); branch `feature/AMS-368-phase-03-videos`
- **Delivered:** `src/videos/entities/video.entity.ts` (UUID PK, timestamps, `slug` varchar(21) unique, `status` enum `video_status_enum` default `draft`, `channel_id` FK → `channels.id`, all processing fields nullable); `src/videos/videos.constants.ts` (`VIDEO_STATUS` as const object, `VideoStatus` type, `VIDEO_STATUS_TRANSITIONS` map, `canTransition()` helper); `src/videos/entities/video.entity.integration-spec.ts` (8 integration tests ✅); `src/database/migrations/1782478498145-CreateVideos.ts` (migration ✅); `src/channels/entities/channel.entity.ts` (added `@OneToMany(() => Video) videos: Video[]` inverse relation); `src/channels/channels.module.ts` (temporarily registered `Video` entity via `TypeOrmModule.forFeature([Channel, Video])` until `VideosModule` exists in SI-03.5); `src/test/create-test-data-source.ts` (added `DELETE FROM "videos"` to `cleanAllTables`); `src/database/migrations.integration-spec.ts` (updated MANAGED_TABLES + migrations array + test expectations).
- **Tests run (in container, `db` healthy):** `src/videos/entities/video.entity.integration-spec.ts` ✅ (8/8 tests: unique slug, default draft status, enum constraint rejection, FK enforcement, relation loading, nullable fields, jsonb metadata, bigint file_size); `src/database/migrations.integration-spec.ts` ✅ (2/2 tests: apply all migrations + create 5 tables, undo last migration + drop videos table); **full suite** ✅ 26/26 test suites, 154/154 tests (`npm test -- --runInBand`); `tsc --noEmit` ✅ exit 0; **SI-03.2 files** ✅ 0 ESLint errors.
- **Verified:** migration creates `CREATE TYPE "video_status_enum"` (singular name ✅), all columns present, FK `videos_channel_id → channels(id)`, UNIQUE index on `slug`, `idx_videos_channel_id` index; enum rejects invalid values; status defaults to `draft`; `file_size_bytes` returns string (bigint behavior); metadata stores jsonb; nullable fields accept null; Channel ↔ Video bidirectional relation works.
- **Observations:** `video_status_enum` uses explicit `enumName: 'video_status_enum'` to avoid default `videos_status_enum`; `VIDEO_STATUS` as const object (not TS enum) with derived `VideoStatus` type; status-transition guard defined now for SI-03.5 use; all integration test files updated to include `Video` entity in `ALL_ENTITIES` arrays (TypeORM requires relation entities to build metadata).

### SI-03.3 — Storage Service (MinIO) and Storage Module
- **Status:** not started
- **Tests:** —
- **Observations:** single owner of object storage; presigned multipart + range streaming + presigned download.

### SI-03.4 — Queue Module and Video Worker Entrypoint
- **Status:** implemented + verified in isolation — issue [AMS-375](/AMS/issues/AMS-375) (Backend Lead); aggregate DoD gate (full-suite + `tsc --noEmit` exit 0) **blocked** on [AMS-376](/AMS/issues/AMS-376) (SI-03.2) in-flight WIP in the shared workspace. Branch `feature/AMS-368-phase-03-videos`.
- **Delivered:** `src/queue/queue.constants.ts` (`VIDEO_PROCESSING_QUEUE='video-processing'`, `PROCESS_VIDEO_JOB='process-video'`, `as const`); `src/queue/queue.module.ts` (`BullModule.forRootAsync` via `queueConfig` → Compose `redis`, `registerQueue(VIDEO_PROCESSING_QUEUE)`, re-exports `BullModule`); `src/worker.ts` (`createApplicationContext(AppModule)` + `enableShutdownHooks`, no HTTP listener); `QueueModule` registered in `AppModule`; `package.json` `start:worker` (`nest build` already emits `dist/worker.js`, so no separate `build:worker`); `Dockerfile.worker` kept in dev-keepalive parity with `Dockerfile.dev` (launch via `docker compose exec video-worker npm run start:worker`). Videos/storage modules **not** registered — they don't exist yet (SI-03.2/.3/.5 are parallel siblings); registering them now would break `tsc`.
- **Tests run (in container, `redis`/`db` healthy):** `src/queue/queue.module.spec.ts` ✅ compiles + registers the `video-processing` queue on real Redis; `src/worker.integration-spec.ts` ✅ boots the full `AppModule` application context and `queue.add(PROCESS_VIDEO_JOB)` round-trips to real Redis. SI-03.4 files: **0** `tsc` errors.
- **DoD gate pending:** the *aggregate* `tsc --noEmit` and full suite are RED **only** because of [AMS-376](/AMS/issues/AMS-376) (SI-03.2) concurrent WIP in this shared workspace — (1) `src/videos/entities/video.entity.ts:38` TS1272: `VideoStatus` is a type used in a decorated signature but imported as a value (needs `import type`, per `.claude/rules/typescript-strict.md`); (2) the `Channel#videos` inverse relation with `Video` not yet registered in any `TypeOrmModule.forFeature([Video])`, which crashes `AppModule` boot (`Entity metadata for Channel#videos was not found`). Neither is SI-03.4 code. Re-run the aggregate gate once AMS-376 completes.
- **Observations:** BullMQ `video-processing` queue; separate `src/worker.ts` Nest application-context bootstrap. The `@Processor(VIDEO_PROCESSING_QUEUE)` arrives via DI in SI-03.7.

### SI-03.5 — Videos Service, DTOs, and Module
- **Status:** not started
- **Tests:** —
- **Observations:** nanoid slug + collision retry, status-transition guards, ownership, enqueue-on-complete.

### SI-03.6 — Upload Endpoints (Initiate, Part URL, Complete)
- **Status:** not started
- **Tests:** —
- **Observations:** API never receives file bytes; presigned multipart handshake.

### SI-03.7 — Video Processing Processor (Worker, FFmpeg)
- **Status:** not started
- **Tests:** —
- **Observations:** `ffprobe` metadata/duration + midpoint thumbnail; `ready`/`error` outcome.

### SI-03.8 — Streaming and Download Endpoints
- **Status:** not started
- **Tests:** —
- **Observations:** range-proxy `206` streaming + presigned download; `@Public` anonymous access.

### SI-03.9 — Documentation Update and Definition of Done
- **Status:** not started
- **Tests:** —
- **Observations:** update `CLAUDE.md` (root + nestjs-project) + arch diagram; full DoD + real Compose e2e verification.
