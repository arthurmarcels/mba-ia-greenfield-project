import { DomainException } from './domain.exception';

/**
 * Thrown when a stream/download (SI-03.8) targets a video whose status is not
 * `ready` (i.e. it is still `draft`/`uploading`/`processing` or has `error`).
 * Rendered as
 * `{ statusCode: 409, error: 'VIDEO_NOT_READY', message: 'Video is not ready for playback' }`
 * by `DomainExceptionFilter`.
 *
 * Home is `src/common/exceptions/` — generic and reusable, mirroring
 * `VideoNotFoundException`. The `ready` check itself is an HTTP-layer guard in
 * the controller (per the SI-03.8 spec); this exception is the clean transport
 * mapping that flows through the shared domain filter.
 */
export class VideoNotReadyException extends DomainException {
  constructor(message = 'Video is not ready for playback') {
    super('VIDEO_NOT_READY', 409, message);
  }
}
