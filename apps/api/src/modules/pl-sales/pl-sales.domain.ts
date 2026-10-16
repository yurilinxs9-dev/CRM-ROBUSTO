import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dateSchema, monthSchema, moneySchema } from '../partners/partners.schemas';
export { monthSchema };
export const PL_TENANT = 'a44772ed-1382-4400-84fc-3fa350e23e42';
export const PL_PIPELINE = '6f749216-8d83-44ed-8fd0-1c57720c9f11';
export const isPlPipeline = (tenant: string, pipeline?: string) => tenant === PL_TENANT && pipeline === PL_PIPELINE;
export const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim();
export const isSimulation = (s: string) => /(?:^|\s)nova simulacao de consorcio(?:$|\s|:)/.test(normalize(s));
export function simulatorFields(text: string): Record<string,string> {
  if (!isSimulation(text)) return {};
  const names: Record<string,string> = {nome:'nome','e-mail':'email',telefone:'telefone',localidade:'localidade',objetivo:'objetivo','valor do credito':'credito','valor da parcela':'parcela'};
  const result: Record<string,string> = {};
  for (const line of text.split(/\r?\n/)) { const index=line.indexOf(':'); if(index<0) continue; const key=names[normalize(line.slice(0,index))]; const value=line.slice(index+1).trim(); if(key && value) result[key]=value.slice(0,300); }
  return result;
}
export function acceptsClassification(text: string): boolean {
  try { const result=z.object({intent:z.enum(['consorcio','parceria','indefinido']),confidence:z.number().min(0).max(1)}).parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,''))); return result.intent==='consorcio' && result.confidence>=0.95; } catch { return false; }
}
export const saleSchema = z.object({
  lead_id:z.string().uuid(), seller_id:z.string().uuid(), contract_number:z.string().trim().min(1).max(120),
  amount:moneySchema.refine(v=>new Prisma.Decimal(v).gt(0),'O crédito vendido deve ser maior que zero'),
  sold_on:dateSchema, note:z.string().trim().max(3000).default(''),
}).strict();
export const updateSaleSchema = saleSchema.extend({expectedVersion:z.number().int().positive()});
export const cancelSchema = z.object({expectedVersion:z.number().int().positive(),reason:z.string().trim().min(3).max(1000)}).strict();
export const plGoalSchema = z.object({amount:moneySchema,expectedVersion:z.number().int().min(0)}).strict();
export function monthlySummary(sales: {amount:Prisma.Decimal.Value;status:string}[], target:Prisma.Decimal.Value|null) {
  const active=sales.filter(s=>s.status==='ACTIVE'); const total=active.reduce((sum,s)=>sum.plus(s.amount),new Prisma.Decimal(0));
  const goal=target===null?null:new Prisma.Decimal(target);
  return {total:total.toFixed(2),contracts:active.length,target:goal?.toFixed(2)??null,remaining:goal?Prisma.Decimal.max(goal.minus(total),0).toFixed(2):null,percentage:goal&&!goal.isZero()?total.div(goal).times(100).toNumber():null};
}
