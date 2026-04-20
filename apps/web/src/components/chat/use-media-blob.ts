'use client';

import { useEffect, useState } from 'react';

/**
 * Fetches media via the backend proxy endpoint and returns a same-origin blob URL.
 * This bypasses any browser restrictions on loading Supabase signed URLs directly.
 *
 * Priority: proxy (most reliable) → direct signed URL (fallback).
 */
export function useMediaBlob(messageId: string, signedUrl?: string | null): {
  blobUrl: string | null;
  loading: boolean;
  error: boolean;
} {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!messageId) {
      setLoading(false);
      setError(true);
      return;
    }

    let disposed = false;
    let url: string | null = null;

    setLoading(true);
    setError(false);
    setBlobUrl(null);

    (async () => {
      try {
        // 1) Try backend proxy first — always fresh signed URL server-side.
        const token =
          typeof window !== 'undefined'
            ? localStorage.getItem('accessToken')
            : null;
        const proxyUrl = `/api/messages/${messageId}/media`;
        const proxyRes = await fetch(proxyUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          credentials: 'include',
        });

        if (proxyRes.ok) {
          const blob = await proxyRes.blob();
          if (disposed) return;
          url = URL.createObjectURL(blob);
          setBlobUrl(url);
          setLoading(false);
          return;
        }

        // 2) Proxy failed — try direct signed URL if available.
        if (signedUrl && /^https?:\/\//i.test(signedUrl)) {
          const directRes = await fetch(signedUrl);
          if (directRes.ok) {
            const blob = await directRes.blob();
            if (disposed) return;
            url = URL.createObjectURL(blob);
            setBlobUrl(url);
            setLoading(false);
            return;
          }
        }

        // Both failed.
        if (!disposed) {
          console.error(
            `[useMediaBlob] all fetch strategies failed for msg=${messageId}`,
          );
          setError(true);
          setLoading(false);
        }
      } catch (err) {
        if (!disposed) {
          console.error(
            `[useMediaBlob] error for msg=${messageId}:`,
            err,
          );
          setError(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [messageId, signedUrl]);

  return { blobUrl, loading, error };
}
