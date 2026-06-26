import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/**
 * Query of `GET /videos/:id/upload-url` (SI-03.6) — selects which part to
 * presign. The global `ValidationPipe` (`transform: true`) coerces the string
 * query param to a number and validates it is an integer ≥ 1; an absent or
 * invalid value is rejected as 400 before the handler runs.
 */
export class UploadUrlQueryDto {
  /** 1-based part number to presign a PUT URL for. */
  @IsInt({ message: 'partNumber must be an integer' })
  @Min(1, { message: 'partNumber must be at least 1' })
  @Type(() => Number)
  partNumber: number;
}
