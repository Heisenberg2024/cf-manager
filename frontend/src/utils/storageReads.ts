type Entry={value:any;expires:number;bytes:number};
export class StorageReadCache {
 private entries=new Map<string,Entry>();private revision=0;
 async read<T>(key:string,load:()=>Promise<T>,refresh=false):Promise<T>{
  const entry=this.entries.get(key),revision=this.revision;
  if(!refresh&&entry&&entry.expires>Date.now()){this.entries.delete(key);this.entries.set(key,entry);return JSON.parse(JSON.stringify(entry.value));}
  const value=await load();
  if(revision===this.revision){const bytes=JSON.stringify(value).length*2;this.entries.delete(key);if(bytes<=8*1024*1024)this.entries.set(key,{value:JSON.parse(JSON.stringify(value)),expires:Date.now()+30000,bytes});while(this.entries.size>60||[...this.entries.values()].reduce((sum,item)=>sum+item.bytes,0)>8*1024*1024)this.entries.delete(this.entries.keys().next().value!);}
  return value;
 }
 invalidate(predicate:(key:string)=>boolean=()=>true){this.revision++;for(const key of this.entries.keys())if(predicate(key))this.entries.delete(key);}
 get size(){return this.entries.size;}
}
export class CursorWindow {
 items:any[]=[];prefixes:string[]=[];cursor='';hasMore=false;seen=new Set<string>();dropped=0;
 apply(page:{items:any[];prefixes?:string[];cursor?:string;is_truncated?:boolean},cursor=''){
  if(!Array.isArray(page.items))throw Error('Invalid list page');
  const more=page.is_truncated ?? !!page.cursor;
  if(typeof more!=='boolean'||(page.cursor!==undefined&&typeof page.cursor!=='string')||(more&&(!page.cursor||page.cursor===cursor||this.seen.has(page.cursor))))throw Error('Invalid or repeated pagination cursor');
  if(cursor&&this.seen.has(cursor))return false;
  if(!cursor){this.items=[];this.prefixes=[];this.seen.clear();this.dropped=0;}
  const rows=new Map(this.items.map(row=>[row.key ?? row.name,row]));for(const row of page.items)rows.set(row.key ?? row.name,row);
  const values=[...rows.values()];this.dropped+=Math.max(0,values.length-2000);this.items=values.slice(-2000);this.prefixes=[...new Set([...this.prefixes,...(page.prefixes || [])])].slice(-2000);
  // Bound serialized values too; an individual oversized metadata row is omitted with a visible window count.
  while(JSON.stringify(this.items).length*2>4*1024*1024){this.items.shift();this.dropped++;}
  if(cursor)this.seen.add(cursor);while(this.seen.size>1000)this.seen.delete(this.seen.values().next().value!);
  this.cursor=more?page.cursor!:'';this.hasMore=more;return true;
 }
}
