import type { ConfigType } from '@nestjs/config';
import { Client } from 'minio';
import { Readable } from 'stream';
import storageConfig from '../../config/storage.config';
import { StorageService } from './storage.service';

jest.mock('minio');

const STORAGE_CONFIG = {
  endpoint: 'minio',
  port: 9000,
  useSsl: false,
  accessKey: 'access',
  secretKey: 'secret',
  bucket: 'unit-bucket',
  publicBaseUrl: undefined,
} as ConfigType<typeof storageConfig>;

/**
 * Typed view of the auto-mocked minio client: one `jest.Mock` per method the
 * service calls, with the exact param tuple asserted in each test. Keeps the
 * unit test free of `any` (the eslint config treats `no-unsafe-*` as errors).
 */
type MinioClientStub = {
  bucketExists: jest.Mock<Promise<boolean>, [string]>;
  makeBucket: jest.Mock<Promise<void>, [string]>;
  initiateNewMultipartUpload: jest.Mock<
    Promise<string>,
    [string, string, object]
  >;
  presignedUrl: jest.Mock<
    Promise<string>,
    [string, string, string, number, Record<string, string>]
  >;
  completeMultipartUpload: jest.Mock<
    Promise<{ etag: string; versionId: string | null }>,
    [string, string, string, { part: number; etag?: string }[]]
  >;
  statObject: jest.Mock<Promise<{ size: number }>, [string, string]>;
  getPartialObject: jest.Mock<
    Promise<Readable>,
    [string, string, number, number]
  >;
  getObject: jest.Mock<Promise<Readable>, [string, string]>;
  presignedGetObject: jest.Mock<
    Promise<string>,
    [string, string, number, Record<string, string>]
  >;
  putObject: jest.Mock<
    Promise<unknown>,
    [string, string, Buffer, number, Record<string, string>]
  >;
  removeObject: jest.Mock<Promise<void>, [string]>;
};

