import { createModelSchema, updateModelSchema } from './ai.dto';

const baseCreatePayload = {
  label: 'Modelo teste',
  provider: 'anthropic' as const,
  model_id: 'claude-x',
  api_key: 'sk-abc123',
};

describe('ai.dto — whitelist de host para base_url', () => {
  const originalEnv = process.env.AI_ALLOWED_HOSTS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_ALLOWED_HOSTS;
    } else {
      process.env.AI_ALLOWED_HOSTS = originalEnv;
    }
  });

  it('aceita host da whitelist padrão', () => {
    const result = createModelSchema.safeParse({
      ...baseCreatePayload,
      base_url: 'https://api.anthropic.com/v1',
    });
    expect(result.success).toBe(true);
  });

  it('aceita base_url ausente', () => {
    const result = createModelSchema.safeParse({ ...baseCreatePayload });
    expect(result.success).toBe(true);
  });

  it('aceita base_url null', () => {
    const result = createModelSchema.safeParse({ ...baseCreatePayload, base_url: null });
    expect(result.success).toBe(true);
  });

  it('recusa host fora da whitelist', () => {
    const result = createModelSchema.safeParse({
      ...baseCreatePayload,
      base_url: 'https://evil-collector.example.com',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Host não permitido para base_url');
    }
  });

  it('recusa subdomínio disfarçado (api.anthropic.com.evil.com)', () => {
    const result = createModelSchema.safeParse({
      ...baseCreatePayload,
      base_url: 'https://api.anthropic.com.evil.com',
    });
    expect(result.success).toBe(false);
  });

  it('recusa esquema http mesmo em host permitido', () => {
    const result = createModelSchema.safeParse({
      ...baseCreatePayload,
      base_url: 'http://api.openai.com',
    });
    expect(result.success).toBe(false);
  });

  it('AI_ALLOWED_HOSTS substitui a whitelist padrão (host padrão passa a ser recusado)', () => {
    process.env.AI_ALLOWED_HOSTS = 'my-proxy.internal.example.com';
    const recusaPadrao = createModelSchema.safeParse({
      ...baseCreatePayload,
      base_url: 'https://api.anthropic.com',
    });
    expect(recusaPadrao.success).toBe(false);

    const aceitaCustom = createModelSchema.safeParse({
      ...baseCreatePayload,
      base_url: 'https://my-proxy.internal.example.com',
    });
    expect(aceitaCustom.success).toBe(true);
  });

  it('updateModelSchema aplica a mesma whitelist', () => {
    const result = updateModelSchema.safeParse({ base_url: 'https://evil.example.com' });
    expect(result.success).toBe(false);
  });
});
