import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Client } from 'minio';
import type { Readable } from 'stream';
import storageConfig from '../../config/storage.config';

/** A part of an in-progress multipart upload the client finished uploading. */
export interface MultipartPart {
  partNumber: number;
  etag: string;
}

/** Inclusive byte range `[start, end]` for a ranged read (206). */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Result of a ranged object read, carrying the metadata a streaming response
 * needs alongside the bytes: `Content-Length`, `Content-Range`, and the full
 * object `totalSize`.
 */
export interface ObjectRangeRead {
  stream: Readable;
  contentLength: number;
  contentRange: string | null;
  totalSize: number;
}

/** Default lifetime (seconds) for presigned part-PUT and download-GET URLs. */
const DEFAULT_PRESIGN_EXPIRY_SECONDS = 60 * 60;

/**
 * Characters that would break the `Content-Disposition: attachment; filename="…"`
 * value emitted on a presigned download GET: a stray `"` escapes the quoted
 * token, CR/LF smuggle extra header lines (HTTP response-splitting when S3/MinIO
 * echoes the value as the real `Content-Disposition`), a null byte truncates the
 * string in C-based parsers, and `/`/`\` are path separators with no place in a
 * bare filename. All are stripped from caller-supplied filenames.
 */
const CONTENT_DISPOSITION_FILENAME_DENY = /["\r\n\0/\\]/g;

/** Neutral fallback when sanitization leaves nothing usable (avoids `filename=""`). */
const CONTENT_DISPOSITION_FALLBACK_FILENAME = 'download';

/**
 * Sanitizes a caller-supplied `filename` before it is interpolated into a
 * `Content-Disposition` header value, closing the header-injection / quoted-
 * token-escape vector of `presignedDownloadUrl`. Returns the filename with the
 * `CONTENT_DISPOSITION_FILENAME_DENY` characters removed, or a neutral fallback
 * when nothing safe remains.
 */
export function sanitizeContentDispositionFilename(filename: string): string {
  const cleaned = filename.replace(CONTENT_DISPOSITION_FILENAME_DENY, '');
  return cleaned.length > 0 ? cleaned : CONTENT_DISPOSITION_FALLBACK_FILENAME;
}

/**
 * Single owner of object-storage interaction (single-responsibility). Wraps the
 * MinIO client and exposes the operations the rest of Phase 03 needs:
 * presigned multipart upload (TD-02), HTTP range streaming (TD-05), and the
 * thumbnail object helpers used by the worker (SI-03.7).
 *
 * The `storage` config is registered globally (`ConfigModule.forRoot`), so the
 * token is injected directly — no `forRootAsync` is needed.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new Client({
      endPoint: config.endpoint,
      port: config.port,
      useSSL: config.useSsl,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
    this.bucket = config.bucket;
  }

  /**
   * Ensures the configured bucket exists. `makeBucket` throws when the bucket
   * already exists, so the call is guarded by `bucketExists` — a second boot is
   * a no-op (acceptance criterion: idempotent init).
   */
  async onModuleInit(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) {
      await this.client.makeBucket(this.bucket);
      this.logger.log(`Bucket "${this.bucket}" created`);
    }
  }

  /**
   * Starts an S3 multipart upload for `key` and returns the `uploadId`.
   *
   * `presignedUrl('POST', ...)` only yields a URL — the `uploadId` lives in the
   * POST response body (TD-02), so the server obtains it directly via the
   * MinIO multipart-initiate primitive.
   */
  async initiateMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const uploadId = await this.client.initiateNewMultipartUpload(
      this.bucket,
      key,
      {},
    );
    return { uploadId };
  }

  /** Presigned PUT URL for one part of an in-progress multipart upload. */
  async presignPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiry: number = DEFAULT_PRESIGN_EXPIRY_SECONDS,
  ): Promise<string> {
    return this.client.presignedUrl('PUT', this.bucket, key, expiry, {
      partNumber: String(partNumber),
      uploadId,
    });
  }

  /**
   * Aggregates the uploaded parts server-side into a single object.
   *
   * `complete` is a server-side call (not a presigned URL): it folds the parts
   * on the storage side. The spec's `{ partNumber, etag }` maps to MinIO's
   * `{ part, etag }` here at the boundary. The result is discarded to honor the
   * `void` return.
   */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    await this.client.completeMultipartUpload(
      this.bucket,
      key,
      uploadId,
      parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
    );
  }

  /**
   * Reads `key` (optionally a byte range) for HTTP range streaming (TD-05).
   *
   * `getObject`'s stream carries no `Content-Range`/`Content-Length`, so the
   * metadata is derived: `statObject` gives `totalSize`; the range values are
   * computed from the requested `[start, end]`. No range → whole object
   * (200-equivalent): `contentLength = totalSize`, no `contentRange`.
   *
   * The typed minio-js v8 primitive for a byte range is `getPartialObject`
   * (`offset`, `length`); the lowercase `{ start, end }` public API maps to it
   * at this boundary.
   */
  async getObjectRange(
    key: string,
    range?: ByteRange,
  ): Promise<ObjectRangeRead> {
    const { size: totalSize } = await this.client.statObject(this.bucket, key);

    if (!range) {
      const stream = await this.client.getObject(this.bucket, key);
      return {
        stream,
        contentLength: totalSize,
        contentRange: null,
        totalSize,
      };
    }

    const length = range.end - range.start + 1;
    const stream = await this.client.getPartialObject(
      this.bucket,
      key,
      range.start,
      length,
    );
    return {
      stream,
      contentLength: length,
      contentRange: `bytes ${range.start}-${range.end}/${totalSize}`,
      totalSize,
    };
  }

  /**
   * Returns the object's size in bytes (`statObject` is a HEAD — no body read).
   * Used by the streaming controller (SI-03.8) to resolve open-ended/suffix
   * `Range` headers and to reject out-of-bounds ranges (416) before the ranged
   * read. It is the size source the controller owns all HTTP range math on;
   * `getObjectRange` re-stats internally to build `Content-Range`.
   */
  async getObjectSize(key: string): Promise<number> {
    const { size } = await this.client.statObject(this.bucket, key);
    return size;
  }

  /**
   * Presigned GET URL forcing a download via `Content-Disposition: attachment`
   * with the given `filename`. The `filename` is sanitized first — it is
   * caller-supplied and flows into a header value echoed back by S3/MinIO, so a
   * raw quote/CR/LF/null/path-separator would enable response-splitting or token
   * escape (Finding 5, AMS-400).
   */
  async presignedDownloadUrl(
    key: string,
    filename: string,
    expiry: number = DEFAULT_PRESIGN_EXPIRY_SECONDS,
  ): Promise<string> {
    const safeFilename = sanitizeContentDispositionFilename(filename);
    return this.client.presignedGetObject(this.bucket, key, expiry, {
      'response-content-disposition': `attachment; filename="${safeFilename}"`,
    });
  }

  /** Stores a buffer object with its `Content-Type` (worker: thumbnail). */
  async putObject(
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': contentType,
    });
  }

  /** Deletes an object (worker: cleanup). */
  async removeObject(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }
}
