import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { InitiateUploadDto } from './dtos/initiate-upload.dto';
import { StorageService } from './storage/storage.service';
import { Video } from './entities/video.entity';
import { VIDEO_STATUS } from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const REDIS_CONNECTION = {
  host: process.env.QUEUE_HOST ?? 'redis',
  port: Number(process.env.QUEUE_PORT ?? 6379),
};

function makeDto(sizeBytes = 2048): InitiateUploadDto {
  return Object.assign(new InitiateUploadDto(), {
    title: 'Integration clip',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes,
  });
}

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let queue: Queue;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  /**
   * Storage is stubbed here on purpose: `storage.service.integration-spec.ts`
   * already proves the real MinIO multipart round-trip. This suite isolates the
   * service's own responsibilities — DB persistence and the real-Redis enqueue
   * — so we do not retest MinIO. DB and the queue are real.
   *
   * The stub is kept as `jest.Mock`-typed properties (not cast to
   * `StorageService` here) so asserting on its methods does not trip
   * `@typescript-eslint/unbound-method`; the cast happens only at the DI site.
   */
  const storageStub = {
    initiateMultipartUpload: jest
      .fn()
      .mockResolvedValue({ uploadId: 'upload-id' }),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    queue = new Queue(VIDEO_PROCESSING_QUEUE, { connection: REDIS_CONNECTION });
    service = new VideosService(
      videoRepository,
      storageStub as unknown as StorageService,
      queue,
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    jest.clearAllMocks();
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `chan-${counter}`,
        nickname: `chan-${counter}`,
        user_id: user.id,
      }),
    );
  }

  describe('createDraft', () => {
    it('persists a draft with a unique 12-char slug', async () => {
      const channel = await createChannel();

      const video = await service.createDraft(channel.id, makeDto());

      expect(video.id).toBeDefined();
      expect(video.slug).toHaveLength(12);
      expect(video.status).toBe(VIDEO_STATUS.DRAFT);
      expect(video.channel_id).toBe(channel.id);
      expect(video.file_size_bytes).toBe('2048');
      expect(video.mime_type).toBe('video/mp4');

      const persisted = await videoRepository.findOneBy({ id: video.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.slug).toBe(video.slug);
      expect(persisted!.status).toBe(VIDEO_STATUS.DRAFT);
    });

    it('produces distinct slugs across drafts', async () => {
      const channel = await createChannel();

      const a = await service.createDraft(channel.id, makeDto());
      const b = await service.createDraft(channel.id, makeDto());

      expect(a.slug).not.toBe(b.slug);
    });
  });

  describe('completeUpload', () => {
    it('transitions to processing and enqueues exactly one process-video job', async () => {
      const channel = await createChannel();
      const draft = await service.createDraft(channel.id, makeDto());
      const key = `${channel.id}/${draft.id}/original.mp4`;

      await service.beginUpload(draft, key);
      const parts = [{ partNumber: 1, etag: 'etag-1' }];
      const completed = await service.completeUpload(draft.id, parts);

      expect(completed.status).toBe(VIDEO_STATUS.PROCESSING);
      expect(storageStub.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(storageStub.completeMultipartUpload).toHaveBeenCalledWith(
        key,
        'upload-id',
        parts,
      );

      const dbVideo = await videoRepository.findOneBy({ id: draft.id });
      expect(dbVideo!.status).toBe(VIDEO_STATUS.PROCESSING);

      const jobs = await queue.getJobs(
        ['waiting', 'delayed', 'active', 'completed', 'failed'],
        0,
        100,
      );
      const processJobs = jobs.filter((j) => {
        const data = j.data as { videoId?: string };
        return j.name === PROCESS_VIDEO_JOB && data.videoId === draft.id;
      });
      expect(processJobs).toHaveLength(1);
      expect(processJobs[0].data).toEqual({ videoId: draft.id });
      expect(processJobs[0].opts.attempts).toBe(3);
      expect(processJobs[0].opts.backoff).toEqual({
        type: 'exponential',
        delay: 1000,
      });
    });
  });
});
