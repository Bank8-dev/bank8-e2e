// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/cli.ts - sentin8-cli subprocess runner + output parser for bank8 e2e.
//
// The bank8 suite drives ALL platform setup through the real sentin8-cli
// binary (subprocess) instead of the Dash UI - org/env creation, feature
// enablement, app installation, staff users, and group membership. This is
// much faster than browser-driven Dash flows and leaves Dash testing to the
// sentin8 e2e suite.
//
// Adapted from sentin8/e2e-ts/fixtures/cli.ts (shared pattern; bank8 keeps
// its own copy because the suites are separate packages - see BACKLOG).

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_BIN, Auth8URL, TREE_ROOT } from './testdata.js';
import { platformDomain } from './env.js';
import { logStep } from './log.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
  /** Full command line used to invoke the CLI (for logging). */
  cmdLine: string;
}

// ── Core runner ────────────────────────────────────────────────────────

/**
 * The CLI's state HOME for this suite - `~/.sentin8/credentials` under a
 * private root the suite owns. The CLI resolves both config/credentials
 * and its Acme client dir from `$HOME` (config.rs, auth.rs), so pointing
 * HOME here isolates the bank8 run's token from any OTHER suite using
 * the same binary concurrently (the platform sentin8-e2e writes the same
 * shared file - observed clobbering this run's session between org
 * create and verify).
 */
export const CLI_HOME = join(process.cwd(), '.tmp', 'cli-home');

/**
 * Plane env for the standalone CLI (BANK8CLI-): the HOME override
 * above ALSO breaks the CLI's last-resort CA fallback
 * (`$HOME/.sentin8/acme/ca/root-ca.crt` - the sandbox dir has no Acme
 * state), and in a clean operator shell no `SENTIN8_*` plane var is
 * exported while `dotenvy`'s walk-up from THIS repo stops at the
 * vertical group's DSN-only `bank8/.env` - never reaching the tree-root
 * `.env`. So the suite passes the plane paths explicitly, derived from
 * the same absolute TREE_ROOT it already anchors the CLI binary on
 * (each var stays overridable through the operator environment).
 */
function planeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Tree-relative plane paths (the live fleet's dev layout, `.run` under
  // the aggregation root). SENTIN8_ACME_DATA_DIR is deliberately NOT
  // derived: it is machine-level state (root .env pins it to the user's
  // `~/.sentin8/acme`), and the CLI already derives a working default
  // when it is absent - the trust anchor itself rides SENTIN8_TLS_CA_PEM.
  const derived: Record<string, string> = {
    SENTIN8_RUN_DIR: `${TREE_ROOT}/.run`,
    SENTIN8_LOG_DIR: `${TREE_ROOT}/.run/logs`,
    SENTIN8_SECRETS_DIR: `${TREE_ROOT}/.run/secrets`,
    SENTIN8_M2M_CREDENTIALS_DIR: `${TREE_ROOT}/.run/secrets/m2m-credentials`,
    SENTIN8_TLS_CA_PEM: `${TREE_ROOT}/.run/secrets/acme-ca/root-ca.crt`,
    // The CLI's dotenvy walk-up stops at this group's DSN-only `bank8/.env`,
    // never reaching the tree-root `.env` - without this the CLI falls back
    // to its built-in domain and every API call 404s/dns-fails (fixtures/env.ts
    // pins the real value).
    SENTIN8_DOMAIN: platformDomain(),
    // The CLI's config.sentin8_auth_url still resolves from a config file,
    // then `SENTIN8_SENTIN8_AUTH_URL`, then a hardcoded `local.sentin8.dev`
    // default that IGNORES SENTIN8_DOMAIN (cli config.rs
    // `sentin8_auth_url()`): pass the derived URL explicitly so signup /
    // sign-in land on the fleet's real auth host.
    SENTIN8_SENTIN8_AUTH_URL: `https://auth.ops.sys.${platformDomain()}`,
  };
  for (const [key, value] of Object.entries(derived)) {
    env[key] = process.env[key] ?? value;
  }
  return env;
}

