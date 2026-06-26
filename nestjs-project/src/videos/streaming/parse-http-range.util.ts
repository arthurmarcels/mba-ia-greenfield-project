/**
 * Outcome of parsing a `Range` header against a known object size.
 *
 * - `none`    — no usable `Range` header → serve the whole object (200).
 * - `range`   — a valid single byte range → serve it (206) as `[start, end]`.
 * - `invalid` — malformed or out of bounds → 416 Range Not Satisfiable.
 */
export type HttpRangeParseResult =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'invalid' };

/**
 * Parses a single HTTP `Range: bytes=...` header (RFC 7233 §2.1) into a
 * concrete inclusive `[start, end]` against `totalSize`. Tolerates the three
 * player-emitted forms:
 *
 * - `bytes=<start>-<end>` — explicit range; `end` is clamped to `totalSize - 1`.
 * - `bytes=<start>-`      — from `start` to the end of the object.
 * - `bytes=-<suffix>`     — the last `<suffix>` bytes (whole object if larger).
 *
 * Anything else — a non-`bytes` unit, multiple comma-separated ranges, empty
 * bounds, non-digits, or a `start >= totalSize` — yields `invalid` (→ 416).
 *
 * This is pure byte arithmetic over an HTTP header (an HTTP-layer concern), so
 * it lives in a standalone helper the controller calls after sizing the object;
 * it holds no domain state and has no collaborators.
 */
export function parseHttpRange(
  header: string | undefined,
  totalSize: number,
): HttpRangeParseResult {
  if (header === undefined || header.trim() === '') {
    return { kind: 'none' };
  }

  const unit = /^bytes=(.+)$/i.exec(header.trim());
  if (!unit) {
    return { kind: 'invalid' };
  }

  const spec = unit[1].trim();
  // Only a single range is supported; multipart byte ranges (`a-b,c-d`) → 416.
  if (spec.includes(',')) {
    return { kind: 'invalid' };
  }

  const bounds = /^(\d*)-(\d*)$/.exec(spec);
  if (!bounds) {
    return { kind: 'invalid' };
  }

  const startRaw = bounds[1];
  const endRaw = bounds[2];

  // Suffix range: `bytes=-<suffix>` → last `suffix` bytes.
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (endRaw === '' || !Number.isInteger(suffix) || suffix <= 0) {
      return { kind: 'invalid' };
    }
    if (totalSize === 0) {
      return { kind: 'invalid' };
    }
    const start = suffix >= totalSize ? 0 : totalSize - suffix;
    return { kind: 'range', start, end: totalSize - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0 || start >= totalSize) {
    return { kind: 'invalid' };
  }

  // Open-ended: `bytes=<start>-` → to the end of the object.
  if (endRaw === '') {
    return { kind: 'range', start, end: totalSize - 1 };
  }

  const end = Number(endRaw);
  if (!Number.isInteger(end) || end < start) {
    return { kind: 'invalid' };
  }

  return { kind: 'range', start, end: Math.min(end, totalSize - 1) };
}
