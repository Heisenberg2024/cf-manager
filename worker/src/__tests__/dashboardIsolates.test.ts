import {it,expect,vi} from 'vitest';
import {Hono} from 'hono';
import {dashboardDb} from '../../../shared/tests/dashboard.fixture.mjs';
const transport=vi.hoisted(()=>({calls:0}));
vi.mock('../services/cfApi',()=>({accountRequest:async()=>async(path:string)=>{transport.calls++;return path.includes('workers/scripts')?{result:[{id:'w1'},{id:'w2'}]}:{result:[],result_info:{page:1,per_page:10,count:0,total_pages:0,total_count:0}};}}));
it('independent Worker module graphs serve identical HTTP resources from the shared D1 database',async()=>{
 const f=dashboardDb();f.accounts(2,true);const env={DB:f.d1,ENCRYPTION_KEY:'synthetic',DASHBOARD_AUTO_COLLECT:'false'} as any;
 try {
  vi.resetModules();const a=(await import('../services/dashboardRuntime')).dashboardRuntime(env);const account=(await a.accounts())[0]!;
  await a.workers.read(account,await a.request(account),'workers',{refresh:true});
  const routeA=(await import('../routes/dashboard')).default;const appA=new Hono().route('/dashboard',routeA);
  const before=await (await appA.request('/dashboard/resources',{},env)).json() as any;
  vi.resetModules();const b=(await import('../services/dashboardRuntime')).dashboardRuntime(env);expect(b.zones).not.toBe(a.zones);expect(await b.workers.peek(account,'workers')).toBeUndefined();
  const routeB=(await import('../routes/dashboard')).default;const appB=new Hono().route('/dashboard',routeB);
  const after=await (await appB.request('/dashboard/resources',{},env)).json() as any;
  const persisted=(rows:any[])=>rows.map(({snapshotAgeMs:_,...row})=>row);expect(persisted(after.metrics)).toEqual(persisted(before.metrics));expect(after.metrics[1]).toMatchObject({value:2,state:'ready',totalAccounts:1});expect(transport.calls).toBe(1);
  f.sqlite.exec("UPDATE accounts SET name='Changed',updated_at='2030-01-01' WHERE id=1;");
  const renamed=await (await appB.request('/dashboard/resources',{},env)).json() as any;expect(renamed.metrics[1]).toMatchObject({value:2,state:'ready'});
  f.sqlite.exec("UPDATE credentials SET api_token='replacement' WHERE id=1;");expect((await (await appB.request('/dashboard/resources',{},env)).json() as any).metrics[1].value).toBeNull();
 }finally{f.sqlite.close();}
});
