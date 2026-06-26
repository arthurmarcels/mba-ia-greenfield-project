import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from '../videos/entities/video.entity';
import { Channel } from './entities/channel.entity';
import { ChannelsService } from './channels.service';

@Module({
  imports: [TypeOrmModule.forFeature([Channel, Video])],
  providers: [ChannelsService],
  exports: [TypeOrmModule, ChannelsService],
})
export class ChannelsModule {}
