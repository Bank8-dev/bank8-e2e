// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/global-setup.ts - runs ONCE before all test files.
//
// Platform setup happens entirely through the sentin8-cli binary (no Dash
// browser flows - Dash coverage lives in the sentin8 e2e suite):
//
//   1. CLI sign-in (Bill, platform operator) via headless device flow.
//   2. iBank org + staff/prod envs via `sys org create` / `sys env create`.
//   3. Vertical services (ledger, payments, openfin8-ca) enabled on prod env.
//   4. App instances (eBank, eTeller, Admin) installed from store listings.
//   5. Staff users (Ben org-admin, Bob teller) + group membership.
//
// The resulting org/env/hostname data is written to .tmp/test-meta.json
// and read by the lifecycle spec. UI tests then drive ONLY the four bank8
// apps (admin, ebank, eteller) - the recipient journey lives in openfin8-e2e.

import { Personas, RUN_ID, DOMAIN } from '../fixtures/testdata.js';
import { runCli, cliCall, cliDo, cliDoSettled, cliSignIn, cliRefreshToken, cliCallSettled, assertCliOk } from '../fixtures/cli.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const META_PATH = join(process.cwd(), '.tmp', 'test-meta.json');

let _done = false;

export async function globalSetup(): Promise<void> {
  if (_done) return;
  _done = true;

  const bill = Personas.bill;
  const ben = Personas.ben;
  const bob = Personas.bob;

  // ── 1. CLI sign-in as Bill (platform operator for this run) ────────
  await runCli([
    'signup', '--email', bill.email!, '--password', bill.password!,
    '--first-name', bill.firstName, '--last-name', bill.lastName,
  ]).catch(() => undefined); // best-effort; user may already exist
  await cliSignIn(bill.email!, bill.password!);
  assertCliOk(await runCli(['whoami']), 'globalSetup: CLI whoami after sign-in');

  // ── 2. iBank org + envs ─────────────────────────────────────────────
  const org = await cliDo('sys', 'org', 'create', {
    display_name: bill.orgName!,
    name: bill.orgSlug!,
    slug: bill.orgSlug!,
    domain: bill.domain!,
  });
  assertCliOk(org, 'globalSetup: create iBank org');
  const ibankOrgId = (org.json as { id: string }).id;
  const ibankOrgDomain =
    (org.json as { custom_domain?: string }).custom_domain ?? bill.domain!;

  // Org verify acts as the PROVISIONING BARRIER before any
  // authorize_org-gated call: org create delegates the creator's
  // access-model provisioning (membership in sentin8:org:{slug}:owners)
  // to an async Sentin8:Flow workflow (sentin8 sys design §5.1). A CLI
  // call that lands inside that window fails with a transient 403
  // "not a member of this organization" (§3.1d-1 pre-grant identity).
  // The settled variant retries until membership exists - do NOT
  // proceed to env creation until this succeeds.
  const orgVerify = await cliCallSettled('sys', 'GET', `/v1/org/${ibankOrgId}`);
  assertCliOk(orgVerify, 'globalSetup: CLI verify iBank org (provisioning barrier)');

  // Settled variant: org create → env create can still race the last
  // provisioning step; retry transient denies instead of failing.
  const staffEnv = await cliDoSettled('sys', 'env', 'create', {
    org_id: ibankOrgId,
    display_name: 'Staff',
    name: 'staff',
    slug: 'staff',
    env_type: 'staging',
  });
  assertCliOk(staffEnv, 'globalSetup: create iBank staff env');
  const ibankStaffEnvId = (staffEnv.json as { id: string }).id;

  const prodEnv = await cliDoSettled('sys', 'env', 'create', {
    org_id: ibankOrgId,
    display_name: bill.envName!,
    name: bill.envSlug!,
    slug: bill.envSlug!,
    env_type: 'production',
  });
  assertCliOk(prodEnv, 'globalSetup: create iBank prod env');
  const ibankEnvId = (prodEnv.json as { id: string }).id;

  // CLI-verify org + env (read-your-writes). Settled variant: the env
  // verify can race the env's own Flow provisioning (env:admin role).
  assertCliOk(
    await cliCallSettled('sys', 'GET', `/v1/org/${ibankOrgId}`),
    'globalSetup: CLI verify iBank org',
  );
  assertCliOk(
    await cliCallSettled('sys', 'GET', `/v1/env/${ibankEnvId}`),
    'globalSetup: CLI verify iBank prod env',
  );

  // Refresh the CLI token - org + env creation assigned Bill new roles
  // (org:admin → nested sys:features:admin etc.), but the access token
  // predates them and carries the old scope set.
  await cliRefreshToken();

  // ── 3. Enable vertical services on the prod env ────────────────────
  // VDC-9 (design/sentin8-vertical-data-plane-contract.md §VDC.8): ONE
  // enable event per service - the env-init path is verified working, so
  // the former brute-force re-PUT loops (30× re-firing the enable event to
  // mask a silently-broken consumer) are removed. A seed that genuinely
  // fails must FAIL the suite, not be retried away.
  // reporting/risk/compliance are the regulatory suite - enabling them
  // seeds jurisdiction obligations + policy templates through each
  // service's env-init consumer (bank8:reporting:envinit etc.).
  for (const svc of ['ledger', 'payments', 'fdx', 'reporting', 'risk', 'compliance']) {
    assertCliOk(
      await cliCall('sys', 'PUT', `/v1/env/${ibankEnvId}/services`, { service: svc, enabled: true, config: {} }),
      `globalSetup: enable ${svc} on iBank prod env`,
    );
  }

  // ── 4. Install app instances from store listings ────────────────────
  const listings = await cliCall('app', 'GET', '/v1/app/store/listings');
  assertCliOk(listings, 'globalSetup: list app store listings');
  const listingItems = (listings.json as Array<{ id: string; app_slug: string }>) ?? [];
  const listingId = (slug: string): string => {
    const hit = listingItems.find((l) => l.app_slug === slug);
    if (!hit) throw new Error(`globalSetup: listing ${slug} not found in store (${listingItems.length} listings)`);
    return hit.id;
  };

  /**
   * Install an app instance via POST /v1/app/setup. The endpoint returns an
   * RFW redirect (no hostname body), so the canonical default hostname is
   * derived here - matching setup_instance's derivation for non-custom
   * domains: {app_slug}.{env_slug}.{org_domain}.
   */
  const instanceIds = new Map<string, string>();
  async function installApp(
    slug: string,
    envId: string,
    name: string,
    authUrl?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = { listing_id: listingId(slug), instance_name: name };
    if (authUrl) body.auth_url = authUrl;
    const resp = await cliCall('app', 'POST', '/v1/app/setup', body, envId);
    assertCliOk(resp, `globalSetup: install ${slug}`);
    // Resolve the instance id via Sys's auth-mode API (the same lookup the
    // BFF's F-A gate uses) - the F-A strict gate checks membership of the
    // setup-provisioned `sentin8:app:{instance_id}` group in the token's
    // auth env, and that group's role carries the listing's scopes (the
    // live `principal.scopes` the vertical scope-mirror policies evaluate
    // against). The setup response is a redirect envelope (no instance id).
    const hostname = `${slug}.${bill.envSlug}.${ibankOrgDomain}`;
    const authMode = await cliCall(
      'sys', 'GET',
      `/v1/app-instance/auth-mode?hostname=${encodeURIComponent(hostname)}`,
    );
    assertCliOk(authMode, `globalSetup: auth-mode lookup for ${slug}`);
    const body2 = authMode.json as { application_id?: string };
    instanceIds.set(slug, body2.application_id ?? '');
    // Default hostname: {app_slug}.{env_slug}.{org.domain} - org.domain is
    // the platform-assigned domain ({slug}.{SENTIN8_DOMAIN}), NOT the
    // persona's .local string.
    return `${slug}.${bill.envSlug}.${ibankOrgDomain}`;
  }

  const staffAuthUrl = `https://auth.staff.${ibankOrgDomain}`;
  const ebankHostname = await installApp('bank8-ebank', ibankEnvId, 'eBank');
  const etellerHostname = await installApp('bank8-eteller', ibankEnvId, 'eTeller', staffAuthUrl);
  const adminAppHostname = await installApp('bank8-admin', ibankEnvId, 'Bank8 Admin', staffAuthUrl);

  // ── 5. Staff users (Ben org-admin, Bob teller) ──────────────────────
  // Staff users live in the org-scoped (staff) Auth env. Created via the
  // auth admin API (requires --env=<staff env>).
  const benUser = await cliCall('auth', 'POST', '/v1/admin/users', {
    email: ben.email, first_name: ben.firstName, last_name: ben.lastName,
    password: ben.password!, group_ids: [],
  }, ibankStaffEnvId);
  assertCliOk(benUser, 'globalSetup: create Ben (staff user)');

  const bobUser = await cliCall('auth', 'POST', '/v1/admin/users', {
    email: bob.email, first_name: bob.firstName, last_name: bob.lastName,
    password: bob.password!, group_ids: [],
  }, ibankStaffEnvId);
  assertCliOk(bobUser, 'globalSetup: create Bob (staff user)');

  /** Find-or-create an auth group in the staff env, then add the member. */
  async function ensureGroupMember(groupName: string, userId: string, label: string): Promise<void> {
    const groups = await cliCall('auth', 'GET', '/v1/admin/groups', undefined, ibankStaffEnvId);
    assertCliOk(groups, `globalSetup: list groups (${label})`);
    // Response shape: { "groups": [...] } (verified live).
    const root = groups.json as { groups?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
    const items = Array.isArray(root) ? root : (root?.groups ?? []);
    let group = items.find((g) => g.name === groupName);
    if (!group) {
      const created = await cliCall('auth', 'POST', '/v1/admin/groups', { name: groupName }, ibankStaffEnvId);
      assertCliOk(created, `globalSetup: create group ${groupName}`);
      group = created.json as { id: string; name: string };
    }
    await cliCall('auth', 'POST', `/v1/admin/groups/${group.id}/members`, { user_id: userId }, ibankStaffEnvId);
    console.log(`  ✅ globalSetup: ${label}`);
  }

  // Ben → sentin8:env:admins (the platform-seeded env admin group - sys
  // env provisioning creates it with the `sentin8:env:admin` role attached,
  // whose permissions include `sentin8:sys:env:admin` - the live scope the
  // vertical scope-mirror policies permit on) + membership in the admin
  // app's instance group `sentin8:app:bank8_admin` (the F-A app-group gate,
  // BFF design §4.3a, strict mode: staff-app users must be members of the
  // instance's group in the token's auth env - org admin roles alone no
  // longer grant an admin-app session). The instance group is provisioned
  // by app setup_instance (staff auth_domain → staff env) BEFORE here, so
  // ensureGroupMember finds it in the catalog. Uniform RBAC naming
  // (principles §6.0b): the `sentin8:app:` prefix replaced the legacy bare
  // `app:` form; the legacy org-scoped `org:admins` group is gone -
  // env-scoped admin authorization rides the sys-seeded `sentin8:env:admins`.
  await ensureGroupMember('sentin8:env:admins', (benUser.json as { id: string }).id, 'Ben → sentin8:env:admins');
  // Ben/Bob → the INSTANCE groups provisioned by app setup
  // (`sentin8:app:{instance_id}`, staff auth env). The F-A strict gate
  // checks THESE names, and their setup-attached role carries the
  // listing's scopes - the live `principal.scopes` the vertical
  // scope-mirror policies evaluate against. The legacy snake_case groups
  // (`sentin8:app:bank8_admin`) grant nothing (AUTH-3 retired them).
  const adminInstanceGroup = instanceIds.get('bank8-admin');
  const tellerInstanceGroup = instanceIds.get('bank8-eteller');
  if (adminInstanceGroup) {
    await ensureGroupMember(`sentin8:app:${adminInstanceGroup}`, (benUser.json as { id: string }).id, 'Ben → sentin8:app:{admin instance}');
  } else {
    await ensureGroupMember('sentin8:app:bank8_admin', (benUser.json as { id: string }).id, 'Ben → sentin8:app:bank8_admin (legacy fallback)');
  }
  if (tellerInstanceGroup) {
    await ensureGroupMember(`sentin8:app:${tellerInstanceGroup}`, (bobUser.json as { id: string }).id, 'Bob → sentin8:app:{teller instance}');
  } else {
    await ensureGroupMember('sentin8:app:e_teller', (bobUser.json as { id: string }).id, 'Bob → sentin8:app:e_teller (legacy fallback)');
  }

  // ── Write meta for test files ───────────────────────────────────────
  const meta = {
    runId: RUN_ID,
    domain: DOMAIN,
    ibankOrgId,
    ibankEnvId,
    ibankStaffEnvId,
    ibankOrgDomain,
    ebankHostname,
    adminAppHostname,
    etellerHostname,
    benEmail: ben.email,
    bobEmail: bob.email,
    aliceEmail: Personas.alice.email,
  };
  mkdirSync(dirname(META_PATH), { recursive: true });
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
  console.log(`  ✅ globalSetup complete - meta written to ${META_PATH}`);
}

export default globalSetup;

export function getMetaPath(): string {
  return META_PATH;
}