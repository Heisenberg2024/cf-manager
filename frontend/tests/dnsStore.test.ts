import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
const mock=vi.hoisted(()=>({getRecords:vi.fn(),getSettings:vi.fn(),updateSettings:vi.fn(),purgeCache:vi.fn(),updateStatus:vi.fn(),getDomains:vi.fn(),getAccountDomains:vi.fn(),createDomains:vi.fn(),deleteDomains:vi.fn(),createRecord:vi.fn(),updateRecord:vi.fn(),deleteRecord:vi.fn(),updateProxy:vi.fn()}));
vi.mock('../src/api/dns',()=>({dnsApi:mock}));
import { useDnsStore } from '../src/stores/dnsStore';
function deferred<T>() {let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
beforeEach(()=>{setActivePinia(createPinia());vi.clearAllMocks();});
afterEach(()=>vi.restoreAllMocks());
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
 it('refreshes only affected Zones and reuses the successful refreshed snapshot',async()=>{
  const store=useDnsStore();mock.getRecords.mockResolvedValue({data:[]});await store.fetchRecords('a.com',{accountId:1,zoneId:'a'});
  await store.invalidateRecords([{accountId:2,credentialId:20,zoneId:'b',zoneName:'b.com'}]);expect(mock.getRecords).toHaveBeenCalledTimes(1);
  await store.invalidateRecords([{accountId:1,credentialId:10,zoneId:'a',zoneName:'a.com'}]);expect(mock.getRecords).toHaveBeenCalledTimes(2);
  await store.fetchRecords('b.com',{accountId:2,zoneId:'b'});await store.fetchRecords('a.com',{accountId:1,zoneId:'a'});expect(mock.getRecords).toHaveBeenCalledTimes(3);
 });
});

