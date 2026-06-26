import { Test } from '@nestjs/testing';
import type { JwtPayload } from '../auth/auth.types';
import { ChannelsService } from '../channels/channels.service';
import { ForbiddenResourceException } from '../common/exceptions/forbidden-resource.exception';
import { VideoNotFoundException } from '../common/exceptions/video-not-found.exception';
import { Video } from './entities/video.entity';
import { PART_SIZE_BYTES } from './storage/storage.constants';
import { StorageService } from './storage/storage.service';
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
      assertVideoOwnership: jest.fn(),
    };
    storageService = { presignPartUrl: jest.fn() };
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
});
