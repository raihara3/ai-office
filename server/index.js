// ai-office entry point: wires the application core to the HTTP/SSE transport
// and starts listening. `startServer` is also the embedding contract used by
// the Electron main process (see electron/main.js).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from './core.js';
import { createHttpServer } from './http.js';

const DEFAULT_PORT = Number(process.env.PORT ?? 4680);
const PUBLIC_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public'
);

// Bind to loopback only: the streamed session logs contain prompts and
// commands that must not be exposed to the local network.
export function startServer({ port = DEFAULT_PORT, publicDirectory = PUBLIC_DIRECTORY } = {}) {
  const core = createCore();
  core.start();
  const server = createHttpServer(core, { publicDirectory });
  server.listen(port, '127.0.0.1');
  const url = `http://127.0.0.1:${port}`;
  return {
    server,
    port,
    url,
    core,
    close() {
      server.close();
      core.stop();
    },
  };
}

// Run directly (`node server/index.js`): start and log the URL.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const { url } = startServer();
  console.log(`ai-office running at ${url}`);
}
