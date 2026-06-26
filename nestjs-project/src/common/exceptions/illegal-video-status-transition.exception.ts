import { DomainException } from './domain.exception';

/**
 * Thrown when a `VideosService` status change is not permitted by the TD-07
 * transition map (e.g. completing an upload on a video that is not `uploading`).
 * Rendered as `{ statusCode: 409, error: 'ILLEGAL_VIDEO_STATUS_TRANSITION', ... }`
 * by `DomainExceptionFilter`.
 *
 * The statuses are accepted as plain strings so this exception does not couple
 * `src/common/exceptions/` to the videos domain — the service passes the
 * current/target `VideoStatus` values at the throw site.
 */
export class IllegalVideoStatusTransitionException extends DomainException {
  constructor(from: string, to: string) {
    super(
      'ILLEGAL_VIDEO_STATUS_TRANSITION',
      409,
      `Video cannot transition from "${from}" to "${to}"`,
    );
  }
}
