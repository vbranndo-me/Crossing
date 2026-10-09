import { runJob } from './job.ts';
import type { Job } from './job.ts';

self.onmessage = async (e: MessageEvent<Job>) => {
  const result = await runJob(e.data);
  self.postMessage(result, { transfer: [result.cells.buffer] });
};
