import type { BatchEvent } from '../shared/dnsBatch';
/** Consume SSE without EventSource (execute uses POST + Bearer authentication). */
export async function readBatchStream(response: Response, receive: (event: BatchEvent) => void): Promise<void> {
  if (!response.body) throw new Error('No batch response stream');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let done = false;
  try {
    for (;;) {
      const part = await reader.read(); buffer = (buffer + decoder.decode(part.value, { stream: !part.done })).replace(/\r\n/g, '\n');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as BatchEvent;
        if (event.type === 'error') throw new Error(event.message || 'Batch execution failed');
        if (event.type === 'done') done = true;
        receive(event);
      }
      if (part.done) break;
    }
    if (!done) throw new Error('Batch connection interrupted. Refresh DNS and preview again before retrying.');
  } finally { reader.releaseLock(); }
}
