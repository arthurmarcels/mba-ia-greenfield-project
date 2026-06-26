import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UploadUrlQueryDto } from './upload-url-query.dto';

/**
 * Pure unit test for `UploadUrlQueryDto.partNumber` validation. The global
 * `ValidationPipe` runs these exact `class-validator` decorators — after
 * `@Type(() => Number)` coerces the raw query string — before the handler runs,
 * rejecting invalid input as 400. This spec exercises that pipeline directly
 * against the coerced instance, covering the `@Max(10000)` S3 multipart ceiling
 * added in AMS-418 (Finding 2).
 */
describe('UploadUrlQueryDto', () => {
  /** Mirrors the ValidationPipe: coerce the raw query value, then validate. */
  async function validatePartNumber(raw: unknown) {
    const instance = plainToInstance(UploadUrlQueryDto, { partNumber: raw });
    return validate(instance);
  }

  it('accepts a part number within the S3 multipart range [1, 10000]', async () => {
    expect(await validatePartNumber(1)).toHaveLength(0);
    expect(await validatePartNumber(10000)).toHaveLength(0);
  });

  it('coerces a numeric query string via @Type and validates the result', async () => {
    // Mirrors `?partNumber=5` / `?partNumber=10001` arriving as strings on the wire.
    expect(await validatePartNumber('5')).toHaveLength(0);
    expect(await validatePartNumber('10001')).toHaveLength(1);
  });

  it('rejects a part number above the 10000 S3 multipart limit with @Max', async () => {
    const errors = await validatePartNumber(10001);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('partNumber');
    expect(errors[0]?.constraints).toEqual({
      max: 'partNumber must be at most 10000 (S3 multipart limit)',
    });
  });

  it('rejects a part number below 1 with @Min', async () => {
    const errors = await validatePartNumber(0);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('partNumber');
    expect(errors[0]?.constraints?.min).toBe('partNumber must be at least 1');
  });
});
