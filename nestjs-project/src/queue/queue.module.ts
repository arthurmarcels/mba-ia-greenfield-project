import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

/**
 * Wires BullMQ onto the shared Redis connection (Compose service `redis`) and
 * registers the `video-processing` queue.
 *
 * `BullModule` is re-exported so any module importing `QueueModule` (e.g.
 * `VideosModule` in SI-03.5) can inject the queue via
 * `@InjectQueue(VIDEO_PROCESSING_QUEUE)`.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: { host: config.host, port: config.port },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
