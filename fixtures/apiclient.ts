// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/apiclient.ts — direct HTTP API client (no browser) for
// setup/teardown that a human would never perform in the UI.
//
// Mirrors fixtures/apiclient.go + fixtures/apiclient_cookies.go from
// the Go suite.  Uses Node's built-in fetch (Node ≥18) and trusts
// the local Sentin8 root CA from SENTIN8_CA_CERT (or well-known locations)
// by setting NODE_EXTRA_CA_CERTS (the simplest portable approach —
// Node's global fetch / undici both honor it).

import { readFileSync, existsSync } from 'node:fs';

// ── CA detection ──────────────────────────────────────────────────────
// If SENTIN8_CA_CERT is set, expose it as NODE_EXTRA_CA_CERTS so Node's
// global fetch (undici) trusts the local Sentin8 root.  This avoids
// pulling in extra deps and works on every Node ≥18.

const CA_CANDIDATES = [
  process.env.SENTIN8_CA_CERT,
  '/usr/local/share/ca-certificates/sentin8-local-ca.crt',
  '/etc/ssl/certs/sentin8-local-ca.pem',
].filter((x): x is string => Boolean(x));

if (!process.env.SENTIN8_CA_CERT && !process.env.NODE_EXTRA_CA_CERTS) {
  for (const c of CA_CANDIDATES) {
    if (existsSync(c)) {
      process.env.SENTIN8_CA_CERT = c;
      process.env.NODE_EXTRA_CA_CERTS = c;
      break;
    }
  }
}

/**
 * Build a TLS-disabling fetch for tests that need to bypass the local
 * CA check (e.g. when the suite wants to verify that an endpoint
 * returns 401 even with an untrusted CA).
 */
function makeFetch(allowInsecure: boolean): typeof fetch {
  if (allowInsecure) {
    // Construct an Agent-like dispatcher via undici's global Agent.
    // Node ≥18 has globalThis.fetch backed by undici; we can disable
    // verification by setting NODE_TLS_REJECT_UNAUTHORIZED=0 for the
    // process — but that affects every test.  Instead we route through
    // a small undici.Agent.  To avoid the undici dep, we set the env
    // var only for the duration of an insecure call using a child
    // process would be heavy.  So instead we use the per-request
    // approach: undici's global agent honours NODE_TLS_REJECT_UNAUTHORIZED
    // — we'll just flip it briefly inside the call.
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const f = (...args: Parameters<typeof fetch>) => fetch(...args);
    f.finally = () => {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    };
    return f;
  }
  return fetch;
}

// ── Client ────────────────────────────────────────────────────────────

export interface APIClientOptions {
  baseURL: string;
  /** BFF8 session cookie value to send as `__Host-bff8-session`. */
  rawCookie?: string;
  /** Optional CSRF token (X-BFF8-CSRF). */
  csrfToken?: string;
  /** Force insecure (skip CA verification).  Default false. */
  insecure?: boolean;
}

export class APIClient {
  baseURL: string;
  rawCookie?: string;
  csrfToken?: string;
  private doFetch: typeof fetch;
  private insecure: boolean;

  constructor(opts: APIClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.rawCookie = opts.rawCookie;
    this.csrfToken = opts.csrfToken;
    this.insecure = !!opts.insecure;
    this.doFetch = makeFetch(this.insecure);
  }

  /** Extract the __Host-bff8-session cookie value from a Playwright BrowserContext's cookies. */
  static extractSessionCookie(cookies: Array<{ name: string; value: string }>): string | undefined {
    return cookies.find((c) => c.name === 'bff8-session' || c.name === '__Host-bff8-session')?.value;
  }

