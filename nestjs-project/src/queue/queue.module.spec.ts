import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import appConfig from '../config/app.config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  let module: TestingModule | undefined;

  afterAll(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should compile and register the video-processing queue on the configured connection', async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, queueConfig],
        }),
        QueueModule,
      ],
    }).compile();

    expect(module).toBeDefined();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.name).toBe(VIDEO_PROCESSING_QUEUE);
  }, 15000);
});
