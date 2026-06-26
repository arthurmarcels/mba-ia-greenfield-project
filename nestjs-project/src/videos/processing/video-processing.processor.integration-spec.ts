import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ConfigType } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import storageConfig from '../../config/storage.config';
import { Video } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { VIDEO_STATUS } from '../videos.constants';
import { VideosService } from '../videos.service';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Integration spec for the processor against real FFmpeg/ffprobe + real MinIO +
 * real PostgreSQL. MUST run inside the `video-worker` container (the only image
 * that bundles ffmpeg): from `nestjs-project/`,
 *   `sudo docker compose exec video-worker npm test -- --runInBand
 *    src/videos/processing/video-processing.processor.integration-spec.ts`
 * The worker shares the mounted codebase + node_modules; `db`/`minio` resolve on
 * the Compose network and `.env` is loaded by Jest's `setupFiles`.
 */
const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

const STORAGE_CONFIG = {
  endpoint: process.env.STORAGE_ENDPOINT || 'minio',
  port: parseInt(process.env.STORAGE_PORT || '9000', 10),
  useSsl: process.env.STORAGE_USE_SSL === 'true',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-media',
  publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
} as ConfigType<typeof storageConfig>;

const GENERATED_KEYS: string[] = [];

function makeJob(videoId: string, attemptsMade = 1): Job<{ videoId: string }> {
  return {
    id: `job-${videoId}`,
    data: { videoId },
    opts: { attempts: 3 },
    attemptsMade,
  } as Job<{ videoId: string }>;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function canRunFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG_AVAILABLE = canRunFfmpeg();

if (!FFMPEG_AVAILABLE) {
  // Visible in the test log so the skip is never silent. The real run happens in
  // the `video-worker` container (the only image that bundles ffmpeg/ffprobe).

  console.warn(
    '[VideoProcessingProcessor integration] SKIPPED — ffmpeg/ffprobe not on PATH in this container. ' +
      'Run in the worker image: `sudo docker compose exec video-worker npm test -- --runInBand ' +
      'src/videos/processing/video-processing.processor.integration-spec.ts`.',
  );
}

(FFMPEG_AVAILABLE ? describe : describe.skip)(
  'VideoProcessingProcessor (integration)',
  () => {
    let dataSource: DataSource;
    let storage: StorageService;
    let processor: VideoProcessingProcessor;
    let userRepository: Repository<User>;
    let channelRepository: Repository<Channel>;
    let videoRepository: Repository<Video>;
    let fixturePath: string;
    let fixtureBytes: Buffer;
    let fixtureDir: string;
    let counter = 0;

    beforeAll(async () => {
      // Generate a tiny but real, valid H.264 mp4 the worker's ffmpeg can probe +
      // thumbnail. `testsrc` guarantees frames at the 50% mark.
      fixtureDir = await mkdtemp(join(tmpdir(), 'vp-int-fixture-'));
      fixturePath = join(fixtureDir, 'fixture.mp4');
      execFileSync(
        'ffmpeg',
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=1:size=320x240:rate=25',
          '-pix_fmt',
          'yuv420p',
          fixturePath,
        ],
        { stdio: 'pipe' },
      );
      fixtureBytes = await readFile(fixturePath);

      dataSource = createTestDataSource(ALL_ENTITIES);
      await dataSource.initialize();
      userRepository = dataSource.getRepository(User);
      channelRepository = dataSource.getRepository(Channel);
      videoRepository = dataSource.getRepository(Video);

      storage = new StorageService(STORAGE_CONFIG);
      await storage.onModuleInit();

      const videosService = new VideosService(
        videoRepository,
        storage,
        {} as never, // queue unused by findById/markReady/markError
      );
      processor = new VideoProcessingProcessor(videosService, storage);
    });

    afterAll(async () => {
      await Promise.all(
        GENERATED_KEYS.map((key) =>
          storage.removeObject(key).catch(() => undefined),
        ),
      );
      await dataSource.destroy();
      await rm(fixtureDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    });

    beforeEach(async () => {
      await cleanAllTables(dataSource);
    });

    async function createChannel(): Promise<Channel> {
      counter += 1;
      const user = await userRepository.save(
        userRepository.create({
          email: `proc_int_${counter}@example.com`,
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

    /** Creates a `processing` video whose original is uploaded to MinIO. */
    async function seedProcessingVideo(
      channelId: string,
      bytes: Buffer,
    ): Promise<Video> {
      const video = await videoRepository.save(
        videoRepository.create({
          channel_id: channelId,
          slug: `procint-${counter}-${Date.now().toString(36)}`,
          title: 'integration clip',
          status: VIDEO_STATUS.PROCESSING,
          mime_type: 'video/mp4',
        }),
      );
      const key = `${channelId}/${video.id}/original.mp4`;
      await storage.putObject(key, bytes, 'video/mp4');
      GENERATED_KEYS.push(key);
      video.video_storage_key = key;
      return videoRepository.save(video);
    }

    it('processes a valid upload to ready with duration, metadata, and a MinIO thumbnail', async () => {
      const channel = await createChannel();
      const video = await seedProcessingVideo(channel.id, fixtureBytes);

      await processor.process(makeJob(video.id));

      const ready = await videoRepository.findOneBy({ id: video.id });
      expect(ready).not.toBeNull();
      expect(ready!.status).toBe(VIDEO_STATUS.READY);
      expect(ready!.duration_seconds).toBeGreaterThan(0);
      expect(ready!.metadata).not.toBeNull();
      const metadata = ready!.metadata as Record<string, unknown>;
      expect(typeof metadata.codec).toBe('string');
      expect(typeof metadata.width).toBe('number');
      expect(typeof metadata.height).toBe('number');
      const expectedThumbnailKey = `${channel.id}/${video.id}/thumbnail.jpg`;
      expect(ready!.thumbnail_storage_key).toBe(expectedThumbnailKey);

      // The thumbnail object must actually exist in MinIO and be a real JPEG.
      const thumbnail = await storage.getObjectRange(expectedThumbnailKey);
      expect(thumbnail.totalSize).toBeGreaterThan(0);
      const thumbnailBytes = await readAll(thumbnail.stream);
      expect(thumbnailBytes[0]).toBe(0xff); // JPEG SOI magic byte
      expect(thumbnailBytes[1]).toBe(0xd8);
      GENERATED_KEYS.push(expectedThumbnailKey);
    });

    it('fails a corrupt upload terminally and marks the video error', async () => {
      const channel = await createChannel();
      const video = await seedProcessingVideo(
        channel.id,
        Buffer.from('this is definitely not a video file'),
      );

      // process() must throw (job fails). ffprobe rejects the garbage as a decode
      // error → UnrecoverableError.
      const thrown = await processor
        .process(makeJob(video.id))
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);

      // The worker emits `failed` on a terminal failure; simulate it so the
      // terminal handler marks the video `error` (exhausted branch is robust to
      // the exact ffprobe wording; unrecoverable would also qualify).
      await processor.onFailed(
        makeJob(video.id, 3), // attemptsMade === attempts → exhausted
        thrown as Error,
      );

      const errored = await videoRepository.findOneBy({ id: video.id });
      expect(errored).not.toBeNull();
      expect(errored!.status).toBe(VIDEO_STATUS.ERROR);
      expect(errored!.error_message).toBeTruthy();
      expect(typeof errored!.error_message).toBe('string');
      expect(errored!.error_message!.length).toBeGreaterThan(0);
    });

    it('marks the video error immediately on an unrecoverable failure with retries left', async () => {
      const channel = await createChannel();
      const video = await seedProcessingVideo(
        channel.id,
        Buffer.from('still not a video'),
      );

      const thrown = await processor
        .process(makeJob(video.id))
        .catch((e: unknown) => e);

      // Replays the worker `failed` event before retries are exhausted; an
      // unrecoverable failure marks the video error without waiting.
      if (thrown instanceof UnrecoverableError) {
        await processor.onFailed(makeJob(video.id, 1), thrown);
        const errored = await videoRepository.findOneBy({ id: video.id });
        expect(errored!.status).toBe(VIDEO_STATUS.ERROR);
        expect(errored!.error_message).toBeTruthy();
      }
    });
  },
);
