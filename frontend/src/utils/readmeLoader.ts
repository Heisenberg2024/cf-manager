export class ReadmeLoader {
 private controller?:AbortController;private revision=0;
 private cache=new Map<string,{content:string;baseUrl:string;expires:number}>();
 private fetcher:typeof fetch;private timeoutMs:number;
 constructor(fetcher:typeof fetch=(...args)=>fetch(...args),timeoutMs=8000){this.fetcher=fetcher;this.timeoutMs=timeoutMs;}
 cancel(){this.revision++;this.controller?.abort();}
 clear(){this.cancel();this.cache.clear();}
 async load(urls:string[]){
  this.cancel();const revision=this.revision,controller=new AbortController();this.controller=controller;
  const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  try{for(const raw of urls){controller.signal.throwIfAborted();const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password)continue;
   const cached=this.cache.get(url.href);if(cached&&Date.now()<cached.expires)return {content:cached.content,baseUrl:cached.baseUrl};
   try{const response=await this.fetcher(url.href,{signal:controller.signal,redirect:'error',credentials:'omit'});if(!response.ok)continue;
    if(Number(response.headers.get('content-length')||0)>1024*1024)throw Error('README exceeds 1 MiB');
    const reader=response.body?.getReader();if(!reader)continue;const decoder=new TextDecoder();let bytes=0,content='';
    try{while(true){const part=await reader.read();controller.signal.throwIfAborted();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1024*1024)throw Error('README exceeds 1 MiB');content+=decoder.decode(part.value,{stream:true});}content+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
    if(revision!==this.revision)throw new DOMException('Aborted','AbortError');if(!content||content.startsWith('404: Not Found'))continue;
    const result={content,baseUrl:new URL('.',url).href};this.cache.delete(url.href);this.cache.set(url.href,{...result,expires:Date.now()+300000});
    while(this.cache.size>20||[...this.cache.values()].reduce((n,r)=>n+r.content.length*2,0)>2*1024*1024)this.cache.delete(this.cache.keys().next().value!);
    return result;
   }catch(error){if(controller.signal.aborted||revision!==this.revision)throw error;}
  }return {content:'',baseUrl:''};}finally{clearTimeout(timer);}
 }
}
