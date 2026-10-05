import { describe, it, expect } from 'vitest';
import { readBatchStream } from '../src/utils/batchStream';
describe('DNS batch progress stream',()=>{
 it('handles heartbeat, split UTF-8, CRLF and multiple events',async()=>{
  const text=': heartbeat\r\n\r\ndata: {"type":"item","message":"中文","completed":1}\r\n\r\ndata: {"type":"done","completed":2}\r\n\r\n';const encoded=new TextEncoder().encode(text);const events:unknown[]=[];
  const response=new Response(new ReadableStream({start(c){for(const byte of encoded)c.enqueue(Uint8Array.of(byte));c.close();}}));
  await readBatchStream(response,e=>events.push(e));expect(events).toEqual([{type:'item',message:'中文',completed:1},{type:'done',completed:2}]);
 });
 it('does not treat a broken response or server error as completion',async()=>{
  await expect(readBatchStream(new Response('data: {"type":"start"}\n\n'),()=>{})).rejects.toThrow('interrupted');
  await expect(readBatchStream(new Response('data: {"type":"error","message":"failed"}\n\n'),()=>{})).rejects.toThrow('failed');
 });
});
