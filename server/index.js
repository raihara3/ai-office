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
//
// Returns a handle whose `ready` promise resolves (with the same handle) once
// the socket is accepting connections, or rejects on a bind failure such as
// EADDRINUSE. Callers must await `ready` before loading the URL. Pass port 0
// to bind an arbitrary free port; `url`/`port` are updated to the real one.
export function startServer({ port = DEFAULT_PORT, publicDirectory = PUBLIC_DIRECTORY } = {}) {
  const core = createCore();
  const server = createHttpServer(core, { publicDirectory });

  const handle = {
    server,
    core,
    port,
    url: `http://127.0.0.1:${port}`,
    ready: null,
    close() {
      try {
        server.close();
      } catch {
        // Server may never have started listening (failed bind); ignore.
      }
      core.stop();
    },
  };

  handle.ready = new Promise((resolve, reject) => {
    const onStartupError = (error) => reject(error);
    server.once('error', onStartupError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onStartupError);
      // Later runtime errors must not throw as unhandled 'error' events.
      server.on('error', (error) => console.error(`[ai-office] server error: ${error.message}`));
      // Start the watchers only once we actually own the port, so a failed
      // bind never leaves a set of file watchers running.
      core.start();
      const actualPort = server.address().port;
      handle.port = actualPort;
      handle.url = `http://127.0.0.1:${actualPort}`;
      resolve(handle);
    });
  });

  return handle;
}

// Run directly (`node server/index.js`): start, then log the URL or the error.
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  const embedded = startServer();
  embedded.ready
    .then(() => console.log(`ai-office running at ${embedded.url}`))
    .catch((error) => {
      console.error(`ai-office failed to start: ${error.message}`);
      process.exit(1);
    });
}
