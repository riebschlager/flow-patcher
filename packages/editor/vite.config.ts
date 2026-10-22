/// <reference types="node" />
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Sampled Voice's samples and their notices live in the repo's vendor/ (vendor/README.md).
// Dev (and e2e, which runs `pnpm dev`) serves them read-only at /vendor; a build copies them
// into the output as they are.
const vendor = resolve(__dirname, '../../vendor');

function vendorPlugin(): Plugin {
  return {
    name: 'flow-patcher-vendor',
    configureServer(server) {
      server.middlewares.use('/vendor', (req, res) => {
        let file: string;
        try {
          file = resolve(vendor, '.' + decodeURIComponent((req.url ?? '').split('?')[0]!));
        } catch {
          res.statusCode = 400;
          return res.end();
        }
        // A 404, not Vite's index.html fallback, for anything that isn't a vendor file.
        if (req.method !== 'GET' || !file.startsWith(vendor + sep) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'max-age=3600');
        createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    },
    generateBundle() {
      for (const name of readdirSync(vendor)) {
        this.emitFile({ type: 'asset', fileName: `vendor/${name}`, source: readFileSync(resolve(vendor, name)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), vendorPlugin()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
