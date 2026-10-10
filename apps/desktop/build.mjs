// Bundles the Electron main process and preload into CommonJS. The server, core and shared
// packages are ESM TypeScript (run with type stripping elsewhere), so they are bundled in too.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
  // The Ed25519 release public key is compiled into main.cjs.
  loader: { '.pem': 'text' },
};

await build({
  ...common,
  entryPoints: { main: 'src/main.ts' },
  outExtension: { '.js': '.cjs' },
  outdir: 'dist',
  // ws probes for these optional native add-ons inside try/catch; they are not installed.
  external: [...common.external, 'bufferutil', 'utf-8-validate'],
  // The server computes a default web root from import.meta.url at module load; in CJS that is
  // undefined, so map it to this bundle's own file URL (desktop passes webRoot explicitly).
  define: { 'import.meta.url': '__import_meta_url' },
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
});

await build({
  ...common,
  entryPoints: { preload: 'src/preload.ts', 'prompt-preload': 'src/prompt-preload.ts' },
  outExtension: { '.js': '.cjs' },
  outdir: 'dist',
});
