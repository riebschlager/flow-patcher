import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// host: true so the reference phone and tablet can open it over the LAN.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, host: true },
});