  private buildInit(method: string, body?: string, extraHeaders: Record<string, string> = {}): RequestInit {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.rawCookie) headers['cookie'] = `bff8-session=${this.rawCookie}`;
    if (this.csrfToken) headers['x-bff8-csrf'] = this.csrfToken;
    if (body && !headers['content-type']) headers['content-type'] = 'application/json';
    return { method, headers, body };
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; json: unknown }> {
    return this.#send('GET', path, undefined, headers);
  }

  async postJSON(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string; json: unknown }> {
    return this.#send('POST', path, JSON.stringify(body), headers);
  }

  async putJSON(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string; json: unknown }> {
    return this.#send('PUT', path, JSON.stringify(body), headers);
  }

  async delete(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; json: unknown }> {
    return this.#send('DELETE', path, undefined, headers);
  }

  async #send(method: string, path: string, body?: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; json: unknown }> {
    const url = `${this.baseURL}${path.startsWith('/') ? path : `/${path}`}`;
    const init = this.buildInit(method, body, extraHeaders);
    const res = await this.doFetch(url, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: text, json };
  }

  // ── Domain-specific helpers (mirrors Go suite) ──────────────────

  /** Fetch the CSRF token from BFF8 /auth/session. Must be called before
   *  any mutating request (POST/PUT/DELETE) when csrf_enabled is true. */
  async fetchCsrfToken(): Promise<void> {
    const { status, json, body } = await this.get('/auth/session');
    if (status !== 200) throw new Error(`fetchCsrfToken: /auth/session returned ${status}: ${body}`);
    const data = json as Record<string, unknown> | null;
    if (data) {
      this.csrfToken = (data['csrf_token'] as string) ?? (data['csrfToken'] as string) ?? undefined;
    }
  }

  /** Refresh the BFF8 session so the access token is re-issued with updated
   *  role scopes. Needed after creating an org/env (which adds the user
   *  to org-admin/env-admin roles). */
  async refreshSession(): Promise<void> {
    const res = await this.doFetch(`${this.baseURL}/auth/refresh`, {
      method: 'POST',
      headers: this.buildInit('POST', undefined, {}).headers as Record<string, string>,
    });
    // Best-effort — if refresh fails, the old token is still valid for
    // non-admin operations.
    if (res.ok) {
      // Re-fetch CSRF token since the session was refreshed.
      await this.fetchCsrfToken();
    }
  }

  async createOrganization(orgSlug: string, orgName: string): Promise<string> {
    const { status, json, body } = await this.postJSON('/proxy/sys8/v1/o', {
      slug: orgSlug,
      display_name: orgName,
    });
    if (status >= 400) throw new Error(`createOrganization failed: ${status} ${body}`);
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new Error(`createOrganization: missing id in response: ${body}`);
    return id;
  }

  async createEnvironment(orgID: string, envSlug: string, envName: string, envType: string): Promise<string> {
    const { status, json, body } = await this.postJSON(`/proxy/sys8/v1/org/${orgID}/e`, {
      slug: envSlug,
      display_name: envName,
      type: envType,
    });
    if (status >= 400) throw new Error(`createEnvironment failed: ${status} ${body}`);
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new Error(`createEnvironment: missing id in response: ${body}`);
    return id;
  }

  async setAuthDomain(orgID: string, envID: string, authDomain: string): Promise<void> {
    const { status, body } = await this.putJSON(`/proxy/sys8/v1/env/${envID}`, {
      auth_domain: authDomain,
    });
    if (status >= 400) throw new Error(`setAuthDomain failed: ${status} ${body}`);
  }

  /** Create an App8 store listing via the public API. Supports the full
   *  payload (app_slug, oauth_defaults). Security groups are no longer
   *  declared on the listing — they are materialized per-instance at
   *  install time (Epic 12.4). */
  async createListing(payload: {
    app_name: string;
    app_slug: string;
    description?: string;
    backend_url?: string;
    supports_dcr?: boolean;
    oauth_defaults?: Record<string, unknown>;
  }): Promise<string> {
    const { status, json, body } = await this.postJSON(
      '/proxy/app8/v1/app8/store/listings',
      payload,
    );
    if (status >= 400) throw new Error(`createListing failed: ${status} ${body}`);
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new Error(`createListing: missing id in response: ${body}`);
    return id;
  }

  /** Install an App8 app instance. Pass auth_mode ('customer' or 'staff')
   *  to select the auth realm (Epic 12.4). */
  async installApp(
    listingId: string,
    options: {
      instance_name?: string;
      instance_description?: string;
      custom_domain?: string;
      auth_mode?: string;
    } = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = { listing_id: listingId };
    if (options.instance_name) payload['instance_name'] = options.instance_name;
    if (options.instance_description) payload['instance_description'] = options.instance_description;
    if (options.custom_domain) payload['custom_domain'] = options.custom_domain;
    if (options.auth_mode) payload['auth_mode'] = options.auth_mode;
    const { status, json, body } = await this.postJSON('/proxy/app8/v1/app8/setup', payload);
    if (status >= 400) throw new Error(`installApp failed: ${status} ${body}`);
    const data = json as Record<string, unknown> | null;
    return (data?.['instance_id'] as string) ?? (data?.['id'] as string) ?? '';
  }

  /** Create a user in Auth8 via the admin API. Returns the user ID.
   *  Realm is derived by the backend from (org_id, env_id). */
  async createUser(payload: {
    email: string;
    first_name?: string;
    last_name?: string;
    password?: string;
  }): Promise<string> {
    const { status, json, body } = await this.postJSON(
      '/proxy/auth8/v1/admin/users',
      payload,
    );
    if (status >= 400) throw new Error(`createUser failed: ${status} ${body}`);
    const data = json as Record<string, unknown> | null;
    return (data?.['id'] as string) ?? '';
  }

  /** List Auth8 groups for the org/env. Returns array of {id, name}. */
  async listGroups(): Promise<Array<{ id: string; name: string }>> {
    const { status, json, body } = await this.get('/proxy/auth8/v1/admin/groups');
    if (status >= 400) throw new Error(`listGroups failed: ${status} ${body}`);
    const data = json as Array<{ id: string; name: string }> | null;
    return data ?? [];
  }

  /** Add a user to an Auth8 group. */
  async addGroupMember(groupId: string, userId: string): Promise<void> {
    const { status, body } = await this.postJSON(
      `/proxy/auth8/v1/admin/groups/${groupId}/members`,
      { user_id: userId },
    );
    if (status >= 400) throw new Error(`addGroupMember failed: ${status} ${body}`);
  }

  /** Find a group by name and add a user to it. */
  async addUserToGroupByName(groupName: string, userId: string): Promise<void> {
    const groups = await this.listGroups();
    const group = groups.find(g => g.name === groupName);
    if (!group) throw new Error(`Group "${groupName}" not found`);
    await this.addGroupMember(group.id, userId);
  }
}
