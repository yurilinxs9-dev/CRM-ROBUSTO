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
        '-c:a', 'libopus',
        '-b:a', '64k',
        '-ar', '48000',
        '-ac', '1',
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
