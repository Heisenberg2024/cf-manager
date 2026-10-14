import { collectorFixture } from './dashboardCollector.contract';
import { dashboardAccounts, aggregateResources } from '../dashboardData';
import type * as Collector from '../dashboardCollector';
import { snapshotIdentity } from '../snapshotIdentity';
import { bindingSignature } from '../zoneDirectory';

export function dashboardConsistencyContract(label:string, impl:typeof Collector, {describe,it,expect}:any) {
 describe(label,()=>{
  it('keeps successful counts at 1m, 6m, 30m, 6h, 23h and after the daily refresh is due',async()=>{
   const f=collectorFixture();const row=await impl.collectResource(f.runtime,1,'workers') as any;
   const accounts=await dashboardAccounts(f.db);
   for(const age of [60000,360000,1800000,21600000,82800000,90000000]) {
    const metric=aggregateResources(accounts,[row],row.last_success_at+age).find(m=>m.metric==='workers');
    expect(metric).toMatchObject({value:1,state:'ready',complete:true,errorKind:null});
   }
   f.sqlite.close();
  });
  it('renaming or checking an Account preserves every persisted successful product',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');
   f.sqlite.prepare("UPDATE accounts SET name='Renamed',last_checked_at=CURRENT_TIMESTAMP,updated_at='2026-10-15' WHERE id=1").run();
   expect((await impl.dashboardResources(f.runtime)).metrics.find(m=>m.metric==='workers')).toMatchObject({value:1,state:'ready'});
   f.sqlite.close();
  });
  it('ordinary module results are shared with a cold runtime through the database',async()=>{
   const f=collectorFixture();const a=(await f.runtime.accounts())[0]!;
   await f.runtime.workers.read(a,await f.runtime.request(),'workers',{refresh:true});
   const cold=collectorFixture();cold.runtime.db=f.db;cold.runtime.accounts=f.runtime.accounts;
   const result=await impl.dashboardResources(cold.runtime);
   expect(result.metrics.find(m=>m.metric==='workers')).toMatchObject({value:1,state:'ready'});
   expect(cold.calls).toEqual([]);cold.sqlite.close();f.sqlite.close();
  });
  it('Dashboard never overlays an unpersisted process snapshot',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');
   f.runtime.workers.peek=async()=>({value:[{id:'old1'},{id:'old2'}],fetchedAt:Date.now()+1000});
   expect((await impl.dashboardResources(f.runtime)).metrics.find(m=>m.metric==='workers')!.value).toBe(1);
   f.sqlite.close();
  });
  it('a resource mutation retains the old count as pending without creating a read failure',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');await impl.collectResource(f.runtime,1,'zones');
   f.sqlite.prepare("INSERT INTO audit_log(account_id,action,status) VALUES(1,'create_worker','success')").run();
   const r=await impl.dashboardResources(f.runtime);
   expect(r.metrics.find(m=>m.metric==='workers')).toMatchObject({value:1,errorKind:null});
   expect(r.metrics.find(m=>m.metric==='zones')).toMatchObject({value:1,state:'ready'});
   expect(r.issues.some(i=>i.kind==='resourceRead')).toBe(false);
   f.sqlite.close();
  });
  it('long age is detail metadata, independent of actual failure and configured collection period',async()=>{
   const f=collectorFixture();const row=await impl.collectResource(f.runtime,1,'workers') as any;const accounts=await dashboardAccounts(f.db);
   expect(aggregateResources(accounts,[row],row.last_success_at+49*3600000)[1]).toMatchObject({value:1,state:'ready',longUnupdated:true,refreshState:'due',errorKind:null});
   expect(aggregateResources(accounts,[row],row.last_success_at+3*3600000,2)[1]).toMatchObject({state:'ready',longUnupdated:false,refreshState:'due'});
   expect(aggregateResources(accounts,[row],row.last_success_at+5*3600000,2)[1]).toMatchObject({longUnupdated:true});f.sqlite.close();
  });
  for(const sql of ["UPDATE credentials SET api_token='changed' WHERE id=1","UPDATE credentials SET auth_type='global_key',api_key='key',email='a@test' WHERE id=1","UPDATE accounts SET credential_id=2,account_id='another' WHERE id=1","UPDATE accounts SET account_id='another' WHERE id=1","UPDATE accounts SET proxy_enabled=1,proxy_url='http://example.test' WHERE id=1"])
   it(`security transition invalidates only the changed binding: ${sql}`,async()=>{
    const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');const previous=await snapshotIdentity((await f.runtime.accounts())[0]!);f.sqlite.exec(sql);
    expect(await snapshotIdentity((await f.runtime.accounts())[0]!)).not.toBe(previous);expect((await impl.dashboardResources(f.runtime)).metrics[1]!.value).toBeNull();f.sqlite.close();
   });
  it('credential A -> B -> A cannot accept a delayed result under the restored secret',async()=>{
   const f=collectorFixture();let resolve!:()=>void;f.setDelay(new Promise<void>(r=>resolve=r));const read=impl.collectResource(f.runtime,1,'workers');while(!f.calls.length)await new Promise(r=>setTimeout(r,1));
   f.sqlite.exec("UPDATE credentials SET api_token='changed' WHERE id=1;UPDATE credentials SET api_token='synthetic' WHERE id=1;");resolve();await expect(read).rejects.toThrow('changed');f.sqlite.close();
  });
  it('exact legacy signatures are inherited, ambiguous legacy signatures remain labelled history',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');const a=(await f.runtime.accounts())[0]!;
   f.sqlite.prepare("UPDATE resource_summaries SET identity=? WHERE account_id=1").run(await bindingSignature(a));expect((await impl.dashboardResources(f.runtime)).metrics[1]).toMatchObject({value:1,state:'ready'});
   f.sqlite.exec("UPDATE accounts SET updated_at='2030-01-01' WHERE id=1;");expect((await impl.dashboardResources(f.runtime)).metrics[1]).toMatchObject({value:null,historicalValue:1,refreshState:'historical',errorKind:null});f.sqlite.close();
  });
  it('older completed module reads cannot clear a newer mutation or replace a successful count',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');const a=(await f.runtime.accounts())[0]!;
   f.sqlite.exec("INSERT INTO audit_log(account_id,action,status) VALUES(1,'create_worker','success');");await impl.recordInventoryList(f.db,a,'workers',[{id:'stale'},{id:'stale2'}],1);
   expect((await impl.dashboardResources(f.runtime)).metrics[1]).toMatchObject({value:1,refreshState:'pending'});f.sqlite.close();
  });
  it('disabled, unbound and failed credential Accounts are distinct from collectible coverage',async()=>{
   const f=collectorFixture();f.accounts(3);f.sqlite.exec("UPDATE accounts SET is_enabled=0 WHERE id=1;UPDATE accounts SET account_id=NULL WHERE id=2;UPDATE credentials SET status='invalid' WHERE id=3;");
   const metrics=(await impl.dashboardResources(f.runtime)).metrics;expect(metrics[1]).toMatchObject({value:null,state:'unknown',collectibleAccounts:0,excludedAccounts:3});f.sqlite.close();
  });
  it('a disabled product cannot be interpreted as an empty remote directory',async()=>{
   const f=collectorFixture();f.sqlite.exec("UPDATE accounts SET enabled_features='dns' WHERE id=1;");expect((await impl.dashboardResources(f.runtime,1)).metrics[1]).toMatchObject({value:null,state:'unknown',complete:false});f.sqlite.close();
  });
  it('DNS, Workers, Storage and Tunnels ordinary reads persist independently and never erase peer counts',async()=>{
   const f=collectorFixture(),a=(await f.runtime.accounts())[0]!,request=await f.runtime.request();
   await f.runtime.zones.list(a,request,{refresh:true});await f.runtime.workers.read(a,request,'workers',{refresh:true});await f.runtime.workers.read(a,request,'pages',{refresh:true});await f.runtime.d1.databases(a,request,{refresh:true});await f.runtime.storage.allBuckets(a,request,{refresh:true});await f.runtime.tunnels.list(a,request,true);
   const rows=await f.db.all<any>('SELECT * FROM resource_summaries');expect(rows).toHaveLength(6);
   const prior=(await impl.dashboardResources(f.runtime)).metrics.map(m=>m.value);
   await f.runtime.zones.list(a,request,{refresh:true});expect((await impl.dashboardResources(f.runtime)).metrics.map(m=>m.value)).toEqual(prior);
   f.runtime.workers.peek=async()=>{throw Error('Dashboard GET must not peek module memory');};expect((await impl.dashboardResources(f.runtime)).metrics.map(m=>m.value)).toEqual(prior);f.sqlite.close();
  });
  it('confirmation time and snapshot version advance only on real changes, not GETs or cache hits',async()=>{
   const f=collectorFixture(),a=(await f.runtime.accounts())[0]!,request=await f.runtime.request();await f.runtime.workers.read(a,request,'workers',{refresh:true});
   const before=(await f.db.all<any>('SELECT * FROM resource_summaries'))[0],revision=(await f.db.all<any>('SELECT snapshot_revision FROM dashboard_scan_control'))[0].snapshot_revision;
   await f.runtime.workers.read(a,request,'workers');await impl.dashboardResources(f.runtime);expect((await f.db.all<any>('SELECT * FROM resource_summaries'))[0].last_success_at).toBe(before.last_success_at);expect((await f.db.all<any>('SELECT snapshot_revision FROM dashboard_scan_control'))[0].snapshot_revision).toBe(revision);f.sqlite.close();
  });
  it('an older healthy credential cannot replace the newer confirmed count after a failed refresh',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');await impl.collectResource(f.runtime,2,'workers');const now=Date.now();
   f.sqlite.prepare("UPDATE resource_summaries SET value=25,last_success_at=?,error_kind='permission',last_failed_at=? WHERE account_id=1").run(now,now);
   f.sqlite.prepare('UPDATE resource_summaries SET last_success_at=? WHERE account_id=2').run(now-3600000);
   expect((await impl.dashboardResources(f.runtime)).metrics[1]).toMatchObject({value:25,state:'error',lastSuccessAt:now});f.sqlite.close();
  });
  it('equal-time aliases remain deterministic across SQL row order and issues identify one Account owner',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'zones');await impl.collectResource(f.runtime,2,'zones');const rows=await f.db.all<any>('SELECT * FROM resource_summaries'),accounts=await dashboardAccounts(f.db);
   const equal=rows.map(s=>({...s,last_success_at:1000,fetched_at:1000,value:s.account_id===1?3:9}));expect(aggregateResources(accounts,equal)[0]!.value).toBe(aggregateResources(accounts,[...equal].reverse())[0]!.value);
   const issues=(await impl.dashboardResources(f.runtime)).issues.filter(i=>i.kind==='zonePending');expect(issues).toHaveLength(1);expect(issues[0]).toMatchObject({accountId:expect.any(Number),name:expect.stringContaining('Account')});f.sqlite.close();
  });
  it('missing authentication is unknown and excluded from collection instead of failing all products',async()=>{
   const f=collectorFixture();f.sqlite.exec("UPDATE accounts SET credential_id=NULL,api_token=NULL,api_key=NULL WHERE id=1;");
   expect((await impl.dashboardResources(f.runtime,1)).metrics[1]).toMatchObject({value:null,state:'unknown',collectibleAccounts:0,excludedAccounts:1});await expect(impl.collectResource(f.runtime,1,'workers')).rejects.toThrow('disabled');expect(f.calls).toEqual([]);f.sqlite.close();
  });
  it('an old runtime cannot promote a legacy row after a security epoch changed',async()=>{
   const f=collectorFixture();await impl.collectResource(f.runtime,1,'workers');const old=(await f.db.all<any>('SELECT * FROM resource_summaries'))[0];f.sqlite.exec("UPDATE credentials SET api_token='changed' WHERE id=1;");const a=(await f.runtime.accounts())[0]!;
   await f.db.run('INSERT INTO resource_summaries(account_id,cf_account_id,metric,identity,value,breakdown,fetched_at,last_success_at,error_kind) VALUES(?,?,?,?,?,?,?,?,NULL)',[1,a.account_id,'workers',await bindingSignature(a),old.value,old.breakdown,old.fetched_at,old.last_success_at]);
   expect((await impl.dashboardResources(f.runtime)).metrics[1]).toMatchObject({value:null,historicalValue:1,refreshState:'historical'});f.sqlite.close();
  });
  it('R2 SWR recovery returns history without a fake pending-read failure and persists the real completed refresh',async()=>{
   const f=collectorFixture(),a=(await f.runtime.accounts())[0]!,request=await f.runtime.request();await f.runtime.storage.allBuckets(a,request,{refresh:true});f.setFail(true);await expect(f.runtime.storage.allBuckets(a,request,{refresh:true})).rejects.toThrow();
   f.setFail(false);let release!:()=>void;f.setDelay(new Promise<void>(r=>release=r));expect(await f.runtime.storage.allBuckets(a,request)).toEqual([]);expect((await f.db.all<any>("SELECT error_kind FROM resource_summaries WHERE metric='r2'"))[0].error_kind).toBe('not_applicable');release();
   for(let i=0;i<100;i++){if((await f.db.all<any>("SELECT error_kind FROM resource_summaries WHERE metric='r2'"))[0].error_kind===null)break;await new Promise(r=>setTimeout(r,2));}
   expect((await impl.dashboardResources(f.runtime)).metrics[6]).toMatchObject({value:0,state:'ready',errorKind:null});f.sqlite.close();
  });
 });
}
