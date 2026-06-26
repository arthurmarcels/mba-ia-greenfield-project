import { DataSource, Repository } from 'typeorm';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { Video } from './video.entity';
import { VIDEO_STATUS } from '../videos.constants';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUser(): Promise<User> {
    return userRepository.save(
      userRepository.create({
        email: `vid_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
  }

  let channelCounter = 0;
  async function createChannel(user: User): Promise<Channel> {
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${channelCounter}`,
        nickname: `channel_${channelCounter++}`,
        user_id: user.id,
      }),
    );
  }

  let videoCounter = 0;
  async function createVideo(channel: Channel): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        slug: `video_${videoCounter++}`,
        title: 'Test Video',
        channel_id: channel.id,
      }),
    );
  }

  it('should enforce unique slug constraint', async () => {
    const user = await createUser();
    const channel = await createChannel(user);

    await videoRepository.save(
      videoRepository.create({
        slug: 'same_slug',
        title: 'Video One',
        channel_id: channel.id,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'same_slug',
          title: 'Video Two',
          channel_id: channel.id,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft', async () => {
    const user = await createUser();
    const channel = await createChannel(user);
    const video = await createVideo(channel);

    expect(video.status).toBe(VIDEO_STATUS.DRAFT);
  });

  it('should reject invalid status values', async () => {
    const user = await createUser();
    const channel = await createChannel(user);

    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'invalid_status',
          title: 'Invalid Status Video',
          channel_id: channel.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          status: 'invalid_status_value' as any,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce channel foreign key constraint', async () => {
    const nonExistentChannelId = '00000000-0000-0000-0000-000000000000';

    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'orphan_video',
          title: 'Orphan Video',
          channel_id: nonExistentChannelId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const user = await createUser();
    const channel = await createChannel(user);
    await videoRepository.save(
      videoRepository.create({
        slug: 'relation_test',
        title: 'Relation Test Video',
        channel_id: channel.id,
      }),
    );

    const found = await videoRepository.findOne({
      where: { slug: 'relation_test' },
      relations: ['channel'],
    });

    expect(found?.channel.name).toBe(channel.name);
  });

  it('should allow null on nullable processing fields', async () => {
    const user = await createUser();
    const channel = await createChannel(user);
    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'nullable_fields',
        title: 'Nullable Fields Video',
        channel_id: channel.id,
        duration_seconds: null,
        metadata: null,
        video_storage_key: null,
        thumbnail_storage_key: null,
        multipart_upload_id: null,
        file_size_bytes: null,
        mime_type: null,
        error_message: null,
      }),
    );

    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.video_storage_key).toBeNull();
    expect(video.thumbnail_storage_key).toBeNull();
    expect(video.multipart_upload_id).toBeNull();
    expect(video.file_size_bytes).toBeNull();
    expect(video.mime_type).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should allow storing metadata as jsonb', async () => {
    const user = await createUser();
    const channel = await createChannel(user);
    const testMetadata = {
      codec: 'h264',
      width: 1920,
      height: 1080,
      bitrate: 4500000,
    };

    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'metadata_test',
        title: 'Metadata Test Video',
        channel_id: channel.id,
        metadata: testMetadata,
      }),
    );

    expect(video.metadata).toEqual(testMetadata);
  });

  it('should store file_size_bytes as string (bigint)', async () => {
    const user = await createUser();
    const channel = await createChannel(user);
    const fileSize = '1073741824'; // 1GB in bytes

    const video = await videoRepository.save(
      videoRepository.create({
        slug: 'filesize_test',
        title: 'Filesize Test Video',
        channel_id: channel.id,
        file_size_bytes: fileSize,
      }),
    );

    expect(video.file_size_bytes).toBe(fileSize);
    expect(typeof video.file_size_bytes).toBe('string');
  });
});
