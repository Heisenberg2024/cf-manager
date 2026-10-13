import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('../src/api/client',()=>({default:{},API_BASE_URL:'/api'}));
import {dnsApi} from '../src/api/dns';
afterEach(()=>vi.unstubAllGlobals());
describe('Zone save SSE and legacy JSON',()=>{
 it('preserves a definite permission rejection so a batch does not label it as a lost write',async()=>{
  vi.stubGlobal('localStorage',{getItem:()=> 'synthetic'});const fetcher=vi.fn(async()=>Response.json({success:false,error:{code:'CF_PERMISSION',message:'SSL Write denied'}},{status:403}));vi.stubGlobal('fetch',fetcher);
  await expect(dnsApi.updateSettings('a.test',{changes:{ssl:'strict'}},{accountId:1,zoneId:'a'})).rejects.toMatchObject({errorMessage:'SSL Write denied',response:{status:403}});expect(fetcher).toHaveBeenCalledOnce();
 });
 it('receives actual per-field progress and the confirmed final result without retries',async()=>{
  const progress=vi.fn(),result={updated:['ssl'],fields:{ssl:{status:'updated'}},settings:{ssl:'strict'}};
  vi.stubGlobal('localStorage',{getItem:()=> 'synthetic'});const fetcher=vi.fn(async()=>new Response(`data: ${JSON.stringify({type:'progress',key:'ssl',stage:'done',completed:1,total:1,patchCount:1,status:'updated'})}\n\ndata: ${JSON.stringify({type:'done',result})}\n\n`,{headers:{'Content-Type':'text/event-stream'}}));vi.stubGlobal('fetch',fetcher);
  expect((await dnsApi.updateSettings('a.test',{changes:{ssl:'strict'},baseline:{ssl:'full'}},{accountId:1,zoneId:'a'},progress)).data).toEqual(result);expect(progress).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();
 });
 it('keeps interrupted writes unconfirmed and never sends a second PATCH',async()=>{
  vi.stubGlobal('localStorage',{getItem:()=> 'synthetic'});const fetcher=vi.fn(async()=>new Response('data: {"type":"progress","stage":"confirming"}\n\n',{headers:{'Content-Type':'text/event-stream'}}));vi.stubGlobal('fetch',fetcher);await expect(dnsApi.updateSettings('a.test',{ssl:'strict'},{accountId:1,zoneId:'a'})).rejects.toThrow('结果未确认');expect(fetcher).toHaveBeenCalledOnce();
 });
 it('continues accepting the old JSON receipt',async()=>{vi.stubGlobal('localStorage',{getItem:()=> 'synthetic'});vi.stubGlobal('fetch',async()=>Response.json({success:true,data:{updated:['ssl']}}));expect((await dnsApi.updateSettings('a.test',{ssl:'strict'})).data.updated).toEqual(['ssl']);});
});
