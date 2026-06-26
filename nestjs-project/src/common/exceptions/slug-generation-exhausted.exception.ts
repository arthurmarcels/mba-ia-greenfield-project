import { DomainException } from './domain.exception';

/**
 * Thrown when `VideosService.createDraft` exhausts `VIDEO_SLUG_MAX_RETRIES`
 * slug regenerations — every nanoid draw collided on the unique constraint.
 * Rendered as `{ statusCode: 503, error: 'SLUG_GENERATION_EXHAUSTED', message }`
 * by `DomainExceptionFilter`.
 *
 * Mapped to 503 (not 4xx, not 409) because the resource state is intact: we
 * simply failed to allocate a slug. It is transient and client-retryable, so
 * Service Unavailable is the honest signal rather than blaming the client or
 * implying a conflict. In practice unreachable (six nanoid(12) draws do not all
 * collide), but surfaced as a typed domain exception instead of a bare `Error`
 * so the standardized error envelope is produced.
 */
export class SlugGenerationExhaustedException extends DomainException {
  constructor() {
    super(
      'SLUG_GENERATION_EXHAUSTED',
      503,
      'Unable to generate a unique video slug — please retry',
    );
  }
}
