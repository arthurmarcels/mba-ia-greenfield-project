/**
 * Length of the public URL slug (TD-04). nanoid's URL-safe alphabet at 12 chars
 * gives ample collision resistance for a video URL key; the column is sized to
 * 21 to stay forward-compatible with the default nanoid size.
 */
export const VIDEO_SLUG_LENGTH = 12;

/** Cap on slug-regeneration attempts before surfacing a hard failure. */
export const VIDEO_SLUG_MAX_RETRIES = 5;

/**
 * Supported upload MIME types mapped to their file extension (TD-06). The DTO
 * validates membership (SI-03.5); the controller (SI-03.6) reads the extension
 * to derive the storage key `<channelId>/<videoId>/original.<ext>`.
 */
export const ALLOWED_VIDEO_MIME_TYPES = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
} as const;

export type VideoMimeType = keyof typeof ALLOWED_VIDEO_MIME_TYPES;

/**
 * Target resolution for the midpoint thumbnail captured by the worker (SI-03.7).
 * Used as the `size` option of `fluent-ffmpeg` `screenshots`.
 */
export const VIDEO_THUMBNAIL_SIZE = '1280x720' as const;

/**
 * Thumbnail object filename. The processor stores the captured JPEG at the key
 * `<channelId>/<videoId>/thumbnail.jpg` (SI-03.7) — the same key SI-03.8/streaming
 * resolves the public thumbnail URL from. Centralized so producer and consumer
 * agree on the exact suffix.
 */
export const VIDEO_THUMBNAIL_FILENAME = 'thumbnail.jpg' as const;

export const VIDEO_STATUS = {
  DRAFT: 'draft',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

/**
 * Status transition map per TD-07.
 * draft → uploading
 * uploading → {processing, error}
 * processing → {ready, error}
 * ready/error: terminal (no transitions out)
 */
export const VIDEO_STATUS_TRANSITIONS: Record<VideoStatus, VideoStatus[]> = {
  [VIDEO_STATUS.DRAFT]: [VIDEO_STATUS.UPLOADING],
  [VIDEO_STATUS.UPLOADING]: [VIDEO_STATUS.PROCESSING, VIDEO_STATUS.ERROR],
  [VIDEO_STATUS.PROCESSING]: [VIDEO_STATUS.READY, VIDEO_STATUS.ERROR],
  [VIDEO_STATUS.READY]: [],
  [VIDEO_STATUS.ERROR]: [],
};

/**
 * Check if a status transition is allowed.
 * @param from - Current status
 * @param to - Target status
 * @returns true if the transition is allowed
 */
export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return VIDEO_STATUS_TRANSITIONS[from].includes(to);
}
