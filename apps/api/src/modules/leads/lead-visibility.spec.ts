import { UserRole } from '@/common/types/roles';
import {
  buildVisibilityWhere,
  isManagerRole,
  mergeSearchCondition,
} from './lead-visibility';

const uid = 'user-1';

describe('isManagerRole', () => {
  it('GERENTE e SUPER_ADMIN são managers', () => {
    expect(isManagerRole(UserRole.GERENTE)).toBe(true);
    expect(isManagerRole(UserRole.SUPER_ADMIN)).toBe(true);
    expect(isManagerRole(UserRole.OPERADOR)).toBe(false);
    expect(isManagerRole(UserRole.VISUALIZADOR)).toBe(false);
  });
});

describe('buildVisibilityWhere — modo COMPARTILHADO (pool_enabled=true)', () => {
  it('manager vê tudo exceto lead privado de outro', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.GERENTE,
      poolEnabled: true,
    });
    expect(w).toEqual({
      OR: [{ is_private: false }, { responsavel_id: uid }],
    });
  });

  it('operador vê pool não-privado + as próprias', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.OPERADOR,
      poolEnabled: true,
    });
    expect(w).toEqual({
      OR: [
        { responsavel_id: null, is_private: false },
        { responsavel_id: uid },
      ],
    });
  });

  it('operador NÃO vê lead assumido por outro (regra implícita do OR)', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.OPERADOR,
      poolEnabled: true,
    });
    // lead { responsavel_id: 'outro', is_private: false } não casa com nenhum ramo
    const or = w.OR as Array<Record<string, unknown>>;
    const leadDeOutro = { responsavel_id: 'outro', is_private: false };
    const matches = or.some((cond) =>
      Object.entries(cond).every(([k, v]) => leadDeOutro[k as keyof typeof leadDeOutro] === v),
    );
    expect(matches).toBe(false);
  });
});

describe('buildVisibilityWhere — modo INDIVIDUAL (pool_enabled=false)', () => {
  it('operador só vê as próprias (+ a nuvem de devolvidos)', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.OPERADOR,
      poolEnabled: false,
    });
    expect(w).toEqual({
      OR: [
        { responsavel_id: uid },
        { responsavel_id: null, returned_at: { not: null }, is_private: false },
      ],
    });
    // nenhum ramo casa com lead de outro dono
    const or = w.OR as Array<Record<string, unknown>>;
    const leadDeOutro = { responsavel_id: 'outro', is_private: false };
    const matches = or.some((cond) =>
      Object.entries(cond).every(
        ([k, v]) => leadDeOutro[k as keyof typeof leadDeOutro] === v,
      ),
    );
    expect(matches).toBe(false);
  });

  it('gerente vê tudo na LISTA (sem scope)', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.GERENTE,
      poolEnabled: false,
    });
    expect(w.responsavel_id).toBeUndefined();
    expect(w.OR).toEqual([{ is_private: false }, { responsavel_id: uid }]);
  });

  it('anti-leak Cajuru: gerente no scope=chat só vê as próprias', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.GERENTE,
      poolEnabled: false,
      scope: 'chat',
    });
    expect(w.responsavel_id).toBe(uid);
    expect(w.OR).toBeUndefined();
  });

  it('SUPER_ADMIN no scope=chat também é restrito', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.SUPER_ADMIN,
      poolEnabled: false,
      scope: 'chat',
    });
    expect(w.responsavel_id).toBe(uid);
    expect(w.OR).toBeUndefined();
  });

  it('visualizador só vê as próprias (+ a nuvem de devolvidos)', () => {
    const w = buildVisibilityWhere({
      userId: uid,
      role: UserRole.VISUALIZADOR,
      poolEnabled: false,
    });
    expect(w).toEqual({
      OR: [
        { responsavel_id: uid },
        { responsavel_id: null, returned_at: { not: null }, is_private: false },
      ],
    });
  });
});

describe('buildVisibilityWhere — modo foco (gerente vira operador)', () => {
  it('INDIVIDUAL + foco: gerente vê os próprios + qualquer sem-dono não-privado', () => {
    const where = buildVisibilityWhere({
      userId: 'g1',
      role: UserRole.GERENTE,
      poolEnabled: false,
      focusMode: true,
    });
    expect(where).toEqual({
      OR: [{ responsavel_id: 'g1' }, { responsavel_id: null, is_private: false }],
    });
  });

  it('COMPARTILHADO + foco: gerente cai na regra de operador (pool + próprios)', () => {
    const where = buildVisibilityWhere({
      userId: 'g1',
      role: UserRole.SUPER_ADMIN,
      poolEnabled: true,
      focusMode: true,
    });
    expect(where).toEqual({
      OR: [{ responsavel_id: null, is_private: false }, { responsavel_id: 'g1' }],
    });
  });

  it('foco NÃO muda nada para operador', () => {
    const comFoco = buildVisibilityWhere({
      userId: 'o1',
      role: UserRole.OPERADOR,
      poolEnabled: false,
      focusMode: true,
    });
    const semFoco = buildVisibilityWhere({
      userId: 'o1',
      role: UserRole.OPERADOR,
      poolEnabled: false,
      focusMode: false,
    });
    expect(comFoco).toEqual(semFoco);
  });
});

describe('buildVisibilityWhere — nuvem de devolvidos (INDIVIDUAL)', () => {
  it('operador vê os próprios + devolvidos (returned_at preenchido)', () => {
    const where = buildVisibilityWhere({
      userId: 'o1',
      role: UserRole.OPERADOR,
      poolEnabled: false,
    });
    expect(where).toEqual({
      OR: [
        { responsavel_id: 'o1' },
        { responsavel_id: null, returned_at: { not: null }, is_private: false },
      ],
    });
  });

  it('scope=chat continua estrito: só os próprios, para QUALQUER role', () => {
    for (const role of [
      UserRole.OPERADOR,
      UserRole.GERENTE,
      UserRole.SUPER_ADMIN,
    ]) {
      const where = buildVisibilityWhere({
        userId: 'u1',
        role,
        poolEnabled: false,
        scope: 'chat',
        focusMode: true,
      });
      expect(where).toEqual({ responsavel_id: 'u1' });
    }
  });

  it('gerente SEM foco no INDIVIDUAL segue supervisionando tudo', () => {
    const where = buildVisibilityWhere({
      userId: 'g1',
      role: UserRole.GERENTE,
      poolEnabled: false,
    });
    expect(where).toEqual({ OR: [{ is_private: false }, { responsavel_id: 'g1' }] });
  });
});

describe('mergeSearchCondition', () => {
  const search = [{ nome: { contains: 'x' } }, { telefone: { contains: 'x' } }];

  it('com OR de visibilidade existente vira AND [{OR vis},{OR busca}] — busca não fura visibilidade', () => {
    const where: Record<string, unknown> = {
      OR: [{ is_private: false }],
    };
    mergeSearchCondition(where, search);
    expect(where.OR).toBeUndefined();
    expect(where.AND).toEqual([{ OR: [{ is_private: false }] }, { OR: search }]);
  });

  it('sem OR existente a busca vira o OR', () => {
    const where: Record<string, unknown> = { tenant_id: 't1' };
    mergeSearchCondition(where, search);
    expect(where.OR).toEqual(search);
    expect(where.AND).toBeUndefined();
  });
});
