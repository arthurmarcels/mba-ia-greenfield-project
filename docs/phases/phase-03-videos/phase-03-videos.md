---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-06-26T07:07:31-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-26T07:10:39-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T07:05:41-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload, storage, asynchronous processing, and playback/download: authenticated users upload videos of up to 10GB directly to object storage without blocking the API (presigned multipart), each video is pre-registered as a draft and processed by a background worker (FFmpeg) that extracts duration/metadata and generates a thumbnail, and every video gets a unique URL served via HTTP range streaming and download — backed by MinIO, Redis/BullMQ, and an FFmpeg worker all running in Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose

**Description:** Install all Phase 03 dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add the MinIO (object storage), Redis (queue), and `video-worker` services to Docker Compose. The worker image must include `ffmpeg`/`ffprobe`.

**Technical actions:**

- Install production dependencies in nestjs-project: `minio@^8`, `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`, `fluent-ffmpeg@^2`, `nanoid@^5`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'minio'`), `STORAGE_PORT` (number, default `9000`), `STORAGE_USE_SSL` (boolean, default `false`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube-media'`), `STORAGE_PUBLIC_BASE_URL` (string, optional). Use Docker Compose service name `minio` as the default endpoint (never `localhost`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `QUEUE_HOST` (string, default `'redis'`), `QUEUE_PORT` (number, default `6379`), `QUEUE_PREFIX` (string, default `'streamtube'`)
- Update `src/config/env.validation.ts` — add all new variables to the Joi schema (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` required, others with defaults). Update `.env.example` with Compose-compatible defaults
- Extend `nestjs-project/compose.yaml`:
  - `minio` service — image `minio/minio`, command `server /data --console-address ":9001"`, ports 9000 (S3 API) + 9001 (console), env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, a named volume, and a healthcheck
  - `redis` service — image `redis:7-alpine`, port 6379, healthcheck
  - `video-worker` service — builds from a worker `Dockerfile.worker` (node + `ffmpeg`) OR reuses the API image with a different command; `depends_on` db + redis + minio; runs the worker entrypoint (`node dist/worker.js`)
  - wire `nestjs-api` to `depends_on` redis + minio (healthy)
- Create `Dockerfile.worker` (or a multi-stage image) based on `node:25-slim` + `apt-get install -y ffmpeg`, building the worker entrypoint. Keep the API image lean (no ffmpeg)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| _(no code tests this SI)_ | — | Verification is infra: `docker compose up -d` brings minio, redis, video-worker to healthy; app still boots; existing E2E (`GET /`) still passes |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts MinIO (reachable at `localhost:9000`, console at `:9001`), Redis (accepts connections on 6379 inside the network), and `video-worker` (running, not crash-looping)
- The API boots without error when all new env vars are provided; starting it without `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` fails Joi validation at bootstrap
- `ffmpeg -version` succeeds inside the `video-worker` container

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity linked to `Channel` (many-to-one), carrying the public slug, status lifecycle, storage keys, and processing output fields. Generate the `CreateVideos` migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `slug` (varchar, unique, not null — nanoid URL-safe public id), `title` (varchar, not null), `description` (text, nullable), `channel_id` (uuid FK → channels.id, not null), `status` (enum `draft|uploading|processing|ready|error`, not null, default `draft`), `duration_seconds` (integer, nullable), `metadata` (jsonb, nullable), `video_storage_key` (varchar, nullable), `thumbnail_storage_key` (varchar, nullable), `multipart_upload_id` (varchar, nullable), `file_size_bytes` (bigint, nullable), `mime_type` (varchar, nullable), `error_message` (text, nullable), `created_at` (CreateDateColumn), `updated_at` (UpdateDateColumn). Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })` and the matching inverse on `Channel` (`@OneToMany(() => Video)`) per the entity rules (both sides defined)
- Define a `VideoStatus` enum/union type in `src/videos/videos.constants.ts` (`as const`) and a `status_transition` guard (allowed transitions) used by the service in SI-03.5
- Generate migration via `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos` and review the SQL for the status enum type, columns, FK, unique index on `slug`, and index on `channel_id`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | unique `slug` constraint, `status` defaults to `draft`, enum rejects invalid values, channel FK relation, nullable processing fields |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with the `video_status_enum` type, all columns, the `channel_id` FK, the unique index on `slug`, and the index on `channel_id`
- Inserting two videos with the same `slug` fails with a unique-constraint violation
- A new video defaults to `status = 'draft'`; an out-of-enum value is rejected by the column constraint

---

### SI-03.3 — Storage Service (MinIO) and Storage Module

**Description:** Create a `StorageModule` + `StorageService` wrapping the MinIO client, exposing bucket initialization, presigned multipart upload (initiate / part-URL / complete), presigned GET (download), and range-aware object streaming. This is the single owner of object-storage interaction (single-responsibility).

**Technical actions:**

- Create `src/videos/storage/storage.service.ts` — injects the `storage` config and constructs a `minio.Client`. `onModuleInit` ensures the configured bucket exists (`makeBucket` guarded against "already exists")
- `StorageService` methods:
  - `initiateMultipartUpload(key: string): Promise<{ uploadId: string }>` — starts an S3 multipart upload for `key`
  - `presignPartUrl(key, uploadId, partNumber, expiry): Promise<string>` — presigned PUT for one part
  - `completeMultipartUpload(key, uploadId, parts: Array<{ partNumber; etag }>): Promise<void>`
  - `getObjectRange(key, range?: { start; end }): Promise<{ stream; contentLength; contentRange; totalSize }>` — for streaming (206)
  - `presignedDownloadUrl(key, filename, expiry): Promise<string>` — presigned GET with `response-content-disposition: attachment`
  - `putObject(key, buffer, contentType)` / `removeObject(key)` — used by the worker for the thumbnail
- Create `src/videos/storage/storage.module.ts` — `@Global()` `StorageModule` exporting `StorageService`, with `forRootAsync` reading the `storage` config

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/storage/storage.service.spec.ts` | Unit | Method calls map to the expected MinIO client calls (mocked client); part-URL / range params built correctly |
| `src/videos/storage/storage.service.integration-spec.ts` | Integration | Against a **real MinIO** (Compose service): initiate→part-presign→complete a small multipart upload, putObject + getObjectRange round-trip, presignedDownloadUrl resolves |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- The bucket is created on module init if absent; a second boot does not error
- A multipart upload can be initiated, a part URL issued, a part uploaded, and the upload completed against real MinIO
- `getObjectRange` returns a stream and correct `Content-Range`/`Content-Length` for a byte range; a full-object read returns 200-equivalent metadata

---

### SI-03.4 — Queue Module and Video Worker Entrypoint

**Description:** Wire BullMQ via `@nestjs/bullmq`, register the `video-processing` queue, and create a separate worker entrypoint (`src/worker.ts`) that boots a Nest application context consuming the queue. The worker is a second process/container sharing the same codebase, config, entities, and storage service.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })` and `BullModule.registerQueue({ name: 'video-processing' })`. Export a `VIDEO_PROCESSING_QUEUE` injection token
- Create `src/queue/queue.constants.ts` — `export const VIDEO_PROCESSING_QUEUE = 'video-processing';` and the job name `'process-video'`, `as const`
- Create `src/worker.ts` — a standalone Nest bootstrap: `const app = await NestFactory.createApplicationContext(AppModule); await app.init();` plus graceful shutdown (`enableShutdownHooks`). It reuses `AppModule` (which imports the queue module + videos module + storage module); the `@Processor` from SI-03.7 is registered through DI
- Update `package.json` scripts: `"start:worker": "node dist/worker.js"` and `"build:worker"` if a separate build step is needed. Ensure `nest build` emits `worker.js` (or build both `main.ts` and `worker.ts`)
- Register the queue module and videos module in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles and registers the `video-processing` queue with the configured connection |
| `src/worker.integration-spec.ts` | Integration | `createApplicationContext(AppModule)` boots the worker context and connects to real Redis without error |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- The queue connects to the `redis` Compose service by name (never `localhost`)
- The worker context boots as a separate process and stays up consuming the queue
- The `video-processing` queue is discoverable in BullMQ (e.g., via a quick `queue.add` + drain against real Redis)

---

### SI-03.5 — Videos Service, DTOs, and Module

**Description:** Implement the core `VideosService` (draft creation with nanoid slug, status transitions, ownership), request/response DTOs, and the `VideosModule`. This is the domain logic the controller (SI-03.6), worker processor (SI-03.7), and streaming endpoint (SI-03.8) all depend on.

**Technical actions:**

- Create `src/videos/dtos/` — `initiate-upload.dto.ts` (`title`, `filename`, `mimeType`, `sizeBytes`, optional `description`), `complete-upload.dto.ts` (`parts: Array<{ partNumber; etag }>`), with class-validator rules (title non-empty, mimeType in an allow-list, sizeBytes ≤ 10GB). Reuse the inherited `{ statusCode, error, message }` error contract
- Create `src/videos/videos.service.ts` injecting `Repository<Video>`, `StorageService`, the `VIDEO_PROCESSING_QUEUE` queue:
  - `createDraft(channelId, dto): Promise<Video>` — generate `slug = nanoid(12)`; on unique-constraint violation regenerate (retry loop). Persist `status = 'draft'`
  - `beginUpload(video, key): Promise<{ uploadId }>` — `StorageService.initiateMultipartUpload`, set `status = 'uploading'`, `multipart_upload_id`, `video_storage_key`
  - `completeUpload(videoId, parts): Promise<Video>` — `StorageService.completeMultipartUpload`, set `status = 'processing'`, then `queue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })`
  - `findBySlug(slug)`, `findById(id)`, `findByChannel(channelId)`, `markReady(videoId, { duration, metadata, thumbnailKey })`, `markError(videoId, message)` — all guarded by the `status_transition` map from SI-03.2
  - ownership helper: assert a video belongs to the caller's channel, else throw `ForbiddenResourceException`
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, providers `VideosService`, exports `VideosService` + `TypeOrmModule`. Import `StorageModule` and `QueueModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | nanoid slug generation + collision retry (mock repository to throw unique-violation once), status-transition guards reject illegal transitions, ownership throws on channel mismatch |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against real DB: createDraft persists `draft`; completeUpload transitions to `processing` and enqueues a real job (assert queue receives it via real Redis) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Two drafts get distinct, URL-safe slugs; a forced unique violation triggers regeneration rather than surfacing the constraint error
- Status transitions are enforced — e.g., `completeUpload` on a non-`uploading` video is rejected
- `completeUpload` enqueues exactly one `process-video` job carrying `{ videoId }` with attempts/backoff set

---

### SI-03.6 — Upload Endpoints (Initiate, Part URL, Complete)

**Description:** Add the authenticated upload endpoints to `VideosController`: initiate (create draft + start multipart), fetch a presigned part URL, and complete (finalize multipart + enqueue processing). The API never receives file bytes.

**Technical actions:**

- Create `src/videos/videos.controller.ts`:
  - `POST /videos` (authenticated) — body `InitiateUploadDto` → creates draft in the caller's channel, derives the storage key `<channelId>/<videoId>/original.<ext>` (ext from mimeType), calls `beginUpload` → `201 { id, slug, uploadId, key, partSize }`
  - `GET /videos/:id/upload-url?partNumber=N` (authenticated, owner) → `200 { url }` (presigned PUT for that part)
  - `POST /videos/:id/complete` (authenticated, owner) — body `CompleteUploadDto` → `completeUpload` → `200 { id, slug, status: 'processing' }`
- Resolve the caller's channel from the JWT payload (reuse Phase 02 auth) for ownership and key scoping
- Apply the inherited domain exception filter + ValidationPipe; add `VideoNotFoundException`, `ForbiddenResourceException` to `src/common/exceptions/`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.controller.spec.ts` | Unit | Controller maps service results to correct status codes / shapes; calls service with the caller's channel |
| `test/videos-upload.e2e-spec.ts` | E2E | Full HTTP cycle: authenticated initiate → 201 with uploadId; part-URL endpoint returns a presigned PUT; complete → 200 `processing`; unauthorized user blocked; non-owner gets 403 |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- An authenticated user can initiate an upload, receive a multipart uploadId + part URL, and complete the upload; the response transitions the video to `processing`
- No file body transits the API (only control calls + presigned URLs) — a large upload does not pin the API process
- A non-owner attempting `upload-url`/`complete` on another channel's video gets `403`; an unauthenticated request gets `401`

---

### SI-03.7 — Video Processing Processor (Worker, FFmpeg)

**Description:** Implement the BullMQ `@Processor('video-processing')` in the worker process: on `process-video`, download the original to a temp file, run `ffprobe` for duration/metadata, capture a midpoint thumbnail with `ffmpeg`, upload the thumbnail to storage, and update the video to `ready` (or `error` with a message on failure).

**Technical actions:**

- Create `src/videos/processing/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`. `process(job: Job<{ videoId }>)`:
  1. load the video; set `status = 'processing'` if not already
  2. stream the original object to a temp file (`StorageService.getObjectRange(key)` → `fs.createWriteStream`)
  3. `fluent-ffmpeg` `ffprobe(path)` → extract `duration_seconds` and a metadata summary (codec, width, height, bitrate) into the `metadata` jsonb
  4. `ffmpeg(path).screenshots({ timestamps: ['50%'], filename, folder, size })` → single JPEG; upload via `StorageService.putObject(thumbnailKey, buffer, 'image/jpeg')`
  5. `VideosService.markReady(videoId, { duration, metadata, thumbnailKey })` → `status = 'ready'`
  6. on error: if unrecoverable (corrupt file / ffprobe fails), throw `UnrecoverableError`; otherwise throw a regular `Error` (retry per attempts). On terminal failure, `markError(videoId, message)` sets `status = 'error'` + `error_message` via a `@OnWorkerEvent('failed')` handler when attempts are exhausted
  7. clean up the temp file in a `finally`
- Decide part-size/thumbnail-size constants in `src/videos/videos.constants.ts` (e.g., thumbnail `1280x720`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/video-processing.processor.spec.ts` | Unit | Processor orchestrates ffprobe/screenshots calls (mock `fluent-ffmpeg`), calls `markReady` with extracted duration/metadata; on ffprobe failure throws (retryable vs `UnrecoverableError`) |
| `src/videos/processing/video-processing.processor.integration-spec.ts` | Integration | Against real FFmpeg (worker image) + real MinIO + real DB + a small sample video fixture: job consumes → video becomes `ready` with `duration_seconds`, `metadata`, and a `thumbnail_storage_key` whose object exists in MinIO |

**Dependencies:** SI-03.4, SI-03.5, SI-03.3

**Acceptance criteria:**

- A completed upload, once its `process-video` job runs in the worker, transitions to `ready` with populated `duration_seconds`, `metadata`, and `thumbnail_storage_key`
- The thumbnail object is actually present in MinIO at `<channelId>/<videoId>/thumbnail.jpg`
- A corrupt/invalid video causes the job to fail and the video to reach `error` with a non-empty `error_message` (after exhausting retries or on `UnrecoverableError`)

---

### SI-03.8 — Streaming and Download Endpoints

**Description:** Add the public streaming and download endpoints that serve a ready video via HTTP range (206 Partial Content) proxied from MinIO, keyed by the unique slug. These are anonymous-accessible (`@Public`).

**Technical actions:**

- In `VideosController`:
  - `GET /videos/:slug/stream` (`@Public()`) — read the `Range` header, `findBySlug`, guard `status === 'ready'` (else `VideoNotReadyException`/404), `StorageService.getObjectRange(key, range)` → respond `206` with `Accept-Ranges: bytes`, `Content-Range`, `Content-Length`, `Content-Type`; respond `200` + full stream when no `Range` is present
  - `GET /videos/:slug/download` (`@Public()`) — resolve the ready video and return a short-lived presigned attachment URL (`StorageService.presignedDownloadUrl(key, filename)`) — `200 { url }` or a `302` redirect, offloading the large download from the API
- Add `VideoNotReadyException` (409) and `VideoNotFoundException` (404) to the exception catalog

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos-streaming.e2e-spec.ts` | E2E | A `Range` request on a `ready` video returns `206` + `Content-Range`; a no-range request returns `200`; a request for a non-ready/unknown slug returns 409/404; download endpoint returns a usable presigned attachment URL; anonymous access works (no auth header) |

**Dependencies:** SI-03.5, SI-03.3

**Acceptance criteria:**

- A `Range: bytes=0-1023` request streams the first 1KB with `206` and correct `Content-Range`; the whole object streams on a rangeless request
- A player-style multi-range request sequence plays without requiring the full download (streaming, not buffering)
- Streaming/download of a `draft`/`processing`/`error` video is rejected (409 `VIDEO_NOT_READY`); an unknown slug returns 404
- Anonymous (unauthenticated) clients can stream and download ready videos

---

### SI-03.9 — Documentation Update and Definition of Done

**Description:** Update `CLAUDE.md` (root) and `nestjs-project/CLAUDE.md` to document the videos module, endpoints, queue/worker, and storage, consistent with the shipped code. Then run the full Definition of Done: full test suite, `tsc --noEmit`, lint, and an end-to-end Compose verification of the real flow.

**Technical actions:**

- Update `nestjs-project/CLAUDE.md` — add the MinIO, Redis, and `video-worker` services to the services list; document container-only vs host-only commands for the new services (e.g., `docker compose exec video-worker ...`); note the `start:worker` script and that the worker image carries `ffmpeg`
- Update root `CLAUDE.md` — extend the architecture/container notes and repository structure to reflect the `videos/` module, the `videos` table, the queue/worker, and MinIO storage (no citations of nonexistent files/behaviors)
- Update `docs/diagrams/software-arch.mermaid` message-queue label from `TBD` to `Redis (BullMQ)` to match the shipped architecture
- Run full DoD inside containers:
  - `docker compose exec nestjs-api npm test -- --runInBand`
  - `docker compose exec nestjs-api npm run test:e2e`
  - `docker compose exec nestjs-api npx tsc --noEmit`
  - `docker compose exec nestjs-api npm run lint`
- Verify the real end-to-end flow on Compose: initiate upload → upload a small sample video via the presigned part URL → complete → observe the worker process it to `ready` → stream it with a `Range` request (206) → download it

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| _(no new tests)_ | — | DoD: all suites green, `tsc` exit 0, lint clean, and the manual Compose e2e flow works |

**Dependencies:** SI-03.6, SI-03.7, SI-03.8

**Acceptance criteria:**

- `CLAUDE.md` (root + nestjs-project) accurately describes the videos module, endpoints, queue/worker, and storage — every cited file/behavior exists
- `npx tsc --noEmit` exits with code 0; `npm run lint` passes
- Full unit + integration + e2e suites pass (`--runInBand`)
- On Compose, a real small video flows draft → uploading → processing → ready, streams via 206, and downloads — exercising real MinIO, Redis, and FFmpeg (not mocks)

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| slug | varchar | unique, not null | nanoid URL-safe public id (12 chars) — the URL key (TD-04) |
| title | varchar(255) | not null | Set at upload init; editable in a later phase |
| description | text | nullable | |
| channel_id | uuid | FK → channels.id, not null | Owning channel |
| status | enum | not null, default `draft` | `draft \| uploading \| processing \| ready \| error` (TD-07); PG enum type `video_status_enum` |
| duration_seconds | integer | nullable | From `ffprobe` (TD-03) |
| metadata | jsonb | nullable | ffprobe summary: codec, width, height, bitrate, etc. (TD-03) |
| video_storage_key | varchar | nullable | `<channelId>/<videoId>/original.<ext>` (TD-06) |
| thumbnail_storage_key | varchar | nullable | `<channelId>/<videoId>/thumbnail.jpg` (TD-06) |
| multipart_upload_id | varchar | nullable | S3 multipart upload id while uploading (TD-02) |
| file_size_bytes | bigint | nullable | Declared at upload init |
| mime_type | varchar | nullable | Declared at upload init |
| error_message | text | nullable | Set when `status = 'error'` (TD-07) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); inverse `@OneToMany` on `Channel`.
**Indexes:** `(slug)` — unique; `(channel_id)` — FK lookups / per-channel listing.

**Status transitions (TD-07):** `draft → uploading → processing → ready`; `uploading|processing → error`; `error` is terminal (re-processing is a later-phase concern). Enforced by a transition map in `videos.service`.

---

### API Contracts

All responses use the inherited `{ statusCode, error, message }` shape; validation errors are `{ statusCode: 400, error: 'VALIDATION_ERROR', message: [...] }`. Upload endpoints require `Authorization: Bearer <access_token>`; streaming/download are `@Public`.

#### POST /videos (SI-03.6)

**Request headers:** Authorization: Bearer \<access_token>; Content-Type: application/json
**Request body:** title (string, required), filename (string, required), mimeType (string, required — video allow-list), sizeBytes (number, required, ≤ 10GB), description (string, optional)
**Response 201:** { id, slug, status: 'uploading', uploadId, key, partSize }
**Error responses:** 400 VALIDATION_ERROR; 401 unauthorized; 403 not the channel owner

---

#### GET /videos/:id/upload-url?partNumber=N (SI-03.6)

**Request headers:** Authorization: Bearer \<access_token>
**Response 200:** { url } — a presigned PUT URL for the given part (client uploads the part directly to MinIO)
**Error responses:** 400 VALIDATION_ERROR (missing/invalid partNumber); 401; 403 non-owner; 404 VIDEO_NOT_FOUND

---

#### POST /videos/:id/complete (SI-03.6)

**Request headers:** Authorization: Bearer \<access_token>; Content-Type: application/json
**Request body:** parts: Array<{ partNumber: number, etag: string }> (required)
**Response 200:** { id, slug, status: 'processing' }
**Error responses:** 400 VALIDATION_ERROR; 401; 403 non-owner; 404 VIDEO_NOT_FOUND; 409 if the video is not in `uploading` state

---

#### GET /videos/:slug/stream (SI-03.8)

**Request headers:** (optional) Range: bytes=\<start>-\<end>
**Response 206 (with Range):** stream + `Accept-Ranges: bytes`, `Content-Range: bytes <start>-<end>/<total>`, `Content-Length`, `Content-Type: <mime>`
**Response 200 (no Range):** full stream
**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY (video not `ready`)

---

#### GET /videos/:slug/download (SI-03.8)

**Response 200:** { url } — a short-lived presigned GET URL with `response-content-disposition: attachment` (client downloads directly from MinIO)
**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY

#### Validation Rules — Upload

| Field | Rule | Error message |
|-------|------|---------------|
| title | Non-empty, ≤ 255 chars | title must not be empty |
| mimeType | In the video allow-list (mp4, webm, …) | mimeType must be a supported video type |
| sizeBytes | Integer, ≤ 10\*1024^3 | sizeBytes must be at most 10GB |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos | | ✓ | Creates a draft in the caller's channel |
| GET /videos/:id/upload-url | | ✓ | Owner only — presigned part URL |
| POST /videos/:id/complete | | ✓ | Owner only — finalizes + enqueues |
| GET /videos/:slug/stream | ✓ | | Anonymous watch; ready videos only |
| GET /videos/:slug/download | ✓ | | Anonymous download; ready videos only |

---

### Error Catalog

**Error response format (inherited from Phase 02):** `{ statusCode: number, error: string, message: string }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Stream/download/complete referencing an unknown id/slug |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | Stream/download on a video whose status is not `ready` |
| FORBIDDEN_RESOURCE | 403 | You do not own this resource | Upload-url/complete by a user whose channel is not the video's owner |
| VALIDATION_ERROR | 400 | (array of field errors) | Invalid upload DTO (inherited behavior) |

> Processing failures are **not** HTTP errors — the worker writes `status = 'error'` + `error_message` to the row; clients observe it via the video's state (a later-phase management endpoint surfaces it).

---

### Events/Messages

**Broker:** Redis, accessed via `@nestjs/bullmq` / BullMQ (`Queue`/`Worker`). Connection uses the `redis` Compose service name.

| Queue | Job name | Producer | Consumer | Payload | Retry policy |
|-------|----------|----------|----------|---------|--------------|
| `video-processing` | `process-video` | `VideosService.completeUpload` (API) | `VideoProcessingProcessor` (`@Processor`, worker process) | `{ videoId: string }` | `attempts: 3`, exponential backoff (delay 1000ms) |

**Job lifecycle → video status mapping (TD-07):**

| BullMQ event | Video status transition | Side effects |
|--------------|------------------------|--------------|
| job added (on `completeUpload`) | `uploading → processing` | original multipart finalized in storage |
| `completed` | `processing → ready` | persist `duration_seconds`, `metadata`, `thumbnail_storage_key` |
| `failed` (attempts exhausted) or `UnrecoverableError` | `processing → error` | write `error_message` (temp files cleaned up) |

**Idempotency / durability:** re-running a job re-derives metadata and overwrites the thumbnail safely (keyed by `<channelId>/<videoId>`). A lost Redis job is recoverable by re-enqueuing from the DB row (`status = 'processing'` with no completed job).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2 (entity + migration)
├── SI-03.3 (storage service)
└── SI-03.4 (queue module + worker entrypoint)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5 (videos service + DTOs + module)

SI-03.5
├── SI-03.6 (upload endpoints)
├── SI-03.8 (streaming + download endpoints)
└── SI-03.7 (processing processor)

SI-03.6 + SI-03.7 + SI-03.8
└── SI-03.9 (docs + Definition of Done)
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6, SI-03.7, SI-03.8 (parallel) → SI-03.9.

## Deliverables

- [ ] MinIO (object storage), Redis (queue), and `video-worker` services running in `docker compose` with the API; worker image includes FFmpeg
- [ ] `videos` table created by migration, linked to `channels` via `channel_id`, with the status enum
- [ ] Upload of up to 10GB that never streams bytes through the API (presigned multipart), with draft pre-registration on initiate and `uploading → processing` on complete
- [ ] Background worker (BullMQ consumer) that extracts duration/metadata (`ffprobe`) and generates a thumbnail (`ffmpeg`), transitioning the video to `ready`
- [ ] Unique URL per video (nanoid slug, DB-unique with collision retry), never conflicting
- [ ] HTTP range streaming (`206 Partial Content`) for ready videos, anonymous-accessible
- [ ] Video download available (presigned attachment URL)
- [ ] Video status lifecycle (`draft → uploading → processing → ready | error`) reflected in the DB, with `error_message` on failure
- [ ] `CLAUDE.md` (root + nestjs-project) updated with the videos module, endpoints, queue/worker, and storage, consistent with the code
- [ ] Full unit + integration + e2e suites green (`docker compose exec nestjs-api npm test -- --runInBand` and `npm run test:e2e`), exercising real MinIO/Redis/FFmpeg (not mocks)
- [ ] `npx tsc --noEmit` exits with code 0; `npm run lint` passes
- [ ] Real end-to-end flow verified on Compose: initiate → upload → complete → worker processes to `ready` → stream (206) → download
