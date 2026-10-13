import { describe, it, expect, vi } from 'vitest';
import { createDrawerReads } from '../src/utils/drawerReads';
function deferred<T>() { let resolve!: (v:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve}; }
describe('Settings drawer read reuse and sensitive state',()=>{
 it('reuses only the same resource/identity and clones editable values',async()=>{
  let id='1:a';const cache=createDrawerReads(()=>id);const fetch=vi.fn(async()=>({data:{name:'A',bindings:[{name:'X'}]}}));
  const value=await cache.read('settings',fetch);value.data.name='edited';expect((await cache.read('settings',fetch)).data.name).toBe('A');expect(fetch).toHaveBeenCalledOnce();
  id='2:a';await cache.read('settings',fetch);expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('does not retain Secret plaintext in nested bindings, env_vars or vars',async()=>{
  const cache=createDrawerReads(()=>'1:a');const secret={type:'secret_text',value:'secret-value',text:'secret-text',key_base64:'key'};
  const value=await cache.read('project',async()=>({data:{deployment_configs:{production:{env_vars:{PASSWORD:secret}}},vars:[{secret:true,value:'also-secret'}]}}));
  expect(JSON.stringify(value)).not.toContain('secret-value');expect(JSON.stringify(value)).not.toContain('secret-text');expect(JSON.stringify(value)).not.toContain('also-secret');
 });
 it('merges same-resource loads and refreshes only its target',async()=>{
  const cache=createDrawerReads(()=>'1:a');const task=vi.fn(async()=>({data:1}));await Promise.all([cache.read('domains',task),cache.read('domains',task)]);expect(task).toHaveBeenCalledOnce();
  await cache.read('schedules',task);await cache.read('domains',task,true);await cache.read('schedules',task);expect(task).toHaveBeenCalledTimes(3);
 });
 it('fetches a fresh tab after the 30 second read cache expires',async()=>{
  vi.useFakeTimers();
  try {
   vi.setSystemTime(1000);const cache=createDrawerReads(()=>'1:a');const task=vi.fn(async()=>({data:'fresh'}));
   await cache.read('settings',task);vi.setSystemTime(30000);await cache.read('settings',task);expect(task).toHaveBeenCalledOnce();
   vi.setSystemTime(31001);await cache.read('settings',task);expect(task).toHaveBeenCalledTimes(2);
  } finally {vi.useRealTimers();}
 });
 it('cancels old work and never lets a late response repopulate a changed identity',async()=>{
  let id='1:a';const cache=createDrawerReads(()=>id);const old=deferred<any>();let signal:AbortSignal|undefined;
  const pending=cache.read('settings',s=>{signal=s;return old.promise;});const rejected=expect(pending).rejects.toThrow();cache.cancel();id='1:b';old.resolve({data:'old'});await rejected;expect(signal?.aborted).toBe(true);
  expect(await cache.read('settings',async()=>({data:'new'}))).toEqual({data:'new'});
 });
 it('does not cache failures and surfaces the current error',async()=>{
  const errors:string[]=[];const cache=createDrawerReads(()=>'1:a',v=>errors.push(v));await expect(cache.read('project',async()=>{throw Error('permission');})).rejects.toThrow();
  expect(await cache.read('project',async()=>({data:3}))).toEqual({data:3});expect(errors).toEqual(['permission']);
 });
});
