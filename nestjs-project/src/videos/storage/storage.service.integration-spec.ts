import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'stream';
import storageConfig from '../../config/storage.config';
import { StorageService } from './storage.service';

/**
 * Integration spec against the real MinIO Compose service (`minio`). Run inside
 * the container (`docker compose exec nestjs-api npm test -- --runInBand`) so
 * the presigned URLs (host `minio:9000`) resolve over the Docker network.
 */
const CONFIG = {
  endpoint: process.env.STORAGE_ENDPOINT || 'minio',
  port: parseInt(process.env.STORAGE_PORT || '9000', 10),
  useSsl: process.env.STORAGE_USE_SSL === 'true',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-media',
  publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
} as ConfigType<typeof storageConfig>;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let service: StorageService;
  const runId = `int-${Date.now()}`;
  const createdKeys: string[] = [];
  let seq = 0;

  function nextKey(suffix: string): string {
    const key = `tests/${runId}/${++seq}-${suffix}`;
    createdKeys.push(key);
    return key;
  }

  beforeAll(async () => {
    service = new StorageService(CONFIG);
    await service.onModuleInit();
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        service.removeObject(key).catch(() => undefined),
      ),
    );
  });

  it('creates the bucket if absent and does not error on a second init', async () => {
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });

  it('completes a small presigned multipart upload round-trip', async () => {
    const key = nextKey('multipart.bin');
    const partData = Buffer.from('hello-multipart-part-bytes');

    const { uploadId } = await service.initiateMultipartUpload(key);
    expect(uploadId).toBeTruthy();

    const partUrl = await service.presignPartUrl(key, uploadId, 1, 3600);
    const putRes = await fetch(partUrl, { method: 'PUT', body: partData });
    expect(putRes.status).toBe(200);
    const etag = (putRes.headers.get('etag') || '').replace(/"/g, '');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    const read = await service.getObjectRange(key);
    expect(read.totalSize).toBe(partData.length);
    expect(read.contentLength).toBe(partData.length);
    expect(read.contentRange).toBeNull();
    expect((await readAll(read.stream)).equals(partData)).toBe(true);
  });

  it('round-trips putObject with a partial and a full getObjectRange', async () => {
    const key = nextKey('roundtrip.txt');
    const body = Buffer.from('0123456789-roundtrip-content');

    await service.putObject(key, body, 'text/plain');

    const partial = await service.getObjectRange(key, { start: 0, end: 9 });
    expect(partial.contentLength).toBe(10);
    expect(partial.contentRange).toBe(`bytes 0-9/${body.length}`);
    expect(partial.totalSize).toBe(body.length);
    expect((await readAll(partial.stream)).toString()).toBe('0123456789');

    const full = await service.getObjectRange(key);
    expect(full.contentLength).toBe(body.length);
    expect(full.contentRange).toBeNull();
    expect((await readAll(full.stream)).equals(body)).toBe(true);
  });

  it('resolves a presigned download URL with an attachment disposition', async () => {
    const key = nextKey('download.txt');
    const body = Buffer.from('download-me');

    await service.putObject(key, body, 'text/plain');
    const url = await service.presignedDownloadUrl(key, 'download.txt', 3600);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="download.txt"',
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
  });
});
