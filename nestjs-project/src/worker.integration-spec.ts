import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { AppModule } from './app.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './queue/queue.constants';

describe('Worker application context (integration)', () => {
  let app: INestApplicationContext | undefined;
  let queue: Queue | undefined;

  beforeAll(async () => {
    // Mirrors src/worker.ts: a Nest application context (no HTTP server) that
    // reuses AppModule, wiring BullMQ against the real Compose `redis` service.
    app = await NestFactory.createApplicationContext(AppModule);
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
