'use client';

import { Megaphone } from 'lucide-react';
import { AdReferral } from './types';

/** 'instagram' → 'Instagram'. Sem origem conhecida, só "Anúncio". */
function sourceLabel(app?: string): string {
  if (!app) return 'Anúncio';
  return `Anúncio · ${app.charAt(0).toUpperCase()}${app.slice(1)}`;
}

/** Só o domínio, pra não estourar a largura da bolha com a URL inteira. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

interface AdReferralCardProps {
  ad: AdReferral;
}

/**
 * Card do anúncio de origem, mostrado acima da primeira mensagem do lead —
 * a mesma informação que o WhatsApp do celular exibe e que o CRM não mostrava.
 */
export function AdReferralCard({ ad }: AdReferralCardProps) {
  const link = ad.source_url ?? ad.media_url;

  return (
    <div className="mb-1.5 flex gap-2 rounded-lg border-l-2 border-primary bg-background/40 p-2">
      {ad.thumbnail_data_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ad.thumbnail_data_url}
          alt={ad.title ?? 'Anúncio'}
          className="h-14 w-14 flex-shrink-0 rounded object-cover"
          loading="lazy"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[11px] font-semibold text-primary">
          <Megaphone size={11} className="flex-shrink-0" />
          {sourceLabel(ad.source_app)}
        </p>
        {ad.title && (
          <p className="mt-0.5 line-clamp-2 text-xs font-medium text-foreground">
            {ad.title}
          </p>
        )}
        {ad.body && (
          <p className="mt-0.5 line-clamp-3 text-[11px] text-muted-foreground">
            {ad.body}
          </p>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block truncate text-[11px] text-primary underline underline-offset-2 hover:opacity-80"
          >
            {shortUrl(link)}
          </a>
        )}
      </div>
    </div>
  );
}
