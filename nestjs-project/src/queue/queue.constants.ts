/**
 * BullMQ identifiers for the video-processing pipeline.
 *
 * The queue name doubles as its DI injection token: use `VIDEO_PROCESSING_QUEUE`
 * both in `BullModule.registerQueue({ name })` and `@InjectQueue(...)`, so the
 * producer (VideosService, SI-03.5) and consumer (processor, SI-03.7) reference
 * the exact same string.
 */
export const VIDEO_PROCESSING_QUEUE = 'video-processing' as const;

/**
 * Job name enqueued by `VideosService.completeUpload` (SI-03.5) and consumed by
 * the `@Processor(VIDEO_PROCESSING_QUEUE)` worker (SI-03.7).
 */
export const PROCESS_VIDEO_JOB = 'process-video' as const;
