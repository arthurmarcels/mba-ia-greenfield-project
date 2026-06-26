---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-26
scope_description: "Backend for video upload, storage, async processing and streaming: queue technology, 10GB upload strategy, video worker + FFmpeg processing, unique URL, streaming/download, object-storage usage, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video upload endpoints (create draft, issue upload URLs, complete upload, stream, download), the queue producer, the `videos` module + entity + migration, and the object-storage service. It also hosts the **video worker** (a second NestJS entrypoint that consumes the processing queue).
- `next-frontend/` — Frontend out of scope for this phase. The video UI is explicitly deferred (this is a backend-only phase per the engagement brief). No open decision in this document.

---

## TD-01: Queue / Background-Processing Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (metadata extraction, thumbnail generation) is CPU/IO-heavy and must run out-of-band so the upload/response path never blocks. The project plan leaves the message-queue component explicitly open ("TBD" in `software-arch.mermaid`). This is the principal stack decision of the phase. The chosen tech must (a) integrate with NestJS 11, (b) support retries + a failed/dead-letter path for error videos, (c) run a worker as a separate container, and (d) be trivial to stand up locally in Docker alongside the existing API + Postgres.

**Options:**

### Option A: Redis + BullMQ (@nestjs/bullmq)
- BullMQ is a Redis-backed job queue for Node with first-class NestJS integration via `@nestjs/bullmq` (`BullModule.registerQueue`, `@Processor` + `WorkerHost.process()`, worker-event listeners). The API enqueues with `queue.add()`; a separate process/container runs the `Worker`. Built-in retries with exponential backoff, `attempts`, `UnrecoverableError` to stop retrying, `moveToFailed`, job priorities, and concurrency control.
- **Pros:** Canonical NestJS pattern (official `@nestjs/bullmq` package, documented recipe). Redis is a single lightweight container already standard in dev stacks. Worker is just another NestJS bootstrap (`NestFactory.createApplicationContext`) sharing the same codebase/config/entities — no new language or runtime. Retry/backoff/failed-set come free; the video-error lifecycle maps cleanly to BullMQ's failed state. Bull Board gives an optional UI.
- **Cons:** Redis is an in-memory store used as a queue (not a durable broker like RabbitMQ); a Redis flush loses pending jobs (mitigated by Redis AOF persistence and by idempotent re-enqueue from the DB). Adds Redis as an infra dependency.

### Option B: RabbitMQ (AMQP 0.9.1 broker)
- A full message broker with exchanges, routing, durable queues, and dead-letter exchanges. Integrable via `amqplib` or a community NestJS wrapper.
- **Pros:** Purpose-built durable broker with dead-lettering and routing — the "enterprise" choice for complex topologies. Survives broker restarts with durability semantics stronger than Redis.
- **Cons:** Heavier to operate (Erlang runtime, management UI, exchange/queue topology). No official NestJS integration package equivalent to `@nestjs/bullmq` — more hand-wired boilerplate. Overkill for a single "process this video" queue with one producer and one consumer. Steeper learning curve for the same single-queue need.

### Option C: Amazon SQS (or SQS-compatible)
- Managed queue (or an SQS-compatible local server). Poll-based consumer.
- **Pros:** Zero ops in production; scales horizontally.
- **Cons:** Cloud vendor lock-in against the local-first, Docker-first ethos of the project. No clean local equivalent that matches the S3/MinIO swap story (MinIO is S3-API-compatible locally; there is no equally clean SQS-compatible local story). Adds polling-latency and a second provider abstraction.

**Recommendation:** **Option A (Redis + BullMQ via @nestjs/bulmq)** — It is the documented NestJS queue pattern, gives retries/backoff/failed-state out of the box (which maps directly onto the video `error` status), and runs the worker as a second NestJS container reusing the existing codebase, config, and entities. RabbitMQ's routing power is unused by a single consumer queue, and SQS breaks the local-first model. Redis AOF persistence + idempotent re-enqueue from the DB cover the durability concern.

