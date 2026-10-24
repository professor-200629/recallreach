import { existsSync, readFileSync } from 'node:fs';

/** Reads KEY=VALUE lines from .dev.vars; ZETARIS_* environment variables override them. */
export function loadDevVars(path = '.dev.vars'): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('ZETARIS_') && v) out[k] = v;
  return out;
}
