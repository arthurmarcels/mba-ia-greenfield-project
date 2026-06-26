import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Video worker entrypoint — a second process/container that shares the same
 * codebase as the API (`AppModule`: config, entities, storage) but runs NO HTTP
 * server. It boots a Nest application context so BullMQ consumers are wired
 * purely through DI: the `@Processor(VIDEO_PROCESSING_QUEUE)` delivered in
 * SI-03.7 is picked up automatically once its module is part of `AppModule`.
 *
 * Until SI-03.7 lands there is no consumer, so the context boots and idles,
 * keeping the `video-processing` queue connection warm on Redis.
 *
 * Graceful shutdown is enabled so SIGINT/SIGTERM (e.g. `docker compose stop`)
 * triggers `onModuleDestroy`/`onApplicationShutdown` and closes the Redis and
 * DB connections cleanly.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  await app.init();
  new Logger('Worker').log('video-processing worker context started');
}

void bootstrap();
