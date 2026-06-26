import { Readable } from 'node:stream';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { Video } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { VIDEO_STATUS } from '../videos.constants';
import { VideosService } from '../videos.service';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * `fluent-ffmpeg` is mocked entirely: this suite exercises the processor's
 * orchestration/control-flow (download → probe → thumbnail → markReady), its
 * recoverable-vs-unrecoverable error classification, the idempotency guard, and
 * the `@OnWorkerEvent('failed')` terminal guard — without invoking the real
 * ffmpeg binary. The screenshots stub mimics the library's file-writing side
 * effect (writing a placeholder JPEG into the requested folder) so the
 * processor's real `fs.readFile` of the thumbnail succeeds; ffprobe is driven by
 * a module-level state object the test toggles per case.
 */
jest.mock('fluent-ffmpeg', () => {
  // `require` of node built-ins is the conventional way to reach them inside a
  // hoisted `jest.mock` factory (top-level ESM imports are out of scope there).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');

  const state = {
    ffprobeError: null as Error | null,
    screenshotsError: null as Error | null,
    ffprobeData: null as unknown,
  };

  function defaultProbeData(): unknown {
    return {
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          bit_rate: '867211',
        },
      ],
      format: { duration: '12.5', bit_rate: '867211' },
    };
  }

  interface CommandMock {
    on: jest.Mock;
    screenshots: jest.Mock;
  }

  function createCommand(): CommandMock {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const command: CommandMock = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        handlers[event] = cb;
        return command;
      }),
      screenshots: jest.fn(
        (options: { folder?: string; filename?: string }) => {
          // Fire on the next microtask so the processor's awaiting promise has
          // registered its `end`/`error` listeners first (mirrors the real lib).
          void Promise.resolve().then(() => {
            if (state.screenshotsError) {
              handlers.error?.(state.screenshotsError);
              return;
            }
            if (options.folder && options.filename) {
              fs.writeFileSync(
                path.join(options.folder, options.filename),
                Buffer.from('fake-thumbnail-jpeg'),
              );
            }
            handlers.end?.();
          });
          return command;
        },
      ),
    };
    return command;
  }

  const ffmpeg = jest.fn((): CommandMock => createCommand()) as unknown as {
    (): CommandMock;
    ffprobe: jest.Mock;
    __setState: (next: Partial<typeof state>) => void;
  };
  ffmpeg.ffprobe = jest.fn(
    (_file: string, cb: (err: Error | null, data: unknown) => void) => {
      void Promise.resolve().then(() => {
        if (state.ffprobeError) {
          cb(state.ffprobeError, {} as unknown);
          return;
        }
        cb(null, state.ffprobeData ?? defaultProbeData());
      });
    },
  );
  ffmpeg.__setState = (next) => Object.assign(state, next);

  return { __esModule: true, default: ffmpeg };
});

const mockedFfmpeg = ffmpeg as unknown as {
  ffprobe: jest.Mock;
  __setState: (next: {
    ffprobeError?: Error | null;
    screenshotsError?: Error | null;
    ffprobeData?: unknown;
  }) => void;
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-id',
    channel_id: 'channel-id',
    status: VIDEO_STATUS.PROCESSING,
    video_storage_key: 'channel-id/video-id/original.mp4',
    mime_type: 'video/mp4',
    duration_seconds: null,
    metadata: null,
    thumbnail_storage_key: null,
    ...overrides,
  });
}

