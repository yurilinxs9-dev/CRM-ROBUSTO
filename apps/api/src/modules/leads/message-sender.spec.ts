import { resolveMessageSender } from './message-sender';
import type { MessageSenderInput } from './message-sender';

const lookup = {
  userNames: new Map([['u-yago', 'Yago Couto']]),
  instanceOwnerNames: new Map([['yago-couto---06', 'Yago Couto']]),
};

const msg = (over: Partial<MessageSenderInput> = {}): MessageSenderInput => ({
  direction: 'OUTGOING',
  is_internal_note: false,
  sender_type: 'user',
  sent_by_user_id: null,
  instance_name: 'yago-couto---06',
  ...over,
});

describe('resolveMessageSender', () => {
  it('mensagem do cliente não tem remetente', () => {
    expect(resolveMessageSender(msg({ direction: 'INCOMING' }), lookup)).toBeNull();
  });

  it('nota interna não ganha legenda', () => {
    expect(resolveMessageSender(msg({ is_internal_note: true, sent_by_user_id: 'u-yago' }), lookup)).toBeNull();
  });

  it('enviada pelo CRM usa o usuário que enviou', () => {
    expect(resolveMessageSender(msg({ sent_by_user_id: 'u-yago', instance_name: 'outro' }), lookup)).toEqual({
      name: 'Yago Couto',
      origin: 'crm',
    });
  });

  it('enviada do celular é atribuída ao dono do número', () => {
    expect(resolveMessageSender(msg(), lookup)).toEqual({ name: 'Yago Couto', origin: 'celular' });
  });

  it('IA e automação não levam nome de usuário', () => {
    expect(resolveMessageSender(msg({ sender_type: 'ai' }), lookup)).toEqual({ name: null, origin: 'ia' });
    expect(resolveMessageSender(msg({ sender_type: 'system', sent_by_user_id: 'u-yago' }), lookup)).toEqual({
      name: null,
      origin: 'automacao',
    });
  });

  it('número sem dono conhecido devolve nome nulo', () => {
    expect(resolveMessageSender(msg({ instance_name: 'desconhecida' }), lookup)).toEqual({
      name: null,
      origin: 'celular',
    });
  });
});