/**
 * Spawn the sentin8-cli binary with the given args, wait for it to
 * complete, and return the captured output.
 */
export async function runCli(
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...planeEnv(), ...process.env, HOME: CLI_HOME, ...opts.env };
    const cmdLine = `${CLI_BIN} ${args.join(' ')}`;
    // Log EVERY cli invocation - one line per call, with a marker so
    // failures are easy to spot in the transcript.
    logStep(`[cli $] ${cmdLine}`);
    const child: ChildProcess = spawn(CLI_BIN, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`CLI timed out after ${opts.timeout}ms: ${args.join(' ')}`));
        }, opts.timeout)
      : undefined;

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      const result: CliResult = {
        exitCode: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        cmdLine,
      };
      // Result line - exit code + first stderr line on failure.
      if (result.exitCode === 0) {
        logStep(`[cli =] exit=0 ${shortCmd(cmdLine)}`);
      } else {
        const errFirst = result.stderr.split('\n').find((l) => l.trim()) ?? '';
        logStep(`[cli !] exit=${result.exitCode} ${shortCmd(cmdLine)} - ${errFirst}`);
      }
      // Try to parse JSON - the CLI prints a "sentin8-cli v0.1.0" banner to
      // stdout BEFORE the JSON body, so skip to the first `{`/`[` that
      // starts a line and parse from there to the end.
      const trimmed = result.stdout.trim();
      const m = trimmed.match(/^(\{|\[)/m);
      if (m && m.index !== undefined) {
        const jsonStart = trimmed.indexOf(m[1], m.index);
        try {
          result.json = JSON.parse(trimmed.slice(jsonStart));
        } catch {
          // not pure JSON - leave json undefined
        }
      }
      resolve(result);
    });

    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Execute the generic passthrough:
 *   sentin8-cli call <service> <method> <path> [--body=JSON] [--env=ENV_ID]
 * When envId is provided, the CLI targets that env (target_env_id query param).
 */
export async function cliCall(
  service: string,
  method: string,
  path: string,
  body?: unknown,
  envId?: string,
): Promise<CliResult> {
  const args = ['call', service, method, path];
  if (body) {
    args.push(`--body=${JSON.stringify(body)}`);
  }
  if (envId) {
    args.push(`--env=${envId}`);
  }
  return runCli(args);
}

/**
 * Execute a declarative service command:
 *   sentin8-cli do <command> <subcommand> <action> [--field value ...] [--env ID]
 */
export async function cliDo(
  command: string,
  subcommand: string,
  action: string,
  fields: Record<string, string> = {},
  opts: { env?: string } = {},
): Promise<CliResult> {
  const args = ['do', command, subcommand, action];
  for (const [k, v] of Object.entries(fields)) {
    args.push(`--${k}=${v}`);
  }
  if (opts.env) {
    args.push(`--env=${opts.env}`);
  }
  return runCli(args);
}

/** Get the current signed-in user. */
export async function cliWhoami(): Promise<CliResult> {
  return runCli(['whoami']);
}

// ── Settled variants (transient pre-grant identity, §3.1d-1) ───────────

/**
 * Transient-403 predicates for CLI calls that can land before the
 * platform has finished provisioning the caller's access model.
 *
 * Concretely: `sys org create` delegates the creator's access-model
 * provisioning (membership in `sentin8:org:{slug}:owners`) to a
 * Sentin8:Flow workflow that runs asynchronously (sentin8 sys design
 * §5.1). Any `authorize_org`-gated call fired within that window fails
 * with 403 "not a member of this organization"; Shield policy may
 * similarly deny with "forbidden by policy" while roles are still
 * resolving. Both are transient - a retry after provisioning completes
 * succeeds.
 */
function isTransientCliDeny(result: CliResult): boolean {
  if (result.exitCode === 0) return false;
  const stderr = result.stderr.toLowerCase();
  return (
    stderr.includes('not a member of this organization') ||
    stderr.includes('forbidden by policy') ||
    (stderr.includes('http 403') && !stderr.includes('missing'))
  );
}

