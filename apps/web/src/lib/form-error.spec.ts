import { formError, validateRegistration } from './form-error';
const response = (status: number, data: unknown) => ({ response: { status, data } });
describe('form errors', () => {
  it('explains an existing email', () => expect(formError(response(409, {message: 'Email ja cadastrado'}), 'account')).toMatch(/e-mail.*cadastrado/i));
  it('explains short passwords before sending', () => expect(validateRegistration('Maria', 'm@example.com', '123', '')).toMatch(/8 caracteres/));
  it('accepts valid registration', () => expect(validateRegistration('Maria', 'm@example.com', '12345678', '')).toBe(''));
  it('rejects invalid email', () => expect(validateRegistration('Maria', 'invalid', '12345678', '')).toMatch(/e-mail/));
  it('shows lead validation details', () => expect(formError(response(400, {details: [{path:['email'], message:'Invalid email'}]}), 'lead')).toMatch(/E-mail:.*válido/));
  it('handles message arrays', () => expect(formError(response(400, {message:['Preencha nome', 'Preencha telefone']}), 'lead')).toBe('Preencha nome; Preencha telefone'));
  it('distinguishes connection failure', () => expect(formError({code:'ERR_NETWORK'}, 'account')).toMatch(/conexão/));
  it('does not expose internal errors', () => expect(formError(response(500, {message:'password SQL secret'}), 'account')).not.toMatch(/SQL|secret/));
  it('explains rate limiting', () => expect(formError(response(429, {}), 'account')).toMatch(/tentativas/));
});