function makeJob(
  overrides: Partial<Job<{ videoId: string }>> = {},
): Job<{ videoId: string }> {
  return {
    id: 'job-1',
    data: { videoId: 'video-id' },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<{ videoId: string }>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videosService: {
    findById: jest.Mock;
    markReady: jest.Mock;
    markError: jest.Mock;
  };
  let storage: { getObjectRange: jest.Mock; putObject: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedFfmpeg.__setState({
      ffprobeError: null,
      screenshotsError: null,
      ffprobeData: null,
    });
    videosService = {
      findById: jest.fn(),
      markReady: jest
        .fn()
        .mockResolvedValue(makeVideo({ status: VIDEO_STATUS.READY })),
      markError: jest
        .fn()
        .mockResolvedValue(makeVideo({ status: VIDEO_STATUS.ERROR })),
    };
    storage = {
      getObjectRange: jest.fn().mockResolvedValue({
        stream: Readable.from([Buffer.from('original-bytes')]),
        contentLength: 14,
        contentRange: null,
        totalSize: 14,
      }),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessingProcessor(
      videosService as unknown as VideosService,
      storage as unknown as StorageService,
    );
  });

  describe('process', () => {
    it('probes, captures + uploads the thumbnail, and marks the video ready', async () => {
      videosService.findById.mockResolvedValue(makeVideo());

      await processor.process(makeJob());

      expect(mockedFfmpeg.ffprobe).toHaveBeenCalledTimes(1);
      expect(storage.getObjectRange).toHaveBeenCalledWith(
        'channel-id/video-id/original.mp4',
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        'channel-id/video-id/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(videosService.markReady).toHaveBeenCalledWith('video-id', {
        duration: 12.5,
        metadata: {
          codec: 'h264',
          width: 1280,
          height: 720,
          bitrate: '867211',
        },
        thumbnailKey: 'channel-id/video-id/thumbnail.jpg',
      });
    });

    it('skips reprocessing when the video is already ready (idempotent retry)', async () => {
      videosService.findById.mockResolvedValue(
        makeVideo({ status: VIDEO_STATUS.READY }),
      );

      await processor.process(makeJob());

      expect(mockedFfmpeg.ffprobe).not.toHaveBeenCalled();
      expect(storage.getObjectRange).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(videosService.markReady).not.toHaveBeenCalled();
    });

    it('fails terminally when the video does not exist', async () => {
      videosService.findById.mockResolvedValue(null);

      await expect(processor.process(makeJob())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(videosService.markReady).not.toHaveBeenCalled();
    });

    it('classifies a corrupt-file ffprobe failure as unrecoverable (no retry)', async () => {
      videosService.findById.mockResolvedValue(makeVideo());
      mockedFfmpeg.__setState({
        ffprobeError: new Error('Invalid data found when processing input'),
      });

      const error = await processor.process(makeJob()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(videosService.markReady).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('classifies a transient storage failure as retryable (plain Error)', async () => {
      videosService.findById.mockResolvedValue(makeVideo());
      storage.getObjectRange.mockRejectedValue(
        new Error('connect ECONNREFUSED 10.0.0.1:9000'),
      );

      const error = await processor.process(makeJob()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toContain('ECONNREFUSED');
    });

    it('classifies a thumbnail-capture (ffmpeg encode) failure as retryable', async () => {
      videosService.findById.mockResolvedValue(makeVideo());
      mockedFfmpeg.__setState({
        screenshotsError: new Error('transient encode write error'),
      });

      const error = await processor.process(makeJob()).catch((e: unknown) => e);

      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(videosService.markReady).not.toHaveBeenCalled();
    });
  });

  describe('onFailed (worker failed event)', () => {
    it('marks the video error when retries are exhausted', async () => {
      const job = makeJob({ attemptsMade: 3 }); // attempts: 3 → exhausted

      await processor.onFailed(job, new Error('boom'));

      expect(videosService.markError).toHaveBeenCalledWith('video-id', 'boom');
    });

    it('marks the video error immediately on an unrecoverable failure, even with retries left', async () => {
      const job = makeJob({ attemptsMade: 1 }); // not exhausted

      await processor.onFailed(job, new UnrecoverableError('Invalid data'));

      expect(videosService.markError).toHaveBeenCalledWith(
        'video-id',
        'Invalid data',
      );
    });

    it('does NOT mark error on a transient failure with retries remaining', async () => {
      const job = makeJob({ attemptsMade: 1 }); // attempts: 3, plain Error

      await processor.onFailed(job, new Error('connect ECONNREFUSED'));

      expect(videosService.markError).not.toHaveBeenCalled();
    });

    it('swallows a markError failure without rethrowing (event handler must not crash the worker)', async () => {
      const job = makeJob({ attemptsMade: 3 });
      videosService.markError.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(job, new Error('boom')),
      ).resolves.toBeUndefined();
    });
  });
});
