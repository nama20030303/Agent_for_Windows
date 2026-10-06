/**
 * Browser-only preview of the Nexus Code UI (no Electron backend).
 * Used for UI development and for remote preview environments.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5180, strictPort: true, cors: true, allowedHosts: true }
});
