import { Injectable, Logger, BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { AudioService } from './audio.service';

const execFileAsync = promisify(execFile);

export const MEDIA_LIMITS = {
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 20 * 1024 * 1024,
} as const;

export const ALLOWED_MIMES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav'],
  document: ['application/pdf'],
} as const;

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface ProcessedMediaThumb {
  buffer: Buffer;
  path_suffix: string;
  mimetype: string;
}

export interface ProcessedMedia {
  kind: MediaKind;
  buffer: Buffer;
  mimetype: string;
  size_bytes: number;
  width?: number;
  height?: number;
  duration_seconds?: number;
  thumbnail?: ProcessedMediaThumb;
  poster?: ProcessedMediaThumb;
}

@Injectable()
export class MediaPipelineService {
  private readonly logger = new Logger(MediaPipelineService.name);
  private readonly videoTmpDir = path.join(process.env['TMP_VIDEO_DIR'] ?? '/tmp/video');

  constructor(private readonly audio: AudioService) {}

  async detectAndValidate(input: Buffer, claimedMime?: string): Promise<{ kind: MediaKind; realMime: string }> {
    // file-type v22 is ESM — dynamic import to keep CJS tsc happy.
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(input);
    let realMime = detected?.mime;
    if (!realMime) {
      // PDF fallback: magic bytes %PDF
      if (claimedMime === 'application/pdf' && input.length >= 4 && input.subarray(0, 4).toString('ascii') === '%PDF') {
        realMime = 'application/pdf';
      } else {
        throw new BadRequestException('Unable to detect file type');
      }
    }
    let kind: MediaKind | undefined;
    for (const [k, list] of Object.entries(ALLOWED_MIMES) as Array<[MediaKind, readonly string[]]>) {
      if ((list as readonly string[]).includes(realMime)) { kind = k; break; }
    }
    if (!kind) throw new BadRequestException(`Unsupported media type: ${realMime}`);
    if (input.length > MEDIA_LIMITS[kind]) {
      throw new PayloadTooLargeException(`Media exceeds ${kind} limit of ${MEDIA_LIMITS[kind]} bytes`);
    }
    return { kind, realMime };
  }

  async processImage(buffer: Buffer): Promise<{
    buffer: Buffer;
    mimetype: string;
    size_bytes: number;
    width: number | undefined;
    height: number | undefined;
    thumbnail: ProcessedMediaThumb;
  }> {
    // limitInputPixels: 24MP — protects against decompression-bomb attacks (~4k*6k image).
    const pipeline = sharp(buffer, { failOn: 'truncated', limitInputPixels: 24_000_000 }).rotate(); // auto-orient + strips EXIF by default
    const meta = await pipeline.metadata();
    const webp = await pipeline.clone().webp({ quality: 82 }).toBuffer();
    // Reuse same decoded pipeline for the thumbnail (M1) — avoids a second full decode.
    const thumb = await pipeline
      .clone()
      .resize(320, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return {
      buffer: webp,
      mimetype: 'image/webp',
      size_bytes: webp.length,
      width: meta.width,
      height: meta.height,
      thumbnail: { buffer: thumb, path_suffix: '.thumb.jpg', mimetype: 'image/jpeg' } satisfies ProcessedMediaThumb,
    };
  }

  async processVideo(buffer: Buffer, inputMime: string): Promise<{
    buffer: Buffer;
    mimetype: string;
    size_bytes: number;
    width: number | undefined;
    height: number | undefined;
    duration_seconds: number | undefined;
    poster: ProcessedMediaThumb;
  }> {
    await fs.promises.mkdir(this.videoTmpDir, { recursive: true });
    const ext = inputMime === 'video/webm' ? 'webm'
      : inputMime === 'video/quicktime' ? 'mov'
      : 'mp4';
    const id = crypto.randomUUID();
    const inputPath = path.join(this.videoTmpDir, `${id}.${ext}`);
    const posterPath = path.join(this.videoTmpDir, `${id}.poster.jpg`);
    await fs.promises.writeFile(inputPath, buffer);
    try {
      const ffmpeg = process.env['FFMPEG_PATH'] ?? 'ffmpeg';
      const ffprobe = process.env['FFPROBE_PATH'] ?? 'ffprobe';
      // Extract poster frame at 1s (fallback to 0 if video shorter).
      await execFileAsync(ffmpeg, ['-ss', '00:00:01', '-i', inputPath, '-vframes', '1', '-f', 'image2', '-y', posterPath]).catch(async () => {
        await execFileAsync(ffmpeg, ['-i', inputPath, '-vframes', '1', '-f', 'image2', '-y', posterPath]);
      });
      const { stdout } = await execFileAsync(ffprobe, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json',
        inputPath,
      ]);
      const parsed: { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } } = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
      const width = parsed.streams?.[0]?.width;
      const height = parsed.streams?.[0]?.height;
      const duration = parsed.format?.duration ? Math.round(parseFloat(parsed.format.duration)) : undefined;
      const posterBuf = await fs.promises.readFile(posterPath);
      return {
        buffer,
        mimetype: inputMime,
        size_bytes: buffer.length,
        width,
        height,
        duration_seconds: duration,
        poster: { buffer: posterBuf, path_suffix: '.poster.jpg', mimetype: 'image/jpeg' } satisfies ProcessedMediaThumb,
      };
    } finally {
      await fs.promises.unlink(inputPath).catch(() => undefined);
      await fs.promises.unlink(posterPath).catch(() => undefined);
    }
  }

  async processAudio(buffer: Buffer, inputMime: string): Promise<{
    buffer: Buffer;
    mimetype: string;
    size_bytes: number;
    duration_seconds: number | undefined;
  }> {
    const opus = await this.audio.convertToOpus(buffer, inputMime);
    const duration = await this.audio.probeDurationSeconds(opus, 'audio/ogg');
    return {
      buffer: opus,
      mimetype: 'audio/ogg',
      size_bytes: opus.length,
      duration_seconds: duration,
    };
  }

  async processDocument(buffer: Buffer): Promise<{
    buffer: Buffer;
    mimetype: string;
    size_bytes: number;
  }> {
    return {
      buffer,
      mimetype: 'application/pdf',
      size_bytes: buffer.length,
    };
  }

  async processMultipart(input: Buffer, claimedMime: string): Promise<ProcessedMedia> {
    const { kind, realMime } = await this.detectAndValidate(input, claimedMime);
    if (kind === 'image') {
      const result = await this.processImage(input);
      return { kind, ...result };
    }
    if (kind === 'video') {
      const result = await this.processVideo(input, realMime);
      return { kind, ...result };
    }
    if (kind === 'audio') {
      const result = await this.processAudio(input, realMime);
      return { kind, ...result };
    }
    const result = await this.processDocument(input);
    return { kind, ...result };
  }
}
