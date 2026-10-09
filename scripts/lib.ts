import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** BENCH_QUICK=1 runs a tiny version of each benchmark, to smoke-test the harness. */
export const QUICK = !!process.env.BENCH_QUICK;
export const RUNS = QUICK ? 2 : 5;
export const SIZES = [200, 500, 1000];

export function machineInfo(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim(),
    cores: cpus.length,
    ramGB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    ...extra,
  };
}

export function writeRaw(name: string, data: unknown): string {
  const dir = resolve(ROOT, 'results/raw');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(`wrote ${file}`);
  return file;
}

export function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
