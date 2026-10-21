/// <reference types="node" />
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Flow's WebAudioFont player and samples (8.3 MB) are served read-only from the sibling
// Flow checkout instead of being committed to the throwaway spike. M1 copies them into vendor/.
const flowVendor = resolve(__dirname, '../../flow/public/vendor');

function flowVendorPlugin(): Plugin {
  return {
    name: 'flow-vendor',
    configureServer(server) {
      if (!existsSync(flowVendor)) server.config.logger.warn(`[spike] ${flowVendor} not found: Sampled Voice needs the Flow checkout next to this repo.`);
      // Read-only, and a 404 (not Vite's index.html fallback) for anything that isn't a vendor file.
      server.middlewares.use('/vendor', (req, res) => {
        let file: string;
        try {
          file = resolve(flowVendor, '.' + decodeURIComponent((req.url ?? '').split('?')[0]));
        } catch {
          res.statusCode = 400;
          return res.end();
        }
        if (req.method !== 'GET' || !file.startsWith(flowVendor + sep) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'max-age=3600');
        createReadStream(file).on('error', () => res.destroy()).pipe(res);
      });
    },
  };
}

// host: true so the reference phone and tablet can open it over the LAN.
export default defineConfig({
  plugins: [react(), flowVendorPlugin()],
  server: { port: 5174, strictPort: true, host: true },
});
