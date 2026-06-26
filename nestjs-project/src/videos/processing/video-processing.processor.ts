import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import ffmpeg, { type FfprobeData } from 'fluent-ffmpeg';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.constants';
import { Video } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  VIDEO_STATUS,
  VIDEO_THUMBNAIL_FILENAME,
  VIDEO_THUMBNAIL_SIZE,
  type VideoMimeType,
} from '../videos.constants';
import { VideosService } from '../videos.service';

/**
 * ffmpeg/ffprobe error fragments that signal a corrupt or invalid input — the
 * file can never be processed, so the job must fail *terminally* (no retry).
 * Matches the decode-failure messages the worker's ffmpeg 5.1 emits.
 */
const UNRECOVERABLE_FFMPEG_MARKERS = [
  'invalid data found',
  'moov atom',
  'malformed',
  'end of file',
  'no video stream',
  'not a valid codec',
] as const;

/** Job payload enqueued by `VideosService.completeUpload` (SI-03.5). */
interface ProcessVideoJobData {
  videoId: string;
}

/**
 * BullMQ consumer for the `video-processing` queue (SI-03.7). Runs in the worker
 * process (`video-worker`), not the API. For each `process-video` job it streams
 * the uploaded original out of object storage, probes it with ffprobe, captures
 * a midpoint thumbnail with ffmpeg, stores the thumbnail, and marks the video
 * `ready` — or `error` once retries are exhausted / the failure is unrecoverable.
 *
 * `concurrency: 1` keeps a single ffmpeg pipeline on the worker at a time
 * (ffmpeg is CPU/disk heavy); v1 deliberately serializes processing.
 */
@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    this.logger.log(`Processing video ${videoId} (job ${job.id ?? '?'})`);

    const video = await this.videosService.findById(videoId);
    if (!video) {
      // A job for a deleted video can never succeed — fail terminally.
      throw new UnrecoverableError(`Video ${videoId} not found`);
    }
    // Idempotency hardening (Lead guidance #4): a job re-enqueued after a prior
    // success is a no-op rather than reprocessing. `completeUpload` (SI-03.5)
    // always leaves the row in `processing` before enqueuing, so any other
    // non-`ready` status is unexpected and `markReady`'s transition guard will
    // surface it.
    if (video.status === VIDEO_STATUS.READY) {
      this.logger.log(`Video ${videoId} already ready; skipping reprocessing`);
      return;
    }

    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
      const sourcePath = join(tempDir, `original.${extensionFor(video)}`);

      await this.downloadOriginal(video, sourcePath);

      const { duration, metadata } = await this.probe(sourcePath);

      const thumbnailPath = await this.captureThumbnail(sourcePath, tempDir);
      const thumbnailBuffer = await readFile(thumbnailPath);
      const thumbnailKey = `${video.channel_id}/${video.id}/${VIDEO_THUMBNAIL_FILENAME}`;
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videosService.markReady(videoId, {
        duration,
        metadata,
        thumbnailKey,
      });
      this.logger.log(`Video ${videoId} marked ready`);
    } catch (err) {
      // BullMQ contract: `process()` MUST throw so the job is retried/marked
      // failed and the `failed` worker event fires (→ `onFailed`). This is the
      // background-task exception to "never swallow" — we classify and rethrow.
      const error = err instanceof Error ? err : new Error(String(err));
      throw isUnrecoverableDecodeError(error)
        ? new UnrecoverableError(error.message)
        : error;
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch((cleanErr) =>
          this.logger.warn(
            `Failed to clean temp dir ${tempDir}: ${String(cleanErr)}`,
          ),
        );
      }
    }
  }

  /**
   * Fires on EVERY job failure (Lead guidance #1). `markError` is a terminal
   * side-effect, so it runs only when retries are exhausted OR the failure is
   * `UnrecoverableError` — otherwise a transient hiccup would immediately mark
   * the video `error` and defeat the retry policy. As an event handler this
   * catch-and-logs rather than rethrowing (rethrowing would crash the worker).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= attempts;
    const unrecoverable = err instanceof UnrecoverableError;
    if (!exhausted && !unrecoverable) {
      return;
    }
    await this.videosService
      .markError(String(job.data.videoId), err.message)
      .catch((markErr) =>
        this.logger.error(
          `markError failed for video ${job.data.videoId}`,
          markErr instanceof Error ? markErr.stack : String(markErr),
        ),
      );
  }

  /** Streams the uploaded original object to a local temp file. */
  private async downloadOriginal(
    video: Video,
    destPath: string,
  ): Promise<void> {
    const { stream } = await this.storageService.getObjectRange(
      video.video_storage_key as string,
    );
    await pipeline(stream, createWriteStream(destPath));
  }

  /** Probes the source and extracts the duration + a metadata summary. */
  private async probe(sourcePath: string): Promise<{
    duration: number;
    metadata: Record<string, unknown>;
  }> {
    const data = await this.runFfprobe(sourcePath);
    const videoStream =
      data.streams.find((stream) => stream.codec_type === 'video') ?? undefined;
    const duration = parseDuration(
      data.format?.duration,
      videoStream?.duration,
    );
    const metadata: Record<string, unknown> = {
      codec: videoStream?.codec_name ?? null,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      bitrate: data.format?.bit_rate ?? videoStream?.bit_rate ?? null,
    };
    return { duration, metadata };
  }

  private runFfprobe(sourcePath: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(sourcePath, (err, data) => {
        if (err || !data) {
          reject(err ?? new Error('ffprobe returned no data'));
          return;
        }
        resolve(data);
      });
    });
  }

  /**
   * Captures a single JPEG at the 50% mark. `fluent-ffmpeg` resolves a
   * percentage timemark by computing the absolute offset from the duration, so a
   * file path (not a stream) is required — satisfied by the temp file.
   * Resolves with the path the (single) screenshot was written to.
   */
  private captureThumbnail(
    sourcePath: string,
    folder: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      ffmpeg(sourcePath)
        .on('end', () => resolve(join(folder, VIDEO_THUMBNAIL_FILENAME)))
        .on('error', (err) => reject(err))
        .screenshots({
          timestamps: ['50%'],
          folder,
          filename: VIDEO_THUMBNAIL_FILENAME,
          size: VIDEO_THUMBNAIL_SIZE,
        });
    });
  }
}

/** Derives the original's file extension from its stored MIME type. */
function extensionFor(video: Video): string {
  const mime = (video.mime_type ?? 'video/mp4') as VideoMimeType;
  return ALLOWED_VIDEO_MIME_TYPES[mime] ?? 'mp4';
}

/** Parses the (string) duration ffprobe emits, defaulting to 0 when absent. */
function parseDuration(
  formatDuration: string | undefined,
  streamDuration: string | undefined,
): number {
  const raw = formatDuration ?? streamDuration;
  if (raw === undefined) {
    return 0;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** Heuristic classifier (Lead guidance #2): decode errors are unrecoverable. */
function isUnrecoverableDecodeError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return UNRECOVERABLE_FFMPEG_MARKERS.some((marker) =>
    message.includes(marker),
  );
}
