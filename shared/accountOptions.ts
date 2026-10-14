import { invalid, type LocalSql } from './auditQueries';
import { normalizeAccountName } from './accountName';
export interface AccountOption {id:number;name:string;account_id:string|null;credential_id:number|null;is_active:number;is_enabled:number;enabled_features:string;access_status:string;credential_status:string|null;worker_plan:string;updated_at:string;available_features:string;identity_version:string;is_demo?:boolean}
export async function accountOptions(db:LocalSql,feature?:unknown):Promise<AccountOption[]>{
 if(feature!==undefined&&feature!==''&&(!['ai','workers','browser_render','dns','storage','tunnels'].includes(String(feature))||typeof feature!=='string'))invalid('Invalid account feature');
 const rows=await db.all<AccountOption & {proxy_url:string;proxy_enabled:number;identity_fingerprint:string;credential_updated_at:string}>(`SELECT a.id,a.name,a.account_id,a.credential_id,a.is_active,a.is_enabled,a.enabled_features,a.access_status,a.worker_plan,a.updated_at,a.available_features,a.proxy_url,a.proxy_enabled,c.fingerprint AS identity_fingerprint,c.updated_at AS credential_updated_at,c.status AS credential_status FROM accounts a LEFT JOIN credentials c ON c.id=a.credential_id ORDER BY a.created_at DESC,a.id`);
 return Promise.all(rows.filter(a=>!feature||feature==='tunnels'||a.enabled_features.split(',').includes(String(feature))).map(async a=>{
  const bytes=new TextEncoder().encode(JSON.stringify([a.account_id,a.credential_id,a.updated_at,a.credential_updated_at,a.identity_fingerprint,a.proxy_url,a.proxy_enabled]));
  const identity_version=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  return {id:a.id,name:normalizeAccountName(a.name),account_id:a.account_id,credential_id:a.credential_id,is_active:a.is_active,is_enabled:a.is_enabled,enabled_features:a.enabled_features,access_status:a.access_status,credential_status:a.credential_status,worker_plan:a.worker_plan,updated_at:a.updated_at,available_features:a.available_features,identity_version};
 }));
}
