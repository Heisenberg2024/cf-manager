import {describe,it,expect,vi,beforeAll,afterAll,beforeEach} from 'vitest';
import express from 'express';
import type {Server} from 'node:http';
const mock=vi.hoisted(()=>({account:vi.fn(),request:vi.fn(),audit:vi.fn(),config:{demoAccountIds:''}}));
vi.mock('../src/models/account',()=>({getAccountById:mock.account}));
vi.mock('../src/config',()=>({config:mock.config}));
vi.mock('../src/models/auditLog',()=>({createAuditLog:mock.audit}));
vi.mock('../src/services/cfFactory',()=>({accountRequest:mock.request,getCfClient:vi.fn()}));
vi.mock('../src/services/workerService',()=>({listKvNamespaces:vi.fn()}));
vi.mock('../src/services/logger',()=>({appLogger:{error:vi.fn(),warn:vi.fn()},apiLogger:{info:vi.fn()}}));
import router from '../src/routes/storage';
import {responseWrapper} from '../src/middleware/responseWrapper';
import {errorHandler} from '../src/middleware/errorHandler';
import {storageResources} from '../src/services/storageRuntime';
import {storageRoutesContract,storageHttpFixture} from '../../shared/tests/storageRoutes.contract';
let server:Server,base:string,fixture:ReturnType<typeof storageHttpFixture>;
beforeAll(async()=>{const app=express();app.use(express.json());app.use(responseWrapper);app.use('/storage',router);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.on('listening',r));const address=server.address();if(!address||typeof address==='string')throw Error('No test address');base=`http://127.0.0.1:${address.port}/storage`;});
afterAll(()=>new Promise<void>(r=>server.close(()=>r())));
beforeEach(()=>{vi.clearAllMocks();storageResources.invalidate();mock.config.demoAccountIds='';fixture=storageHttpFixture();mock.account.mockReturnValue({id:1,name:'fixture',account_id:'cf-a',credential_id:10,api_token:'synthetic',is_active:1,is_enabled:1,enabled_features:'storage',available_features:'r2'});mock.request.mockReturnValue(fixture.request);});
storageRoutesContract('Docker',{send:async(method,path,body)=>{const result=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const json=await result.json();return {status:result.status,data:json.data || json,cache:result.headers.get('Cache-Control')};},demo:value=>{mock.config.demoAccountIds=value?'1':'';},denyR2:()=>fixture.denyR2(),calls:()=>fixture.calls,audits:()=>mock.audit.mock.calls},{describe,it,expect,vi});

// This resource-only fixture has no local SQL database; persistence has dedicated HTTP/isolate integration coverage.
vi.mock('../src/services/dashboardCollector',async importOriginal=>({...await importOriginal<object>(),inventorySink:()=>async()=>{}}));
