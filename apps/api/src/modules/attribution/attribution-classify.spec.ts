import { classifyAttribution } from './attribution-classify';
import { attributionInputSchema } from './attribution.types';

/** Passa pelo Zod antes, como acontece em produção (trim, corte, coerção). */
const classify = (raw: Record<string, unknown>) =>
  classifyAttribution(attributionInputSchema.parse(raw));

describe('classifyAttribution', () => {
  describe('Meta CTWA (anúncio que chega pelo WhatsApp)', () => {
    // Payload real, da amostra em docs/specs/anuncio-na-conversa.md.
    const anuncio = {
      ad_id: '120251874055560237',
      ad_title: 'Viva uma formatura inesquecível! ✨',
      ad_url: 'https://www.instagram.com/p/DbDxlGxs6jt/',
      ctwa_clid: 'AfgLBjYZquD6-iob2B4',
      source_app: 'instagram',
    };

    it('classifica como Meta Ads pago', () => {
      const r = classify(anuncio);
      expect(r.channel).toBe('META_ADS');
      expect(r.paid).toBe(true);
      expect(r.source).toBe('instagram');
    });

    it('usa o anúncio como campanha e o título como rótulo — sem API nenhuma', () => {
      const r = classify(anuncio);
      expect(r.campaign_id).toBe('120251874055560237');
      expect(r.campaign_name).toBe('Viva uma formatura inesquecível! ✨');
    });

    it('cai para "meta" quando o source_app não é instagram/facebook', () => {
      expect(classify({ ...anuncio, source_app: 'whatsapp' }).source).toBe('meta');
      expect(classify({ ad_id: '123' }).source).toBe('meta');
    });

    it('vence a UTM: evidência dentro da mensagem ganha de evidência declarada', () => {
      const r = classify({ ...anuncio, utm_source: 'google', utm_medium: 'cpc', gclid: 'abc' });
      expect(r.channel).toBe('META_ADS');
    });
  });

  describe('Google Ads', () => {
    it('reconhece pelo gclid sozinho, sem UTM nenhuma', () => {
      const r = classify({ gclid: 'Cj0KCQjw', landing_url: 'https://site.com/' });
      expect(r.channel).toBe('GOOGLE_ADS');
      expect(r.paid).toBe(true);
      expect(r.source).toBe('google');
    });

    it('aceita wbraid/gbraid — tráfego iOS/EEA sem gclid ainda é pago', () => {
      expect(classify({ wbraid: 'Cj0ABC' }).channel).toBe('GOOGLE_ADS');
      expect(classify({ gbraid: 'Cj0ABC' }).channel).toBe('GOOGLE_ADS');
      expect(classify({ wbraid: 'Cj0ABC' }).paid).toBe(true);
    });

    it('guarda campanha, grupo, palavra-chave e correspondência do ValueTrack', () => {
      const r = classify({
        gclid: 'Cj0KCQjw',
        utm_source: 'google',
        utm_medium: 'cpc',
        utm_campaign: '21587364',
        utm_term: 'aluguel de vestido de formatura',
        matchtype: 'p',
        network: 'g',
        device: 'm',
        adgroupid: '9988',
        creative: '77665544',
      });
      expect(r.campaign_id).toBe('21587364');
      expect(r.keyword).toBe('aluguel de vestido de formatura');
      expect(r.match_type).toBe('p');
      expect(r.adgroup_id).toBe('9988');
      expect(r.creative_id).toBe('77665544');
    });

    it('campanha numérica não vira rótulo; campanha em texto vira', () => {
      expect(classify({ gclid: 'x', utm_campaign: '21587364' }).campaign_name).toBeNull();
      expect(classify({ gclid: 'x', utm_campaign: 'formatura-abril' }).campaign_name).toBe(
        'formatura-abril',
      );
    });

    it('reconhece por UTM quando o gclid falta (auto-tagging desligado)', () => {
      const r = classify({ utm_source: 'google', utm_medium: 'cpc' });
      expect(r.channel).toBe('GOOGLE_ADS');
    });
  });

  describe('Meta pelo site', () => {
    it('reconhece pelo fbclid', () => {
      const r = classify({ fbclid: 'IwAR0abc', landing_url: 'https://site.com/' });
      expect(r.channel).toBe('META_ADS');
      expect(r.paid).toBe(true);
    });

    it('reconhece instagram + mídia paga', () => {
      const r = classify({ utm_source: 'instagram', utm_medium: 'paid_social' });
      expect(r.channel).toBe('META_ADS');
      expect(r.source).toBe('instagram');
    });
  });

  describe('orgânico', () => {
    it('link de bio do Instagram sem mídia paga é social orgânico', () => {
      const r = classify({ utm_source: 'instagram', utm_medium: 'bio' });
      expect(r.channel).toBe('SOCIAL_ORGANIC');
      expect(r.paid).toBe(false);
    });

    it('referrer do Google sem gclid é busca orgânica', () => {
      const r = classify({
        referrer: 'https://www.google.com.br/',
        landing_url: 'https://site.com/servicos',
      });
      expect(r.channel).toBe('GOOGLE_ORGANIC');
      expect(r.paid).toBe(false);
    });

    it('referrer de rede social é social orgânico', () => {
      expect(classify({ referrer: 'https://l.facebook.com/' }).channel).toBe('SOCIAL_ORGANIC');
      expect(classify({ referrer: 'https://t.co/abc' }).channel).toBe('SOCIAL_ORGANIC');
    });

    it('UTM de parceiro sem mídia paga é referral', () => {
      const r = classify({ utm_source: 'newsletter', utm_medium: 'email' });
      expect(r.channel).toBe('REFERRAL');
      expect(r.paid).toBe(false);
    });

    it('site externo qualquer é referral', () => {
      const r = classify({
        referrer: 'https://blogdamoda.com.br/post',
        landing_url: 'https://site.com/',
      });
      expect(r.channel).toBe('REFERRAL');
      expect(r.source).toBe('blogdamoda.com.br');
    });
  });

  describe('direto × não identificado', () => {
    it('visita ao site sem referrer é direto', () => {
      const r = classify({ landing_url: 'https://site.com/' });
      expect(r.channel).toBe('DIRECT');
    });

    it('navegação dentro do próprio site não inventa origem', () => {
      const r = classify({
        referrer: 'https://site.com/home',
        landing_url: 'https://site.com/contato',
      });
      expect(r.channel).toBe('DIRECT');
    });

    it('mensagem sem contexto web nenhum é não identificado, não direto', () => {
      // A diferença importa: uma é resposta, a outra é falta de dado.
      expect(classify({}).channel).toBe('UNKNOWN');
    });

    it('mídia paga de plataforma desconhecida fica explícita como paga', () => {
      const r = classify({ utm_source: 'taboola', utm_medium: 'cpc' });
      expect(r.channel).toBe('UNKNOWN');
      expect(r.paid).toBe(true);
      expect(r.source).toBe('taboola');
    });
  });

  describe('robustez', () => {
    it('referrer inválido não derruba a classificação', () => {
      expect(classify({ referrer: 'não é uma url' }).channel).toBe('UNKNOWN');
    });

    it('utm_medium em maiúsculas é reconhecido', () => {
      expect(classify({ utm_source: 'Google', utm_medium: 'CPC' }).channel).toBe('GOOGLE_ADS');
    });

    it('string vazia é tratada como ausente', () => {
      expect(classify({ gclid: '', utm_source: '  ' }).channel).toBe('UNKNOWN');
    });

    it('URL gigante é cortada em vez de rejeitada', () => {
      const gigante = `https://site.com/?q=${'a'.repeat(5000)}`;
      const r = classify({ landing_url: gigante });
      expect(r.landing_url).toHaveLength(1000);
      expect(r.channel).toBe('DIRECT');
    });
  });
});
