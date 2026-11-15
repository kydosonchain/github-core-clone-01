// Entry point: start the forge and run the trial lifecycle against the
// make.fun environment.
//
// The environment (env) owns the trial. This process only has to:
//   1. read the env's origin from MAKEFUN_ENV_URL,
//   2. bind the forge to an ephemeral port (never 8080 — the env owns it),
//   3. tell the env which port to dial, and
//   4. keep serving until the env reports the trial is done, then exit 0.
//
// The scored surface is the server built by app.ts; this file only wires it
// into the harness's lifecycle. It imports nothing but the local app.

import { createApp } from './app.ts';

// --- configuration ---------------------------------------------------------

/** Origin of the trial env, e.g. http://store:8080 inside a trial container. */
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** One env request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;
/** Cap the exponent so the delay stops growing after a few failures. */
const MAX_BACKOFF_STEPS = 8;

if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// --- small helpers ---------------------------------------------------------

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `failures` consecutive failed attempts: exponential, capped. */
function backoffMs(failures: number): number {
  const steps = Math.min(failures, MAX_BACKOFF_STEPS);
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** steps);
}

/** A contract error (the env rejected the request itself) ends the program. */
class ContractError extends Error {}

// --- env calls --------------------------------------------------------------

/**
 * Tell the env which port the forge bound. Succeeds on 200, and on 409 too:
 * 409 means another entry registered first and this process simply waits
 * like any other. 400/405 mean the request itself broke the contract, so
 * they are fatal. Anything else (env still starting, network hiccup, odd
 * status) is retried until the env answers.
 */
async function registerPort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new ContractError(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      // Any other status: the env is not ready to accept us yet.
    } catch (err) {
      if (err instanceof ContractError) throw err;
      // Network error or timeout: retry below.
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

/**
 * Poll the env until it reports the trial finished. The env answers each
 * poll at once ({"done": false} while the suite runs), so this is a poll,
 * not a long-held request. A failed or slow poll is just "not done yet".
 */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env not answering yet, or the poll timed out: not done, poll again.
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

// --- lifecycle --------------------------------------------------------------

/** Start the forge on a kernel-chosen port and return the server and port. */
async function startForge(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** The whole life of the process: bind, register, serve until done, exit 0. */
async function run(): Promise<void> {
  const { server, port } = await startForge();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await registerPort(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
