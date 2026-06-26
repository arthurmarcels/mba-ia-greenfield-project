import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelsService } from '../channels/channels.service';
import { IllegalVideoStatusTransitionException } from '../common/exceptions/illegal-video-status-transition.exception';
import { RangeNotSatisfiableException } from '../common/exceptions/range-not-satisfiable.exception';
import { UserHasNoChannelException } from '../common/exceptions/user-has-no-channel.exception';
import { VideoNotFoundException } from '../common/exceptions/video-not-found.exception';
import { VideoNotReadyException } from '../common/exceptions/video-not-ready.exception';
import { VideoStorageKeyMissingException } from '../common/exceptions/video-storage-key-missing.exception';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { Video } from './entities/video.entity';
import { parseHttpRange } from './streaming/parse-http-range.util';
import type { MultipartPart } from './storage/storage.service';
import { CompleteUploadDto } from './dtos/complete-upload.dto';
import { InitiateUploadDto } from './dtos/initiate-upload.dto';
import { UploadUrlQueryDto } from './dtos/upload-url-query.dto';
import { PART_SIZE_BYTES } from './storage/storage.constants';
import { StorageService } from './storage/storage.service';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  VIDEO_DOWNLOAD_PRESIGN_EXPIRY_SECONDS,
  VIDEO_STATUS,
  type VideoMimeType,
  type VideoStatus,
} from './videos.constants';
import { VideosService } from './videos.service';

/** Response of `POST /videos` (SI-03.6). */
interface InitiateUploadResponse {
  id: string;
  slug: string;
  status: VideoStatus;
  uploadId: string;
  key: string;
  partSize: number;
}

/** Response of `GET /videos/:id/upload-url` (SI-03.6). */
interface UploadUrlResponse {
  url: string;
}

/** Response of `POST /videos/:id/complete` (SI-03.6). */
interface CompleteUploadResponse {
  id: string;
  slug: string;
  status: VideoStatus;
}

/** Response of `GET /videos/:slug/download` (SI-03.8). */
interface DownloadUrlResponse {
  url: string;
}

/**
 * Upload control-plane (SI-03.6) + public playback (SI-03.8). The upload routes
 * never receive file bytes: they pre-register a draft + start the multipart
 * upload, hand out presigned part-PUT URLs, and finalize the upload + enqueue
 * processing; the caller's channel is resolved once per request from the JWT for
 * key scoping and ownership. The stream/download routes are anonymous
 * (`@Public()`): a ready video is served by HTTP range (206) proxied from
 * storage, or handed out as a presigned attachment URL. Because some routes are
 * public and some are authenticated, `@ApiBearerAuth` is applied per-method
 * (not at the class level) so the public routes stay clean.
 */
