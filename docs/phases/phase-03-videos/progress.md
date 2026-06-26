# phase-03-videos — Progress

**Status:** implementation started — branch created, planning artifacts committed, SI-03.1 routed
**SIs:** 0/9 implemented (SI-03.1 in progress via [AMS-370](/AMS/issues/AMS-370))

> Planning pipeline complete and **approved by the board** on parent AMS-368. Git Flow set up by CTO: `dev` created from `main`, working branch `feature/AMS-368-phase-03-videos` from `dev`; planning artifacts committed as the first branch commit (durable spec for all 9 SIs). Implementation routed SI-by-SI per the Dependency Map — only advance when the current SI's suite is green.
>
> ⚠️ **Push gate:** repo write access for the agent service account is currently read-only — tracked in [AMS-371](/AMS/issues/AMS-371) (CEO-owned). Does not block engineering (SIs commit locally); gates only the final `git push` + PR.

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose
- **Status:** routed → Infrastructure Lead ([AMS-370](/AMS/issues/AMS-370)); no deps; blocks SI-03.2/.3/.4
- **Tests:** — (infra verification: `docker compose up -d` brings minio/redis/video-worker healthy; app boots; existing `GET /` E2E green)
- **Observations:** adds `minio`, `@nestjs/bullmq`/`bullmq`/`ioredis`, `fluent-ffmpeg`, `nanoid`; new `storage` + `queue` config namespaces; MinIO + Redis + `video-worker` services in Compose; worker image carries FFmpeg.

### SI-03.2 — Video Entity and Migration
- **Status:** not started
- **Tests:** —
- **Observations:** `videos` table linked to `channels`; status enum `draft|uploading|processing|ready|error`.

### SI-03.3 — Storage Service (MinIO) and Storage Module
- **Status:** not started
- **Tests:** —
- **Observations:** single owner of object storage; presigned multipart + range streaming + presigned download.

### SI-03.4 — Queue Module and Video Worker Entrypoint
- **Status:** not started
- **Tests:** —
- **Observations:** BullMQ `video-processing` queue; separate `src/worker.ts` Nest application-context bootstrap.

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
