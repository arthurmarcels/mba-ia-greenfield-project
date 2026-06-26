import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/videos/storage/storage.service';
import { VIDEO_STATUS, type VideoStatus } from '../src/videos/videos.constants';

/** Inherited `{ statusCode, error, message }` error envelope. */
interface ErrorResponse {
  error: string;
}
interface DownloadResponse {
  url: string;
}

describe('Videos streaming & download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

  /** Set up fresh in `beforeEach` (tables are wiped between tests). */
  let channelId: string;
  let readyKey: string;

  const OBJECT_SIZE = 2048;
  const OBJECT_BUFFER = Buffer.alloc(OBJECT_SIZE, 0x42);
  const STREAMER_EMAIL = 'streamer@example.com';

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    // Registration fires a confirmation email; stub it so no SMTP is attempted.
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockResolvedValue(undefined);
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = app.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();

    // Registering a user atomically creates a channel — its id is the FK the
    // seeded videos hang off. Stream/download are anonymous, so no login needed.
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: STREAMER_EMAIL, password: 'password123' });
    // Exactly one channel exists per test (tables wiped, one user registered),
    // so the typed repository lookup gives a clean `string` id with no `any`.
    const channel = await dataSource.getRepository(Channel).findOneByOrFail({});
    channelId = channel.id;

    readyKey = `e2e/streaming/${randomUUID()}/original.mp4`;
    await storageService.putObject(readyKey, OBJECT_BUFFER, 'video/mp4');
  });

  /** Inserts a video row in `status` under the streamer's channel. */
  async function seedVideo(slug: string, status: VideoStatus): Promise<void> {
    const repo = dataSource.getRepository(Video);
    await repo.save(
      repo.create({
        slug,
        title: `video-${slug}`,
        channel_id: channelId,
        status,
        mime_type: 'video/mp4',
        video_storage_key: readyKey,
        file_size_bytes: String(OBJECT_SIZE),
      }),
    );
  }

  describe('GET /videos/:slug/stream', () => {
    it('returns 206 + Content-Range/Content-Length for a ranged request', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      const res = await request(app.getHttpServer())
        .get('/videos/ready-vid/stream')
        .set('Range', 'bytes=0-1023')
        .expect(206);

      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-range']).toBe(`bytes 0-1023/${OBJECT_SIZE}`);
      expect(res.headers['content-length']).toBe('1024');
      expect(res.headers['content-type']).toBe('video/mp4');
    });

    it('returns 200 with the full Content-Length when no Range is sent', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      const res = await request(app.getHttpServer())
        .get('/videos/ready-vid/stream')
        .expect(200);

      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(OBJECT_SIZE));
      expect(res.headers['content-range']).toBeUndefined();
    });

    it('serves a player-style multi-range sequence without buffering the whole object', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      const first = await request(app.getHttpServer())
        .get('/videos/ready-vid/stream')
        .set('Range', 'bytes=0-1023')
        .expect(206);
      expect(first.headers['content-range']).toBe(
        `bytes 0-1023/${OBJECT_SIZE}`,
      );

      const second = await request(app.getHttpServer())
        .get('/videos/ready-vid/stream')
        .set('Range', 'bytes=1024-')
        .expect(206);
      expect(second.headers['content-range']).toBe(
        `bytes 1024-${OBJECT_SIZE - 1}/${OBJECT_SIZE}`,
      );
      expect(second.headers['content-length']).toBe(String(OBJECT_SIZE - 1024));
    });

    it('returns 416 RANGE_NOT_SATISFIABLE for an out-of-bounds range', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      const res = await request(app.getHttpServer())
        .get('/videos/ready-vid/stream')
        .set('Range', 'bytes=99999-')
        .expect(416);

      expect((res.body as ErrorResponse).error).toBe('RANGE_NOT_SATISFIABLE');
    });

    it('returns 409 VIDEO_NOT_READY for a non-ready video', async () => {
      await seedVideo('draft-vid', VIDEO_STATUS.DRAFT);
      await seedVideo('proc-vid', VIDEO_STATUS.PROCESSING);
      await seedVideo('err-vid', VIDEO_STATUS.ERROR);

      for (const slug of ['draft-vid', 'proc-vid', 'err-vid']) {
        const res = await request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .expect(409);
        expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_READY');
      }
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/no-such-slug/stream')
        .expect(404);

      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');
    });

    it('is anonymously accessible (no Authorization header)', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      await request(app.getHttpServer())
        .get('/videos/ready-vid/stream')
        .set('Range', 'bytes=0-511')
        .expect(206); // no Authorization set — proves @Public()
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('returns 200 { url } for a ready video', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      const res = await request(app.getHttpServer())
        .get('/videos/ready-vid/download')
        .expect(200);

      const { url } = res.body as DownloadResponse;
      expect(url).toEqual(expect.any(String));
      expect(url.startsWith('http')).toBe(true);
    });

    it('hands out a usable presigned attachment URL (fetch → 200 + the bytes)', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      const res = await request(app.getHttpServer())
        .get('/videos/ready-vid/download')
        .expect(200);
      const { url } = res.body as DownloadResponse;

      const dl = await fetch(url);
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-disposition')).toBe(
        'attachment; filename="ready-vid.mp4"',
      );
      const body = Buffer.from(await dl.arrayBuffer());
      expect(body.length).toBe(OBJECT_SIZE);
    });

    it('returns 409 VIDEO_NOT_READY for a non-ready video', async () => {
      await seedVideo('proc-vid', VIDEO_STATUS.PROCESSING);

      const res = await request(app.getHttpServer())
        .get('/videos/proc-vid/download')
        .expect(409);

      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_READY');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/no-such-slug/download')
        .expect(404);

      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');
    });

    it('is anonymously accessible (no Authorization header)', async () => {
      await seedVideo('ready-vid', VIDEO_STATUS.READY);

      await request(app.getHttpServer())
        .get('/videos/ready-vid/download')
        .expect(200); // no Authorization set — proves @Public()
    });
  });
});
