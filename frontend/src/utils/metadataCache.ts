/** Session-only metadata cache. Invalidating fences late results as well as completed entries. */
export class MetadataCache<T> {
 private entries=new Map<string,{value:T;expires:number}>();private flights=new Map<string,Promise<T>>();private revision=0;
 private ttl:number;constructor(ttl=30000){this.ttl=ttl;}
 clear(){this.revision++;this.entries.clear();this.flights.clear();}
 async read(key:string,load:()=>Promise<T>):Promise<T>{
  const cached=this.entries.get(key);if(cached&&Date.now()<cached.expires)return structuredClone(cached.value);
  const old=this.flights.get(key);if(old)return structuredClone(await old);
  const revision=this.revision;
  const promise=load().then(value=>{if(revision!==this.revision)throw new DOMException('Metadata invalidated','AbortError');this.entries.set(key,{value:structuredClone(value),expires:Date.now()+this.ttl});return value;});
  this.flights.set(key,promise);try{return structuredClone(await promise);}finally{if(this.flights.get(key)===promise)this.flights.delete(key);}
 }
}
