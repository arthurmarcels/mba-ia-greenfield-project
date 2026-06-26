import { DomainException } from './domain.exception';

/**
 * Thrown when an authenticated caller has no channel. Registration creates the
 * channel atomically with the user, so a valid authenticated user always has
 * one; reaching this branch is therefore a server-side data inconsistency (a
 * corrupt user row or a failed registration transaction), not an authorization
 * failure — hence 500, not 403. The user *should* have a channel.
 *
 * Rendered as
 * `{ statusCode: 500, error: 'USER_HAS_NO_CHANNEL', message: '...' }` by
 * `DomainExceptionFilter`. It flows through the shared domain filter (rather
 * than a bare `throw new Error`) so the response keeps the standard error
 * envelope and the case is distinguishable from an unhandled crash.
 *
 * Home is `src/common/exceptions/`: generic and reusable across any domain that
 * resolves the caller's channel.
 */
export class UserHasNoChannelException extends DomainException {
  constructor(message = 'Authenticated user has no channel') {
    super('USER_HAS_NO_CHANNEL', 500, message);
  }
}
