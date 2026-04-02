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
}