describe('DNS progressive reads and bounded in-memory snapshots', () => {
 const a = { accountId: 1, zoneId: 'a' }, b = { accountId: 2, zoneId: 'b' };
 const row = { id: 'record-1', type: 'A', name: 'api.a.test', content: '192.0.2.1', proxied: false, ttl: 300 };
 it('renders completed accounts while a slow account is still pending', async () => {
  const slow = deferred<any>();
  mock.getAccountDomains.mockImplementation((id: number) => id === 1 ? slow.promise : Promise.resolve({ data: { zones: [{ id: 'b', name: 'b.test', cfAccountId: 2 }], meta: { state: 'miss' } } }));
  const store = useDnsStore(); store.configureAccounts([{ id: 1 }, { id: 2 }]);
  const pending = store.fetchDomains(); await vi.waitFor(() => expect(store.domains).toHaveLength(1));
  expect(store.domainsLoading).toBe(true); expect(store.domains[0].cfAccountId).toBe(2);
  slow.resolve({ data: { zones: [{ id: 'a', name: 'a.test', cfAccountId: 1 }], meta: { state: 'miss' } } }); await pending;
  expect(store.domains).toHaveLength(2);
  expect(store.domains.map(zone => zone.cfAccountId)).toEqual([1, 2]);
 });
 it('keeps successful account data and exposes individual failure/retry state', async () => {
  mock.getAccountDomains.mockImplementation((id: number) => id === 2 ? Promise.reject(Error('CF permission denied')) : Promise.resolve({ data: { zones: [{ id: 'a', name: 'a.test', cfAccountId: 1 }], meta: { state: 'fresh' } } }));
  const store = useDnsStore(); store.configureAccounts([{ id: 1 }, { id: 2 }]); await store.fetchDomains();
  expect(store.domains).toHaveLength(1); expect(store.domainErrors[2]).toBe('CF permission denied'); expect(store.domainStates[1]).toBe('fresh');
 });
 it('shows stale Zones immediately, then replaces them with live revalidation', async () => {
  const fresh = deferred<any>(); mock.getAccountDomains.mockResolvedValueOnce({ data: { zones: [{ id: 'old', cfAccountId: 1 }], meta: { state: 'stale' } } }).mockReturnValueOnce(fresh.promise);
  const store = useDnsStore(); const pending = store.fetchDomains(false, [1]); await vi.waitFor(() => expect(store.domains[0]?.id).toBe('old'));
  fresh.resolve({ data: { zones: [{ id: 'new', cfAccountId: 1 }], meta: { state: 'miss' } } }); await pending; expect(store.domains[0].id).toBe('new'); expect(store.domainStates[1]).toBe('miss');
 });
 it('scopes loading to the chosen account and ignores previous scope responses', async () => {
  const slow = deferred<any>(); mock.getAccountDomains.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ data: { zones: [{ id: 'b', cfAccountId: 2 }], meta: { state: 'miss' } } });
  const store = useDnsStore(); const old = store.fetchDomains(false, [1]); await store.fetchDomains(false, [2]);
  slow.resolve({ data: { zones: [{ id: 'a', cfAccountId: 1 }], meta: { state: 'miss' } } }); await old; expect(store.domains.map(zone => zone.id)).toEqual(['b']);
 });
 it('reuses fresh records, displays stale records immediately, and forces a live refresh', async () => {
  mock.getRecords.mockResolvedValue({ data: [row] }); const store = useDnsStore(); await store.fetchRecords('a.test', a); await store.fetchRecords('b.test', b); await store.fetchRecords('a.test', a);
  expect(mock.getRecords).toHaveBeenCalledTimes(2);
  const slow = deferred<any>(); mock.getRecords.mockReturnValueOnce(slow.promise); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31000);
  const refresh = store.fetchRecords('a.test', a); expect(store.records).toEqual([row]); expect(store.loading).toBe(true);
  slow.resolve({ data: [{ ...row, ttl: 600 }] }); await refresh;
  await store.fetchRecords('a.test', a, true); expect(mock.getRecords).toHaveBeenCalledTimes(4);
 });
 it('updates/adds/removes confirmed records without downloading the entire Zone again', async () => {
  mock.getRecords.mockResolvedValue({ data: [row] }); const store = useDnsStore(); await store.fetchRecords('a.test', a);
  mock.updateRecord.mockResolvedValue({ data: { ...row, ttl: 600 } }); await store.saveRecord('a.test', a, { ttl: 600 }, row.id); expect(store.records[0].ttl).toBe(600);
  mock.createRecord.mockResolvedValue({ data: { ...row, id: 'new' } }); await store.saveRecord('a.test', a, row); expect(store.records).toHaveLength(2);
  mock.deleteRecord.mockResolvedValue({}); await store.removeRecord('a.test', a, row.id); expect(store.records.map(record => record.id)).toEqual(['new']); expect(mock.getRecords).toHaveBeenCalledTimes(1);
 });
 it('never treats a mutation during the first read as a complete one-row Zone snapshot', async () => {
  const first = deferred<any>(), fresh = deferred<any>(); mock.getRecords.mockReturnValueOnce(first.promise).mockReturnValueOnce(fresh.promise); mock.createRecord.mockResolvedValue({ data: { ...row, id: 'added' } });
  const store = useDnsStore(); const pending = store.fetchRecords('a.test', a); await store.saveRecord('a.test', a, row);
  expect(store.records).toEqual([]); expect(store.loading).toBe(true); fresh.resolve({ data: [row, { ...row, id: 'added' }] }); await vi.waitFor(() => expect(store.records).toHaveLength(2));
  first.resolve({ data: [] }); await pending; expect(store.records).toHaveLength(2);
 });
 it('optimistically toggles Proxy, restores the original value on failure, and evicts uncertain snapshots', async () => {
  mock.getRecords.mockResolvedValue({ data: [row] }); const store = useDnsStore(); await store.fetchRecords('a.test', a);
  const slow = deferred<any>(); mock.updateProxy.mockReturnValueOnce(slow.promise);
  const pending = store.toggleProxy('a.test', a, row.id, true); expect(store.records[0]).toMatchObject({ proxied: true, ttl: 1 });
  slow.reject(Error('Permission denied')); await expect(pending).rejects.toThrow('Permission'); expect(store.records[0]).toEqual(row);
  await store.fetchRecords('a.test', a); expect(mock.getRecords).toHaveBeenCalledTimes(2);
 });
 it('rolls back an acknowledged Proxy change when legacy response revalidation fails', async () => {
  mock.getRecords.mockResolvedValueOnce({ data: [row] }).mockRejectedValueOnce(Error('Revalidation failed')); mock.updateProxy.mockResolvedValueOnce({ data: { success: true } });
  const store = useDnsStore(); await store.fetchRecords('a.test', a); await expect(store.toggleProxy('a.test', a, row.id, true)).rejects.toThrow('Revalidation failed'); expect(store.records[0]).toEqual(row);
 });
 it('keeps a late successful mutation in its captured Account/Zone', async () => {
  mock.getRecords.mockResolvedValueOnce({ data: [row] }).mockResolvedValueOnce({ data: [{ ...row, id: 'B' }] }); const store = useDnsStore(); await store.fetchRecords('a.test', a);
  const slow = deferred<any>(); mock.updateRecord.mockReturnValueOnce(slow.promise); const save = store.saveRecord('a.test', a, { ttl: 600 }, row.id);
  await store.fetchRecords('b.test', b); slow.resolve({ data: { ...row, ttl: 600 } }); await save; expect(store.records[0].id).toBe('B');
  await store.fetchRecords('a.test', a); expect(store.records[0].ttl).toBe(600); expect(mock.getRecords).toHaveBeenCalledTimes(2);
 });
 it('evicts least-recently-used Zones and invalidates changed credential metadata', async () => {
  mock.getRecords.mockResolvedValue({ data: [row] }); const store = useDnsStore(); store.configureAccounts([{ id: 1, credential_id: 10 }]);
  for (let i = 0; i < 31; i++) await store.fetchRecords(`z${i}.test`, { accountId: 1, zoneId: `z${i}` });
  await store.fetchRecords('z0.test', { accountId: 1, zoneId: 'z0' }); expect(mock.getRecords).toHaveBeenCalledTimes(32);
  store.configureAccounts([{ id: 1, credential_id: 20 }]); expect(store.currentDomain).toBe(''); await store.fetchRecords('z0.test', { accountId: 1, zoneId: 'z0' }); expect(mock.getRecords).toHaveBeenCalledTimes(33);
 });
 it('bounds total record retention and clears sensitive data when the session ends', async () => {
  mock.getRecords.mockResolvedValue({ data: Array.from({ length: 10000 }, (_, i) => ({ ...row, id: String(i) })) }); const store = useDnsStore();
  for (let i = 0; i < 6; i++) await store.fetchRecords(`z${i}.test`, { accountId: 1, zoneId: `z${i}` });
  await store.fetchRecords('z0.test', { accountId: 1, zoneId: 'z0' }); expect(mock.getRecords).toHaveBeenCalledTimes(7);
  store.resetSensitiveState(); expect(store.records).toEqual([]); await store.fetchRecords('z0.test', { accountId: 1, zoneId: 'z0' }); expect(mock.getRecords).toHaveBeenCalledTimes(8);
 });
 it('does not let a write from an expired session poison the new session snapshot', async () => {
  mock.getRecords.mockResolvedValue({ data: [row] }); const store = useDnsStore(); await store.fetchRecords('a.test', a);
  const slow = deferred<any>(); mock.updateRecord.mockReturnValueOnce(slow.promise); const save = store.saveRecord('a.test', a, { ttl: 600 }, row.id);
  store.resetSensitiveState(); await store.fetchRecords('a.test', a); slow.resolve({ data: { ...row, ttl: 600 } }); await save; expect(store.records[0].ttl).toBe(300);
 });
 it('evicts deleted Zone aliases while preserving unrelated and failed Zone selections', async () => {
  mock.getRecords.mockResolvedValue({ data: [row] }); const store = useDnsStore(); await store.fetchRecords('alias.test', { accountId: 2, zoneId: 'shared-zone' });
  store.domains = [{ id: 'shared-zone', cfAccountId: 1 }, { id: 'shared-zone', cfAccountId: 2 }, { id: 'kept', cfAccountId: 3 }];
  store.forgetDeletedZones([{ name: 'alias.test', accountId: 1, zoneId: 'shared-zone', success: true }, { name: 'kept.test', accountId: 3, zoneId: 'kept', success: false }]);
  expect(store.currentDomain).toBe(''); expect(store.domains).toEqual([{ id: 'kept', cfAccountId: 3 }]); await store.fetchRecords('alias.test', { accountId: 2, zoneId: 'shared-zone' }); expect(mock.getRecords).toHaveBeenCalledTimes(2);
 });
});


