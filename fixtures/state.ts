// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/state.ts - cross-suite state shared via .e2e-state.json.
//
// Mirrors fixtures/state.go from the Go playwright-go suite.
// Suites write their outputs here (listing IDs, org/env IDs, cookies)
// and later suites read them in.  This keeps the suites independent
// yet allows them to build on each other (e.g. Suite 2 needs the
// eBank listing ID produced by Suite 1).

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { orgDomain, tenantAppURL, tenantBff8URL } from './testdata.js';

// Path is repo-root-relative so both the Go (../sentin8/e2e) and
// TypeScript (e2e-ts) suites can read/write the same file.  Resolved
// against process.cwd() which the runner ensures is the e2e-ts dir
// for this suite, but we also try a few common locations.
const STATE_CANDIDATES = [
  '.e2e-state.json',
  '../.e2e-state.json',
  '../../.e2e-state.json',
];

export interface E2EState {
  // Suite 1 - App Store / catalog
  ebankListingId?: string;

  // Suite 2 - iBank end-to-end
  ibankOrgId?: string;
  ibankEnvId?: string;
  ibankOrgSlug?: string;
  ibankEnvSlug?: string;
  ebankInstanceId?: string;
  ebankHostname?: string;
  ebankSetupIdempotencyKey?: string;
  billEmail?: string;
  aliceEmail?: string;
  bobEmail?: string;
  carolEmail?: string;
  ebankAccountIds?: string[];

  // Suite 3 - admin end-to-end
  adminOrgId?: string;

  // BFF8 proxy state (cross-suite)
  ebankBff8SessionCookie?: string;
}

let resolvedPath: string | undefined;

async function stateFilePath(): Promise<string> {
  if (resolvedPath) return resolvedPath;
  for (const c of STATE_CANDIDATES) {
    try {
      // Stat-then-resolve: we treat any candidate as the right one
      // and remember it.  If the file doesn't exist yet, we fall
      // through and use the first candidate.
      const fs = await import('node:fs/promises');
      await fs.access(c);
      resolvedPath = c;
      return c;
    } catch {
      // try next
    }
  }
  resolvedPath = STATE_CANDIDATES[0];
  return resolvedPath;
}

export async function loadState(): Promise<E2EState> {
  const p = await stateFilePath();
  try {
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw) as E2EState;
  } catch {
    return {};
  }
}

export async function saveState(state: E2EState): Promise<void> {
  const p = await stateFilePath();
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, p);
}

/** Merge `partial` into the on-disk state, returning the merged result. */
export async function updateState(partial: Partial<E2EState>): Promise<E2EState> {
  const current = await loadState();
  const merged: E2EState = { ...current };
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  await saveState(merged);
  return merged;
}

export async function resetState(): Promise<void> {
  const p = await stateFilePath();
  try {
    await unlink(p);
  } catch {
    // already gone
  }
  resolvedPath = undefined;
}

/** URL helpers that read from the on-disk state. */
export function ebankAppURLFromState(s: E2EState): string {
  if (s.ebankHostname) return `https://${s.ebankHostname}`;
  return tenantAppURL(s.ibankOrgSlug ?? 'ibank', s.ibankEnvSlug ?? 'prod', 'www');
}
export function ebankBff8URLFromState(s: E2EState): string {
  return tenantBff8URL(s.ibankOrgSlug ?? 'ibank', s.ibankEnvSlug ?? 'prod', 'www');
}
// The efintech app URL helpers moved with the recipient journey to the
// openfin8-e2e suite (the iFinTech tenant is no longer provisioned here).

// Re-export the join so callers can compute repo-relative paths.
export { join };