describe('StorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeService(): { service: StorageService; client: MinioClientStub } {
    const service = new StorageService(STORAGE_CONFIG);
    const MockedClient = Client as unknown as jest.Mock;
    const instance: unknown =
      MockedClient.mock.instances[MockedClient.mock.instances.length - 1];
    return { service, client: instance as MinioClientStub };
  }

  it('constructs the minio client mapping the config useSsl flag to useSSL', () => {
    const MockedClient = Client as unknown as jest.Mock;
    MockedClient.mockClear();
    new StorageService(STORAGE_CONFIG);

    expect(MockedClient).toHaveBeenCalledWith({
      endPoint: 'minio',
      port: 9000,
      useSSL: false,
      accessKey: 'access',
      secretKey: 'secret',
    });
  });

  describe('onModuleInit', () => {
    it('creates the bucket when it does not exist', async () => {
      const { service, client } = makeService();
      client.bucketExists.mockResolvedValue(false);

      await service.onModuleInit();

      expect(client.bucketExists).toHaveBeenCalledWith('unit-bucket');
      expect(client.makeBucket).toHaveBeenCalledWith('unit-bucket');
    });

    it('is a no-op when the bucket already exists', async () => {
      const { service, client } = makeService();
      client.bucketExists.mockResolvedValue(true);

      await service.onModuleInit();

      expect(client.bucketExists).toHaveBeenCalledWith('unit-bucket');
      expect(client.makeBucket).not.toHaveBeenCalled();
    });
  });

  it('initiateMultipartUpload returns the server-side uploadId', async () => {
    const { service, client } = makeService();
    client.initiateNewMultipartUpload.mockResolvedValue('upload-123');

    const result = await service.initiateMultipartUpload('channel/key');

    expect(result).toEqual({ uploadId: 'upload-123' });
    expect(client.initiateNewMultipartUpload).toHaveBeenCalledWith(
      'unit-bucket',
      'channel/key',
      {},
    );
  });

  it('presignPartUrl builds a presigned PUT with partNumber and uploadId', async () => {
    const { service, client } = makeService();
    client.presignedUrl.mockResolvedValue('https://signed/part');

    const url = await service.presignPartUrl(
      'channel/key',
      'upload-123',
      2,
      3600,
    );

    expect(url).toBe('https://signed/part');
    expect(client.presignedUrl).toHaveBeenCalledWith(
      'PUT',
      'unit-bucket',
      'channel/key',
      3600,
      { partNumber: '2', uploadId: 'upload-123' },
    );
  });

  it('completeMultipartUpload maps partNumber to the minio part field', async () => {
    const { service, client } = makeService();
    client.completeMultipartUpload.mockResolvedValue({
      etag: 'obj-etag',
      versionId: null,
    });

    await service.completeMultipartUpload('channel/key', 'upload-123', [
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: 'etag-2' },
    ]);

    expect(client.completeMultipartUpload).toHaveBeenCalledWith(
      'unit-bucket',
      'channel/key',
      'upload-123',
      [
        { part: 1, etag: 'etag-1' },
        { part: 2, etag: 'etag-2' },
      ],
    );
  });

  describe('getObjectRange', () => {
    it('derives content-range/length from statObject and reads via getPartialObject', async () => {
      const { service, client } = makeService();
      client.statObject.mockResolvedValue({ size: 100 });
      const fakeStream = new Readable();
      client.getPartialObject.mockResolvedValue(fakeStream);

      const result = await service.getObjectRange('channel/key', {
        start: 10,
        end: 19,
      });

      expect(client.statObject).toHaveBeenCalledWith(
        'unit-bucket',
        'channel/key',
      );
      expect(client.getPartialObject).toHaveBeenCalledWith(
        'unit-bucket',
        'channel/key',
        10,
        10,
      );
      expect(result).toEqual({
        stream: fakeStream,
        contentLength: 10,
        contentRange: 'bytes 10-19/100',
        totalSize: 100,
      });
    });

    it('reads the whole object with no range and omits contentRange', async () => {
      const { service, client } = makeService();
      client.statObject.mockResolvedValue({ size: 100 });
      const fakeStream = new Readable();
      client.getObject.mockResolvedValue(fakeStream);

      const result = await service.getObjectRange('channel/key');

      expect(client.getObject).toHaveBeenCalledWith(
        'unit-bucket',
        'channel/key',
      );
      expect(client.getPartialObject).not.toHaveBeenCalled();
      expect(result).toEqual({
        stream: fakeStream,
        contentLength: 100,
        contentRange: null,
        totalSize: 100,
      });
    });
  });

  it('presignedDownloadUrl forces an attachment content-disposition', async () => {
    const { service, client } = makeService();
    client.presignedGetObject.mockResolvedValue('https://signed/download');

    const url = await service.presignedDownloadUrl(
      'channel/key',
      'video.mp4',
      3600,
    );

    expect(url).toBe('https://signed/download');
    expect(client.presignedGetObject).toHaveBeenCalledWith(
      'unit-bucket',
      'channel/key',
      3600,
      { 'response-content-disposition': 'attachment; filename="video.mp4"' },
    );
  });

  it('putObject stores the buffer with its content-type', async () => {
    const { service, client } = makeService();
    client.putObject.mockResolvedValue({ etag: 'put-etag' });
    const buffer = Buffer.from('thumbnail-bytes');

    await service.putObject('channel/thumb.jpg', buffer, 'image/jpeg');

    expect(client.putObject).toHaveBeenCalledWith(
      'unit-bucket',
      'channel/thumb.jpg',
      buffer,
      buffer.length,
      { 'Content-Type': 'image/jpeg' },
    );
  });

  it('removeObject deletes the object', async () => {
    const { service, client } = makeService();
    client.removeObject.mockResolvedValue(undefined);

    await service.removeObject('channel/key');

    expect(client.removeObject).toHaveBeenCalledWith(
      'unit-bucket',
      'channel/key',
    );
  });
});