describe('DNS adaptive server windows', () => {
 const target={accountId:1,zoneId:'large'};
 const page=(count=10000, id='first')=>({data:{records:[{id,type:'A',name:'api.test',content:'192.0.2.1'}],meta:{scope:'page',total_count:count}}});
 it('keeps a small Zone complete with one request and reads only one window for large Zones', async()=>{
  mock.getRecords.mockResolvedValueOnce(page(1));const store=useDnsStore();await store.fetchRecords('small.test',target);
  expect(store.recordMode).toBe('all');expect(mock.getRecords).toHaveBeenCalledTimes(1);
  mock.getRecords.mockResolvedValueOnce(page());await store.fetchRecords('large.test',{accountId:2,zoneId:'b'});
  expect(store.recordMode).toBe('page');expect(store.recordTotal).toBe(10000);expect(store.records).toHaveLength(1);
 });
 it('caches visited windows, includes filters in the key and preserves accurate totals', async()=>{
  mock.getRecords.mockResolvedValueOnce(page()).mockResolvedValueOnce(page(10000,'second')).mockResolvedValueOnce(page(3,'filtered'));
  const store=useDnsStore();await store.fetchRecords('large.test',target);await store.fetchRecordWindow(2);await store.fetchRecordWindow(1);
  expect(mock.getRecords).toHaveBeenCalledTimes(2);expect(store.records[0].id).toBe('first');
  await store.fetchRecordWindow(1,{type:'TXT',nameContains:'api'});expect(store.recordTotal).toBe(3);expect(store.zoneRecordTotal).toBe(10000);
 });
 it('isolates late pages and credential changes, and cancels the old consumer', async()=>{
  const late=deferred<any>();mock.getRecords.mockResolvedValueOnce(page()).mockReturnValueOnce(late.promise).mockResolvedValueOnce({data:[{id:'other'}]});
  const store=useDnsStore();await store.fetchRecords('large.test',target);const pending=store.fetchRecordWindow(2);
  const signal=mock.getRecords.mock.calls.at(-1)![2];await store.fetchRecords('other.test',{accountId:2,zoneId:'other'});
  late.resolve(page(10000,'late'));await pending;expect(signal.aborted).toBe(true);expect(store.records[0].id).toBe('other');
 });
 it('invalidates all aliases/windows after batch writes without fetching the entire Zone', async()=>{
  mock.getRecords.mockResolvedValue(page());const store=useDnsStore();await store.fetchRecords('large.test',target);await store.fetchRecordWindow(2);
  await store.invalidateRecords([{...target,credentialId:10,zoneName:'large.test'}]);expect(mock.getRecords.mock.calls.at(-1)![3]).toMatchObject({page:2,perPage:500});
  await store.fetchRecordWindow(1);expect(mock.getRecords).toHaveBeenCalledTimes(4);
 });
 it('drops old complete snapshots when a Zone grows and evicts aliases before partial local updates',async()=>{
  const alias={accountId:2,zoneId:'large'}, old={id:'old',type:'A',name:'old.test',content:'192.0.2.1',proxied:false,ttl:300};
  const fresh={id:'new',type:'A',name:'new.test',content:'192.0.2.2',proxied:false,ttl:300};
  mock.getRecords.mockResolvedValueOnce({data:[old]}).mockResolvedValueOnce({data:[old]}).mockResolvedValueOnce({data:{records:[fresh],meta:{total_count:10000}}}).mockResolvedValueOnce({data:{records:[{...fresh,proxied:true,ttl:1}],meta:{total_count:10000}}});
  const store=useDnsStore();await store.fetchRecords('large.test',alias);await store.fetchRecords('large.test',target);await store.fetchRecords('large.test',target,true);
  mock.updateProxy.mockResolvedValue({data:{...fresh,proxied:true,ttl:1}});await store.toggleProxy('large.test',target,'new',true);
  expect(mock.updateProxy).toHaveBeenCalledOnce();await store.fetchRecords('large.test',alias);expect(mock.getRecords).toHaveBeenCalledTimes(4);expect(store.records[0].id).toBe('new');expect(store.records[0].proxied).toBe(true);
 });
 it('refuses a full page without total metadata rather than claiming it is the whole Zone', async()=>{
  mock.getRecords.mockResolvedValue({data:{records:Array.from({length:500},(_,i)=>({id:String(i)})),meta:{scope:'page'}}});
  const store=useDnsStore();await store.fetchRecords('large.test',target);expect(store.recordsError).toContain('total unavailable');expect(store.records).toHaveLength(0);
 });
});


