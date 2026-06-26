import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ALLOWED_VIDEO_MIME_TYPES } from '../videos.constants';

const ALLOWED_MIME_TYPES = Object.keys(ALLOWED_VIDEO_MIME_TYPES);
/** 10GB — the maximum declared upload size (Phase 03 objective). */
const MAX_VIDEO_SIZE_BYTES = 10 * 1024 ** 3;

/**
 * Body of `POST /videos` (SI-03.6) — pre-registers a draft and starts the
 * multipart upload. The API never receives the file bytes; the client uploads
 * each part directly to MinIO via presigned URLs. The storage object key is
 * derived from the declared MIME type's extension
 * (`<channelId>/<videoId>/original.<ext>`); no client-supplied filename is
 * accepted or stored.
 */
export class InitiateUploadDto {
  /** Title shown on the video; set at upload init. */
  @IsString()
  @IsNotEmpty({ message: 'title must not be empty' })
  title: string;

  /** Declared video MIME type; must be in the supported allow-list. */
  @IsIn(ALLOWED_MIME_TYPES, {
    message: 'mimeType must be a supported video type',
  })
  mimeType: string;

  /** Declared file size in bytes (≤ 10GB). */
  @IsInt({ message: 'sizeBytes must be an integer' })
  @Min(1, { message: 'sizeBytes must be a positive integer' })
  @Max(MAX_VIDEO_SIZE_BYTES, { message: 'sizeBytes must be at most 10GB' })
  @Type(() => Number)
  sizeBytes: number;

  /** Optional description. */
  @IsOptional()
  @IsString()
  description?: string;
}
