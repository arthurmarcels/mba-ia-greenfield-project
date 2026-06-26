import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One part the client finished uploading to MinIO. Mirrors the
 * `MultipartPart` contract of `StorageService` (`{ partNumber, etag }`).
 */
export class MultipartPartDto {
  /** 1-based part number within the multipart upload. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** ETag MinIO returned when the part was uploaded. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

/**
 * Body of `POST /videos/:id/complete` (SI-03.6) — the list of uploaded parts
 * that finalizes the multipart upload server-side and enqueues processing.
 */
export class CompleteUploadDto {
  /** The parts completing the multipart upload — must be non-empty. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MultipartPartDto)
  parts: MultipartPartDto[];
}
