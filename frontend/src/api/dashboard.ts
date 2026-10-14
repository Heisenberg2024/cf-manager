import client from './client';
import type { dashboardOverview, dashboardTrends, Metric, ResourceMetric, Attention } from '../shared/dashboardData';
import type { AuditEvent } from '../shared/auditQueries';
export type Overview = Awaited<ReturnType<typeof dashboardOverview>>;
export type Trends = Awaited<ReturnType<typeof dashboardTrends>>;
export interface ResourceOverview { metrics:Metric[]; issues:Attention[]; accounts:Array<{accountId:number;metrics:Metric[]}>; fetchedAt:number }
export interface AuditPage {items:AuditEvent[];nextCursor:string|null;timezone:string}
export const dashboardApi={
  overview:(params:Record<string,unknown>,signal?:AbortSignal)=>client.get<Overview>('/dashboard/overview',{params,signal,_silent:true}),
  resources:(params:Record<string,unknown>,signal?:AbortSignal)=>client.get<ResourceOverview>('/dashboard/resources',{params,signal,_silent:true}),
  trends:(params:Record<string,unknown>,signal?:AbortSignal)=>client.get<Trends>('/dashboard/trends',{params,signal,_silent:true}),
  activity:(params:Record<string,unknown>,signal?:AbortSignal)=>client.get<AuditPage>('/dashboard/activity',{params,signal,_silent:true}),
  collect:(accountId:number,metric:ResourceMetric,refresh:boolean,signal?:AbortSignal)=>client.post('/dashboard/collect',{accountId,metric,refresh},{signal,timeout:120000}),
};
