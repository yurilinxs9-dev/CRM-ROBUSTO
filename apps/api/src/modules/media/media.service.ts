import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private supabase: SupabaseClient;
  private bucket: string;

  constructor(private config: ConfigService) {
    this.supabase = createClient(
      config.get('SUPABASE_URL')!,
      config.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    this.bucket = config.get('SUPABASE_STORAGE_BUCKET', 'crm-media') || 'crm-media';
  }

  async upload(path: string, buffer: Buffer, mimetype: string): Promise<string> {
    const { error } = await this.supabase.storage
      .from(this.bucket)
      .upload(path, buffer, { contentType: mimetype, upsert: true });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return path;
  }

  async getSignedUrl(path: string, expiresIn = 3600): Promise<string> {
    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresIn);

    if (error || !data) throw new Error(`Failed to get signed URL: ${error?.message}`);
    return data.signedUrl;
  }

  async delete(path: string): Promise<void> {
    await this.supabase.storage.from(this.bucket).remove([path]);
  }

  /**
   * Download remote image → upload to Storage → return signed URL.
   * Used to mirror short-lived signed URLs (e.g. pps.whatsapp.net avatar URLs
   * with embedded `oh=`/`oe=` params) into our own bucket so the frontend
   * never depends on third-party expiry windows.
   */
  async mirrorFromUrl(
    path: string,
    srcUrl: string,
    opts: { maxBytes?: number; expiresIn?: number; timeoutMs?: number } = {},
  ): Promise<string> {
    const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    const expiresIn = opts.expiresIn ?? 60 * 60 * 24 * 365;
    const timeoutMs = opts.timeoutMs ?? 10_000;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(srcUrl, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${srcUrl}`);

    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    if (!contentType.startsWith('image/')) {
      throw new Error(`Unexpected content-type: ${contentType}`);
    }

    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`Image too large: ${ab.byteLength} > ${maxBytes}`);
    }

    await this.upload(path, Buffer.from(ab), contentType);
    return this.getSignedUrl(path, expiresIn);
  }
}
