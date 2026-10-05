import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
const mocks = vi.hoisted(()=>({ account: vi.fn(), request: vi.fn(), audit: vi.fn(), db: null as unknown }));
vi.mock('../src/models/account',()=>({getAccountById:mocks.account}));
vi.mock('../src/services/cfFactory',()=>({accountRequest:mocks.request, getCfClient: vi.fn()}));
vi.mock('../src/models/auditLog',()=>({createAuditLog:mocks.audit}));
vi.mock('../src/db',()=>({getDb:()=>mocks.db}));
vi.mock('../src/config',()=>({config:{encryptionKey:'synthetic-test-key'}}));
vi.mock('../src/services/accountRouter',()=>({getAllZones:vi.fn(),findAccountByDomain:vi.fn(),clearCache:vi.fn()}));
vi.mock('../src/services/logger',()=>({appLogger:{error:vi.fn()}}));
vi.mock('../src/routes/routeUtils',()=>({isDemoAccountId:()=>false}));
import backendDns from '../src/routes/dns';
import { responseWrapper } from '../src/middleware/responseWrapper';
import { errorDetails } from '../src/services/cfErrors';
const zone={accountId:1,credentialId:10,zoneId:'a'.repeat(32),zoneName:'a.com'};
const account={id:1,credential_id:10,is_active:1,is_enabled:1,enabled_features:'dns',account_id:'b'.repeat(32)};
const db = new Database(':memory:');
let server:Server,base:string;
beforeAll(async()=>{
 mocks.db=db;db.exec(readFileSync(new URL('../../worker/src/db/migrations/0012_dns_batch_executions.sql',import.meta.url),'utf8'));
 const app=express();app.use(express.json());app.use(responseWrapper);app.use('/dns',backendDns);app.use((error:unknown,_req:unknown,res:express.Response,_next:unknown)=>{const e=errorDetails(error);res.status(e.statusCode).json({error:{code:e.code,message:e.message}});});
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));const a=server.address();if(!a||typeof a==='string')throw Error('No server');base=`http://127.0.0.1:${a.port}`;
});
afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));db.close();});
beforeEach(()=>{
 vi.clearAllMocks();db.exec('DELETE FROM dns_batch_executions');mocks.account.mockReturnValue(account);
 mocks.request.mockImplementation(()=>async(path:string,init:RequestInit={})=>{
  if(path===`/zones/${zone.zoneId}`)return {result:{id:zone.zoneId,name:zone.zoneName,account:{id:account.account_id}}};
  if(init.method==='POST')return {result:{id:'created'}};
  return {result:[],result_info:{total_pages:1}};
 });
});
describe('Express DNS batch HTTP / SSE',()=>{
 const send=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const spec={action:'create',zones:[zone],match:{host:'@',types:['TXT']},record:{type:'TXT',name:'@',content:'verification-token-secret',ttl:300,proxied:false}};
 it('previews without writes, streams progress, and atomically consumes the receipt once',async()=>{
  const preview=await send('/dns/batch/preview',spec);expect(preview.status).toBe(200);const plan=(await preview.json()).data;expect(plan.items[0].status).toBe('READY');expect(mocks.audit).not.toHaveBeenCalled();
  const result=await send('/dns/batch/execute',plan);expect(result.headers.get('content-type')).toContain('text/event-stream');const events=(await result.text()).split('\n\n').filter(b=>b.startsWith('data:')).map(b=>JSON.parse(b.slice(6)));
  expect(events.map(e=>e.type)).toEqual(['start','item','item','done']);expect(events.at(-1).items[0].status).toBe('SUCCESS');expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('verification-token-secret');
  const repeat=await send('/dns/batch/execute',plan);expect(repeat.status).toBe(400);expect((await repeat.json()).error.message).toContain('already been executed');
 });
 it('rejects changed previews and stale Credential/Account metadata',async()=>{
  const plan=(await (await send('/dns/batch/preview',spec)).json()).data;plan.items[0].after.content='attacker';expect((await send('/dns/batch/execute',plan)).status).toBe(400);
  mocks.account.mockReturnValue({...account,credential_id:11});const result=(await (await send('/dns/batch/preview',spec)).json()).data;expect(result.items[0].status).toBe('ERROR');
 });
});
