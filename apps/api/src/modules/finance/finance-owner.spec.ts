import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FinanceGuard } from './finance.guard';
import { FINANCE_PLATFORM_OWNER, FINANCE_TENANT, FINANCE_USER } from './finance.domain';
import { FinanceAuthService } from './finance-auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
function fixture(actor = FINANCE_PLATFORM_OWNER, activeOwner = true, method = 'GET', authRoute = false) {
 const user = { id: FINANCE_USER, tenantId: FINANCE_TENANT, ativo: true };
 const req = { user, method, get: (h:string) => h === 'authorization' ? 'Bearer h.'+Buffer.from(JSON.stringify({impersonatedBy:actor})).toString('base64url')+'.s' : undefined };
 const db = {user:{findFirst:jest.fn().mockImplementation(({where}) => Promise.resolve(where.id === FINANCE_PLATFORM_OWNER ? (activeOwner ? {id:FINANCE_PLATFORM_OWNER} : null) : {id:FINANCE_USER}))}};
 const auth = {validate:jest.fn()};
 const guard = new FinanceGuard(auth as unknown as FinanceAuthService, db as unknown as PrismaService, {get:()=>authRoute} as unknown as Reflector);
 const context = {switchToHttp:()=>({getRequest:()=>req,getResponse:()=>({setHeader:jest.fn()})}),getHandler:()=>({})} as unknown as ExecutionContext;
 return {req,user,db,auth,guard,context};
}
describe('named finance platform owner',()=>{
 it('allows Yuri without the Paloma session and preserves the actor without mutating cached user',async()=>{const f=fixture();await expect(f.guard.canActivate(f.context)).resolves.toBe(true);expect(f.auth.validate).not.toHaveBeenCalled();expect(f.req.user).toHaveProperty('financeActorId',FINANCE_PLATFORM_OWNER);expect(f.user).not.toHaveProperty('financeActorId');expect(f.db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:FINANCE_PLATFORM_OWNER,ativo:true,is_platform_admin:true,platform_scopes:{has:'*'}}}));});
 it('rejects all other impersonators',async()=>{const f=fixture('another-admin');await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(ForbiddenException);});
 it('revokes access when the owner is disabled or loses platform privileges',async()=>{const f=fixture(FINANCE_PLATFORM_OWNER,false);await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(ForbiddenException);});
 it('does not let the owner overwrite Paloma financial credentials',async()=>{const f=fixture(FINANCE_PLATFORM_OWNER,true,'POST',true);await expect(f.guard.canActivate(f.context)).rejects.toBeInstanceOf(ForbiddenException);});
});