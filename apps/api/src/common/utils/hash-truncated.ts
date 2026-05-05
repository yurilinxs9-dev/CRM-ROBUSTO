import * as crypto from 'node:crypto';

export function hashTruncated(input: string, len = 8): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, len);
}
