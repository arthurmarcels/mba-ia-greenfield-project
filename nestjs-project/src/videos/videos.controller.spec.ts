import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { ChannelsService } from '../channels/channels.service';
import { ForbiddenResourceException } from '../common/exceptions/forbidden-resource.exception';
import { IllegalVideoStatusTransitionException } from '../common/exceptions/illegal-video-status-transition.exception';
import { UserHasNoChannelException } from '../common/exceptions/user-has-no-channel.exception';
import { VideoNotFoundException } from '../common/exceptions/video-not-found.exception';
import { VideoNotReadyException } from '../common/exceptions/video-not-ready.exception';
import { VideoStorageKeyMissingException } from '../common/exceptions/video-storage-key-missing.exception';
import { Video } from './entities/video.entity';
import { PART_SIZE_BYTES } from './storage/storage.constants';
import { StorageService } from './storage/storage.service';
import { VIDEO_DOWNLOAD_PRESIGN_EXPIRY_SECONDS } from './videos.constants';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

describe('VideosController', () => {
  let controller: VideosController;
  let videosService: Record<string, jest.Mock>;
  let storageService: Record<string, jest.Mock>;
  let channelsService: Record<string, jest.Mock>;

  const CALLER: JwtPayload = { sub: 'user-1', email: 'owner@example.com' };
  const CHANNEL_ID = 'channel-1';

  /** Minimal `Video`-shaped stub for service return values. */
  function makeVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      slug: 'abc123def456',
      channel_id: CHANNEL_ID,
      status: 'uploading',
      video_storage_key: `${CHANNEL_ID}/video-1/original.mp4`,
      multipart_upload_id: 'upload-1',
      ...overrides,
    } as Video;
  }

  beforeEach(async () => {
    videosService = {
      createDraft: jest.fn(),
      beginUpload: jest.fn(),
      completeUpload: jest.fn(),
      findById: jest.fn(),
      findBySlug: jest.fn(),
      assertVideoOwnership: jest.fn(),
    };
    storageService = {
      presignPartUrl: jest.fn(),
      getObjectSize: jest.fn(),
      getObjectRange: jest.fn(),
      presignedDownloadUrl: jest.fn(),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: CHANNEL_ID }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        { provide: VideosService, useValue: videosService },
        { provide: StorageService, useValue: storageService },
        { provide: ChannelsService, useValue: channelsService },
      ],
    }).compile();

    controller = moduleRef.get(VideosController);
  });

  describe('initiate', () => {
    it('creates a draft in the caller channel, begins the upload, returns the contract', async () => {
      const dto = {
        title: 'My Clip',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      };
      const draft = makeVideo({ status: 'draft' });
      videosService.createDraft.mockResolvedValue(draft);
      videosService.beginUpload.mockResolvedValue({ uploadId: 'upload-1' });

      const result = await controller.initiate(dto, CALLER);

      // channelId resolved from the JWT subject via the caller's channel
      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-1');
      expect(videosService.createDraft).toHaveBeenCalledWith(CHANNEL_ID, dto);
      // key derived as <channelId>/<videoId>/original.<ext>
      expect(videosService.beginUpload).toHaveBeenCalledWith(
        draft,
        `${CHANNEL_ID}/video-1/original.mp4`,
      );
      expect(result).toEqual({
        id: 'video-1',
        slug: 'abc123def456',
        status: 'uploading',
        uploadId: 'upload-1',
        key: `${CHANNEL_ID}/video-1/original.mp4`,
        partSize: PART_SIZE_BYTES,
      });
    });

    it('derives the storage key extension from the declared mime type', async () => {
      const dto = {
        title: 'Web',
        filename: 'clip.webm',
        mimeType: 'video/webm',
        sizeBytes: 10,
      };
      videosService.createDraft.mockResolvedValue(
        makeVideo({ id: 'vid-webm' }),
      );
      videosService.beginUpload.mockResolvedValue({ uploadId: 'u' });

      await controller.initiate(dto, CALLER);

      expect(videosService.beginUpload).toHaveBeenCalledWith(
        expect.anything(),
        `${CHANNEL_ID}/vid-webm/original.webm`,
      );
    });
  });

  describe('getUploadUrl', () => {
    it('presigns a PUT for the video key, uploadId and requested part number', async () => {
      const video = makeVideo();
      videosService.findById.mockResolvedValue(video);
      storageService.presignPartUrl.mockResolvedValue('https://presigned.put');

      const result = await controller.getUploadUrl(
        'video-1',
        { partNumber: 2 },
        CALLER,
      );

      expect(videosService.findById).toHaveBeenCalledWith('video-1');
      expect(videosService.assertVideoOwnership).toHaveBeenCalledWith(
        video,
        CHANNEL_ID,
      );
      expect(storageService.presignPartUrl).toHaveBeenCalledWith(
        `${CHANNEL_ID}/video-1/original.mp4`,
        'upload-1',
        2,
      );
      expect(result).toEqual({ url: 'https://presigned.put' });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      videosService.findById.mockResolvedValue(null);

      await expect(
        controller.getUploadUrl('nope', { partNumber: 1 }, CALLER),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videosService.assertVideoOwnership).not.toHaveBeenCalled();
    });

    it('propagates ForbiddenResourceException from the ownership check', async () => {
      videosService.findById.mockResolvedValue(makeVideo());
      videosService.assertVideoOwnership.mockImplementation(() => {
        throw new ForbiddenResourceException();
      });

      await expect(
        controller.getUploadUrl('video-1', { partNumber: 1 }, CALLER),
      ).rejects.toBeInstanceOf(ForbiddenResourceException);
      expect(storageService.presignPartUrl).not.toHaveBeenCalled();
    });

    it('throws IllegalVideoStatusTransitionException when the video has no active multipart upload', async () => {
      // out-of-order call: a video that is not actively uploading lacks the
      // key/uploadId pair → 409 instead of part-presigning.
      videosService.findById.mockResolvedValue(
        makeVideo({
          status: 'draft',
          video_storage_key: null,
          multipart_upload_id: null,
        }),
      );

      await expect(
        controller.getUploadUrl('video-1', { partNumber: 1 }, CALLER),
      ).rejects.toBeInstanceOf(IllegalVideoStatusTransitionException);
      expect(storageService.presignPartUrl).not.toHaveBeenCalled();
    });

    it('throws UserHasNoChannelException when the caller has no channel', async () => {
      // data inconsistency: registration creates the channel atomically with
      // the user, so absence is a server-side bug → 500.
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(
        controller.getUploadUrl('video-1', { partNumber: 1 }, CALLER),
      ).rejects.toBeInstanceOf(UserHasNoChannelException);
      expect(videosService.findById).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('finalizes the upload and maps the result to the processing contract', async () => {
      const video = makeVideo();
      videosService.findById.mockResolvedValue(video);
      const parts = [{ partNumber: 1, etag: 'etag-1' }];
      videosService.completeUpload.mockResolvedValue(
        makeVideo({ status: 'processing' }),
      );

      const result = await controller.complete('video-1', { parts }, CALLER);

      expect(videosService.assertVideoOwnership).toHaveBeenCalledWith(
        video,
        CHANNEL_ID,
      );
      expect(videosService.completeUpload).toHaveBeenCalledWith(
        'video-1',
        parts,
      );
      expect(result).toEqual({
        id: 'video-1',
        slug: 'abc123def456',
        status: 'processing',
      });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      videosService.findById.mockResolvedValue(null);

      await expect(
        controller.complete(
          'nope',
          { parts: [{ partNumber: 1, etag: 'e' }] },
          CALLER,
        ),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('download', () => {
    it('returns a presigned attachment URL for a ready video', async () => {
      const video = makeVideo({ status: 'ready', mime_type: 'video/mp4' });
      videosService.findBySlug.mockResolvedValue(video);
      storageService.presignedDownloadUrl.mockResolvedValue('https://dl');

      const result = await controller.download('abc123def456');

      expect(videosService.findBySlug).toHaveBeenCalledWith('abc123def456');
      // filename derived as <slug>.<ext> from the declared mime type
      expect(storageService.presignedDownloadUrl).toHaveBeenCalledWith(
        `${CHANNEL_ID}/video-1/original.mp4`,
        'abc123def456.mp4',
        VIDEO_DOWNLOAD_PRESIGN_EXPIRY_SECONDS,
      );
      expect(result).toEqual({ url: 'https://dl' });
    });

    it('throws VideoNotFoundException for an unknown slug', async () => {
      videosService.findBySlug.mockResolvedValue(null);

      await expect(controller.download('nope')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      expect(storageService.presignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws VideoNotReadyException for a non-ready video', async () => {
      videosService.findBySlug.mockResolvedValue(
        makeVideo({ status: 'processing' }),
      );

      await expect(controller.download('abc123def456')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
      expect(storageService.presignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('throws VideoStorageKeyMissingException when a ready video has a null storage key', async () => {
      // invariant violation: a ready video must carry its key; null → 500,
      // never a blind cast handed to storage.
      videosService.findBySlug.mockResolvedValue(
        makeVideo({ status: 'ready', video_storage_key: null }),
      );

      await expect(controller.download('abc123def456')).rejects.toBeInstanceOf(
        VideoStorageKeyMissingException,
      );
      expect(storageService.presignedDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('stream', () => {
    // The 404/409 guards throw before the Response is touched, so a stub is
    // enough here; the 206/200 streaming paths are exercised end-to-end (real
    // pipe + real MinIO) and the byte-range math by parseHttpRange's unit suite.
    const res = {} as Response;

    it('throws VideoNotFoundException for an unknown slug', async () => {
      videosService.findBySlug.mockResolvedValue(null);

      await expect(
        controller.stream('nope', undefined, res),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storageService.getObjectSize).not.toHaveBeenCalled();
    });

    it('throws VideoNotReadyException for a non-ready video', async () => {
      videosService.findBySlug.mockResolvedValue(
        makeVideo({ status: 'draft' }),
      );

      await expect(
        controller.stream('abc123def456', undefined, res),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storageService.getObjectSize).not.toHaveBeenCalled();
    });

    it('throws VideoStorageKeyMissingException when a ready video has a null storage key', async () => {
      // invariant violation: a ready video must carry its key; null → 500,
      // never a blind cast handed to storage.
      videosService.findBySlug.mockResolvedValue(
        makeVideo({ status: 'ready', video_storage_key: null }),
      );

      await expect(
        controller.stream('abc123def456', undefined, res),
      ).rejects.toBeInstanceOf(VideoStorageKeyMissingException);
      expect(storageService.getObjectSize).not.toHaveBeenCalled();
    });
  });
});
