import type { UserConfig } from 'vite';

export function developmentConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const port = Number(env.GUILDMASTER_DEV_PORT ?? '5173');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('GUILDMASTER_DEV_PORT must be a port between 1 and 65535.');
  }
  const backend = new URL(env.GUILDMASTER_API_URL ?? 'http://127.0.0.1:4173');
  if (backend.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(backend.hostname) ||
      backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('GUILDMASTER_API_URL must be a local HTTP service URL.');
  }
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  return {
    plugins: [{
      name: 'guildmaster-local-api',
      configureServer(server) {
        // Runs before Vite's proxy. Never turn a foreign Origin into a trusted one.
        server.middlewares.use((req, res, next) => {
          if (!/^\/api(?:\/|\?|$)/.test(req.url ?? '')) { next(); return; }
          if (!hosts.has(req.headers.host ?? '') ||
              (req.headers.origin !== undefined && !origins.has(req.headers.origin))) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'This origin cannot access Guildmaster.' }));
            return;
          }
          next();
        });
      },
    }],
    server: {
      host: '127.0.0.1', port, strictPort: true,
      proxy: {
        '^/api(?:/|\\?|$)': {
          target: backend.origin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyReq', (outgoing, incoming) => {
              if (incoming.headers.origin !== undefined) outgoing.setHeader('Origin', backend.origin);
            });
          },
        },
      },
    },
  };
}
