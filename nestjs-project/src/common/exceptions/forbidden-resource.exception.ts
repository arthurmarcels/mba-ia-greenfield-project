import { DomainException } from './domain.exception';

/**
 * Thrown when a caller tries to act on a resource they do not own (e.g. a user
 * finalizing the upload of another channel's video). Rendered as
 * `{ statusCode: 403, error: 'FORBIDDEN_RESOURCE', message }` by
 * `DomainExceptionFilter`.
 *
 * Home is `src/common/exceptions/` — like the auth exceptions, it is generic and
 * reusable across domains (single-responsibility), not videos-specific.
 */
export class ForbiddenResourceException extends DomainException {
  constructor(message = 'You do not have access to this resource') {
    super('FORBIDDEN_RESOURCE', 403, message);
  }
}
