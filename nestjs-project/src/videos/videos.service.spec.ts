import { QueryFailedError } from 'typeorm';
import { ForbiddenResourceException } from '../common/exceptions/forbidden-resource.exception';
import { IllegalVideoStatusTransitionException } from '../common/exceptions/illegal-video-status-transition.exception';
import { PROCESS_VIDEO_JOB } from '../queue/queue.constants';
import { InitiateUploadDto } from './dtos/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { VIDEO_SLUG_LENGTH, VIDEO_STATUS } from './videos.constants';
import { VideosService } from './videos.service';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-id',
    slug: 'initialslug',
    title: 'title',
    description: null,
    channel_id: 'channel-id',
    status: VIDEO_STATUS.DRAFT,
    duration_seconds: null,
    metadata: null,
    video_storage_key: null,
    thumbnail_storage_key: null,
    multipart_upload_id: null,
    file_size_bytes: null,
    mime_type: null,
    error_message: null,
    ...overrides,
  });
}

function makeUniqueError(): QueryFailedError {
  const driverError = new Error('duplicate key');
  (driverError as { code?: string }).code = '23505';
  return new QueryFailedError('INSERT INTO "videos" ...', [], driverError);
}

function makeDto(
  overrides: Partial<InitiateUploadDto> = {},
): InitiateUploadDto {
  return Object.assign(new InitiateUploadDto(), {
    title: 'My Video',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    ...overrides,
  });
}

/** `create` echoes its argument so the generated slug is observable per attempt. */
function makeRepo() {
  return {
    create: jest.fn((dto: Partial<Video>) => Object.assign(new Video(), dto)),
    save: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
  };
}

