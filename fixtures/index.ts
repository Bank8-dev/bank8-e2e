// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/index.ts - barrel export for the e2e fixtures.
//
// Re-exports the helpers so test files can do:
//
//   import { Personas, tenantAppURL, signUpViaApp, clickFlutterButton } from '../fixtures';
//
// UI suites under `tests/` MUST NOT import any backdoor API client.
// Protocol-level suites (HTTP-only, no browser) live under
// `tests/protocol/` and have their own fixtures barrel that exposes
// APIClient for the tenant-auth protocol tests.

export * from './testdata.js';
export * from './state.js';
export * from './harness.js';
export * from './log.js';
export * from './cli.js';
export { APIClient } from './apiclient.js';
