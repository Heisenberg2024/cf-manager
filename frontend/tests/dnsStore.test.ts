import { beforeEach, describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
const mock=vi.hoisted(()=>({getRecords:vi.fn(),getSettings:vi.fn(),getDomains:vi.fn(),createDomains:vi.fn()}));
vi.mock('../src/api/dns',()=>({dnsApi:mock}));
import { useDnsStore } from '../src/stores/dnsStore';
function deferred<T>() {let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});
describe('DNS Account/Zone request scope and invalidation',()=>{
 it('preserves actual plan allocation receipts when the domain refresh fails',async()=>{
  const result={total:5,succeeded:5,failed:0,fallback_count:2};mock.createDomains.mockResolvedValue({data:result});mock.getDomains.mockRejectedValue(Error('Refresh timed out'));
  const store=useDnsStore();expect(await store.createDomains({names:['a.test'],account_id:1,type:'full',plan:'enterprise'})).toEqual(result);
  expect(mock.createDomains).toHaveBeenCalledWith({names:['a.test'],account_id:1,type:'full',plan:'enterprise'});
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