describe('Zone settings cache, drafts and operation identity',()=>{
 const a={accountId:1,zoneId:'a'},b={accountId:2,zoneId:'b'};
 const settings=(ssl='full')=>({data:{ssl,http2:'on',__meta:{ssl:{editable:true},http2:{editable:true}}}});
 async function select(){mock.getRecords.mockResolvedValue({data:[]});const store=useDnsStore();await store.fetchRecords('same.test',a);return store;}
 it('invalidates every Credential alias after batch writes without losing dirty drafts or accepting stale reads',async()=>{
  const store=await select();mock.getSettings.mockResolvedValue(settings());await store.fetchZoneSettings('same.test');store.settingForm.http2='off';
  const alias={accountId:3,zoneId:'a'};await store.fetchRecords('same.test',alias);await store.fetchZoneSettings('same.test');
  const slow=deferred<any>();mock.getSettings.mockReturnValueOnce(slow.promise);const oldRead=store.fetchZoneSettings('same.test',alias,true);
  mock.getSettings.mockResolvedValue(settings('strict'));await store.invalidateZoneSettings(['a']);slow.resolve(settings('off'));await oldRead;
  expect(store.zoneSettings.ssl).toBe('strict');expect(store.settingForm.ssl).toBe('strict');
  await store.fetchRecords('same.test',a);await store.fetchZoneSettings('same.test');expect(store.zoneSettings.ssl).toBe('strict');expect(store.settingForm.http2).toBe('off');expect(store.settingsDirty).toEqual(['http2']);
  const reads=mock.getSettings.mock.calls.length;await store.invalidateZoneSettings(['b']);expect(mock.getSettings).toHaveBeenCalledTimes(reads);
 });
 it('invalidates dirty computed dependencies after the UI first rendered an empty form',async()=>{
  const store=await select();expect(store.settingsDirty).toEqual([]);mock.getSettings.mockResolvedValue(settings());await store.fetchZoneSettings('same.test');store.settingForm.ssl='strict';expect(store.settingsDirty).toEqual(['ssl']);await store.fetchZoneSettings('same.test');expect(store.settingsDirty).toEqual(['ssl']);
 });
 it('shares settings reads across tab visits and preserves failed refresh snapshots',async()=>{
  const store=await select();mock.getSettings.mockResolvedValue(settings());await Promise.all([store.fetchZoneSettings('same.test'),store.fetchZoneSettings('same.test')]);await store.fetchZoneSettings('same.test');expect(mock.getSettings).toHaveBeenCalledTimes(1);
  mock.getSettings.mockRejectedValueOnce(Error('offline'));await store.fetchZoneSettings('same.test',a,true);expect(store.zoneSettings.ssl).toBe('full');expect(store.settingsError).toBe('offline');
 });
 it('preserves drafts and conflicts during forced refresh and A→B→A',async()=>{
  const store=await select();mock.getSettings.mockResolvedValue(settings());await store.fetchZoneSettings('same.test');store.settingForm.ssl='strict';mock.getSettings.mockResolvedValue(settings('flexible'));await store.fetchZoneSettings('same.test',a,true);
  expect(store.settingForm.ssl).toBe('strict');expect(store.settingsConflicts).toEqual(['ssl']);await store.fetchRecords('same.test',b);expect(store.settingForm).toEqual({});await store.fetchRecords('same.test',a);expect(store.settingForm.ssl).toBe('strict');store.cancelSettings();expect(store.settingForm.ssl).toBe('flexible');
 });
 it('cancels and ignores late settings from an older Zone or session',async()=>{
  const store=await select(),slow=deferred<any>();mock.getSettings.mockReturnValueOnce(slow.promise);const pending=store.fetchZoneSettings('same.test');await store.fetchRecords('same.test',b);mock.getSettings.mockResolvedValue(settings('off'));await store.fetchZoneSettings('same.test');slow.resolve(settings('strict'));await pending;expect(store.zoneSettings.ssl).toBe('off');store.resetSensitiveState();expect(store.settingForm).toEqual({});expect(store.zoneSettings).toEqual({});
 });
 it('empty saves do not call the API, partial saves clear only confirmed edits',async()=>{
  const store=await select();mock.getSettings.mockResolvedValue(settings());await store.fetchZoneSettings('same.test');await store.updateZoneSettings('same.test',{});expect(mock.updateSettings).not.toHaveBeenCalled();store.settingForm.ssl='strict';store.settingForm.http2='off';
  mock.updateSettings.mockResolvedValue({data:{updated:['ssl'],failed:['http2'],fields:{ssl:{status:'updated'},http2:{status:'failed'}},settings:{ssl:'strict',http2:'on',__meta:{ssl:{editable:true},http2:{editable:true}}}}});await store.updateZoneSettings('same.test',{ssl:'strict',http2:'off'});expect(store.settingsDirty).toEqual(['http2']);expect(store.settingsResults.http2.status).toBe('failed');expect(mock.updateSettings.mock.calls[0][1].baseline.ssl).toBe('full');
 });
 it('captures save target and blocks duplicates while another Zone remains usable',async()=>{
  const store=await select();mock.getSettings.mockResolvedValue(settings());await store.fetchZoneSettings('same.test');store.settingForm.ssl='strict';const slow=deferred<any>();mock.updateSettings.mockReturnValue(slow.promise);const pending=store.updateZoneSettings('same.test',{ssl:'strict'});await expect(store.updateZoneSettings('same.test',{ssl:'strict'})).rejects.toThrow('already saving');await store.fetchRecords('same.test',b);slow.resolve({data:{updated:['ssl'],fields:{ssl:{status:'updated'}},settings:{ssl:'strict',__meta:{ssl:{editable:true}}}}});await pending;expect(mock.updateSettings.mock.calls[0][2]).toEqual(a);expect(store.zoneSettings.ssl).toBeUndefined();await store.fetchRecords('same.test',a);expect(store.settingForm.ssl).toBe('strict');expect(store.settingsDirty).toEqual([]);
 });
 it('updates only the captured Zone after a fast switch',async()=>{
  const store=await select(),slow=deferred<any>();store.domains=[{id:'a',name:'same.test',cfAccountId:1,status:'active'},{id:'b',name:'same.test',cfAccountId:2,status:'active'}];mock.updateStatus.mockReturnValue(slow.promise);mock.getAccountDomains.mockResolvedValue({data:{zones:[],meta:{state:'fresh'}}});const pending=store.updateZoneStatus('same.test',true);await store.fetchRecords('same.test',b);slow.resolve({data:{id:'a',paused:true}});await pending;expect(store.domains.find(row=>row.id==='a')?.paused).toBe(true);expect(store.domains.find(row=>row.id==='b')?.status).toBe('active');expect(mock.getAccountDomains).not.toHaveBeenCalled();
 });
 it('purge is independent of settings caches and refuses missing receipts',async()=>{
  const store=await select();mock.getSettings.mockResolvedValue(settings());await store.fetchZoneSettings('same.test');mock.purgeCache.mockResolvedValue({data:{id:'receipt'}});await store.purgeZoneCache('same.test',{purge_everything:true});await store.fetchZoneSettings('same.test');expect(mock.getSettings).toHaveBeenCalledTimes(1);mock.purgeCache.mockResolvedValue({data:{}});await expect(store.purgeZoneCache('same.test',{files:['https://same.test/a']})).rejects.toThrow('receipt missing');
 });
});
