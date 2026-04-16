/**
 * Minimal type shim for `file-type` v22 (ESM-only with `exports` field).
 * Needed because tsconfig uses `moduleResolution: node` (legacy), which does
 * not read the `exports` field. Only the APIs actually consumed here are
 * declared — extend as needed.
 */
declare module 'file-type' {
  export interface FileTypeResult {
    mime: string;
    ext: string;
  }

  export function fileTypeFromBuffer(
    input: Uint8Array | ArrayBuffer | Buffer,
  ): Promise<FileTypeResult | undefined>;
}
