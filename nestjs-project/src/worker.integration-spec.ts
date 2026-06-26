import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { WorkerAppModule } from './worker.module';
import { VideoProcessingProcessor } from './videos/processing/video-processing.processor';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './queue/queue.constants';

describe('Worker application context (integration)', () => {
  let app: INestApplicationContext | undefined;
  let queue: Queue | undefined;

  beforeAll(async () => {
    // Mirrors src/worker.ts: a Nest application context (no HTTP server) rooted
    // at WorkerAppModule (AppModule + the BullMQ consumer), wiring BullMQ
    // against the real Compose `redis` service.
    app = await NestFactory.createApplicationContext(WorkerAppModule);
    await app.init();
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    // Best-effort cleanup of any job this suite enqueued against real Redis.
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => undefined);
    }
    if (app) {
      await app.close();
    }
  }, 30000);

  it('boots the worker context and reaches the video-processing queue on Redis', async () => {
    expect(app).toBeDefined();
    expect(queue).toBeDefined();

    // The worker root must wire the BullMQ consumer (ProcessingModule) — this is
    // the entire purpose of the worker process and is not provided by AppModule
    // alone (the consumer was moved out of AppModule in AMS-390).
    expect(app?.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );

    const videoQueue = queue as Queue;
    expect(videoQueue.name).toBe(VIDEO_PROCESSING_QUEUE);

    // Round-trips to real Redis: a process-video job is accepted (id assigned),
    // proving the queue is live and discoverable from the worker context.
    const job = await videoQueue.add(PROCESS_VIDEO_JOB, {
      videoId: 'integration-probe',
    });
    expect(job.id).toBeDefined();
  }, 15000);
});