describe('VideosService', () => {
  const storage = {
    initiateMultipartUpload: jest.fn(),
    completeMultipartUpload: jest.fn(),
  };
  const queue = { add: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    storage.initiateMultipartUpload.mockResolvedValue({
      uploadId: 'upload-id',
    });
    storage.completeMultipartUpload.mockResolvedValue(undefined);
    queue.add.mockResolvedValue({ id: 'job-id' });
  });

  function build(repo = makeRepo()) {
    return {
      repo,
      service: new VideosService(
        repo as never,
        storage as never,
        queue as never,
      ),
    };
  }

  describe('createDraft', () => {
    it('generates a URL-safe slug of the configured length and persists a draft', async () => {
      const { service, repo } = build();
      repo.save.mockResolvedValueOnce(makeVideo());

      await service.createDraft('channel-id', makeDto());

      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalledTimes(1);
      const created = repo.create.mock.calls[0][0] as Video;
      expect(created.slug).toHaveLength(VIDEO_SLUG_LENGTH);
      expect(created.status).toBe(VIDEO_STATUS.DRAFT);
      expect(created.file_size_bytes).toBe('1024');
      expect(created.mime_type).toBe('video/mp4');
      expect(created.channel_id).toBe('channel-id');
    });

    it('regenerates the slug on a unique-constraint violation and succeeds', async () => {
      const { service, repo } = build();
      repo.save
        .mockRejectedValueOnce(makeUniqueError())
        .mockResolvedValueOnce(makeVideo({ slug: 'secondattempt' }));

      const video = await service.createDraft('channel-id', makeDto());

      expect(repo.save).toHaveBeenCalledTimes(2);
      expect(repo.create).toHaveBeenCalledTimes(2);
      const slugs = repo.create.mock.calls.map((c) => (c[0] as Video).slug);
      expect(slugs).toHaveLength(2);
      expect(slugs[0]).not.toBe(slugs[1]);
      expect(slugs[0]).toHaveLength(VIDEO_SLUG_LENGTH);
      expect(slugs[1]).toHaveLength(VIDEO_SLUG_LENGTH);
      expect(video.slug).toBe('secondattempt');
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const { service, repo } = build();
      repo.save.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(
        service.createDraft('channel-id', makeDto()),
      ).rejects.toThrow('Connection lost');
      expect(repo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('beginUpload', () => {
    it('transitions draft → uploading, initiates the multipart upload, and persists', async () => {
      const { service, repo } = build();
      const video = makeVideo({ status: VIDEO_STATUS.DRAFT });
      repo.save.mockResolvedValue(video);

      const result = await service.beginUpload(
        video,
        'chan/video/original.mp4',
      );

      expect(storage.initiateMultipartUpload).toHaveBeenCalledWith(
        'chan/video/original.mp4',
      );
      expect(result).toEqual({ uploadId: 'upload-id' });
      expect(video.status).toBe(VIDEO_STATUS.UPLOADING);
      expect(video.multipart_upload_id).toBe('upload-id');
      expect(video.video_storage_key).toBe('chan/video/original.mp4');
      expect(repo.save).toHaveBeenCalledWith(video);
    });

    it('rejects an illegal transition (e.g. processing → uploading)', async () => {
      const { service } = build();
      const video = makeVideo({ status: VIDEO_STATUS.PROCESSING });

      await expect(
        service.beginUpload(video, 'chan/video/original.mp4'),
      ).rejects.toBeInstanceOf(IllegalVideoStatusTransitionException);
      expect(storage.initiateMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, etag: 'etag-1' }];

    it('completes the multipart upload, transitions to processing, and enqueues one job', async () => {
      const { service, repo } = build();
      const video = makeVideo({
        status: VIDEO_STATUS.UPLOADING,
        video_storage_key: 'chan/video/original.mp4',
        multipart_upload_id: 'upload-id',
      });
      repo.findOneBy.mockResolvedValueOnce(video);
      repo.save.mockResolvedValue(video);

      const result = await service.completeUpload('video-id', parts);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'chan/video/original.mp4',
        'upload-id',
        parts,
      );
      expect(result.status).toBe(VIDEO_STATUS.PROCESSING);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        PROCESS_VIDEO_JOB,
        { videoId: 'video-id' },
        { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
      );
    });

    it('rejects completing a non-uploading video', async () => {
      const { service, repo } = build();
      repo.findOneBy.mockResolvedValueOnce(
        makeVideo({ status: VIDEO_STATUS.DRAFT }),
      );

      await expect(
        service.completeUpload('video-id', parts),
      ).rejects.toBeInstanceOf(IllegalVideoStatusTransitionException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('markReady', () => {
    it('transitions processing → ready and stores the processing result', async () => {
      const { service, repo } = build();
      const video = makeVideo({ status: VIDEO_STATUS.PROCESSING });
      repo.findOneBy.mockResolvedValueOnce(video);
      repo.save.mockResolvedValue(video);
      const metadata = { codec: 'h264', width: 1280 };

      const result = await service.markReady('video-id', {
        duration: 42,
        metadata,
        thumbnailKey: 'chan/video/thumbnail.jpg',
      });

      expect(result.status).toBe(VIDEO_STATUS.READY);
      expect(result.duration_seconds).toBe(42);
      expect(result.metadata).toEqual(metadata);
      expect(result.thumbnail_storage_key).toBe('chan/video/thumbnail.jpg');
    });

    it('rejects transitioning from a non-processing status', async () => {
      const { service, repo } = build();
      repo.findOneBy.mockResolvedValueOnce(
        makeVideo({ status: VIDEO_STATUS.DRAFT }),
      );

      await expect(
        service.markReady('video-id', {
          duration: 1,
          metadata: {},
          thumbnailKey: 'k',
        }),
      ).rejects.toBeInstanceOf(IllegalVideoStatusTransitionException);
    });
  });

  describe('markError', () => {
    it('transitions processing → error and stores the message', async () => {
      const { service, repo } = build();
      const video = makeVideo({ status: VIDEO_STATUS.PROCESSING });
      repo.findOneBy.mockResolvedValueOnce(video);
      repo.save.mockResolvedValue(video);

      const result = await service.markError('video-id', 'ffprobe failed');

      expect(result.status).toBe(VIDEO_STATUS.ERROR);
      expect(result.error_message).toBe('ffprobe failed');
    });

    it('rejects transitioning out of a terminal status', async () => {
      const { service, repo } = build();
      repo.findOneBy.mockResolvedValueOnce(
        makeVideo({ status: VIDEO_STATUS.READY }),
      );

      await expect(
        service.markError('video-id', 'nope'),
      ).rejects.toBeInstanceOf(IllegalVideoStatusTransitionException);
    });
  });

  describe('assertVideoOwnership', () => {
    it('throws ForbiddenResourceException on a channel mismatch', () => {
      const { service } = build();
      const video = makeVideo({ channel_id: 'channel-a' });

      expect(() => service.assertVideoOwnership(video, 'channel-b')).toThrow(
        ForbiddenResourceException,
      );
    });

    it('passes when the channel matches', () => {
      const { service } = build();
      const video = makeVideo({ channel_id: 'channel-a' });

      expect(() =>
        service.assertVideoOwnership(video, 'channel-a'),
      ).not.toThrow();
    });
  });
});
