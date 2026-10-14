// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/suite4_tenant_auth_flows.spec.ts
//
// Suite 4 — Tenant Auth Flows (HTTP only — no browser).
//
// Mirrors e2e/suites/suite04_tenant_auth_test.go.  Verifies that the
// Sentin8:Auth server responds to OIDC discovery, JWKS, token, health, and
// authorize endpoints on both the platform hostname and tenant
// custom-domain hostnames.  No browser, no Playwright.

import { test, expect } from '@playwright/test';
import { APIClient, Auth8URL, tenantAuthURL, tenantAppURL, TENANT_DOMAINS, logStep } from './fixtures/index.js';

const httpClient = new APIClient({ baseURL: '', insecure: true });

test.describe('Suite 4 — Tenant Auth Flows', () => {
  test('OIDC discovery on platform auth', async () => {
    logStep('[suite4] OIDC discovery on platform auth → GET /.well-known/openid-configuration');
    const r = await httpClient.get(`${Auth8URL}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    const doc = r.json as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string };
    expect(doc.issuer).toBeTruthy();
    expect(doc.authorization_endpoint).toBeTruthy();
    expect(doc.token_endpoint).toBeTruthy();
    expect(doc.jwks_uri).toBeTruthy();
  });

  test('OIDC discovery on iBank tenant auth', async () => {
    logStep('[suite4] OIDC discovery on iBank tenant auth → GET /.well-known/openid-configuration');
    const r = await httpClient.get(`${tenantAuthURL(TENANT_DOMAINS.ibank)}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    expect((r.json as { issuer?: string }).issuer).toBeTruthy();
  });

  test('OIDC discovery on iFinTech tenant auth', async () => {
    logStep('[suite4] OIDC discovery on iFinTech tenant auth → GET /.well-known/openid-configuration');
    const r = await httpClient.get(`${tenantAuthURL(TENANT_DOMAINS.ifintech)}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    expect((r.json as { issuer?: string }).issuer).toBeTruthy();
  });

  test('JWKS on platform auth', async () => {
    logStep('[suite4] JWKS on platform auth → GET /.well-known/jwks.json');
    const r = await httpClient.get(`${Auth8URL}/.well-known/jwks.json`);
    expect(r.status).toBe(200);
    expect((r.json as { keys?: unknown[] }).keys).toBeTruthy();
  });

  test('JWKS on iBank tenant auth', async () => {
    logStep('[suite4] JWKS on iBank tenant auth → GET /.well-known/jwks.json');
    const r = await httpClient.get(`${tenantAuthURL(TENANT_DOMAINS.ibank)}/.well-known/jwks.json`);
    expect(r.status).toBe(200);
  });

  test('POST /oauth/token without body returns 400', async () => {
    logStep('[suite4] POST /oauth/token without body → expect 400');
    const r = await httpClient.postForm(`${Auth8URL}/oauth/token`, {});
    expect(r.status).toBe(400);
  });

  test('GET /v1/admin/users without context returns 401', async () => {
    logStep('[suite4] GET /v1/admin/users without context → expect 401');
    const r = await httpClient.get(`${Auth8URL}/v1/admin/users`);
    expect(r.status).toBe(401);
  });

  test('health on platform auth', async () => {
    logStep('[suite4] health on platform auth → GET /v1/health');
    const r = await httpClient.get(`${Auth8URL}/v1/health`);
    expect(r.status).toBe(200);
    expect((r.json as { service?: string }).service).toBeTruthy();
  });

  test('health on iBank tenant auth', async () => {
    logStep('[suite4] health on iBank tenant auth → GET /v1/health');
    const r = await httpClient.get(`${tenantAuthURL(TENANT_DOMAINS.ibank)}/v1/health`);
    expect(r.status).toBe(200);
  });

  test('authorize endpoint redirects to sign-in without session', async () => {
    logStep('[suite4] authorize endpoint (no session) → expect 302 or 400');
    const url = `${Auth8URL}/oauth/authorize?client_id=test&redirect_uri=${encodeURIComponent(tenantAppURL(TENANT_DOMAINS.ibank, 'prod', 'bank8-ebank') + '/auth/callback')}&response_type=code&code_challenge=test&code_challenge_method=S256&state=test`;
    const r = await httpClient.get(url);
    // Should redirect (302) or return 400 for invalid client_id.
    expect([302, 400]).toContain(r.status);
  });
});
