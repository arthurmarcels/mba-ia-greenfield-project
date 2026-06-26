import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Query of `GET /videos/:id/upload-url` (SI-03.6) — selects which part to
 * presign. The global `ValidationPipe` (`transform: true`) coerces the string
 * query param to a number and validates it is an integer in [1, 10000]; an
 * absent, invalid, or out-of-range value is rejected as 400 before the handler
 * runs. The 10 000 ceiling is the S3 multipart upload part limit.
 */
export class UploadUrlQueryDto {
  /** 1-based part number to presign a PUT URL for. */
  @IsInt({ message: 'partNumber must be an integer' })
  @Min(1, { message: 'partNumber must be at least 1' })
  @Max(10000, {
    message: 'partNumber must be at most 10000 (S3 multipart limit)',
  })
  @Type(() => Number)
  partNumber: number;
}
