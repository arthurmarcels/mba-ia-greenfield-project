import { Module } from '@nestjs/common';
import { AppModule } from './app.module';
import { ProcessingModule } from './videos/processing/processing.module';

/**
 * Root module for the `video-worker` process (booted by `src/worker.ts`).
 *
 * It is the API's `AppModule` — config, TypeORM, storage, and the BullMQ
 * `QueueModule` that registers the `video-processing` queue — PLUS the BullMQ
 * consumer `ProcessingModule`, whose `@Processor(VIDEO_PROCESSING_QUEUE)` is
 * discovered app-wide by `BullModule`'s explorer once it is part of the context.
 *
 * `ProcessingModule` is deliberately NOT imported by `AppModule`: the API only
 * *publishes* jobs, it must not also *consume* them — consuming is the
 * `video-worker` container's sole responsibility (see CLAUDE.md architecture and
 * the processor's own docstring: "Runs in the worker process (`video-worker`),
 * not the API"). Keeping the consumer out of `AppModule` also keeps it out of
 * every API and e2e boot, which is what makes the BullMQ worker's
 * blocking-connection teardown (`Connection is closed.`) a non-issue for the API
 * and the e2e suite (AMS-390).
 */
@Module({ imports: [AppModule, ProcessingModule] })
export class WorkerAppModule {}
