import { beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../types';
const mocks=vi.hoisted(()=>({account:vi.fn(),request:vi.fn(),audit:vi.fn()}));
vi.mock('../db/models',()=>({getAccountById:mocks.account,getActiveAccountsByFeature:vi.fn(),addAuditLog:mocks.audit}));
vi.mock('../services/cfApi',()=>({accountRequest:mocks.request,cfFetch:vi.fn(),cfFetchAll:vi.fn()}));
import dns from '../routes/dns';
import { responseWrapper } from '../middleware/responseWrapper';
import type { BatchPreview } from '../services/dnsBatch';
import { errorDetails } from '../services/cfErrors';
const account={id:1,credential_id:10,is_active:1,is_enabled:1,enabled_features:'dns',account_id:'b'.repeat(32)};
const zone={accountId:1,credentialId:10,zoneId:'a'.repeat(32),zoneName:'a.com'};
const receipts=new Set<string>();
const db = {
  prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            if (sql.startsWith('DELETE')) return { meta: { changes: 0 } };
            const id = String(args[0]), changes = receipts.has(id) ? 0 : 1;
            receipts.add(id);
            return { meta: { changes } };
          },
        };
      },
    };
  },
};
const env={DB:db,ENCRYPTION_KEY:'synthetic-test-key'} as unknown as Env;
const app=new Hono<{Bindings:Env}>();app.use('*',responseWrapper);app.route('/dns',dns);app.onError((error,c)=>{const e=errorDetails(error);return c.json({error:{message:e.message,code:e.code}},e.statusCode as 400);});
beforeEach(()=>{vi.clearAllMocks();receipts.clear();mocks.account.mockResolvedValue(account);mocks.request.mockImplementation(()=>async(path:string,init:RequestInit={})=>path===`/zones/${zone.zoneId}`?{result:{id:zone.zoneId,name:zone.zoneName,account:{id:account.account_id}}}:init.method==='POST'?{result:{id:'created'}}:{result:[],result_info:{total_pages:1}});});
const send=async(path:string,body:unknown):Promise<Response>=>await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},env);
const json = async(response: Response) => await response.json() as {data: BatchPreview; error: {message: string}};
const spec={action:'create',zones:[zone],match:{host:'@',types:['TXT']},record:{type:'TXT',name:'@',content:'verification-token-secret',ttl:300,proxied:false}};
describe('Hono DNS batch HTTP / SSE',()=>{
 it('previews without writes, streams progress and rejects replay',async()=>{
  const response=await send('/dns/batch/preview',spec);expect(response.status).toBe(200);const plan=(await json(response)).data;expect(plan.items[0]!.status).toBe('READY');expect(mocks.audit).not.toHaveBeenCalled();
  const result=await send('/dns/batch/execute',plan);expect(result.headers.get('content-type')).toContain('text/event-stream');const events=(await result.text()).split('\n\n').filter(b=>b.startsWith('data:')).map(b=>JSON.parse(b.slice(6)));expect(events.map(e=>e.type)).toEqual(['start','item','item','done']);expect(events.at(-1).items[0].status).toBe('SUCCESS');expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('verification-token-secret');
  const repeat=await send('/dns/batch/execute',plan);expect(repeat.status).toBe(400);expect((await json(repeat)).error.message).toContain('already been executed');
 });
 it('rejects tampered previews and changed Account/Credential binding',async()=>{
  const plan=(await json(await send('/dns/batch/preview',spec))).data;plan.items[0]!.after!.content='attacker';expect((await send('/dns/batch/execute',plan)).status).toBe(400);
  mocks.account.mockResolvedValue({...account,credential_id:11});const result=(await json(await send('/dns/batch/preview',spec))).data;expect(result.items[0]!.status).toBe('ERROR');
 });
});