/**
 * Retry a `cliCall` while it fails with a transient deny (see
 * isTransientCliDeny). Polls until success, a non-transient failure, or
 * the deadline - then returns the LAST result so callers can assert on
 * it with full stdout/stderr context.
 *
 * Mirrors `cliCallSettled` in the sentin8 e2e suite (§3.1d-1 "cached
 * pre-grant identity" settle window).
 */
export async function cliCallSettled(
  service: string,
  method: string,
  path: string,
  body?: unknown,
  envId?: string,
  opts: { timeoutMs?: number; intervalMs?: number; context?: string } = {},
): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last = await cliCall(service, method, path, body, envId);
  while (isTransientCliDeny(last) && Date.now() < deadline) {
    logStep(`[cli ~] transient deny - retrying ${shortCmd(last.cmdLine)} in ${intervalMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await cliCall(service, method, path, body, envId);
  }
  return last;
}

/**
 * Settled variant of `cliDo` (same transient-deny retry semantics as
 * cliCallSettled). Used for `sys org create` → `sys env create`
 * sequencing in global-setup, where env create's `authorize_org` check
 * races the async Flow provisioning of the creator's org membership.
 */
export async function cliDoSettled(
  command: string,
  subcommand: string,
  action: string,
  fields: Record<string, string> = {},
  opts: { env?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last = await cliDo(command, subcommand, action, fields, { env: opts.env });
  while (isTransientCliDeny(last) && Date.now() < deadline) {
    logStep(`[cli ~] transient deny - retrying ${shortCmd(last.cmdLine)} in ${intervalMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await cliDo(command, subcommand, action, fields, { env: opts.env });
  }
  return last;
}

/**
 * Force a token refresh by calling the auth refresh endpoint directly.
 *
 * Needed after the user gains new roles (e.g. org:admin after creating an
 * org) - the stored access token is still valid but carries the old
 * (pre-org-creation) scope set. A refresh re-computes role scopes
 * server-side via fetch_role_scopes and returns an updated token.
 *
 * Adapted from sentin8/e2e-ts/fixtures/cli.ts.
 */
export async function cliRefreshToken(): Promise<void> {
  const sentin8Dir = join(CLI_HOME, '.sentin8');
  const credPath = join(sentin8Dir, 'credentials');
  const raw = await readFile(credPath, 'utf-8').catch(() => {
    throw new Error('cliRefreshToken: no credentials file found');
  });
  const creds = JSON.parse(raw) as {
    access_token: string;
    refresh_token: string;
    expires_at: string;
    sentin8_auth_url: string;
  };
  if (!creds.refresh_token) {
    throw new Error('cliRefreshToken: no refresh token in credentials');
  }
  // Disable TLS verification for the local self-signed CA (same approach
  // as the platform suite's cli.ts - the Acme root is trusted by the CLI
  // via SENTIN8_TLS_CA_PEM, but Node's fetch needs this bypass locally).
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  let resp: Response;
  try {
    resp = await fetch(`${creds.sentin8_auth_url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
        client_id: 'sentin8-cli',
      }),
    });
  } finally {
    if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
  }
  if (!resp.ok) {
    throw new Error(`cliRefreshToken: refresh failed: HTTP ${resp.status} ${await resp.text()}`);
  }
  const token = await resp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  creds.access_token = token.access_token;
  if (token.refresh_token) {
    creds.refresh_token = token.refresh_token;
  }
  creds.expires_at = new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
  await writeFile(credPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  logStep('[cli] token refreshed (scopes re-computed)');
}

// ── Sign-in (headless device flow) ─────────────────────────────────────

/**
 * Sign in the CLI using OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Simplified bank8 variant of the sentin8 flow: requests a device code from
 * `POST /oauth/device`, approves it via the direct API (sign-in + device
 * verify), and polls `POST /oauth/token` for the token. Writes credentials
 * to ~/.sentin8/credentials.
 *
 * The CLI stores a single set of credentials - bank8 globalSetup signs in
 * as the platform operator (Bill) who owns org creation. Staff users
 * (Ben, Bob) are created via the CLI *as* Bill, then sign in through
 * their apps' UI in the tests.
 */
export async function cliSignIn(email: string, password: string): Promise<void> {
  // Sign up first (idempotent - non-zero exit just means the user exists).
  await runCli([
    'signup', '--email', email, '--password', password,
    '--first-name', 'Test', '--last-name', 'Operator',
  ]).catch(() => undefined);

  // Disable TLS verification for the local self-signed CA (Node fetch).
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  try {
    // 1. Request a device code - endpoint is POST /oauth/device (see
    //    sentin8/cmd/cli/src/auth.rs:95).
    const startResp = await fetch(`${Auth8URL}/oauth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'sentin8-cli',
        scope: 'openid profile email offline_access',
        audience: 'sentin8',
      }),
    });
    if (!startResp.ok) {
      throw new Error(`cliSignIn: device authorize failed: HTTP ${startResp.status} ${await startResp.text()}`);
    }
    const deviceData = await startResp.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };

    // 2. Approve via direct API: sign in, then verify the user code.
    const signInResp = await fetch(`${Auth8URL}/v1/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sentin8-hostname': `auth.ops.sys.${DOMAIN_SAFE}` },
      body: JSON.stringify({ email, password }),
    });
    if (!signInResp.ok) {
      throw new Error(`cliSignIn: sign-in failed: HTTP ${signInResp.status} ${await signInResp.text()}`);
    }
    const signInData = await signInResp.json() as { user_id: string; token: string };
    // SEC-2.1.4 - device verification requires a session; the approving
    // user comes from the session token, not the request body.
    await fetch(`${Auth8URL}/device/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${signInData.token}`,
      },
      body: JSON.stringify({ user_code: deviceData.user_code }),
    });

    // 3. Poll for the token - 1s interval.
    const startTime = Date.now();
    const maxWait = (deviceData.expires_in ?? 900) * 1000;
    while (Date.now() - startTime < maxWait) {
      await sleep(1000);
      const tokenResp = await fetch(`${Auth8URL}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceData.device_code,
          client_id: 'sentin8-cli',
        }),
      });
      const tokenData = await tokenResp.json() as {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        expires_in?: number;
        error?: string;
      };
      if (tokenData.access_token) {
        const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000).toISOString();
        const credentials = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token ?? '',
          token_type: tokenData.token_type ?? 'Bearer',
          expires_at: expiresAt,
          sentin8_auth_url: Auth8URL,
          user: { email, subject_id: signInData.user_id, scopes: [], org_id: undefined, env_id: undefined },
        };
        const sentin8Dir = join(CLI_HOME, '.sentin8');
        await mkdir(sentin8Dir, { recursive: true });
        await writeFile(join(sentin8Dir, 'credentials'), JSON.stringify(credentials, null, 2), { mode: 0o600 });
        logStep(`[cli] signed in as ${email}`);
        return;
      }
      if (tokenData.error === 'authorization_pending' || tokenData.error === 'slow_down') continue;
      if (tokenData.error === 'expired_token' || tokenData.error === 'access_denied') {
        throw new Error(`Device flow failed: ${tokenData.error}`);
      }
    }
    throw new Error('cliSignIn: device flow timed out waiting for approval');
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

const DOMAIN_SAFE = platformDomain();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shorten a CLI command line for the result log line (strip binary path). */
function shortCmd(cmdLine: string): string {
  return cmdLine.replace(/^.*sentin8-cli\s*/, 'cli ');
}

// ── Assertions ─────────────────────────────────────────────────────────

/** Assert the CLI command succeeded (exit code 0). */
export function assertCliOk(result: CliResult, context?: string): void {
  if (result.exitCode !== 0) {
    // The [cli !] result line is already logged by runCli - here we fail
    // with full stdout/stderr for debugging.
    throw new Error(
      `CLI command failed${context ? ` (${context})` : ''}: exit=${result.exitCode}\n` +
      `cmd: ${result.cmdLine}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

/** Path of this module's directory (for resolving the repo-relative CLI path). */
export const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));