import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);
  private readonly tmpDir = '/tmp/audio';

  async convertToOpus(inputBuffer: Buffer, inputMime: string): Promise<Buffer> {
    const ext = this.mimeToExt(inputMime);
    const id = crypto.randomUUID();
    const inputPath = path.join(this.tmpDir, `${id}.${ext}`);
    const outputPath = path.join(this.tmpDir, `${id}.ogg`);

    try {
      await fs.promises.mkdir(this.tmpDir, { recursive: true });
      await fs.promises.writeFile(inputPath, inputBuffer);

      await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
        '-i', inputPath,
        '-vn',
        '-map_metadata', '-1',
        '-c:a', 'libopus',
        '-b:a', '24k',          // PTT: 24k (was 32k)
        '-ar', '16000',         // PTT: 16kHz narrowband (was 48kHz)
        '-ac', '1',
        '-application', 'voip',
        '-vbr', 'on',
        '-compression_level', '10',
        '-frame_duration', '60', // PTT: 60ms frames for WhatsApp compatibility
        '-f', 'ogg',
        '-y',
        outputPath,
      ]);

      const result = await fs.promises.readFile(outputPath);
      return result;
    } finally {
      // cleanup — ignore errors
      fs.promises.unlink(inputPath).catch(() => undefined);
      fs.promises.unlink(outputPath).catch(() => undefined);
    }
  }

  /**
   * Probes the duration of an audio buffer using ffprobe.
   * Returns rounded integer seconds, or 0 on error / unreadable file.
   */
  async probeDurationSeconds(buffer: Buffer, mime: string): Promise<number> {
    const ext = this.mimeToExt(mime);
    const id = crypto.randomUUID();
    const tmpPath = path.join(this.tmpDir, `${id}.${ext}`);

    try {
      await fs.promises.mkdir(this.tmpDir, { recursive: true });
      await fs.promises.writeFile(tmpPath, buffer);

      const { stdout } = await execFileAsync(
        process.env.FFPROBE_PATH ?? 'ffprobe',
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          tmpPath,
        ],
      );

      const seconds = parseFloat(stdout.trim());
      if (!Number.isFinite(seconds) || seconds < 0) return 0;
      return Math.round(seconds);
    } catch (err) {
      this.logger.warn(`probeDurationSeconds failed: ${(err as Error).message}`);
      return 0;
    } finally {
      fs.promises.unlink(tmpPath).catch(() => undefined);
    }
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/mp4': 'mp4',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
    };
    return map[mime] ?? 'webm';
  }
}
