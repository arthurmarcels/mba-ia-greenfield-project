import { DomainException } from './domain.exception';

/**
 * Thrown when a video that should carry an object key has a null
 * `video_storage_key`. The key is written by `beginUpload` on transition to
 * `uploading` and must persist through `ready`; reaching this branch (for an
 * `uploading` part-presign or a `ready` stream/download) is a data-integrity
 * invariant violation — a corrupt row or a failed migration — not a client
 * error, so it surfaces as 500 rather than being masked by a blind
 * `as string` cast that would hand `null` to the storage client.
 *
 * 500 (not 409) is chosen deliberately: 409 implies a recoverable status
 * transition the client can correct; a missing key on a `ready`/`uploading`
 * row is a server-side bug the caller cannot fix, so it belongs in the same
 * semantic class as `UserHasNoChannelException`.
 *
 * Rendered as
 * `{ statusCode: 500, error: 'VIDEO_STORAGE_KEY_MISSING', message: '...' }` by
 * `DomainExceptionFilter`.
 *
 * Home is `src/common/exceptions/` — generic HTTP/storage concern surfaced
 * through the shared domain exception base.
 */
export class VideoStorageKeyMissingException extends DomainException {
  constructor(message = 'Video has no storage key') {
    super('VIDEO_STORAGE_KEY_MISSING', 500, message);
  }
}
