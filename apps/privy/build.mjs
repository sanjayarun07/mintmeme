// Bundles src/main.jsx into ../web/privy.bundle.js for the terminal. Run: npm install && npm run build (inside apps/privy).
import { build } from 'esbuild';
const r = await build({
  entryPoints: ['src/main.jsx'], bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: '../web/privy.bundle.js', metafile: true, logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' }, loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.json': 'json' }, jsx: 'automatic',
});
const out = Object.values(r.metafile.outputs)[0]; console.log(`built ../web/privy.bundle.js (${Math.round(out.bytes / 1024)} KiB)`);
