import { ArgumentsHost, UnauthorizedException } from '@nestjs/common';
import { AllExceptionFilter } from '../../common/filters/all-exception.filter';
describe('finance errors do not expire the CRM login', () => {
    it('retains finance-specific 401 code and prevents caching', () => { const json = jest.fn(); const res = { setHeader: jest.fn(), status: jest.fn().mockReturnValue({ json }) }; const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/api/financeiro/dashboard', method: 'GET', headers: {} }) }) } as unknown as ArgumentsHost; new AllExceptionFilter().catch(new UnauthorizedException({ message: 'Locked', code: 'FINANCE_LOCKED' }), host); expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'FINANCE_LOCKED' })); expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private'); });
});
