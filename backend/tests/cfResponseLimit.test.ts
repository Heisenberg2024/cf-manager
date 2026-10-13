import {describe,it,expect} from 'vitest';
import {Response as NodeResponse} from 'node-fetch';
import {Readable} from 'node:stream';
import {createCfRequest} from '../src/services/accountDiscovery';
describe('D1 bounded responses on native and proxy transports',()=>{
 for(const mode of ['native','proxy','buffer'])it(`parses and limits ${mode} responses`,async()=>{
  const response=()=>mode==='native'?new Response(JSON.stringify({result:['value']})):new NodeResponse(mode==='proxy'?Readable.from([Buffer.from(JSON.stringify({result:['value']}))]):JSON.stringify({result:['value']}));
  expect(await createCfRequest(async()=>response(),{})('/fixture',{maxResponseBytes:100})).toEqual({result:['value']});
  let calls=0;const limited=createCfRequest(async()=>{calls++;return response();},{});await expect(limited('/fixture',{maxResponseBytes:4,retry:false})).rejects.toMatchObject({code:'D1_RESULT_LIMIT'});expect(calls).toBe(1);
 });
 it('does not retry explicit 429 when SQL retry is disabled and strips transport controls',async()=>{
  let calls=0,options:RequestInit|undefined;const request=createCfRequest(async(_path,init)=>{calls++;options=init;return new Response(JSON.stringify({success:false,errors:[{message:'Limited'}]}),{status:429});},{});
  await expect(request('/query',{method:'POST',retry:false,maxResponseBytes:1000})).rejects.toThrow('429');expect(calls).toBe(1);expect(options).not.toHaveProperty('retry');expect(options).not.toHaveProperty('maxResponseBytes');
 });
});
