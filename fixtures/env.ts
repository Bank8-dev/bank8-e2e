// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-License-Identifier: Apache-2.0

// fixtures/env.ts - tree-root `.env` loader (the fleet's own configuration).
//
// Mirrors sentin8-e2e's fixtures/env.ts - same contract, one directory
// deeper (fixtures/ → bank8-e2e/ → bank8/ group → tree root). The suite
// tests the deployment the operator actually booted, so its target
// configuration is read from the SAME `.env` the fleet is booted from.
// NO fallback literal: when nothing defines `SENTIN8_DOMAIN` the run
// fails here - never mid-test with URLs pointed at a domain nothing
// serves.
//
// Second job: feed the SPAWNED sentin8-cli. `bank8/.env` (DSN-only) cuts
// off dotenvy's walk-up, so the CLI never sees the tree-root value on
// its own - `planeEnv()` (fixtures/cli.ts) copies the loader's
// `SENTIN8_DOMAIN` into every spawn env.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Variables read from the tree root `.env` by this suite. */
const DOTENV_VARS = ['SENTIN8_DOMAIN', 'SENTIN8_REPO_ROOT', 'SENTIN8_CLI_BIN'] as const;

function repoRoot(): string {
  // Explicit operator override wins.
  if (process.env.SENTIN8_REPO_ROOT) return resolve(process.env.SENTIN8_REPO_ROOT);
  // fixtures/env.ts → fixtures/ → bank8-e2e/ → bank8/ (group) → tree root.
  return resolve(import.meta.dirname ?? '.', '..', '..', '..');
}

/**
 * Load the tree-root `.env` into `process.env` for the suite's own
 * variables. Idempotent, import-time safe (module-level - same
 * discipline as the platform suite's loader). A variable present in the
 * real environment is never overwritten.
 */
function loadTreeEnv(): void {
  const path = join(repoRoot(), '.env');
  if (!existsSync(path)) return; // environment-only runs are fine.
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(DOTENV_VARS as readonly string[]).includes(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadTreeEnv();

/**
 * The platform root domain the suite (and the fleet) targets - hard
 * error when neither the environment nor the tree-root `.env` defines
 * it (there is no fallback literal to guess).
 */
export function platformDomain(): string {
  const domain = process.env.SENTIN8_DOMAIN;
  if (!domain || domain.trim().length === 0) {
    throw new Error(
      'SENTIN8_DOMAIN is not set - the bank8 e2e suite derives every target URL ' +
      'from it. Export it or define it in the tree-root .env ' +
      `(searched: ${join(repoRoot(), '.env')}); there is no fallback domain.`,
    );
  }
  return domain;
}

/** The resolved tree root, as this module resolved it. */
export function treeRoot(): string {
  return repoRoot();
}