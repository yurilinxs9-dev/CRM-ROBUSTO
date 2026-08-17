/**
 * Contrato de entrada da atribuição. Uma forma só serve os três caminhos —
 * pixel do site, formulário via API pública e anúncio do WhatsApp — para que
 * exista UM classificador, e não um por origem.
 */
import { z } from 'zod';

/** Campo curto de marketing. Tudo é opcional: nenhuma origem preenche tudo. */
const campo = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional();

/**
 * URL longa (landing page com query string inteira, referrer). Cortada em vez
 * de rejeitada: perder a atribuição inteira porque a URL passou do limite seria
 * pior do que guardar o começo dela.
 */
const url = (max = 1000) =>
  z
    .string()
    .trim()
    .transform((v) => (v.length > max ? v.slice(0, max) : v))
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional();

export const attributionInputSchema = z.object({
  // --- Click IDs ---
  gclid: campo(500),
  wbraid: campo(500),
  gbraid: campo(500),
  fbclid: campo(500),
  ctwa_clid: campo(500),

  // --- UTMs ---
  utm_source: campo(),
  utm_medium: campo(),
  utm_campaign: campo(),
  utm_term: campo(),
  utm_content: campo(),

  // --- ValueTrack explícito (quando o template usa nomes próprios) ---
  campaignid: campo(),
  adgroupid: campo(),
  creative: campo(),
  keyword: campo(),
  matchtype: campo(50),
  network: campo(50),
  device: campo(50),

  // --- Anúncio da Meta que chega pelo WhatsApp (Click to WhatsApp) ---
  ad_id: campo(),
  ad_title: campo(500),
  ad_url: url(),
  source_app: campo(50),

  // --- Contexto da visita ---
  landing_url: url(),
  referrer: url(),
  clicked_at: z.coerce.date().optional(),
});

export type AttributionInput = z.infer<typeof attributionInputSchema>;

/**
 * Payload do pixel. Os nomes curtos (`t`, `k`, `lp`, `rf`, `ts`) existem porque
 * isso viaja na query string de um `<img>`: quanto menor, menor o risco de
 * estourar o limite de URL do navegador.
 */
export const trackQuerySchema = attributionInputSchema.extend({
  /** Token público do site do tenant. */
  t: z.string().trim().min(8).max(64),
  /** Código curto que vai no texto pré-preenchido do wa.me. Ausente = só visita. */
  k: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,16}$/)
    .optional(),
  lp: url(),
  rf: url(),
  /** Epoch em ms, como o navegador manda. */
  ts: z.coerce.number().int().positive().optional(),
});

export type TrackQuery = z.infer<typeof trackQuerySchema>;

/** Janela do relatório, no mesmo formato dos endpoints de analytics. */
export const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export const campaignLabelSchema = z.object({
  source: z.enum(['google', 'meta']),
  campaign_id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(120),
});
