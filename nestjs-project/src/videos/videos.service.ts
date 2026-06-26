import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ForbiddenResourceException } from '../common/exceptions/forbidden-resource.exception';
import { IllegalVideoStatusTransitionException } from '../common/exceptions/illegal-video-status-transition.exception';
import { SlugGenerationExhaustedException } from '../common/exceptions/slug-generation-exhausted.exception';
import { VideoNotFoundException } from '../common/exceptions/video-not-found.exception';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import type { InitiateUploadDto } from './dtos/initiate-upload.dto';
import type { MultipartPart } from './storage/storage.service';
import { StorageService } from './storage/storage.service';
import { Video } from './entities/video.entity';
import {
  canTransition,
  VIDEO_SLUG_LENGTH,
  VIDEO_SLUG_MAX_RETRIES,
  VIDEO_STATUS,
  type VideoStatus,
} from './videos.constants';

/** PostgreSQL SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

/** Output of a successful processing run (worker SI-03.7 → `markReady`). */
export interface ProcessedVideoResult {
  duration: number;
  metadata: Record<string, unknown>;
  thumbnailKey: string;
}

/**
 * Core domain logic for videos (SI-03.5). Owns draft creation with a
 * collision-retried nanoid slug, the TD-07 status lifecycle, ownership checks,
 * and the bridge to storage + the processing queue. Consumed by the controller
 * (SI-03.6), the worker processor (SI-03.7), and the streaming endpoint
 * (SI-03.8) — none of which exist yet.
 */
@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  /**
   * Pre-registers a `draft` video in `channelId`'s channel with a fresh URL slug.
   * The slug is regenerated on a unique-constraint violation (astronomically
   * unlikely, but surfaced as a retry rather than the raw constraint error), up
   * to `VIDEO_SLUG_MAX_RETRIES` attempts.
   */
  async createDraft(channelId: string, dto: InitiateUploadDto): Promise<Video> {
    for (let attempt = 0; attempt <= VIDEO_SLUG_MAX_RETRIES; attempt++) {
      const video = this.videoRepository.create({
        channel_id: channelId,
        slug: nanoid(VIDEO_SLUG_LENGTH),
        title: dto.title,
        description: dto.description ?? null,
        status: VIDEO_STATUS.DRAFT,
        // bigint column → mapped as string
        file_size_bytes: String(dto.sizeBytes),
        mime_type: dto.mimeType,
      });

      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        // Non-collision DB errors propagate untouched.
        if (!this.isUniqueViolation(err)) {
          throw err;
        }
        // Last allowed attempt still collided → give up with a typed, transient
        // domain exception rather than the raw constraint error.
        if (attempt >= VIDEO_SLUG_MAX_RETRIES) {
          break;
        }
        this.logger.warn(
          `Video slug collision (attempt ${attempt + 1}); regenerating`,
        );
      }
    }

    // Unreachable in practice — 6 nanoid(12) draws do not all collide.
    throw new SlugGenerationExhaustedException();
  }

  /**
   * Starts a multipart upload for `video` at `key`: initiates it in storage,
   * then transitions `draft → uploading` and persists the `uploadId` + key.
   */
  async beginUpload(video: Video, key: string): Promise<{ uploadId: string }> {
    this.assertTransition(video.status, VIDEO_STATUS.UPLOADING);

    const { uploadId } = await this.storageService.initiateMultipartUpload(key);

    video.status = VIDEO_STATUS.UPLOADING;
    video.multipart_upload_id = uploadId;
    video.video_storage_key = key;
    await this.videoRepository.save(video);

    return { uploadId };
  }

  /**
   * Finalizes the multipart upload and enqueues processing. Order follows the
   * spec (TD-07): storage-complete → persist `uploading → processing` → enqueue.
   *
   * NOTE: if `queue.add` fails *after* the persist, the row is left in
   * `processing` with no job. For SI-03.5 this is accepted (the worker's
   * `attempts: 3` covers worker-side failures); outbox/enqueue-retry hardening
   * is deferred to SI-03.7+.
   */
  async completeUpload(
    videoId: string,
    parts: MultipartPart[],
  ): Promise<Video> {
    const video = await this.findByIdOrThrow(videoId);
    this.assertTransition(video.status, VIDEO_STATUS.PROCESSING);

    await this.storageService.completeMultipartUpload(
      video.video_storage_key as string,
      video.multipart_upload_id as string,
      parts,
    );

    video.status = VIDEO_STATUS.PROCESSING;
    const saved = await this.videoRepository.save(video);

    await this.videoProcessingQueue.add(
      PROCESS_VIDEO_JOB,
      { videoId: saved.id },
      { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );

    return saved;
  }

  /** Finds a video by its public slug (streaming/download — SI-03.8). */
  async findBySlug(slug: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ slug });
  }

  /** Finds a video by id. Absence is `null` — callers translate it (e.g. 404). */
  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  /** Lists the videos belonging to a channel. */
  async findByChannel(channelId: string): Promise<Video[]> {
    return this.videoRepository.find({ where: { channel_id: channelId } });
  }

  /**
   * Marks a processed video `ready` (worker SI-03.7). Only valid from
   * `processing`; the status guard is mandatory even though the worker performs
   * no ownership check.
   */
  async markReady(
    videoId: string,
    result: ProcessedVideoResult,
  ): Promise<Video> {
    const video = await this.findByIdOrThrow(videoId);
    this.assertTransition(video.status, VIDEO_STATUS.READY);

    video.status = VIDEO_STATUS.READY;
    video.duration_seconds = result.duration;
    video.metadata = result.metadata;
    video.thumbnail_storage_key = result.thumbnailKey;
    return this.videoRepository.save(video);
  }

  /**
   * Marks a video `error` with a message (worker SI-03.7, on terminal failure).
   * Valid from `uploading` or `processing`; the status guard is mandatory.
   */
  async markError(videoId: string, message: string): Promise<Video> {
    const video = await this.findByIdOrThrow(videoId);
    this.assertTransition(video.status, VIDEO_STATUS.ERROR);

    video.status = VIDEO_STATUS.ERROR;
    video.error_message = message;
    return this.videoRepository.save(video);
  }

  /**
   * Asserts a video belongs to `channelId`; throws `ForbiddenResourceException`
   * (403) on mismatch. Called by the controller before owner-only operations.
   */
  assertVideoOwnership(video: Video, channelId: string): void {
    if (video.channel_id !== channelId) {
      throw new ForbiddenResourceException();
    }
  }

  private async findByIdOrThrow(id: string): Promise<Video> {
    const video = await this.findById(id);
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Enforces the TD-07 transition map (SI-03.2) on every status change. */
  private assertTransition(from: VideoStatus, to: VideoStatus): void {
    if (!canTransition(from, to)) {
      throw new IllegalVideoStatusTransitionException(from, to);
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!(err instanceof QueryFailedError)) {
      return false;
    }
    const driverError = err.driverError as { code?: string } | undefined;
    return driverError?.code === PG_UNIQUE_VIOLATION;
  }
}
