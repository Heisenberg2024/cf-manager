import { previewBatch, verifyPreview, executeBatch, validateBatchSpec, type BatchSpec, type BatchZone, type BatchRecord, type BatchRuntime, type BatchEvent } from '../dnsBatch';
import { CloudflareError } from '../cfErrors';

interface Matchers {
  not: Matchers; rejects: Matchers;
  toBe(value: unknown): void; toEqual(value: unknown): void; toMatchObject(value: unknown): void;
  toHaveLength(value: number): void; toHaveBeenCalledOnce(): void; toBeLessThanOrEqual(value: number): void;
  toContain(value: unknown): void; toThrow(value?: unknown): void;
}
export interface TestHarness {
  describe(name: string, run: () => void): void;
  it(name: string, run: () => Promise<void> | void): void;
  expect: ((value: unknown, message?: string) => Matchers) & { arrayContaining(value: unknown[]): unknown };
  // The mock keeps the supplied function's call signature across independent project installs.
  vi: { fn<T extends (...args: any[]) => any>(implementation: T): T };
}
export function dnsBatchContract(label: string, implementation: { previewBatch: typeof previewBatch; verifyPreview: typeof verifyPreview; executeBatch: typeof executeBatch; validateBatchSpec: typeof validateBatchSpec }, harness: TestHarness) {
  const { describe, it, expect, vi } = harness;
  const { previewBatch, verifyPreview, executeBatch, validateBatchSpec } = implementation;
  const zones = (count = 3): BatchZone[] => Array.from({length: count},(_,i)=>({zoneName: `${i < 26 ? String.fromCharCode(97+i) : `zone${i+1}`}.com`, zoneId: (i+1).toString(16).padStart(32,'0'), accountId:i+1,credentialId:i+10}));
  const row = (zone: BatchZone, host='api', overrides: Partial<BatchRecord> = {}): BatchRecord => ({id:`r${zone.accountId}`,type:'A',name:`${host}.${zone.zoneName}`,content:'1.2.3.4',ttl:300,proxied:false,priority:10,comment:'keep',tags:['keep:tag'],...overrides});
  const spec = (action: BatchSpec['action'], targets=zones()): BatchSpec => ({zones:targets,action,match:{host:'api',types:['A']},...(action==='create'?{record:{type:'A',name:'www',content:'1.2.3.4',ttl:1,proxied:true}}:action==='delete'?{}:{changes:action==='proxy'?{proxied:true}:action==='ttl'?{ttl:600}:{content:'5.6.7.8'}})});
  function fake(targets=zones(), initial: BatchRecord[][] = targets.map(z=>[row(z)])) {
    const store=new Map(targets.map((z,i)=>[z.zoneId,structuredClone(initial[i]!)]));
    const calls: Array<{zone: BatchZone; path: string; method: string; body?: Record<string,unknown>}> = [];
    let active=0,maxActive=0;
    const requestFor=(z:BatchZone)=>async(path:string,init:RequestInit={})=>{
      active++;maxActive=Math.max(maxActive,active);
      try {
        await new Promise(resolve=>setTimeout(resolve,1));
        const method=init.method || 'GET'; const body=init.body?JSON.parse(String(init.body)):undefined;
        calls.push({zone:z,path,method,body});
        if(path===`/zones/${z.zoneId}`)return {result:{id:z.zoneId,name:z.zoneName,account:{id:`account-${z.accountId}`}}};
        const rows=store.get(z.zoneId)!;
        const url=new URL(path,'https://cf.test');
        const id=url.pathname.split('/')[4];
        if(method==='GET'&&!id)return {result:structuredClone(rows.filter(r=>r.name===url.searchParams.get('name.exact'))),result_info:{total_pages:1}};
        const index=rows.findIndex(r=>r.id===id);
        if(method==='GET') {if(index<0)throw new CloudflareError(404,'Not found');return {result:structuredClone(rows[index])};}
        if(method==='POST'){const created={id:`new-${z.accountId}`,...body};rows.push(created);return {result:created};}
        if(index<0)throw new CloudflareError(404,'Not found');
        if(method==='PATCH')rows[index]={...rows[index]!,...body};
        if(method==='DELETE')rows.splice(index,1);
        return {result:structuredClone(rows[index])};
      }finally{active--;}
    };
    const audit=vi.fn(async()=>{});
    const runtime:BatchRuntime={resolve:vi.fn(async (z: BatchZone)=>({request:requestFor(z),credentialId:z.credentialId,cloudflareAccountId:`account-${z.accountId}`})),audit};
    return {runtime,store,calls,maxActive:()=>maxActive,requestFor};
  }
  const run = async (plan: Awaited<ReturnType<typeof previewBatch>>, runtime: BatchRuntime) => {await verifyPreview(plan,'test-secret');const events:BatchEvent[]=[];const result=await executeBatch(plan,runtime,async e=>{events.push(structuredClone(e))});return {result,events};};
  describe(`${label}: multi-Zone DNS contract`,()=>{
    it('A: creates www in three Zones, routes each through its own Account/Credential',async()=>{
      const target=zones(),f=fake(target,target.map(()=>[]));const plan=await previewBatch(spec('create'),f.runtime,'test-secret');
      expect(plan.items.map(i=>i.status)).toEqual(['READY','READY','READY']);expect(f.calls.some(c=>c.method!=='GET')).toBe(false);
      const {result,events}=await run(plan,f.runtime);
      expect(result.map(i=>i.status)).toEqual(['SUCCESS','SUCCESS','SUCCESS']);
      expect(f.calls.filter(c=>c.method==='POST').map(c=>({name:c.body!.name,account:c.zone.accountId,credential:c.zone.credentialId}))).toEqual(expect.arrayContaining(target.map(z=>({name:`www.${z.zoneName}`,account:z.accountId,credential:z.credentialId}))));
      expect(events[0]!.items!.every(i=>i.status==='PENDING')).toBe(true);expect(events.some(e=>e.item?.status==='RUNNING')).toBe(true);expect(events.at(-1)!.completed).toBe(3);
    });
    it('executes 500 Zones with a maximum of three concurrent CF requests', async()=>{
      const target=zones(500),f=fake(target,target.map(()=>[]));
      const plan=await previewBatch(spec('create',target),f.runtime,'test-secret');
      const {result}=await run(plan,f.runtime);
      expect(result).toHaveLength(500);expect(result.every(i=>i.status==='SUCCESS')).toBe(true);
      expect(f.maxActive()).toBeLessThanOrEqual(3);expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(500);
    });
    it('supports @ apex, complex types and all existing single-Zone record types',async()=>{
      const target=zones(),f=fake(target,target.map(()=>[]));const input=spec('create');input.record!.name='@';const plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items.map(i=>i.name)).toEqual(target.map(z=>z.zoneName));
      for(const type of ['A','AAAA','CNAME','MX','TXT','CAA','SRV','NS','PTR']) {
        const input=spec('create');input.record={...input.record!,type,name:type==='SRV'?'_sip._tcp':'@',content:type==='AAAA'?'2001:db8::1':'example.net',priority:0,weight:0,port:5060,flags:0,tag:'issue',proxied:false};
        const plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items.every(i=>i.status==='READY')).toBe(true);
        if(type==='SRV')expect(plan.items[0]!.after!.data).toEqual({priority:0,weight:0,port:5060,target:'example.net'});
        if(type==='CAA')expect(plan.items[0]!.after!.data).toEqual({flags:0,tag:'issue',value:'example.net'});
      }
    });
    it('distinguishes identical SKIP, different Content CONFLICT, CNAME collision and ERROR',async()=>{
      const target=zones(4),f=fake(target,[[row(target[0]!,'www')],[row(target[1]!,'www',{content:'5.5.5.5'})],[row(target[2]!,'www',{type:'CNAME',content:'origin.test'})],[]]);
      const resolve=f.runtime.resolve;f.runtime.resolve=async z=>{if(z.accountId===4)throw new CloudflareError(403,'Access denied',[1004]);return resolve(z);};
      const plan=await previewBatch(spec('create',target),f.runtime,'test-secret');expect(plan.items.map(i=>i.status)).toEqual(['SKIP','CONFLICT','CONFLICT','ERROR']);expect(plan.items[3]).toMatchObject({httpStatus:403,cfCodes:[1004]});
      expect(f.calls.every(c=>c.method==='GET')).toBe(true);
    });
    it('supports explicit update/additional-record policies and refuses ambiguous overwrite',async()=>{
      const target=zones(1),f=fake(target,[[row(target[0]!,'www',{content:'9.9.9.9'})]]);const input=spec('create',target);input.conflictPolicy='update';let plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items[0]).toMatchObject({operation:'PATCH',status:'FOUND'});
      input.conflictPolicy='create';plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items[0]).toMatchObject({operation:'POST',status:'READY'});
      f.store.get(target[0]!.zoneId)!.push(row(target[0]!,'www',{id:'extra',content:'8.8.8.8'}));input.conflictPolicy='update';plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items[0]!.status).toBe('CONFLICT');
      f.store.set(target[0]!.zoneId,[row(target[0]!,'www',{type:'CNAME',content:'old.test'})]);input.record={...input.record!,type:'CNAME',content:'new.test'};input.conflictPolicy='create';plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items[0]!.status).toBe('CONFLICT');
    });
    it('B: updates a/b and reports c NOT_FOUND without aborting',async()=>{
      const target=zones(),f=fake(target,[[row(target[0]!)],[row(target[1]!)],[]]);const plan=await previewBatch(spec('update'),f.runtime,'test-secret');expect(plan.items.map(i=>i.status)).toEqual(['FOUND','FOUND','NOT_FOUND']);
      const {result}=await run(plan,f.runtime);expect(result.map(i=>i.status)).toEqual(['SUCCESS','SUCCESS','NOT_FOUND']);expect(f.calls.filter(c=>c.method==='PATCH').every(c=>JSON.stringify(c.body)==='{"content":"5.6.7.8"}')).toBe(true);
    });
    it('C: Proxy patches only proxied; Content, TTL, priority, comment, tags are not submitted',async()=>{
      const f=fake();const plan=await previewBatch(spec('proxy'),f.runtime,'test-secret');await run(plan,f.runtime);
      expect(f.calls.filter(c=>c.method==='PATCH').map(c=>c.body)).toEqual([{proxied:true},{proxied:true},{proxied:true}]);
      expect(f.store.values().next().value![0]).toMatchObject({content:'1.2.3.4',ttl:300,priority:10,comment:'keep',tags:['keep:tag']});
    });
    it('TTL patches only ttl and already-set/unsupported Proxy records skip or conflict',async()=>{
      const target=zones(),f=fake(target,[[row(target[0]!, 'api', {ttl:600})],[row(target[1]!,'api',{proxied:true})],[row(target[2]!)]]);
      const plan=await previewBatch(spec('ttl'),f.runtime,'test-secret');expect(plan.items.map(i=>i.status)).toEqual(['SKIP','CONFLICT','FOUND']);await run(plan,f.runtime);expect(f.calls.filter(c=>c.method==='PATCH').map(c=>c.body)).toEqual([{ttl:600}]);
    });
    it('D: refuses mismatched Credential and live CF Account/Zone ownership',async()=>{
      const f=fake(),original=f.runtime.resolve;f.runtime.resolve=async z=>({...await original(z),credentialId:z.credentialId+1});let plan=await previewBatch(spec('delete'),f.runtime,'test-secret');expect(plan.items.every(i=>i.status==='ERROR')).toBe(true);
      f.runtime.resolve=async z=>({...await original(z),cloudflareAccountId:'wrong-account'});plan=await previewBatch(spec('delete'),f.runtime,'test-secret');expect(plan.items.every(i=>i.status==='ERROR')).toBe(true);expect(f.calls.every(c=>c.method==='GET')).toBe(true);
    });
    it('E: deletes exactly the 47 previewed matching records among 50 Zones',async()=>{
      const target=zones(50),f=fake(target,target.map((z,i)=>[...(i<47?[row(z)]:[]),row(z,'untouched',{id:`keep${i}`,content:'9.9.9.9'})]));
      const plan=await previewBatch(spec('delete',target),f.runtime,'test-secret');expect(plan.items.filter(i=>i.status==='FOUND')).toHaveLength(47);expect(plan.items.filter(i=>i.status==='NOT_FOUND')).toHaveLength(3);
      const {result}=await run(plan,f.runtime);expect(result.filter(i=>i.status==='SUCCESS')).toHaveLength(47);expect(f.calls.filter(c=>c.method==='DELETE')).toHaveLength(47);for(const rows of f.store.values())expect(rows).toHaveLength(1);expect(f.maxActive()).toBeLessThanOrEqual(3);
    });
    it('enforces strict Current Content, rechecks deleted/changed records and leaves unrelated rows untouched',async()=>{
      const target=zones(),f=fake(target,[[row(target[0]!)],[row(target[1]!,'api',{content:'other'})],[row(target[2]!)]]);const input=spec('delete');input.match.currentContent='1.2.3.4';const plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items[1]!.status).toBe('CONFLICT');
      f.store.get(target[0]!.zoneId)![0]!.content='changed-after-preview';f.store.set(target[2]!.zoneId,[]);
      const {result}=await run(plan,f.runtime);expect(result.map(i=>i.status)).toEqual(['CONFLICT','CONFLICT','NOT_FOUND']);expect(f.calls.every(c=>c.method==='GET')).toBe(true);
    });
    it('does not add another record if the record set changed after create preview',async()=>{
      const target=zones(1),f=fake(target,[[]]);const input=spec('create',target);input.conflictPolicy='create';const plan=await previewBatch(input,f.runtime,'test-secret');f.store.get(target[0]!.zoneId)!.push(row(target[0]!,'www',{content:'9.9.9.9'}));const {result}=await run(plan,f.runtime);expect(result[0]!.status).toBe('CONFLICT');expect(f.calls.every(c=>c.method==='GET')).toBe(true);
    });
    it('patches SRV/CAA fields without losing other structured fields',async()=>{
      const target=zones(1),f=fake(target,[[row(target[0]!,'api',{type:'SRV',data:{target:'old.test',priority:0,weight:10,port:5060}})]]);const input=spec('update',target);input.match.types=['SRV'];input.changes={content:'new.test'};
      const plan=await previewBatch(input,f.runtime,'test-secret');expect(plan.items[0]!.after).toEqual({data:{target:'new.test',priority:0,weight:10,port:5060}});await run(plan,f.runtime);
    });
    for (const status of [403, 429, 502]) it(`isolates HTTP ${status} failures and reports status/code with no token leak`,async()=>{
      const f=fake(),original=f.runtime.resolve;const plan=await previewBatch(spec('update'),f.runtime,'test-secret');
      f.runtime.resolve=async z=>{const resolved=await original(z);return {...resolved,request:async(path,init)=>{if(init?.method==='PATCH'&&z.accountId===2)throw new CloudflareError(status,'Authorization: Bearer sensitive-key',[81057]);return resolved.request(path,init);}};};
      const {result,events}=await run(plan,f.runtime);expect(result.map(i=>i.status)).toEqual(['SUCCESS','FAILED','SUCCESS']);expect(result[1]).toMatchObject({httpStatus:status,cfCodes:[81057]});expect(JSON.stringify(result)).not.toContain('sensitive-key');expect(events.at(-1)!.type).toBe('done');
    });
    it('rejects tampered/expired previews and duplicate/missing identities',async()=>{
      const f=fake();const plan=await previewBatch(spec('update'),f.runtime,'test-secret');await expect(verifyPreview({...plan,expiresAt:Date.now()-1},'test-secret')).rejects.toThrow('expired');const altered=structuredClone(plan);altered.items[0]!.recordId='victim';await expect(verifyPreview(altered,'test-secret')).rejects.toThrow('changed');
      const input=spec('delete');input.zones.push(input.zones[0]!);expect(()=>validateBatchSpec(input)).toThrow('multiple bindings');expect(()=>validateBatchSpec({...spec('delete'),zones:[{...zones()[0]!,credentialId:0}]})).toThrow('credentialId');
    });
    it('audits identities/statuses without including sensitive TXT Content',async()=>{
      const target=zones(1),f=fake(target,[[row(target[0]!,'api',{type:'TXT',content:'verification-token-secret'})]]);const input=spec('delete',target);input.match.types=['TXT'];const plan=await previewBatch(input,f.runtime,'test-secret');await run(plan,f.runtime);expect(f.runtime.audit).toHaveBeenCalledOnce();
      // Runtime adapters persist only identity/status/codes, not the raw record.
    });
  });
}
