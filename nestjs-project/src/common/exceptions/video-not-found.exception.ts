import { DomainException } from './domain.exception';

/**
 * Thrown when a video referenced by id/slug does not exist. Rendered as
 * `{ statusCode: 404, error: 'VIDEO_NOT_FOUND', message: 'Video not found' }`
 * by `DomainExceptionFilter`.
 *
 * `VideosService` action methods that resolve a video by id before acting
 * (`completeUpload`, `markReady`, `markError`) throw this when the row is
 * absent, so the absence maps to a clean 404 instead of a 500. SI-03.6's
 * controller reuses the same exception for stream/complete/upload-url lookups.
 */
export class VideoNotFoundException extends DomainException {
  constructor(message = 'Video not found') {
    super('VIDEO_NOT_FOUND', 404, message);
  }
}
