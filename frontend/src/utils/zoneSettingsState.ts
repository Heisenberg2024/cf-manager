type Snapshot = {settings:Record<string,any>;fetchedAt:number};
export type ZoneDraft = {form:Record<string,any>;baseline:Record<string,any>};
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const settingValues=(settings:Record<string,any>)=>Object.fromEntries(Object.entries(settings).filter(([key])=>!key.startsWith('__')));
/** Session-scoped, bounded memory only. Refresh updates clean fields and preserves dirty baselines. */
export class ZoneSettingsState {
  private snapshots=new Map<string,Snapshot>();
  private drafts=new Map<string,ZoneDraft>();
  private capacity:number;
  private maxBytes:number;
  constructor(capacity=30,maxBytes=1024*1024){this.capacity=capacity;this.maxBytes=maxBytes;}
  get(key:string){const entry=this.snapshots.get(key);if(entry&&Date.now()-entry.fetchedAt<180000){this.snapshots.delete(key);this.snapshots.set(key,entry);return entry;}return undefined;}
  canEdit(key:string){return this.drafts.has(key)||this.drafts.size<this.capacity||[...this.drafts.values()].some(draft=>!this.dirty(draft).length);}
  draft(key:string){let draft=this.drafts.get(key);if(!draft){if(!this.canEdit(key)){const form=settingValues(this.snapshots.get(key)?.settings || {});return {form,baseline:{...form}};}draft={form:{},baseline:{}};this.drafts.set(key,draft);}else{this.drafts.delete(key);this.drafts.set(key,draft);}this.trim();return draft;}
  dirty(draft:ZoneDraft){return Object.keys(draft.form).filter(key=>!equal(draft.form[key],draft.baseline[key]));}
  conflicts(draft:ZoneDraft,remote:Record<string,any>){return this.dirty(draft).filter(key=>Object.hasOwn(remote,key)&&!equal(draft.baseline[key],remote[key]));}
  accept(key:string,settings:Record<string,any>,fetchedAt=Date.now()){
    const draft=this.draft(key),dirty=new Set(this.dirty(draft));
    for(const [field,value] of Object.entries(settingValues(settings)))if(!dirty.has(field)){draft.form[field]=value;draft.baseline[field]=value;}
    this.snapshots.delete(key);this.snapshots.set(key,{settings:JSON.parse(JSON.stringify(settings)),fetchedAt});this.trim();return draft;
  }
  confirmed(key:string,settings:Record<string,any>,updated:string[],submitted:Record<string,any>){
    const draft=this.draft(key);
    for(const field of updated)if(equal(draft.form[field],submitted[field])){draft.form[field]=settings[field];draft.baseline[field]=settings[field];}
    return this.accept(key,settings,0);
  }
  cancel(key:string,remote:Record<string,any>){const draft=this.draft(key);draft.form=settingValues(remote);draft.baseline={...draft.form};return draft;}
  invalidate(accountId?:number,zoneId?:string){for(const key of new Set([...this.snapshots.keys(),...this.drafts.keys()]))if((!accountId||key.startsWith(`${accountId}:`))&&(!zoneId||key.split(':')[1]===zoneId)){this.snapshots.delete(key);if(!zoneId)this.drafts.delete(key);}}
  clear(){this.snapshots.clear();this.drafts.clear();}
  private trim(){
    while(this.snapshots.size>this.capacity||JSON.stringify([...this.snapshots.values()]).length*2>this.maxBytes)this.snapshots.delete(this.snapshots.keys().next().value!);
    while(this.drafts.size>this.capacity||JSON.stringify([...this.drafts.values()]).length*2>this.maxBytes){const clean=[...this.drafts].find(([,draft])=>!this.dirty(draft).length);if(!clean)break;this.drafts.delete(clean[0]);}
  }
}
