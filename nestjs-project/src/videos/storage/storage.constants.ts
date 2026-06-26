/**
 * Minimum part size for an S3/MinIO multipart upload (TD-02): every part except
 * the last must be at least 5 MiB; the last part has no minimum.
 *
 * Returned by `POST /videos` (SI-03.6) so the client knows how to chunk its
 * upload before requesting part URLs. Lives in the storage layer (next to the
 * multipart primitives it constrains) rather than the videos domain, and is
 * imported directly — it is a static constant, not derived from instance state,
 * so a `StorageService` getter would add indirection for no benefit.
 */
export const PART_SIZE_BYTES = 5 * 1024 * 1024;
