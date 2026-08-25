import { createModelSchema, updateModelSchema, isValidBaseUrl } from './ai.dto';

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

describe('ai.dto — hosts internos http (LLM local)', () => {
  const originalInternal = process.env.AI_ALLOWED_INTERNAL_HOSTS;

  afterEach(() => {
    if (originalInternal === undefined) {
      delete process.env.AI_ALLOWED_INTERNAL_HOSTS;
    } else {
      process.env.AI_ALLOWED_INTERNAL_HOSTS = originalInternal;
    }
  });

  it('aceita http://ollama:11434/v1 (host interno allowlistado)', () => {
    expect(isValidBaseUrl('http://ollama:11434/v1')).toBe(true);
  });

  it('recusa http em host externo mesmo allowlistado para https', () => {
    expect(isValidBaseUrl('http://api.openai.com/v1')).toBe(false);
  });

  it('recusa host interno nao listado', () => {
    expect(isValidBaseUrl('http://redis:6379')).toBe(false);
  });

  it('recusa sufixo disfarcado de host interno (ollama.evil.com)', () => {
    // A checagem e match exato, nao `endsWith`: dominio externo terminando em
    // "ollama..." nao herda a permissao de http.
    expect(isValidBaseUrl('http://ollama.evil.com/v1')).toBe(false);
  });

  it('recusa userinfo disfarcado de host interno (ollama@evil.com)', () => {
    // `ollama` aqui e usuario, nao host: o hostname da URL e evil.com.
    expect(isValidBaseUrl('http://ollama@evil.com/v1')).toBe(false);
  });

  it('mantem https com whitelist externa', () => {
    expect(isValidBaseUrl('https://api.anthropic.com/v1')).toBe(true);
    expect(isValidBaseUrl('https://evil.example.com')).toBe(false);
  });

  it('recusa protocolos fora de http/https', () => {
    expect(isValidBaseUrl('ftp://ollama:11434')).toBe(false);
    expect(isValidBaseUrl('file:///etc/passwd')).toBe(false);
    expect(isValidBaseUrl('nao-e-url')).toBe(false);
  });

  it('AI_ALLOWED_INTERNAL_HOSTS substitui a lista padrao', () => {
    process.env.AI_ALLOWED_INTERNAL_HOSTS = 'llm-local';
    expect(isValidBaseUrl('http://ollama:11434/v1')).toBe(false);
    expect(isValidBaseUrl('http://llm-local:8000/v1')).toBe(true);
  });

  it('createModelSchema aceita base_url do ollama de ponta a ponta', () => {
    const result = createModelSchema.safeParse({
      ...baseCreatePayload,
      provider: 'openai_compatible' as const,
      base_url: 'http://ollama:11434/v1',
    });
    expect(result.success).toBe(true);
  });
});
