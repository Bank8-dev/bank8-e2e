// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/protocol/fixtures/index.ts — barrel export for the
// protocol-level e2e fixtures.
//
// The protocol suites (4, 6, 8) verify the Auth8 OIDC / token endpoint
// behavior at the HTTP level — not through a browser.  They use a
// minimal APIClient (undici + local CA) for this purpose.  UI e2e
// suites under `tests/` MUST NOT import this barrel — they have no
// backdoor API access.

export { APIClient, type APIClientOptions } from './apiclient.js';
export { Auth8URL, tenantAuthURL, tenantAppURL, tenantBff8URL, verticalServiceURL, TENANT_DOMAINS } from '../../../fixtures/testdata.js';
export { logStep } from '../../../fixtures/log.js';
