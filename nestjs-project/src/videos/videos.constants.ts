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