**Decision:** A (Redis + BullMQ via @nestjs/bullmq)

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`

---

## TD-02: Upload Strategy for Videos up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The upload must support up to 10GB **without blocking the API** and allow resuming on connection failure. Passing the whole file through the NestJS API (multer buffering/streaming the body) pins an API process, eats memory, and is explicitly an auto-reprova. The upload protocol is a **Cross-layer** decision: the handshake (initiate → get upload target → upload bytes → signal completion) is implemented on both the backend (issue URLs/confirm) and, later, the frontend (drive the upload). Decided once here. Note: AWS S3 / MinIO spec caps a **single PUT object at 5GB** — 10GB is only reachable via multipart upload, so the single-PUT option is eliminated by the requirement itself.

**Options:**

### Option A: Single presigned PUT URL (browser → MinIO directly)
- API creates the draft and returns one `presignedPutObject` URL; the client PUTs the whole file straight to MinIO, then calls a "complete" endpoint that enqueues processing. The API never sees the bytes.
- **Pros:** Simplest handshake (one URL). Bypasses the API entirely (no memory/time pressure).
- **Cons:** **Cannot support 10GB** — S3/MinIO caps a single PUT at 5GB, so this violates the acceptance criterion. No native resume; a dropped connection restarts the whole upload.

### Option B: Presigned multipart upload (S3 multipart, client → MinIO)
- API initiates an S3 multipart upload, returns presigned URLs for each part; the client uploads parts directly to MinIO (each part retried independently), then calls "complete multipart". The API orchestrates only control calls and never streams file bytes.
- **Pros:** Supports the full 10GB (multipart cap is 5TB). **Never streams through the API** → satisfies "sem travar" regardless of file size. Per-part retry gives **resume-on-failure** for free (re-send only the failed part). Reuses the standard S3 multipart protocol that MinIO implements identically to S3, so the same client code runs against S3 in production.
- **Cons:** More moving parts than a single PUT (initiate → per-part presign → complete). Frontend implementation is more involved (part-size strategy, parallel uploads, completion). Backend must persist a part-size policy and track the multipart upload id.

### Option C: tus resumable upload protocol (dedicated tus server)
- Run a tus server (e.g., `tus-node-server`) with an S3 storage backend; the client uses the tus protocol for chunked resumable uploads.
- **Pros:** Mature resumable-upload protocol with client libraries; abstracts chunking.
- **Cons:** Introduces a new always-on component (tus server) and a second storage abstraction on top of MinIO — extra infra and a non-standard contract. Overkill given S3 multipart already solves resumable large uploads natively against the storage we already run.

**Recommendation:** **Option B (Presigned multipart upload)** — It is the only option that genuinely supports 10GB (single PUT is capped at 5GB), it never streams bytes through the API, and per-part retry delivers the resume-on-failure behavior called out in the project plan. It uses the native S3 multipart protocol, which MinIO implements identically to S3 — zero rewrite for production. The API's role stays cheap: create draft → issue presigned part URLs → confirm completion → enqueue processing.

**Decision:** B (Presigned multipart upload via MinIO/S3 multipart)

**Libraries:** `minio@^8` (or `@aws-sdk/client-s3@^3` + `@aws-sdk/s3-request-presigner@^3`)

---

## TD-03: Video Worker Runtime, Metadata Extraction & Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** After upload completion, a background job must (a) extract duration + container/stream metadata, and (b) generate a thumbnail JPEG from a representative frame, then persist both to the DB and storage and flip the video to `ready` (or `error` on failure). This needs FFmpeg/FFprobe, which is heavy and must not run in the API process. The worker is the BullMQ consumer from TD-01; this TD decides how it runs and how it drives FFmpeg.

**Options:**

### Option A: Separate NestJS worker container + fluent-ffmpeg
- A second NestJS bootstrap (`NestFactory.createApplicationContext`) in the same `nestjs-project/`, registered as a BullMQ `@Processor` and started from its own `worker.ts` entrypoint, packaged in a Docker image based on `node + ffmpeg`. It uses `fluent-ffmpeg` to call `ffprobe` (metadata/duration) and `ffmpeg` (seek to a mid-point frame, output one JPEG thumbnail).
- **Pros:** Same codebase, config namespaces, entities, and DI as the API — no language/runtime split, shared `videos` repository and storage service. `fluent-ffmpeg` gives a clean, promise-able Node API over `ffprobe`/`ffmpeg` (timestamps, single-frame `-frames:v 1`, seek). Runs as its own container (independent scaling, CPU isolation from the API). Natural fit with `@nestjs/bullmq` from TD-01.
- **Cons:** The Docker image must install `ffmpeg`/`ffprobe` (one-time Dockerfile cost). `fluent-ffmpeg` is a thin wrapper; advanced edge cases (corrupt files) still need command-level handling.

### Option B: External standalone worker script (not NestJS)
- A plain Node script (or a separate TS project) that connects to Redis and calls ffmpeg via `child_process`, decoupled from the NestJS app.
- **Pros:** Smallest possible runtime surface; no NestJS overhead in the worker.
- **Cons:** Duplicates config loading, entity definitions, repository logic, and the storage-service contract outside the NestJS module system — violates the project's single-responsibility / shared-module conventions and creates drift. Loses DI, validation, and the typed config already in place.

### Option C: In-process processing (no worker, in the API)
- Run FFmpeg directly inside the API request/completion handler.
- **Pros:** No extra component.
- **Cons:** Blocks/destabilizes the API under load (FFmpeg is CPU- and memory-heavy), defeats the entire "process in background" requirement, and removes the queue — an explicit auto-reprova. Rejected.

**Recommendation:** **Option A (Separate NestJS worker container + fluent-ffmpeg)** — It reuses the existing NestJS codebase (config, entities, repositories, storage service) instead of duplicating it, isolates CPU-heavy FFmpeg work in its own container, and is the natural BullMQ consumer from TD-01. `fluent-ffmpeg` provides a clean, promise-able API for both `ffprobe` (metadata/duration) and single-frame thumbnail extraction. The only cost is an `ffmpeg` install in the worker image — a one-time Dockerfile line.

**Decision:** A (Separate NestJS worker container + fluent-ffmpeg)

**Libraries:** `fluent-ffmpeg@^2`

---

## TD-04: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, stable, unique public identifier used in its watch URL — never conflicting with another video. The `id` (UUID PK) is too long/ugly for a URL; we need a dedicated, collision-free, URL-safe slug. The strategy must guarantee uniqueness under concurrent inserts.

**Options:**

### Option A: nanoid short slug (DB-unique, retry on collision)
- Generate a short, URL-safe id with `nanoid` (e.g., 12–16 chars from the default URL-safe alphabet) at draft creation; store it in a unique column. On the rare unique-constraint violation, regenerate.
- **Pros:** Short, human-tolerable, URL-safe by construction. Cryptographically strong random — collision probability at 12+ chars is negligible; the DB unique index + retry makes uniqueness an absolute guarantee even at scale. Tiny dependency (118 bytes), no sequencing/counter state.
- **Cons:** Not monotonically ordered (not sortable/chronological). Negligible retry cost on collision.

### Option B: UUID (v4) as the public URL id
- Reuse the entity PK (or a dedicated UUID column) directly in the URL.
- **Pros:** No new concept; uniqueness guaranteed.
- **Cons:** Long, ugly URLs (`/watch/550e8400-e29b-41d4-a716-446655440000`), poor shareability, slightly leaks nothing but reads as a system id rather than a content handle.

### Option C: Sequential / base62 counter
- A monotonic integer/base62 derived from a DB sequence.
- **Pros:** Short and chronological.
- **Cons:** Discoverable/enumerable (a privacy/scraping smell for a sharing platform), requires a coordinated counter, and conflicts with the random-handle intent of a video-sharing URL.

**Recommendation:** **Option A (nanoid short slug)** — It produces short, URL-safe, non-enumerable handles ideal for a sharing platform, and the DB unique index + regenerate-on-collision gives an absolute uniqueness guarantee (satisfying "sem conflito"). The dependency is trivial. Non-monotonic ordering is irrelevant since discovery/listing is a later phase, not this URL's job.

**Decision:** A (nanoid short slug, DB-unique, retry on collision)

**Libraries:** `nanoid@^5`

---

## TD-05: Streaming & Download Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Watching must begin before the full file downloads (streaming), and the user must be able to download the file. The video lives in MinIO; the API must serve it through a stable URL keyed by the unique slug (TD-04) while honoring access rules. The standard for "play before fully downloaded" is HTTP `Range` requests answered with `206 Partial Content`.

**Options:**

### Option A: API range-proxy (GET /videos/:slug/stream → 206 Partial Content)
- A streaming endpoint reads the client's `Range` header, fetches that byte range from MinIO (`getObject` with range / S3 range header), and streams it back with `Accept-Ranges: bytes`, `Content-Range`, `Content-Length`, and `206`. The same endpoint serves a `200` full response when no range is requested, and an optional `?download=1`/`Content-Disposition: attachment` for download.
- **Pros:** Single stable URL per video (keyed by the unique slug), consistent access control and error handling through the API, full standard `<video>`/player compatibility (players issue Range requests natively), and one endpoint covers streaming **and** download (attachment). Storage host stays private behind the API.
- **Cons:** Video bytes transit the API process (per-range, memory-bounded via streaming — not buffered), so it consumes API bandwidth/egress. For a single-instance local deployment this is acceptable; it can be offloaded later via short-lived presigned GET URLs.

### Option B: Presigned GET URL to MinIO (direct client → storage)
- Issue a short-lived `presignedGetObject` URL; the client streams/downloads directly from MinIO, bypassing the API.
- **Pros:** Offloads all bandwidth from the API; MinIO answers Range natively.
- **Cons:** URLs expire (must be minted on demand, so there is no single stable URL), bypasses API access control/error handling, and exposes the storage host/scheme to clients. The transient URL conflicts with the "URL única por vídeo" requirement (the public identifier would be a moving target).

### Option C: HLS/DASH adaptive streaming (segment transcoding)
- Transcode the source into multiple renditions + segment playlists; the player adapts bitrate.
- **Pros:** Best playback UX across bandwidths.
- **Cons:** Requires a transcoding pipeline (multiple renditions per upload) — a large, separate scope. Far beyond Phase 03's "streaming working" deliverable; appropriate as a later optimization, not now.

**Recommendation:** **Option A (API range-proxy)** — It delivers true streaming (players get `206` over `Range`), keeps a single stable URL per video keyed by the unique slug (satisfying "URL única"), and reuses one endpoint for both streaming and download. Access control and error handling stay consistent. Presigned URLs (Option B) break the stable-URL requirement and leak the storage host; HLS (Option C) is out of scope. Bandwidth cost is acceptable for the single-instance local deployment and can be revisited later.

**Decision:** A (API range-proxy with 206 Partial Content; same endpoint serves download via Content-Disposition: attachment)

**Libraries:** `minio@^8` (getObject range streaming) — shared with TD-02/TD-06

---

## TD-06: Object-Storage Usage (Buckets & Key Layout)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage *technology* is given (S3-compatible — MinIO locally, S3 in production). This TD decides *how to use it*: bucket organization and object-key naming for the original video file, the processed file, and the thumbnail. The layout must avoid collisions (a video's files never clash with another's), keep original vs. thumbnail distinct, and stay addressable by the `videos` row.

**Options:**

### Option A: Single bucket, channel-scoped keys by type
- One bucket (e.g., `streamtube-media`), with keys namespaced per video: `<channelId>/<videoId>/original.<ext>` for the source video, `<channelId>/<videoId>/thumbnail.jpg` for the generated thumbnail. The `videos` row stores the storage keys (not URLs).
- **Pros:** One bucket to provision/policy. Keys are deterministic, collision-free (each keyed by unique `videoId`), naturally grouped per video for listing/cleanup, and channel-scoped (useful for per-channel quotas/listing later). Original and thumbnail are distinguished by filename, not bucket, simplifying policy.
- **Cons:** All object types share one bucket (mitigated by the key-prefix convention; IAM/policy can still target prefixes).

### Option B: Multiple buckets by type (one for videos, one for thumbnails)
- Separate `streamtube-videos` and `streamtube-thumbnails` buckets.
- **Pros:** Physical separation of object types; per-type lifecycle/policy.
- **Cons:** More buckets to manage; no real benefit at this scale since the same caller owns both. Adds provisioning overhead without a concrete requirement.

### Option C: Flat keys (object key = video slug only)
- Key the object by the public slug alone.
- **Pros:** Trivially simple keys.
- **Cons:** Loses channel grouping, mixes types ambiguously, and couples the storage key to the public URL slug (two concerns that should stay separable). Harder to clean up or quota per channel later.

**Recommendation:** **Option A (Single bucket, channel-scoped keys by type)** — One bucket is simplest to provision and policy, the `<channelId>/<videoId>/<type>` key scheme is collision-free and deterministic (each video's files never clash with another's), and it keeps original vs. thumbnail distinct while staying channel-grouped for future per-channel features. The `videos` row stores the **storage keys**, never URLs — URLs are derived (presigned / streamed) from the key on demand.

**Decision:** A (Single bucket; keys `<channelId>/<videoId>/original.<ext>` and `<channelId>/<videoId>/thumbnail.jpg`; DB stores keys, not URLs)

**Libraries:** `minio@^8` — shared with TD-02/TD-05

---

## TD-07: Video Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video moves through well-defined states from upload start through processing to a terminal ready/error outcome. The lifecycle must be reflected in the DB (`status` column), drive what the worker and endpoints do, and capture *why* a video failed. The engagement brief specifies the core cycle as `rascunho → processando → pronto/erro`.

**Options:**

### Option A: Five-state lifecycle with `uploading` + error detail
- States: `draft` (created at upload start — the pre-cadastro) → `uploading` (multipart in progress) → `processing` (worker picked the job, FFmpeg running) → `ready` (success: metadata + thumbnail persisted) / `error` (failure: terminal, with an `error_message` column capturing the reason). Transitions are validated; failed jobs set `error` + message.
- **Pros:** Covers the full real flow (including the in-progress upload window) and the brief's `rascunho → processando → pronto/erro` cycle. The `error` state with a reason message makes failures debuggable and gives the worker a clean place to write outcome. Maps 1:1 onto BullMQ's job outcomes (completed → `ready`, failed/exhausted → `error`).
- **Cons:** One extra transient state (`uploading`) beyond the bare three — justified because the draft-to-processing window is observable (client is still uploading parts).

### Option B: Three-state lifecycle only (draft → processing → ready/error)
- Exactly the brief's minimum: `draft` → `processing` → `ready` | `error`, with no `uploading`.
- **Pros:** Minimal and matches the brief verbatim.
- **Cons:** Collapses the in-progress upload window into `draft`, so "draft" ambiguously means "not yet uploading" and "currently uploading" — less precise for any future resume/abandonment handling and for surfacing upload-in-progress to clients.

### Option C: Status as a free-text/nullable set of flags
- Track booleans (`is_uploaded`, `is_processed`) instead of an enum.
- **Pros:** Flexible.
- **Cons:** Loses the single source of truth for "what state is this video in"; combinations become ambiguous (e.g., uploaded-but-error). An enum is clearer, queryable, and self-documenting.

**Recommendation:** **Option A (Five-state lifecycle)** — It honors the brief's `rascunho → processando → pronto/erro` cycle while making the in-progress upload window explicit (`uploading`) and giving failures a debuggable home (`error` + `error_message`). The states map cleanly onto BullMQ job outcomes. Transitions are enforced by an enum column guarded in the service layer.

**Decision:** A (Five-state lifecycle: `draft` → `uploading` → `processing` → `ready` | `error`, with `error_message`)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue / Background-Processing Technology | A (Redis + BullMQ via @nestjs/bullmq) | A |
| TD-02 | Cross-layer | Upload Strategy for Videos up to 10GB | B (Presigned multipart upload) | B |
| TD-03 | Backend | Video Worker Runtime, Metadata & Thumbnail | A (Separate NestJS worker container + fluent-ffmpeg) | A |
| TD-04 | Backend | Unique Video URL Identifier | A (nanoid short slug, DB-unique, retry) | A |
| TD-05 | Backend | Streaming & Download Strategy | A (API range-proxy, 206 Partial Content) | A |
| TD-06 | Backend | Object-Storage Usage (Buckets & Key Layout) | A (Single bucket, channel-scoped keys by type) | A |
| TD-07 | Backend | Video Status Lifecycle | A (Five-state: draft→uploading→processing→ready/error) | A |
