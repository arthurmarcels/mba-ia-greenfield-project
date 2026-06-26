/**
 * Local ambient declarations for `fluent-ffmpeg@^2` (SI-03.7). The package ships
 * only CommonJS source and no bundled typings, and `@types/fluent-ffmpeg` is not
 * installed. This declares only the surface the video-processing processor
 * touches: the `ffprobe` metadata read and the `screenshots` thumbnail capture.
 *
 * Modeled as a CommonJS `module.exports = ffmpeg` (function + static methods)
 * so the default import `import ffmpeg from 'fluent-ffmpeg'` (esModuleInterop)
 * resolves to the command factory with `ffmpeg.ffprobe` available.
 */
declare module 'fluent-ffmpeg' {
  export interface FfprobeStream {
    index?: number;
    codec_type?: string;
    codec_name?: string;
    codec_long_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    bit_rate?: string;
    nb_frames?: string;
    [key: string]: unknown;
  }

  export interface FfprobeFormat {
    filename?: string;
    nb_streams?: number;
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    size?: string;
    [key: string]: unknown;
  }

  export interface FfprobeData {
    streams: FfprobeStream[];
    format: FfprobeFormat;
  }

  export interface ScreenshotsOptions {
    /** Where to take screenshots. Overrides `count` when present. */
    timestamps?: Array<number | string>;
    timemarks?: Array<number | string>;
    count?: number;
    /** Output directory; defaults to cwd. */
    folder?: string;
    /** Output filename pattern; defaults to `tn.png`. */
    filename?: string;
    /** Target resolution, e.g. `1280x720`. Do NOT chain `.size()`. */
    size?: string;
    fastSeek?: boolean;
  }

  export interface FfmpegCommand {
    on(event: 'filenames', listener: (filenames: string[]) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    screenshots(options: ScreenshotsOptions, folder?: string): this;
  }

  /** The default export: a command factory that also carries `ffprobe`. */
  type Ffmpeg = ((source: string) => FfmpegCommand) & {
    ffprobe(
      file: string,
      callback: (err: Error | null, data: FfprobeData) => void,
    ): void;
  };

  const ffmpeg: Ffmpeg;
  export default ffmpeg;
}
