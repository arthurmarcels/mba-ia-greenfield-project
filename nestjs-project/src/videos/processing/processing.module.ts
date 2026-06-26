import { Module } from '@nestjs/common';
import { VideosModule } from '../videos.module';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Wires the BullMQ consumer so the worker entrypoint (`src/worker.ts`, which
 * boots an `AppModule` application context) discovers the
 * `@Processor(VIDEO_PROCESSING_QUEUE)` via DI. The explorers registered by
 * `QueueModule` (`BullModule.registerQueue`) scan app-wide providers for
 * `@Processor`, so this module only needs to supply the processor and its
 * collaborator: `VideosService` (exported by `VideosModule`).
 * `StorageService` is `@Global`, so no import is required for it.
 */
@Module({
  imports: [VideosModule],
  providers: [VideoProcessingProcessor],
})
export class ProcessingModule {}
