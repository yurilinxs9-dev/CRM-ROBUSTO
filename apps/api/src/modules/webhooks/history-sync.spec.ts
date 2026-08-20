import {
  backfillJobPayload,
  chatHasGap,
  messageTs,
  parseChatsPage,
  parseFindMessages,
  resolveUazapiPhone,
} from './history-sync';

/**
 * Helpers puros do history sync UazAPI (ver
 * docs/superpowers/specs/2026-08-20-history-sync-design.md). Fixtures seguem o
 * shape REAL verificado em produção (jgtech.uazapi.com, 2026-08-20).
 */

const chatFixture = {
  wa_chatid: '553186332984@s.whatsapp.net',
  wa_chatlid: '126740374524068@lid',
  wa_isGroup: false,
  name: 'Ricardo Borges Tapetes',
  wa_contactName: 'Ricardo Borges Tapetes',
  wa_lastMsgTimestamp: 1787231638000,
  wa_unreadCount: 0,
};

describe('parseChatsPage', () => {
  it('extrai chat individual com telefone, nome e lid', () => {
    const chats = parseChatsPage({ chats: [chatFixture] });
    expect(chats).toEqual([
      {
        chatid: '553186332984@s.whatsapp.net',
        phone: '553186332984',
        name: 'Ricardo Borges Tapetes',
        contactName: 'Ricardo Borges Tapetes',
        lidJid: '126740374524068@lid',
        lastMsgTs: 1787231638000,
      },
    ]);
  });

  it('descarta grupos', () => {
    const chats = parseChatsPage({
      chats: [{ ...chatFixture, wa_chatid: '1203634@g.us', wa_isGroup: true }],
    });
    expect(chats).toEqual([]);
  });

  it('descarta chat sem sufixo @s.whatsapp.net', () => {
    const chats = parseChatsPage({
      chats: [{ ...chatFixture, wa_chatid: '126740374524068@lid' }],
    });
    expect(chats).toEqual([]);
  });

  it('descarta telefone fora de 8-13 digitos', () => {
    const chats = parseChatsPage({
      chats: [{ ...chatFixture, wa_chatid: '1234567@s.whatsapp.net' }],
    });
    expect(chats).toEqual([]);
  });

  it('name null quando vazio; lid null quando nao termina em @lid', () => {
    const chats = parseChatsPage({
      chats: [{ ...chatFixture, name: '', wa_contactName: '', wa_chatlid: '' }],
    });
    expect(chats[0].name).toBeNull();
    expect(chats[0].contactName).toBeNull();
    expect(chats[0].lidJid).toBeNull();
  });

  it('sem wa_contactName: name cai pro nome do chat e contactName fica null', () => {
    const chats = parseChatsPage({
      chats: [{ ...chatFixture, wa_contactName: '', name: 'Perfil do Cliente' }],
    });
    expect(chats[0].name).toBe('Perfil do Cliente');
    expect(chats[0].contactName).toBeNull();
  });

  it('payload invalido vira lista vazia', () => {
    expect(parseChatsPage(undefined)).toEqual([]);
    expect(parseChatsPage({ chats: 'nope' })).toEqual([]);
  });
});

describe('chatHasGap', () => {
  const since = 1_000_000;
  const chat = {
    chatid: 'x@s.whatsapp.net',
    phone: '553186332984',
    name: null,
    contactName: null,
    lidJid: null,
    lastMsgTs: 2_000_000,
  };

  it('true quando nao existe mensagem no banco', () => {
    expect(chatHasGap(chat, null, since)).toBe(true);
  });

  it('true quando banco esta atras alem da margem de 10s', () => {
    expect(chatHasGap(chat, 2_000_000 - 10_001, since)).toBe(true);
  });

  it('false quando banco esta em dia (dentro da margem de 10s — CRM grava antes do carimbo do WhatsApp)', () => {
    expect(chatHasGap(chat, 2_000_000 - 10_000, since)).toBe(false);
    expect(chatHasGap(chat, 2_000_000 - 3500, since)).toBe(false);
    expect(chatHasGap(chat, 2_000_000, since)).toBe(false);
  });

  it('false quando ultima atividade do chat e anterior a janela', () => {
    expect(chatHasGap({ ...chat, lastMsgTs: since - 1 }, null, since)).toBe(false);
  });
});

describe('parseFindMessages', () => {
  it('extrai messages, hasMore e nextOffset', () => {
    const r = parseFindMessages({
      hasMore: true,
      nextOffset: 2,
      messages: [{ messageid: 'A' }, { messageid: 'B' }],
    });
    expect(r.messages).toHaveLength(2);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(2);
  });

  it('payload invalido vira vazio sem hasMore', () => {
    expect(parseFindMessages(undefined)).toEqual({ messages: [], hasMore: false, nextOffset: 0 });
    expect(parseFindMessages({ messages: 'x' })).toEqual({ messages: [], hasMore: false, nextOffset: 0 });
  });
});

describe('messageTs', () => {
  it('epoch ms passa direto', () => {
    expect(messageTs({ messageTimestamp: 1787231638000 })).toBe(1787231638000);
  });

  it('epoch em segundos vira ms', () => {
    expect(messageTs({ messageTimestamp: 1787231638 })).toBe(1787231638000);
  });

  it('ausente ou invalido vira 0', () => {
    expect(messageTs({})).toBe(0);
    expect(messageTs({ messageTimestamp: 'x' })).toBe(0);
  });
});

describe('backfillJobPayload', () => {
  it('monta payload com flag backfill, token e telefone real do chat', () => {
    const message = { messageid: 'A', text: 'oi' };
    expect(backfillJobPayload(message, 'tok-1', '553186332984')).toEqual({
      event: 'uazapi.messages',
      token: 'tok-1',
      message,
      backfill: true,
      chat_phone: '553186332984',
    });
  });
});

describe('resolveUazapiPhone', () => {
  it('chatid PN usa os dígitos', () => {
    expect(resolveUazapiPhone({ chatid: '553186332984@s.whatsapp.net' })).toBe('553186332984');
  });

  it('chatid @lid NUNCA vira telefone — cai pro sender_pn quando !fromMe', () => {
    expect(
      resolveUazapiPhone({
        chatid: '150122142949534@lid',
        fromMe: false,
        sender_pn: '553186332984@s.whatsapp.net',
      }),
    ).toBe('553186332984');
  });

  it('chatid @lid com fromMe true não confia no sender_pn (é o próprio dono) → null', () => {
    expect(
      resolveUazapiPhone({
        chatid: '150122142949534@lid',
        fromMe: true,
        sender_pn: '553799043643@s.whatsapp.net',
      }),
    ).toBeNull();
  });

  it('chatid @lid sem sender_pn → null (descarta em vez de lead fantasma)', () => {
    expect(resolveUazapiPhone({ chatid: '150122142949534@lid' })).toBeNull();
  });
});
