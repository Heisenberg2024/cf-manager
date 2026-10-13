import type { CfRequest } from './accountDiscovery';
import { errorDetails } from './cfErrors';
import { BoundReadCache, type CacheState } from './resourceCache';
import {bindingSignature,type DnsBinding} from './zoneDirectory';
import type { ReadMetric, ReadScheduler } from './readScheduler';
import type {ZoneSaveProgress, FieldStatus, ZoneSettingsResult} from './zoneSettingsEvents';
export type {FieldStatus} from './zoneSettingsEvents';

export const SETTING_PATHS: Record<string, string> = {
  ssl: 'ssl', always_use_https: 'always_use_https', security_level: 'security_level',
  automatic_https_rewrites: 'automatic_https_rewrites', cache_level: 'cache_level',
  browser_cache_ttl: 'browser_cache_ttl', development_mode: 'development_mode',
  zero_rtt: '0rtt', http2: 'http2', http3: 'http3', always_online: 'always_online',
  minify: 'minify', brotli: 'brotli',
};
export interface SettingMeta { editable: boolean; state?: 'available' | 'readonly' | 'unavailable' | 'error'; reason?: string; modifiedOn?: string }
export type Settings = Record<string, unknown> & { __meta: Record<string, SettingMeta>; __cache?: CacheState; __source?: 'bulk' | 'individual' };
export interface SettingsResult extends ZoneSettingsResult { settings: Settings }
const invalid = (message: string) => Object.assign(new Error(message), {statusCode:502,code:'CF_INVALID_RESPONSE'});
const deprecated = (key: string) => key === 'minify' || key === 'brotli';
const same = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function normalizeSettings(result: unknown): Settings {
  if (!Array.isArray(result)) throw invalid('Unexpected Cloudflare zone settings response');
  const settings: Settings = { __meta: {} };
  for (const item of result as Array<{ id: string; value: unknown; editable?: boolean; modified_on?: string }>) {
    const key = Object.keys(SETTING_PATHS).find(k => SETTING_PATHS[k] === item?.id);
    if (!key || !Object.hasOwn(item,'value')) continue;
    settings[key] = item.value;
    const editable = item.editable === true && !deprecated(key);
    const reason = deprecated(key) ? 'Cloudflare has deprecated this setting API' : item.editable === false ? 'Setting is read-only for this Zone or plan' : item.editable !== true ? 'Cloudflare did not confirm edit permission' : undefined;
    settings.__meta[key] = {editable,state:editable ? 'available' : 'readonly',...(reason ? {reason} : {}),...(item.modified_on ? {modifiedOn:item.modified_on} : {})};
  }
  return settings;
}
export function validateSetting(key: string, value: unknown): void {
  const enums: Record<string, unknown[]> = {
    ssl: ['off', 'flexible', 'full', 'strict'],
    security_level: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'],
    cache_level: ['basic', 'simplified', 'aggressive'],
  };
  if (!Object.hasOwn(SETTING_PATHS,key) || deprecated(key)) throw new Error('Unsupported or deprecated zone setting');
  if (key === 'browser_cache_ttl') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 31536000) throw new Error('Browser cache TTL must be an integer from 0 to 31536000');
  } else if (!(enums[key] || ['on','off']).includes(value)) throw new Error(`Invalid ${key} value`);
}
async function readField(request: CfRequest, zoneId: string, key: string): Promise<Settings> {
  const result = (await request(`/zones/${encodeURIComponent(zoneId)}/settings/${SETTING_PATHS[key]}`)).result as {id?:string;value?:unknown};
  if (!result || result.id !== SETTING_PATHS[key] || !Object.hasOwn(result,'value')) throw invalid('Unexpected Cloudflare setting response');
  return normalizeSettings([result]);
}
export async function readZoneSettings(request: CfRequest, zoneId: string, options: {individual?:boolean; keys?:string[]; onBulkUnavailable?:()=>void} = {}): Promise<Settings> {
  const keys = options.keys || Object.keys(SETTING_PATHS).filter(key=>!deprecated(key));
  if(keys.some(key=>!Object.hasOwn(SETTING_PATHS,key))) throw Object.assign(new Error('Unsupported setting field'),{statusCode:400});
  if (!options.individual) {
    try {
      const settings = normalizeSettings((await request(`/zones/${encodeURIComponent(zoneId)}/settings`)).result);
      if(!Object.keys(settings).some(key=>!key.startsWith('__')))throw invalid('Empty Zone settings response');
      for(const key of keys) if(!settings.__meta[key]) settings.__meta[key]={editable:false,state:'unavailable',reason:'Field absent from Cloudflare response'};
      return {...settings,__source:'bulk'};
    } catch(error) {
      // Permissions, rate limits and transport failures are not evidence of API retirement.
      if(![404,405,410,501].includes(errorDetails(error).statusCode) && (error as {code?:string}).code !== 'CF_INVALID_RESPONSE') throw error;
      options.onBulkUnavailable?.();
    }
  }
  const settings: Settings = {__meta:{},__source:'individual'};
  // One existing scheduler slot; sequential fallback preserves transport concurrency limits.
  for(const key of keys) {
    try { const field=await readField(request,zoneId,key); settings[key]=field[key];settings.__meta[key]=field.__meta[key]!; }
    catch(error) {settings.__meta[key]={editable:false,state:[403,404,410].includes(errorDetails(error).statusCode)?'unavailable':'error',reason:errorDetails(error).message};}
  }
  if(!Object.keys(settings).some(key=>!key.startsWith('__'))) throw invalid('No Zone settings could be read; previous snapshot retained');
  return settings;
}
export function parseSettingsWrite(body: Record<string,unknown>) {
  if(!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Invalid settings body'),{statusCode:400});
  const changes = Object.hasOwn(body,'changes') ? body.changes : body;
  if(!changes || typeof changes !== 'object' || Array.isArray(changes)) throw Object.assign(new Error('Invalid settings changes'),{statusCode:400});
  const baseline=body.baseline;
  if(baseline !== undefined && (!baseline || typeof baseline !== 'object' || Array.isArray(baseline))) throw Object.assign(new Error('Invalid settings baseline'),{statusCode:400});
  return {changes:changes as Record<string,unknown>,baseline:baseline as Record<string,unknown>|undefined};
}
export async function writeZoneSettings(request: CfRequest, zoneId: string, input: Record<string,unknown>, baseline?: Record<string,unknown>,onProgress?:(event:ZoneSaveProgress)=>Promise<void>|void): Promise<SettingsResult> {
  const result: SettingsResult={updated:[],failed:[],errors:{},fields:{},settings:{__meta:{}},patchCount:0,conflictDetection:'non-atomic'};
  const pending: Array<[string,unknown]> = [];
  const fail=(key:string,status:FieldStatus,reason:string)=>{result.fields[key]={status,reason};result.failed.push(key);result.errors[key]=reason;};
  const progress=async(key:string,stage:ZoneSaveProgress['stage'])=>{try{await onProgress?.({type:'progress',key,stage,...(stage==='done'?result.fields[key]:{}),completed:Object.keys(result.fields).length,total:Object.keys(input).length,patchCount:result.patchCount});}catch{/* A lost stream cannot turn a sent write into an automatic retry. */}};
  for(const [key,value] of Object.entries(input)) {
    try{validateSetting(key,value);}catch(error){fail(key,'failed',errorDetails(error).message);continue;}
    if(baseline && Object.hasOwn(baseline,key) && same(baseline[key],value)) {result.fields[key]={status:'unchanged'};continue;}
    pending.push([key,value]);
  }
  // Preflight all changed fields before writes. Any conflict stops the proposed save.
  for(const [key,value] of pending) {
    await progress(key,'checking');
    let remote: Settings;
    try {remote=await readField(request,zoneId,key);}
    catch(error){const reason=errorDetails(error).message;fail(key,[403,404,410].includes(errorDetails(error).statusCode)?'unavailable':'failed',reason);result.settings.__meta[key]={editable:false,state:'error',reason};continue;}
    result.settings[key]=remote[key];result.settings.__meta[key]=remote.__meta[key]!;
    if(same(remote[key],value)){result.fields[key]={status:'unchanged',actual:remote[key]};continue;}
    if(!remote.__meta[key]?.editable){fail(key,'unavailable',remote.__meta[key]?.reason || 'Setting is unavailable or read-only for this Zone');continue;}
    if(baseline && (!Object.hasOwn(baseline,key) || !same(remote[key],baseline[key]))) fail(key,'conflict','Remote value changed during editing; refresh and review before saving');
  }
  if(Object.values(result.fields).some(field=>field.status==='conflict')) {
    for(const [key] of pending) if(!result.fields[key]) fail(key,'conflict','Save stopped because another field changed remotely');
    for(const key of Object.keys(result.fields))await progress(key,'done');return result;
  }
  for(const key of Object.keys(result.fields))await progress(key,'done');
  for(const [key,value] of pending) {
    if(result.fields[key]) continue;
    let writeError: unknown;
    await progress(key,'saving');
    try {result.patchCount++;await request(`/zones/${encodeURIComponent(zoneId)}/settings/${SETTING_PATHS[key]}`,{method:'PATCH',body:JSON.stringify({value})});}
    catch(error){writeError=error;}
    await progress(key,'confirming');
    let actual:Settings;
    try {actual=await readField(request,zoneId,key);result.settings[key]=actual[key];result.settings.__meta[key]=actual.__meta[key]!;}
    catch(error){fail(key,'uncertain',writeError ? errorDetails(writeError).message : `Write receipt received, confirmation failed: ${errorDetails(error).message}`);await progress(key,'done');continue;}
    if(same(actual[key],value)) {result.updated.push(key);result.fields[key]={status:'updated',actual:actual[key],...(writeError?{reason:errorDetails(writeError).message}: {})};}
    else {
      const detail=writeError ? errorDetails(writeError) : undefined;
      const uncertain=detail && (detail.statusCode>=500 || detail.kind==='network' || detail.kind==='timeout');
      const reason=detail?.message || 'Cloudflare returned a different value; the interface now shows the remote value';
      fail(key,uncertain ? 'uncertain' : 'failed',reason);result.fields[key]={status:uncertain ? 'uncertain' : 'failed',reason,actual:actual[key]};
    }
    await progress(key,'done');
  }
  return result;
}
export class ZoneSettingsRuntime {
  readonly cache: BoundReadCache;
  private bulkUnavailable = new Map<string,number>();
  private saving = new Set<string>();
  constructor(directory: {scheduler:Pick<ReadScheduler,'run'>},private metric:(event:ReadMetric)=>void=()=>{}) {this.cache=new BoundReadCache(directory,metric);}
  async read(account:DnsBinding,request:CfRequest,zoneId:string,options:{refresh?:boolean;signal?:AbortSignal;waitUntil?:(promise:Promise<unknown>)=>void}={}) {
    const capability=`${await bindingSignature(account)}:${zoneId}`;
    const {value,cache}=await this.cache.read(account,`zone:${zoneId}`,signal=>readZoneSettings((path,init)=>request(path,{...init,signal}),zoneId,{individual:(this.bulkUnavailable.get(capability)||0)>Date.now(),onBulkUnavailable:()=>{this.bulkUnavailable.set(capability,Date.now()+300000);while(this.bulkUnavailable.size>500)this.bulkUnavailable.delete(this.bulkUnavailable.keys().next().value!);}}),options);
    return {...value,__cache:cache};
  }
  invalidate(accountId?:number,cfAccountId?:string|null,zoneId?:string){this.cache.invalidate(accountId,cfAccountId,zoneId ? `zone:${zoneId}` : undefined);if(accountId===undefined)this.bulkUnavailable.clear();}
  async write(account:DnsBinding,request:CfRequest,zoneId:string,body:Record<string,unknown>,onProgress?:(event:ZoneSaveProgress)=>Promise<void>|void) {
    const key=`${account.account_id}:${zoneId}`;
    if(this.saving.has(key)) throw Object.assign(new Error('This Zone is already saving'),{statusCode:409,code:'SETTINGS_SAVE_PENDING'});
    const {changes,baseline}=parseSettingsWrite(body); this.saving.add(key);
    try {const result=await writeZoneSettings(request,zoneId,changes,baseline,onProgress);this.metric({event:'settings_patches',accountId:account.id,attempt:result.patchCount});return result;}
    finally {this.invalidate(account.id,account.account_id,zoneId);this.saving.delete(key);}
  }
}
