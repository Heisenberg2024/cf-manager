import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
const api=vi.hoisted(()=>({getAll:vi.fn(),getSummary:vi.fn()}));
vi.mock('../src/api/workers',()=>({workersApi:api}));
const metadata=vi.hoisted(()=>({getAll:vi.fn()}));
vi.mock('../src/api/accounts',()=>({accountsApi:metadata}));
import { useWorkerStore } from '../src/stores/workerStore';
const accounts=Array.from({length:3},(_,i)=>({id:i+1,name:`Account ${i+1}`,account_id:`cf-${i+1}`,credential_id:i+1,updated_at:'v1',is_enabled:1,is_active:1,enabled_features:'workers'}));
function deferred<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
beforeEach(()=>{setActivePinia(createPinia());vi.resetAllMocks();});
describe('Workers progressive account reads',()=>{
 it('shows metadata immediately and completes fast accounts while others are slow',async()=>{
  const slow=deferred<any>();api.getSummary.mockImplementation((id:number)=>id===2?slow.promise:Promise.resolve({data:[{accountId:id,workerCount:3,pagesCount:2}]}));
  const store=useWorkerStore();store.configureAccounts(accounts);store.selectedAccountId=1;const pending=store.fetchSummary();
  expect(store.summary).toHaveLength(3);expect(store.summary[1].workerCount).toBe(null);
  await vi.waitFor(()=>expect(store.summary[2].workerCount).toBe(3));expect(api.getSummary.mock.calls[0][0]).toBe(1);
  slow.resolve({data:[{accountId:2,workerCount:null,pagesCount:null,states:{workers:'permission',pages:'timeout'}}]});await pending;expect(store.summary[1].workerCount).toBe(null);
 });
 it('retains per-account read caches and evicts only changed aliases after writes',async()=>{
  api.getAll.mockImplementation((id:number)=>Promise.resolve({data:{items:[{id:`w${id}`,type:'worker'}],states:[{accountId:id,workers:'ready',pages:'ready'}]}}));
  const store=useWorkerStore();store.configureAccounts(accounts);store.selectedAccountId=1;await store.fetchWorkers(1);store.selectedAccountId=2;await store.fetchWorkers(2);store.selectedAccountId=1;await store.fetchWorkers(1);
  expect(api.getAll).toHaveBeenCalledTimes(2);store.invalidate([2]);await store.fetchWorkers(1);expect(api.getAll).toHaveBeenCalledTimes(2);
  store.invalidate([1]);await store.fetchWorkers(1);expect(api.getAll).toHaveBeenCalledTimes(3);
 });
 it('fences old list responses on account switching and resets sensitive state on logout',async()=>{
  const old=deferred<any>();api.getAll.mockReturnValueOnce(old.promise).mockResolvedValueOnce({data:[{id:'new',type:'worker'}]});const store=useWorkerStore();store.configureAccounts(accounts);
  store.selectedAccountId=1;const pending=store.fetchWorkers(1);const signal=api.getAll.mock.calls[0][1].signal;store.selectedAccountId=2;await store.fetchWorkers(2);
  old.resolve({data:[{id:'old'}]});await pending;expect(signal.aborted).toBe(true);expect(store.workers[0].id).toBe('new');store.resetSensitiveState();expect(store.workers).toEqual([]);expect(store.summary).toEqual([]);
 });
 it('does not turn partial failures into successful zero-resource counts',async()=>{
  const store=useWorkerStore();store.configureAccounts(accounts);store.selectedAccountId=1;
  api.getAll.mockResolvedValue({data:{items:[],states:[{accountId:1,workers:'permission',pages:'timeout'}]}});await store.fetchWorkers(1);
  expect(store.resourceError).not.toBe('');expect(store.summary[0].workerCount).toBe(null);expect(store.summary[0].pagesCount).toBe(null);
 });
 it('keeps 21 confirmed Workers after a Pages failure and forces a complete manual refresh',async()=>{
  const store=useWorkerStore();store.configureAccounts(accounts);store.selectedAccountId=1;
  const workers=Array.from({length:21},(_,i)=>({id:`worker-${i}`,type:'worker'}));
  api.getAll.mockResolvedValueOnce({data:{items:workers,states:[{accountId:1,workers:'ready',pages:'error'}]}});
  await store.fetchWorkers(1);expect(store.workers).toHaveLength(21);expect(store.summary[0]).toMatchObject({workerCount:21,pagesCount:null,states:{workers:'ready',pages:'error'}});expect(store.resourceError).toBe('RESOURCE_READ_FAILED');
  const pages=Array.from({length:20},(_,i)=>({id:`project-${i}`,type:'pages'}));
  api.getAll.mockResolvedValue({data:{items:[...workers,...pages],states:[{accountId:1,workers:'ready',pages:'ready'}]}});
  await store.fetchWorkers(1,true);expect(api.getAll.mock.calls[1][1].refresh).toBe(true);expect(store.workers).toHaveLength(41);expect(store.summary[0]).toMatchObject({workerCount:21,pagesCount:20});expect(store.resourceError).toBe('');
  await store.fetchWorkers(1);expect(api.getAll).toHaveBeenCalledTimes(2);
 });
 it('does not cache a partial Pages failure as a complete successful list',async()=>{
  const store=useWorkerStore();store.configureAccounts(accounts);
  api.getAll.mockResolvedValue({data:{items:[{id:'w',type:'worker'}],states:[{accountId:1,workers:'ready',pages:'error'}]}});
  await store.fetchWorkers(1);await store.fetchWorkers(1);expect(api.getAll).toHaveBeenCalledTimes(2);expect(store.summary[0].pagesCount).toBe(null);
 });
 it('accepts verified zero resources and makes no resource calls without eligible accounts',async()=>{
  const store=useWorkerStore();metadata.getAll.mockResolvedValue({data:{accounts:[]}});await store.fetchSummary();expect(store.summary).toEqual([]);expect(api.getSummary).not.toHaveBeenCalled();
  store.configureAccounts(accounts);api.getAll.mockResolvedValue({data:{items:[],states:[{accountId:1,workers:'ready',pages:'ready'}]}});await store.fetchWorkers(1);expect(store.summary[0]).toMatchObject({workerCount:0,pagesCount:0});expect(store.resourceError).toBe('');
 });
 it('ignores late account metadata after logout',async()=>{
  const old=deferred<any>();metadata.getAll.mockReturnValue(old.promise);const store=useWorkerStore();const pending=store.fetchSummary();store.resetSensitiveState();old.resolve({data:{accounts}});await pending;expect(store.summary).toEqual([]);expect(api.getSummary).not.toHaveBeenCalled();
 });
 it('discards caches and statistics when credential identity changes',async()=>{
  const store=useWorkerStore();store.configureAccounts(accounts);store.selectedAccountId=1;api.getSummary.mockResolvedValue({data:[{accountId:1,workerCount:7,pagesCount:3,requests:15}]});await store.fetchAccountSummary(1);
  store.configureAccounts(accounts.map(a=>a.id===1?{...a,credential_id:99}:a));expect(store.summary[0].workerCount).toBe(null);expect(store.summary[0].requests).toBe(null);
 });
});
