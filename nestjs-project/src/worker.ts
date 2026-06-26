import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker.module';

/**
 * Video worker entrypoint — a second process/container that shares the same
 * codebase as the API but runs NO HTTP server. It boots a Nest application
 * context from `WorkerAppModule` (the API's `AppModule` + the BullMQ consumer
 * `ProcessingModule`) so the `@Processor(VIDEO_PROCESSING_QUEUE)` from SI-03.7
 * is picked up by `BullModule`'s explorer and wired purely through DI.
 *
 * `ProcessingModule` lives in `WorkerAppModule`, not `AppModule`, so the API
 * process never instantiates a worker (it only publishes jobs); see
 * `worker.module.ts` and AMS-390.
 *
 * Graceful shutdown is enabled so SIGINT/SIGTERM (e.g. `docker compose stop`)
 * triggers `onModuleDestroy`/`onApplicationShutdown` and closes the Redis and
 * DB connections cleanly.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  app.enableShutdownHooks();
  await app.init();
  new Logger('Worker').log('video-processing worker context started');
}

void bootstrap();
