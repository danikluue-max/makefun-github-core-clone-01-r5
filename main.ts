// main.ts — the forge entrypoint, written for round 5.
// Binds an ephemeral port, registers it with the trial environment, then
// polls for the done signal and exits. When MAKEFUN_ENV_URL is unset the
// server simply stays up for local use.
// The register contract is { port: <int 1..65535> } — the env derives the
// entry's base URL from the register request's peer address plus that port.
//
// Extra work this entrypoint does (beyond the kit starter):
//   * validates its configuration before listening and fails loudly,
//   * prints a startup summary (port, mode, viewer login) so a smoke test
//     can confirm the forge is alive without guessing,
//   * shuts the server down cleanly on SIGTERM/SIGINT instead of exiting
//     mid-request, and exits with a distinct code on register failure.

import { Forge } from './src/store.ts';
import { handleRequest } from './src/router.ts';
import { createRawServer } from './src/rawhttp.ts';
import { VIEWER } from './src/viewer.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const DONE_POLL_MS = 250;
const DONE_MAX_WAIT_MS = 870_000;
const REGISTER_TIMEOUT_MS = 60_000;
const REGISTER_RETRY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envBaseUrl(envUrl: string): string {
  return envUrl.endsWith('/') ? envUrl.slice(0, -1) : envUrl;
}

/** Configuration sanity checks: fail before listening, not mid-trial. */
function validateConfig(envUrl: string): void {
  if (envUrl !== '' && !/^https?:\/\//.test(envUrl)) {
    throw new Error(`MAKEFUN_ENV_URL must be an http(s) URL, got ${JSON.stringify(envUrl)}`);
  }
  if (DONE_POLL_MS <= 0 || DONE_MAX_WAIT_MS <= 0 || REGISTER_TIMEOUT_MS <= 0) {
    throw new Error('internal timing constants must be positive');
  }
  if (typeof VIEWER.login !== 'string' || VIEWER.login.length === 0) {
    throw new Error('viewer user has no login; the seed data is broken');
  }
}

async function register(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + REGISTER_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`${envBaseUrl(envUrl)}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
      console.error(`register failed: HTTP ${response.status}`);
    } catch (error) {
      console.error('register failed:', (error as Error).message);
    }
    if (Date.now() >= deadline) throw new Error('could not register with the trial environment');
    await sleep(REGISTER_RETRY_MS);
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${envBaseUrl(envUrl)}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch (error) {
      console.error('done poll failed:', (error as Error).message);
    }
    if (Date.now() - started > DONE_MAX_WAIT_MS) {
      console.error('done was never signalled; exiting');
      return;
    }
    await sleep(DONE_POLL_MS);
  }
}

function installSignalHandlers(server: ReturnType<typeof createRawServer>): void {
  const stop = (): void => {
    server.close(() => process.exit(0));
    // If the socket refuses to drain, force the exit after a grace period.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function main(): Promise<void> {
  validateConfig(ENV_URL);
  const forge = new Forge();
  const server = createRawServer((req, res) => {
    void handleRequest(req, res, forge).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"message":"Internal Server Error"}');
      } else res.end();
    });
  });
  installSignalHandlers(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  console.log(`github-core-clone listening on port ${port} (viewer ${VIEWER.login}, mode ${ENV_URL === '' ? 'local' : 'trial'})`);
  if (ENV_URL === '') {
    console.log('MAKEFUN_ENV_URL is unset; serving without registration.');
    return;
  }
  await register(ENV_URL, port);
  console.log('registered with the trial environment');
  await waitForDone(ENV_URL);
  console.log('trial done; shutting down');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
