import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChannelsService } from '../channels/channels.service';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { VideoNotFoundException } from '../common/exceptions/video-not-found.exception';
import type { MultipartPart } from './storage/storage.service';
import { CompleteUploadDto } from './dtos/complete-upload.dto';
import { InitiateUploadDto } from './dtos/initiate-upload.dto';
import { UploadUrlQueryDto } from './dtos/upload-url-query.dto';
import { PART_SIZE_BYTES } from './storage/storage.constants';
import { StorageService } from './storage/storage.service';
import {
  ALLOWED_VIDEO_MIME_TYPES,
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

/**
 * Authenticated upload control-plane (SI-03.6). The API never receives file
 * bytes: it pre-registers a draft + starts the multipart upload, hands out
 * presigned part-PUT URLs, and finalizes the upload + enqueues processing. The
 * caller's channel is resolved once per request from the JWT for key scoping and
 * ownership. All endpoints are authenticated (global JWT guard); none opt out
 * with `@Public()`. SI-03.8 will add `@Public` stream/download routes to this
 * same controller, so `@ApiBearerAuth` is applied per-method (not at the class
 * level) to keep those public routes clean.
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
   * rather than creating a half-scoped video.
   */
  private async resolveChannelId(userId: string): Promise<string> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error('Authenticated user has no channel');
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
    description: 'Validation failed (invalid partNumber)',
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
  async getUploadUrl(
    @Param('id') id: string,
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
    // part-presigned; absence means the client called out of order.
    const key = video.video_storage_key;
    const uploadId = video.multipart_upload_id;
    if (!key || !uploadId) {
      throw new Error('Video has no active multipart upload');
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
    @Param('id') id: string,
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
}
