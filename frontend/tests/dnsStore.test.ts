import { beforeEach, describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
const mock=vi.hoisted(()=>({getRecords:vi.fn(),getSettings:vi.fn(),getDomains:vi.fn(),createDomains:vi.fn(),deleteDomains:vi.fn()}));
vi.mock('../src/api/dns',()=>({dnsApi:mock}));
import { useDnsStore } from '../src/stores/dnsStore';
function deferred<T>() {let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});
describe('DNS Account/Zone request scope and invalidation',()=>{
 it('preserves individual deletion failures when refreshing the list fails',async()=>{
  const result={total:1,succeeded:0,failed:1,results:[{name:'a.test',accountId:1,zoneId:'a',success:false,error:'Active Enterprise subscription'}]};
  mock.deleteDomains.mockResolvedValue({data:result});mock.getDomains.mockRejectedValue(Error('Refresh failed'));
  expect(await useDnsStore().deleteDomains([{name:'a.test',accountId:1,zoneId:'a'}])).toEqual(result);
 });
 it('preserves actual plan allocation receipts when the domain refresh fails',async()=>{
  const row={name:'a.test',success:true,zone_created:true,requested_plan:'enterprise',plan:{id:'enterprise'}};
  const result={total:1,succeeded:1,failed:0,fallback_count:0,pending_count:0,results:[row]};mock.createDomains.mockResolvedValue({data:result});mock.getDomains.mockRejectedValue(Error('Refresh timed out'));
  const store=useDnsStore();expect(await store.createDomains({names:['a.test'],account_id:1,type:'full',plan:'enterprise'})).toEqual(result);
  expect(mock.createDomains).toHaveBeenCalledWith({names:['a.test'],account_id:1,type:'full',plan:'enterprise'});
 });
 it('creates each normalized domain once and continues after both HTTP errors and unknown receipts',async()=>{
  mock.createDomains.mockRejectedValueOnce(Object.assign(Error('Rejected'),{response:{status:409}}))
   .mockRejectedValueOnce(Error('Connection lost'))
   .mockResolvedValueOnce({data:{total:1,results:[{name:'c.test',success:true,zone_created:true,requested_plan:'enterprise',plan:{id:'enterprise'}}]}});
  mock.getDomains.mockResolvedValue({data:[]});
  const result=await useDnsStore().createDomains({names:[' A.test ','b.test','a.test','c.test'],account_id:1,type:'full',plan:'enterprise'});
  expect(result).toMatchObject({total:3,succeeded:1,failed:2,fallback_count:0});
  expect(result.results.map(row=>row.outcome_uncertain)).toEqual([false,true,undefined]);
  expect(mock.createDomains.mock.calls.map(([input])=>input.names)).toEqual([['a.test'],['b.test'],['c.test']]);
  expect(mock.createDomains.mock.calls.map(([input])=>input.plan)).toEqual(['enterprise','enterprise','enterprise']);
 });
 it('carries an explicit capacity fallback across independent invocations while preserving the requested tier',async()=>{
  mock.createDomains.mockResolvedValueOnce({data:{total:1,results:[{name:'a.test',success:true,zone_created:true,requested_plan:'enterprise',fallback:true,warning:'Enterprise quota exceeded',plan:{id:'free'}}]}})
   .mockResolvedValueOnce({data:{total:1,results:[{name:'b.test',success:true,zone_created:true,requested_plan:'free',plan:{id:'free'}}]}});
  mock.getDomains.mockResolvedValue({data:[]});
  const result=await useDnsStore().createDomains({names:['a.test','b.test'],account_id:1,type:'full',plan:'enterprise'});
  expect(mock.createDomains.mock.calls.map(([input])=>input.plan)).toEqual(['enterprise','free']);
  expect(result.fallback_count).toBe(2);expect(result.results.map(row=>row.requested_plan)).toEqual(['enterprise','enterprise']);
 });
 it('pending activation does not enable Free fallback or stop later creation requests',async()=>{
  mock.createDomains.mockResolvedValueOnce({data:{total:1,results:[{name:'a.test',success:true,zone_created:true,requested_plan:'enterprise',activation_pending:true,plan:{id:'free'}}]}})
   .mockResolvedValueOnce({data:{total:1,results:[{name:'b.test',success:true,zone_created:true,requested_plan:'enterprise',plan:{id:'enterprise'}}]}});
  mock.getDomains.mockResolvedValue({data:[]});
  const result=await useDnsStore().createDomains({names:['a.test','b.test'],account_id:1,type:'full',plan:'enterprise'});
  expect(result).toMatchObject({succeeded:2,pending_count:1,fallback_count:0});
  expect(mock.createDomains.mock.calls.map(([input])=>input.plan)).toEqual(['enterprise','enterprise']);
 });
 it('reports each creation start and its actual receipt in order, including failed requests',async()=>{
  mock.createDomains.mockRejectedValueOnce(Error('Connection lost')).mockResolvedValueOnce({data:{total:1,results:[{name:'b.test',success:true,zone_created:true,requested_plan:'free',plan:{id:'free'}}]}});
  mock.getDomains.mockResolvedValue({data:[]});
  const events:Array<[string,boolean|string]>=[];
  await useDnsStore().createDomains({names:['a.test','b.test'],account_id:1,type:'full'},(name,result)=>events.push([name,result?.success ?? 'running']));
  expect(events).toEqual([['a.test','running'],['a.test',false],['b.test','running'],['b.test',true]]);
 });
 it('old reads cannot overwrite another Account binding of the same domain',async()=>{
  const old=deferred<{data:unknown[]}>();mock.getRecords.mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:[{id:'B'}]});const store=useDnsStore();
  const a=store.fetchRecords('same.com',{accountId:1,zoneId:'a'});await store.fetchRecords('same.com',{accountId:2,zoneId:'b'});old.resolve({data:[{id:'A'}]});await a;expect(store.records).toEqual([{id:'B'}]);expect(store.currentContext.accountId).toBe(2);
 });
 it('old errors/settings cannot replace current state',async()=>{
  const read=deferred<{data:unknown[]}>(),settings=deferred<{data:unknown}>();mock.getRecords.mockReturnValueOnce(read.promise).mockResolvedValueOnce({data:[{id:'B'}]});mock.getSettings.mockReturnValueOnce(settings.promise);const store=useDnsStore();
  const a=store.fetchRecords('a.com',{accountId:1,zoneId:'a'}),s=store.fetchZoneSettings('a.com',{accountId:1,zoneId:'a'});await store.fetchRecords('b.com',{accountId:2,zoneId:'b'});read.reject(Error('Old A failed'));settings.resolve({data:{ssl:'off'}});await Promise.all([a,s]);expect(store.recordsError).toBe('');expect(store.zoneSettings).toEqual({});expect(store.loading).toBe(false);
 });
 it('refreshes an affected current Zone and reads all other Zones fresh on next open',async()=>{
  const store=useDnsStore();mock.getRecords.mockResolvedValue({data:[]});await store.fetchRecords('a.com',{accountId:1,zoneId:'a'});
  await store.invalidateRecords([{accountId:2,credentialId:20,zoneId:'b',zoneName:'b.com'}]);expect(mock.getRecords).toHaveBeenCalledTimes(1);
  await store.invalidateRecords([{accountId:1,credentialId:10,zoneId:'a',zoneName:'a.com'}]);expect(mock.getRecords).toHaveBeenCalledTimes(2);
  await store.fetchRecords('b.com',{accountId:2,zoneId:'b'});await store.fetchRecords('a.com',{accountId:1,zoneId:'a'});expect(mock.getRecords).toHaveBeenCalledTimes(4);
 });
});
