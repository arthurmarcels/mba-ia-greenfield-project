import { DomainException } from './domain.exception';

/**
 * Thrown when a `Range` header on `GET /videos/:slug/stream` (SI-03.8) is
 * malformed or asks for bytes outside the object (`start >= totalSize`).
 * Rendered as
 * `{ statusCode: 416, error: 'RANGE_NOT_SATISFIABLE', message: 'Range Not Satisfiable' }`
 * by `DomainExceptionFilter` — the same `{ statusCode, error, message }`
 * envelope as every other error, so 416 stays consistent with the catalog.
 *
 * Home is `src/common/exceptions/`: it is a generic HTTP-range concern (not
 * videos-specific), surfaced through the shared domain exception base.
 */
export class RangeNotSatisfiableException extends DomainException {
  constructor(message = 'Range Not Satisfiable') {
    super('RANGE_NOT_SATISFIABLE', 416, message);
  }
}
