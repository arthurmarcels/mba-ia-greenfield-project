---
libs:
  "@nestjs/bullmq":
    version: "^11"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-06-26T07:10:00-03:00"
  "bullmq":
    version: "^5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-26T07:10:00-03:00"
  "ioredis":
    version: "^5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-26T07:10:00-03:00"
  "minio":
    version: "^8"
    context7_id: "/minio/minio-js"
    fetched_at: "2026-06-26T07:10:00-03:00"
  "fluent-ffmpeg":
    version: "^2"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T07:10:00-03:00"
  "nanoid":
    version: "^5"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-06-26T07:10:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T07:05:41-03:00"
---

# Library References — Phase 03 (Videos)

Confirmed-via-context7 API surface for each newly decided library. Versions reflect what Phase 03 will install in `nestjs-project/`. Pin to these ranges in `package.json`.

## @nestjs/bullmq

Queue + worker integration for NestJS (the BullMQ wrapper). Confirmed against `/nestjs/bull` (the official `@nestjs/bullmq` package).

- **Register a queue** (API side) with an async connection pulled from config:

```ts
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }),
});
BullModule.registerQueue({ name: 'video-processing' });
```

- **Enqueue a job** by injecting `@InjectQueue('video-processing') private queue: Queue` and calling `queue.add('process-video', { videoId }, { attempts, backoff })`.

- **Consumer (worker side)** — a class decorated `@Processor('video-processing')` extending `WorkerHost`, implementing `async process(job: Job)`. `@OnWorkerEvent('failed')` / `@OnWorkerEvent('completed')` give lifecycle hooks. The worker is a separate NestJS bootstrap (`NestFactory.createApplicationContext`) started from its own entrypoint — same codebase, same entities/config.

- `defaultJobOptions` on the queue set `attempts` + `backoff` (e.g. exponential). Workers initialize after `onModuleInit` (or immediately under default auto-registration).

## bullmq

The underlying Redis-backed queue used by `@nestjs/bullmq`. Confirmed against `/taskforcesh/bullmq` (docs.bullmq.io).

- **Retries with backoff** — set on `queue.add(name, data, { attempts: 3, backoff: 1000 })` (or `backoff: { type: 'exponential', delay: 1000 }`).
- **Stop retrying / terminal failure** — throw `new UnrecoverableError(msg)` from `process()` to move the job straight to the failed set and override `attempts`. This is how Phase 03 maps an unrecoverable processing failure to the `error` status.
- **Regular `Error`** = retry-if-attempts-remain; a thrown `Error` moves the job to `failed` and retries per `attempts`.
- **Manual fail** — `await job.moveToFailed({ message }, true)` for explicit failure handling.
- `RateLimitError` exists for rate-limiting workers (not needed in Phase 03 v1).

## ioredis

The Redis client BullMQ uses under the hood (`connection: { host, port }` → an `ioredis` instance). Referenced via the BullMQ connection pattern above. Installed as a peer/dependency of BullMQ. Phase 03 only needs it implicitly via `BullModule.forRoot({ connection: {...} })`; no direct `new Redis()` calls required in app code.

## minio

MinIO / S3-compatible object storage client (same API as AWS S3). Confirmed against `/minio/minio-js`.

- **Client** — `new Client({ endPoint, port, useSSL, accessKey, secretKey })`. Bucket created once via `client.makeBucket(name)` (guard "already exists").

- **Presigned single PUT** (control reference, capped at 5GB per S3 spec — NOT used for the 10GB video):

```ts
const url = await client.presignedPutObject('streamtube-media', key, 24 * 60 * 60);
```

- **Presigned multipart upload** (TD-02, the 10GB path) — uses `presignedUrl(httpMethod, bucket, object, expiry, reqParams)`:
  1. initiate → `presignedUrl('POST', bucket, key)` returns the `uploadId`;
  2. per part → `presignedUrl('PUT', bucket, key, expiry, { partNumber, uploadId })` — client uploads each part (retry per part);
  3. complete → `presignedUrl('POST', bucket, key, expiry, { uploadId })` with the uploaded parts.
  `reqParams` carries `partNumber` / `uploadId` per the MinIO API.md. Part size policy (e.g. 8–25MB) is decided in the plan.

- **GET object (range streaming, TD-05)** — `client.getObject(bucket, key, { range?: { Start, End } })` returns a readable stream; the controller forwards it with `Accept-Ranges: bytes`, `Content-Range`, `206`.

- **Presigned GET (download variant)** — `client.presignedGetObject(bucket, key, expiry, { 'response-content-disposition': 'attachment; filename="..."' })`.

## fluent-ffmpeg

Node fluent API over `ffmpeg`/`ffprobe`. Confirmed against `/fluent-ffmpeg/node-fluent-ffmpeg`. Requires `ffmpeg` + `ffprobe` binaries in the worker image (`apt-get install ffmpeg`).

- **Metadata / duration (TD-03)** — `ffprobe` returns `{ streams, format }`:

```ts
ffmpeg.ffprobe(localPath, (err, data) => {
  // data.format.duration (seconds), data.streams (video/audio codec, width, height, etc.)
});
```

- **Thumbnail (TD-03)** — `screenshots()` (aliases: `thumbnail`, `thumbnails`, `screenshot`, `takeScreenshots`):

```ts
ffmpeg(localPath)
  .on('filenames', (names) => { /* generated names */ })
  .on('end', () => { /* done */ })
  .screenshots({
    timestamps: ['50%'],      // one frame at the midpoint
    filename: 'thumbnail.jpg',
    folder: '/tmp/thumbs',
    size: '1280x720',         // use size option, not .size()
  });
```

  Limitation: `screenshots` does **not** work on input streams — Phase 03 downloads the original to a temp file in the worker, probes/screenshots it, uploads the thumbnail, then cleans up.

## nanoid

Tiny URL-safe unique-ID generator. Confirmed against `/ai/nanoid`.

- **Default** — `import { nanoid } from 'nanoid'; nanoid(); // 21-char URL-safe`.
- **Custom size (TD-04)** — generate a short slug directly: `nanoid(12)` → 12-char URL-safe id.
- **Custom alphabet** — `import { customAlphabet } from 'nanoid'; const id = customAlphabet('A-Za-z0-9_-', 12);` (the default URL-safe alphabet already excludes ambiguous chars). Phase 03 uses the default `nanoid(size)` and persists the result in a DB-unique column; collisions are handled by regenerate-on-unique-constraint-violation.

> **Frontend note (out of scope):** nanoid v5 ships as ESM. Since Phase 03 is backend-only, the ESM import works under the project's `nodenext` module resolution in the API/worker. No frontend usage this phase.
