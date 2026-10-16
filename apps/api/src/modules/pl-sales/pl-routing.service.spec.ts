import { PlRoutingService } from './pl-routing.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { PL_TENANT, PL_PIPELINE } from './pl-sales.domain';

function setup() {
 const prisma={lead:{findMany:jest.fn().mockResolvedValue([])},message:{findFirst:jest.fn().mockResolvedValue(null)},conversation:{findFirst:jest.fn().mockResolvedValue(null)},pipeline:{findFirst:jest.fn().mockResolvedValue({id:PL_PIPELINE,stages:[{id:'new'}]})}};
 const ai={chat:jest.fn().mockResolvedValue({text:'{"intent":"consorcio","confidence":0.99}'})};
 const service=new PlRoutingService(prisma as unknown as PrismaService,ai as unknown as AiProviderService);
 const resolve=(text:string,fromMe=false,backfill=false,tenant=PL_TENANT)=>service.resolve(tenant,'5537999999999',undefined,'leads',text,fromMe,backfill,new Date('2026-10-15T12:00:00Z'));
 return {prisma,ai,resolve};
}
describe('PL routing',()=>{
 it('does not query or classify another tenant',async()=>{const m=setup();expect(await m.resolve('*Nova Simulação de Consórcio*',false,false,'other')).toBeNull();expect(m.prisma.lead.findMany).not.toHaveBeenCalled();expect(m.ai.chat).not.toHaveBeenCalled();});
 it('recognizes simulation without moving existing partner',async()=>{const m=setup();m.prisma.lead.findMany.mockResolvedValue([{id:'partner',pipeline_id:'partners',telefone:'5537999999999'}]);expect(await m.resolve('*Nova Simulação de Consórcio*\nNome: Ana')).toMatchObject({pipeline:{id:PL_PIPELINE},simulation:{nome:'Ana'}});expect(m.ai.chat).not.toHaveBeenCalled();});
 it('keeps following messages on the established PL conversation',async()=>{const m=setup();m.prisma.lead.findMany.mockResolvedValue([{id:'pl',pipeline_id:PL_PIPELINE,telefone:'5537999999999'},{id:'partner',pipeline_id:'partners',telefone:'5537999999999'}]);m.prisma.conversation.findFirst.mockResolvedValue({lead_id:'pl'});expect(await m.resolve('Obrigada')).toMatchObject({pipeline:{id:PL_PIPELINE}});expect(m.ai.chat).not.toHaveBeenCalled();});
 it('keeps partnership conversation unchanged',async()=>{const m=setup();m.prisma.lead.findMany.mockResolvedValue([{id:'partner',pipeline_id:'partners',telefone:'5537999999999'}]);m.prisma.conversation.findFirst.mockResolvedValue({lead_id:'partner'});expect(await m.resolve('Tenho uma empresa de consórcio')).toBeNull();expect(m.ai.chat).not.toHaveBeenCalled();});
 it('AI identifies only confident new incoming intent',async()=>{const m=setup();expect(await m.resolve('Quero simular um consórcio para minha casa')).toMatchObject({pipeline:{id:PL_PIPELINE}});expect(m.ai.chat).toHaveBeenCalledTimes(1);});
 it.each([['saída',true,false],['histórico',false,true]] as const)('does not invoke AI for %s',async(_label,fromMe,backfill)=>{const m=setup();expect(await m.resolve('Quero consórcio',fromMe,backfill)).toBeNull();expect(m.ai.chat).not.toHaveBeenCalled();});
 it('keeps normal flow when AI is unavailable or uncertain',async()=>{const m=setup();m.ai.chat.mockRejectedValue(new Error('offline'));expect(await m.resolve('Quero consórcio')).toBeNull();m.ai.chat.mockResolvedValue({text:'{"intent":"indefinido","confidence":0.4}'});expect(await m.resolve('Quero consórcio')).toBeNull();});
 it('does not create pipeline as a webhook side effect',async()=>{const m=setup();m.prisma.pipeline.findFirst.mockResolvedValue(null);expect(await m.resolve('*Nova Simulação de Consórcio*')).toBeNull();});
});

it('does not attribute old ambiguous partner history to todays PL conversation',async()=>{
 const m=setup();m.prisma.lead.findMany.mockResolvedValue([{id:'partner',pipeline_id:'partners',telefone:'5537999999999'},{id:'pl',pipeline_id:PL_PIPELINE,telefone:'5537999999999'}]);
 m.prisma.conversation.findFirst.mockResolvedValue({lead_id:'pl'});
 m.prisma.message.findFirst.mockResolvedValueOnce({lead_id:'partner'}).mockResolvedValueOnce({lead_id:'pl'});
 expect(await m.resolve('Mensagem antiga perdida',false,true)).toEqual({skip:true});
 expect(m.prisma.conversation.findFirst).not.toHaveBeenCalled();
});
it('imports historical PL interval only when both timestamp anchors agree',async()=>{
 const m=setup();m.prisma.lead.findMany.mockResolvedValue([{id:'pl',pipeline_id:PL_PIPELINE,telefone:'5537999999999'}]);
 m.prisma.message.findFirst.mockResolvedValue({lead_id:'pl'});
 expect(await m.resolve('Resposta antiga',false,true)).toMatchObject({pipeline:{id:PL_PIPELINE}});
 m.prisma.message.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({lead_id:'pl'});
 expect(await m.resolve('Antes do primeiro contato PL',false,true)).toEqual({skip:true});
});
