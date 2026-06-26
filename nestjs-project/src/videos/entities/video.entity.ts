import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VIDEO_STATUS, type VideoStatus } from '../videos.constants';

@Entity('videos')
@Index('idx_videos_channel_id', ['channel_id'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 21, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({
    type: 'enum',
    enum: Object.values(VIDEO_STATUS),
    enumName: 'video_status_enum',
    default: VIDEO_STATUS.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'integer', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true })
  video_storage_key: string | null;

  @Column({ type: 'varchar', nullable: true })
  thumbnail_storage_key: string | null;

  @Column({ type: 'varchar', nullable: true })
  multipart_upload_id: string | null;

  @Column({ type: 'bigint', nullable: true })
  file_size_bytes: string | null;

  @Column({ type: 'varchar', nullable: true })
  mime_type: string | null;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
