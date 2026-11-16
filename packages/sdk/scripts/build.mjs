// Builds the standalone package into ./dist (plain JavaScript + .d.ts). No npm install needed:
// it uses any `tsc` on PATH (TypeScript 5.7+). Types for Node come from a @types/node folder,
// found via TYPES_ROOT (a node_modules/@types directory) or any node_modules above this folder.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const find = () => { if (process.env.TYPES_ROOT) return process.env.TYPES_ROOT; let d = here; for (;;) { const c = join(d, 'node_modules', '@types'); if (existsSync(join(c, 'node'))) return c; const u = dirname(d); if (u === d) return ''; d = u; } };
const roots = find();
if (!roots) { console.error('Could not find @types/node. Set TYPES_ROOT to a node_modules/@types folder that contains "node".'); process.exit(2); }
rmSync(join(here, 'dist'), { recursive: true, force: true });
const cfg = JSON.parse(readFileSync(join(here, 'tsconfig.build.json'), 'utf8'));
cfg.compilerOptions.typeRoots = [roots]; cfg.compilerOptions.types = ['node'];
const tmp = join(here, 'tsconfig.build.tmp.json'); writeFileSync(tmp, JSON.stringify(cfg));
const r = spawnSync('tsc', ['-p', tmp], { cwd: here, stdio: 'inherit' });
rmSync(tmp, { force: true });
if (r.status !== 0) { console.error('Build failed: fix the type errors above.'); process.exit(r.status ?? 1); }
cpSync(join(here, '../../docs/SDK_AND_API.md'), join(here, 'dist/SDK_AND_API.md'));
console.log('Built', join(here, 'dist'));
