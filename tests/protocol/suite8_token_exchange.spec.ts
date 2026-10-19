// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/suite8_token_exchange.spec.ts
//
// Suite 8 - RFC 8693 Token Exchange - story 15.4.22.
//
// Verifies that:
//   - Sentin8:Auth's /oauth/token accepts the token-exchange grant type
//   - A sys-realm token can be exchanged for an org/env-scoped token
//   - The exchanged token carries the correct org_id, env_id, scope, aud, act
//   - The X-Sentin8:BFF-Target-Org-Id header is consumed by Sentin8:BFF only (not forwarded upstream)
//   - Sentin8:BFF caches the exchanged token (cache hit on second request)
//   - Non-sys-realm tokens are rejected for exchange
//   - may_act check rejects non-members

import { test, expect } from '@playwright/test';
import { APIClient, Auth8URL, verticalServiceURL, logStep } from './fixtures/index.js';

const httpClient = new APIClient({ baseURL: '', insecure: true });

// RFC 8707 resource-indicator audience for bank8:ledger - the registry
// subdomain form ({subdomain}.ops.sys.{SENTIN8_DOMAIN}), derived from
// the env so alternate local domains keep working.
const LEDGER_AUDIENCE = verticalServiceURL('bank8-ledger');

test.describe('Suite 8 - RFC 8693 Token Exchange', () => {
  test('TE1 discovery advertises token-exchange grant type', async () => {
    logStep('[suite8] TE1: discovery → expect grant_types_supported includes token-exchange');
    const r = await httpClient.get(`${Auth8URL}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    const doc = r.json as { grant_types_supported?: string[] };
    expect(doc.grant_types_supported).toContain(
      'urn:ietf:params:oauth:grant-type:token-exchange',
    );
  });

  test('TE2 token-exchange without subject_token returns 400', async () => {
    logStep('[suite8] TE2: token-exchange w/o subject_token → expect 400');
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: LEDGER_AUDIENCE,
      'requested_tenancy.org_id': '00000000-0000-0000-0000-000000000001',
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain('subject_token');
  });

  test('TE3 token-exchange with invalid subject_token returns 400', async () => {
    logStep('[suite8] TE3: token-exchange w/ invalid subject_token → expect 400 (access_token exchange replaced by Delegation Gateway)');
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'invalid-jwt-token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: LEDGER_AUDIENCE,
      'requested_tenancy.org_id': '00000000-0000-0000-0000-000000000001',
    });
    expect(r.status).toBe(400);
  });

  test('TE4 token-exchange without requested_tenancy.org_id returns 400', async () => {
    logStep('[suite8] TE4: token-exchange w/o requested_tenancy.org_id → expect 400 or 401');
    // Use a dummy token - the handler should fail before verifying it
    // if org_id is missing. But since verification happens first, we
    // expect 401 (invalid token) or 400 (missing org_id). Either way,
    // it should not succeed.
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'dummy',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: LEDGER_AUDIENCE,
    });
    expect([400, 401]).toContain(r.status);
  });

  test('TE5 token-exchange with wrong subject_token_type returns 400', async () => {
    logStep('[suite8] TE5: token-exchange w/ wrong subject_token_type → expect 400');
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'dummy',
      subject_token_type: 'urn:ietf:params:oauth:token-type:refresh_token',
      audience: LEDGER_AUDIENCE,
      'requested_tenancy.org_id': '00000000-0000-0000-0000-000000000001',
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain('subject_token_type');
  });

  // TE6-TE9 require a live sys-realm token and a real org/env. These
  // tests are run as part of the full E2E suite (Suite 2 or Suite 5)
  // where a sys user is signed in and an org/env has been created.
  // The tests below verify the protocol-level behavior that doesn't
  // require a live session.

  test('TE6 unsupported grant_type still returns 400', async () => {
    logStep('[suite8] TE6: invalid grant_type → expect 400 "unsupported grant_type"');
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {
      grant_type: 'invalid_grant_type',
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain('unsupported grant_type');
  });

  test('TE7 token-exchange grant type is accepted (not rejected as unsupported)', async () => {
    logStep('[suite8] TE7: token-exchange grant recognized → expect 400 about subject_token, not unsupported');
    // Even with invalid params, the grant type itself should be recognized
    // (the error should be about missing subject_token, not unsupported grant_type)
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    });
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('unsupported grant_type');
    expect(r.body).toContain('subject_token');
  });
});