@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
  ) {}

  /**
   * Resolves the caller's channel id from the JWT subject. Registration creates
   * the channel atomically with the user, so a valid authenticated user always
   * has one; reaching the `null` branch is a data inconsistency surfaced as 500
   * (`UserHasNoChannelException`, flowing through `DomainExceptionFilter`)
   * rather than creating a half-scoped video.
   */
  private async resolveChannelId(userId: string): Promise<string> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new UserHasNoChannelException();
    }
    return channel.id;
  }

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers a draft video in the caller channel and starts a multipart upload. Returns the multipart uploadId, the object key, and the part size the client must chunk by. The API never receives file bytes.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'uploading' },
        uploadId: { type: 'string' },
        key: { type: 'string', example: '<channelId>/<videoId>/original.mp4' },
        partSize: { type: 'integer', example: 5242880 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiate(
    @Body() dto: InitiateUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<InitiateUploadResponse> {
    const channelId = await this.resolveChannelId(user.sub);
    const ext = ALLOWED_VIDEO_MIME_TYPES[dto.mimeType as VideoMimeType];
    const draft = await this.videosService.createDraft(channelId, dto);
    const key = `${channelId}/${draft.id}/original.${ext}`;
    const { uploadId } = await this.videosService.beginUpload(draft, key);
    return {
      id: draft.id,
      slug: draft.slug,
      status: VIDEO_STATUS.UPLOADING,
      uploadId,
      key,
      partSize: PART_SIZE_BYTES,
    };
  }

  @Get(':id/upload-url')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a presigned part upload URL',
    description:
      'Returns a presigned PUT URL for one part of the in-progress multipart upload. Owner only.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (invalid id or partNumber)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in an active multipart upload (illegal status)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadUrl(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: UploadUrlQueryDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<UploadUrlResponse> {
    const channelId = await this.resolveChannelId(user.sub);
    const video = await this.videosService.findById(id);
    if (!video) {
      throw new VideoNotFoundException();
    }
    this.videosService.assertVideoOwnership(video, channelId);

    // Only an `uploading` video (key + uploadId set by `beginUpload`) can be
    // part-presigned; absence means the client called out of order → 409.
    const key = video.video_storage_key;
    const uploadId = video.multipart_upload_id;
    if (!key || !uploadId) {
      throw new IllegalVideoStatusTransitionException(
        video.status,
        VIDEO_STATUS.UPLOADING,
      );
    }
    const url = await this.storageService.presignPartUrl(
      key,
      uploadId,
      query.partNumber,
    );
    return { url };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload with the uploaded parts and enqueues video processing. Owner only. An illegal status transition (e.g. completing an upload that is not `uploading`) is rejected as 409.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Illegal video status transition',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CompleteUploadResponse> {
    const channelId = await this.resolveChannelId(user.sub);
    const video = await this.videosService.findById(id);
    if (!video) {
      throw new VideoNotFoundException();
    }
    this.videosService.assertVideoOwnership(video, channelId);

    const completed = await this.videosService.completeUpload(
      id,
      dto.parts as MultipartPart[],
    );
    return {
      id: completed.id,
      slug: completed.slug,
      status: completed.status,
    };
  }

  @Public()
  @Get(':slug/stream')
  @ApiOperation({
    summary: 'Stream a ready video by slug',
    description:
      'Anonymous. Streams a ready video proxied from object storage. With a `Range: bytes=<start>-<end>` header it responds 206 Partial Content carrying `Accept-Ranges`, `Content-Range`, `Content-Length` and `Content-Type`; without a range it responds 200 with the full object. A malformed or out-of-bounds range is rejected as 416.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full stream (no Range header)',
    content: {
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({
    status: 206,
    description: 'Partial stream (Range honored)',
    content: {
      'application/octet-stream': {
        schema: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Range not satisfiable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('slug') slug: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.getReadyVideoBySlug(slug);
    const key = video.video_storage_key;
    if (!key) {
      // A `ready` video must carry its key (set at `beginUpload`); null is an
      // invariant violation → 500, not a blind cast handing null to storage.
      throw new VideoStorageKeyMissingException();
    }

    const totalSize = await this.storageService.getObjectSize(key);
    const parsed = parseHttpRange(rangeHeader, totalSize);
    if (parsed.kind === 'invalid') {
      throw new RangeNotSatisfiableException();
    }

    const range =
      parsed.kind === 'range'
        ? { start: parsed.start, end: parsed.end }
        : undefined;
    const read = await this.storageService.getObjectRange(key, range);

    res
      .status(range ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK)
      .setHeader('Accept-Ranges', 'bytes')
      .setHeader('Content-Type', video.mime_type ?? 'application/octet-stream')
      .setHeader('Content-Length', String(read.contentLength));
    if (read.contentRange) {
      res.setHeader('Content-Range', read.contentRange);
    }

    // A mid-stream storage error can no longer change the status; end cleanly.
    read.stream.on('error', () => {
      if (res.headersSent) {
        res.end();
      } else {
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).end();
      }
    });
    read.stream.pipe(res);
  }

  @Public()
  @Get(':slug/download')
  @ApiOperation({
    summary: 'Get a presigned download URL for a ready video',
    description:
      'Anonymous. Resolves a ready video by slug and returns a short-lived presigned GET URL that forces a browser download (Content-Disposition: attachment). The client downloads the bytes directly from object storage — the API does not stream them.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned attachment URL',
    schema: { properties: { url: { type: 'string' } } },
  })
  @ApiResponse({
    status: 404,
    description: 'Unknown slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('slug') slug: string): Promise<DownloadUrlResponse> {
    const video = await this.getReadyVideoBySlug(slug);
    const key = video.video_storage_key;
    if (!key) {
      // A `ready` video must carry its key (set at `beginUpload`); null is an
      // invariant violation → 500, not a blind cast handing null to storage.
      throw new VideoStorageKeyMissingException();
    }
    const url = await this.storageService.presignedDownloadUrl(
      key,
      this.buildDownloadFilename(video),
      VIDEO_DOWNLOAD_PRESIGN_EXPIRY_SECONDS,
    );
    return { url };
  }

  /**
   * Resolves a `ready` video by slug for the public stream/download routes:
   * `VideoNotFoundException` (404) on absence, `VideoNotReadyException` (409)
   * when the video is not yet playable. These are HTTP-layer guards, so they
   * live in the controller — `VideosService` stays ownership/status-transition
   * focused and unaware of playback readiness.
   */
  private async getReadyVideoBySlug(slug: string): Promise<Video> {
    const video = await this.videosService.findBySlug(slug);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VIDEO_STATUS.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  /** Derives a friendly attachment filename (`<slug>.<ext>`) for the download. */
  private buildDownloadFilename(video: Video): string {
    const ext = video.mime_type
      ? ALLOWED_VIDEO_MIME_TYPES[video.mime_type as VideoMimeType]
      : undefined;
    return ext ? `${video.slug}.${ext}` : video.slug;
  }
}
