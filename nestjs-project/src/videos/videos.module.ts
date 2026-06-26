import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { Video } from './entities/video.entity';
import { StorageModule } from './storage/storage.module';
import { VideosService } from './videos.service';

/**
 * Wires the videos domain. `StorageModule` (global, owns the `StorageService`)
 * and `QueueModule` (re-exports `BullModule` so the `VIDEO_PROCESSING_QUEUE` can
 * be injected) are imported so `VideosService` resolves all of its
 * collaborators through DI. `TypeOrmModule` is exported alongside the service so
 * the controller (SI-03.6) and processor (SI-03.7) can reuse the `Video`
 * repository without re-registering the entity.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule, QueueModule],
  providers: [VideosService],
  exports: [VideosService, TypeOrmModule],
})
export class VideosModule {}
