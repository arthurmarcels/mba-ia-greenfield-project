import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

/** Response bodies are not validated, so cast `res.body` (typed `any`) at use. */
interface InitiateResponse {
  id: string;
  slug: string;
  status: string;
  uploadId: string;
  key: string;
  partSize: number;
}
interface ErrorResponse {
  error: string;
}
interface UploadUrlResponse {
  url: string;
}
interface CompleteResponse {
  id: string;
  status: string;
}

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

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
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    // Drain jobs this suite enqueued so Redis stays clean for SI-03.7.
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_email, _name, token) => {
        capturedToken = token;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  const VALID_INITIATE = {
    title: 'My Video',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1024,
  };

  // Non-async so it returns the thenable supertest `Test` — callers chain
  // `.expect()` (e.g. `await initiateUpload(token).expect(201)`); making this
  // `async` would wrap it in a `Promise` and drop the `.expect` chaining type.
  function initiateUpload(accessToken: string) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(VALID_INITIATE);
  }

  describe('POST /videos', () => {
    it('initiates an upload for an authenticated owner → 201 with uploadId, key and partSize', async () => {
      const accessToken = await registerConfirmAndLogin('owner@example.com');

      const res = await initiateUpload(accessToken).expect(201);
      const body = res.body as InitiateResponse;

      expect(body.id).toBeDefined();
      expect(body.slug).toBeDefined();
      expect(body.status).toBe('uploading');
      expect(body.uploadId).toBeTruthy();
      expect(body.key).toMatch(/\/original\.mp4$/);
      expect(body.partSize).toBe(5 * 1024 * 1024);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(VALID_INITIATE)
        .expect(401);
    });

    it('returns 400 with VALIDATION_ERROR on an unsupported mime type', async () => {
      const accessToken = await registerConfirmAndLogin('mime@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...VALID_INITIATE, mimeType: 'application/pdf' })
        .expect(400);

      expect((res.body as ErrorResponse).error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /videos/:id/upload-url', () => {
    it('returns 400 on an invalid partNumber (below 1)', async () => {
      const accessToken = await registerConfirmAndLogin('pn@example.com');
      const { id } = (await initiateUpload(accessToken).expect(201))
        .body as InitiateResponse;

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/upload-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ partNumber: 0 })
        .expect(400);

      expect((res.body as ErrorResponse).error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 with VALIDATION_ERROR on a non-UUID id', async () => {
      const accessToken = await registerConfirmAndLogin('uuid@example.com');

      const res = await request(app.getHttpServer())
        .get('/videos/not-a-uuid/upload-url')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ partNumber: 1 })
        .expect(400);

      expect((res.body as ErrorResponse).error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 on a missing partNumber', async () => {
      const accessToken = await registerConfirmAndLogin(
        'pnmissing@example.com',
      );
      const { id } = (await initiateUpload(accessToken).expect(201))
        .body as InitiateResponse;

      await request(app.getHttpServer())
        .get(`/videos/${id}/upload-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('returns 404 with VIDEO_NOT_FOUND for an unknown video', async () => {
      const accessToken = await registerConfirmAndLogin('nf@example.com');

      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/upload-url')
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ partNumber: 1 })
        .expect(404);

      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 403 with FORBIDDEN_RESOURCE for a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin('owner-a@example.com');
      const otherToken = await registerConfirmAndLogin('other-a@example.com');
      const { id } = (await initiateUpload(ownerToken).expect(201))
        .body as InitiateResponse;

      const res = await request(app.getHttpServer())
        .get(`/videos/${id}/upload-url`)
        .set('Authorization', `Bearer ${otherToken}`)
        .query({ partNumber: 1 })
        .expect(403);

      expect((res.body as ErrorResponse).error).toBe('FORBIDDEN_RESOURCE');
    });
  });

  describe('full upload cycle (real MinIO + Redis)', () => {
    it('initiate → part-URL → upload part → complete transitions to processing', async () => {
      const accessToken = await registerConfirmAndLogin('cycle@example.com');

      // 1. initiate — starts a real multipart upload in MinIO
      const initiateRes = await initiateUpload(accessToken).expect(201);
      const { id, uploadId } = initiateRes.body as InitiateResponse;
      expect(uploadId).toBeTruthy();

      // 2. part URL — presigned PUT for part 1
      const urlRes = await request(app.getHttpServer())
        .get(`/videos/${id}/upload-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .query({ partNumber: 1 })
        .expect(200);
      const { url } = urlRes.body as UploadUrlResponse;
      expect(url).toBeTruthy();

      // 3. upload the part directly to MinIO and capture the ETag
      const partData = Buffer.from('e2e-multipart-part-bytes');
      const putRes = await fetch(url, { method: 'PUT', body: partData });
      expect(putRes.status).toBe(200);
      const etag = (putRes.headers.get('etag') || '').replace(/"/g, '');
      expect(etag).toBeTruthy();

      // 4. complete — finalizes multipart server-side + enqueues processing
      const completeRes = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(200);
      const completed = completeRes.body as CompleteResponse;

      expect(completed.id).toBe(id);
      expect(completed.status).toBe('processing');
    });

    it('returns 403 with FORBIDDEN_RESOURCE when a non-owner completes', async () => {
      const ownerToken = await registerConfirmAndLogin('co-owner@example.com');
      const otherToken = await registerConfirmAndLogin('co-other@example.com');
      const { id } = (await initiateUpload(ownerToken).expect(201))
        .body as InitiateResponse;

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ partNumber: 1, etag: 'etag' }] })
        .expect(403);

      expect((res.body as ErrorResponse).error).toBe('FORBIDDEN_RESOURCE');
    });

    it('returns 400 with VALIDATION_ERROR on a non-UUID id', async () => {
      const accessToken = await registerConfirmAndLogin('couuid@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/not-a-uuid/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag: 'etag' }] })
        .expect(400);

      expect((res.body as ErrorResponse).error).toBe('VALIDATION_ERROR');
    });
  });
});
