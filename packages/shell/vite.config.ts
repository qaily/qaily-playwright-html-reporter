import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { createHandler } from '@qaily/reporter/server';

const repoRoot = resolve(__dirname, '../..');

/** Serves /data and /__qaily in dev, exactly like `qaily-report serve` does in production. */
function qailyData(): Plugin {
  const handler = createHandler({
    dataDir: resolve(repoRoot, process.env.QAILY_DATA_DIR ?? '.qaily/data'),
    attachmentsDir: process.env.QAILY_ATTACHMENTS_DIR ? resolve(repoRoot, process.env.QAILY_ATTACHMENTS_DIR) : undefined,
  });
  return {
    name: 'qaily-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/data/') || req.url?.startsWith('/__qaily/')) {
          handler(req, res, next).catch(next);
        } else next();
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths: the same build works at a domain root, a Pages subpath, or from `qaily-report serve`.
  base: './',
  plugins: [qailyData()],
  build: {
    outDir: resolve(repoRoot, '.qaily/app'),
    emptyOutDir: true,
    target: 'es2022',
    // three.js (~560 KB, lazy-loaded by the 3D theme views only) is the one large chunk; that is expected.
    chunkSizeWarningLimit: 600,
  },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  server: { port: 5173, host: '127.0.0.1' },
});
