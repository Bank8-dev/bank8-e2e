// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/testdata.ts - shared test data (URLs, personas, listing payloads).
//
// Mirrors fixtures/testdata.go from the Go playwright-go suite.
//
// Everything below is TENANT-ORG/ENV-first: this suite drives the bank8
// vertical's four apps and their tenant auth hosts. The ONE platform
// surface the suite needs is Sentin8:Auth's system-realm endpoint (the
// CLI's device-flow sign-in in global-setup posts against it) - it is
// the single `URLs.platformAuth` entry, derived from SENTIN8_DOMAIN.

/** Sentin8 platform root domain (defaults to `local.sentin8.dev`). */
export const DOMAIN = process.env.SENTIN8_DOMAIN ?? 'local.sentin8.dev';

// ── Tenant org/ev URL helpers ─────────────────────────────────────────
// The suite operates on the iBank tenant org with its prod env (the
// iFinTech recipient org moved to the openfin8-e2e suite). Every URL
// a test touches is one of:
//
//   app runtime      https://{app-slug}.{env-slug}.{org-domain}
//   BFF8 proxy       https://bff8.{app-slug}.{env-slug}.{org-domain}
//   tenant auth      https://auth.{org-domain}
//   staff auth env   https://auth.{env-slug}.{org-domain}
//
// org-domain defaults to {org-slug}.{SENTIN8_DOMAIN} but an org can set
// a custom_domain (the personas below declare theirs - e.g.
// ibank8NNNN.local); helpers take the resolved org domain as an arg.

/** The two tenant org custom domains the protocol suites probe
 *  (suites 4/6) - global-setup creates the orgs with these
 *  custom_domain values.
 *  DNS: the resolver's wildcard covers *.local.sentin8.dev ONLY
 *  (SENTIN8_ACME_LOCAL_DOMAINS), so the tenant zones are derived as
 *  {tenant}.local.{DOMAIN} - subdomains of the platform wildcard zone,
 *  never bare `.local` names (those resolve nowhere and Acme would
 *  relay them upstream). */
export const TENANT_DOMAINS = {
  ibank: `ibank.local.${DOMAIN}`,
} as const;

/** Tenant org domain: {org-slug}.{SENTIN8_DOMAIN}. */
export function orgDomain(orgSlug: string, domain: string = DOMAIN): string {
  return `${orgSlug}.${domain}`;
}

/** Tenant auth URL for an org: https://auth.{org-domain}.
 *  This is where CUSTOMER journeys resolve (customer auth env). */
export function tenantAuthURL(orgDomainOrSlug: string): string {
  const d = orgDomainOrSlug.includes('.') ? orgDomainOrSlug : orgDomain(orgDomainOrSlug);
  return `https://auth.${d}`;
}

/** Staff auth env URL: https://auth.{env-slug}.{org-domain}.
 *  This is where STAFF journeys resolve (env-scoped staging auth). */
export function staffAuthURL(orgDomainOrSlug: string, envSlug = 'staff'): string {
  const d = orgDomainOrSlug.includes('.') ? orgDomainOrSlug : orgDomain(orgDomainOrSlug);
  return `https://auth.${envSlug}.${d}`;
}

/** App8 runtime URL for an installed instance:
 *  https://{app-slug}.{env-slug}.{org-domain}. */
export function tenantAppURL(orgDomainOrSlug: string, envSlug: string, appSlug: string): string {
  const d = orgDomainOrSlug.includes('.') ? orgDomainOrSlug : orgDomain(orgDomainOrSlug);
  return `https://${appSlug}.${envSlug}.${d}`;
}

/** BFF8 proxy URL for an installed instance:
 *  https://bff8.{app-slug}.{env-slug}.{org-domain}. */
export function tenantBff8URL(orgDomainOrSlug: string, envSlug: string, appSlug: string): string {
  const d = orgDomainOrSlug.includes('.') ? orgDomainOrSlug : orgDomain(orgDomainOrSlug);
  return `https://bff8.${appSlug}.${envSlug}.${d}`;
}

/** Vertical service URL (system environment):
 *  https://{dash-form subdomain}.ops.sys.{SENTIN8_DOMAIN}.
 *  Used only by global-setup's CLI `call` passthroughs (the CLI's
 *  resolver accepts the dash form only; platform CLI backlog). */
export function verticalServiceURL(service: string, domain: string = DOMAIN): string {
  return `https://${service}.ops.sys.${domain}`;
}

// ── Sentin8:Auth system-realm URL - the ONE platform entry ───────────
// Needed by fixtures/cli.ts (device-flow sign-in writes the CLI token
// the setup calls ride on) and by the protocol suites' system-realm
// checks (T4 issuer, T1/T6/T8 anonymous-endpoint probes).
export const Auth8URL = `https://auth.ops.sys.${DOMAIN}`;

// ── Personas ───────────────────────────────────────────────────────────

// ── Timestamp helper ──────────────────────────────────────────────────
// Generates a unique run ID so tests can be re-run without resetting
// the database. Each run gets a fresh timestamp appended to user
// emails, org names, and env names.

export const RUN_ID = Date.now().toString().slice(-8);

export function withRunID(base: string): string {
  return `${base}${RUN_ID}`;
}

export function emailWithRunID(base: string): string {
  return `${base}+${RUN_ID}@a.co`;
}

// ── sentin8-cli binary ────────────────────────────────────────────────
// Used by fixtures/cli.ts for all platform setup (org/env/features/apps/
// users) - no Dash-driven platform setup in the bank8 suite.
//
// Path anchors are absolute (cwd-independent, RS §4.5.1-1): the sibling
// platform group's cli checkout first, then a system-installed CLI.
export const TREE_ROOT = '/home/hamid/dev/sentin8.new';
export const CLI_BIN =
  process.env.SENTIN8_CLI_BIN ??
  `${TREE_ROOT}/sentin8/sentin8-cli/target/release/sentin8-cli`;

// ── Personas ───────────────────────────────────────────────────────────

export interface Persona {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  domain?: string;
  role?: string;
  orgName?: string;
  orgSlug?: string;
  envName?: string;
  envSlug?: string;
}

export const Personas: Record<'dan' | 'bill' | 'alice' | 'bob' | 'carol' | 'ben', Persona> = {
  dan: {
    firstName: 'Dan',
    lastName: 'Developer',
    email: emailWithRunID('dan'),
    password: 'Test1234!',
    domain: `${withRunID('iapp')}.local.${DOMAIN}`,
    role: 'App8 catalog admin',
    orgName: withRunID('TestOrg'),
    orgSlug: withRunID('testorg'),
  },
  bill: {
    firstName: 'Bill',
    lastName: 'Banker',
    email: emailWithRunID('bill'),
    password: 'Test1234!',
    domain: `${withRunID('ibank')}.local.${DOMAIN}`,
    role: 'Sentin8 org admin',
    orgName: withRunID('iBank'),
    orgSlug: withRunID('ibank'),
    envName: 'Prod',
    envSlug: 'prod',
  },
  // frank (the iFinTech recipient-org persona) moved with the recipient
  // journey to the openfin8-e2e suite - the bank8 lifecycle no longer
  // provisions that tenant.
  alice: {
    firstName: 'Alice',
    lastName: 'Customer',
    email: emailWithRunID('alice'),
    password: 'Test1234!',
  },
  carol: {
    firstName: 'Carol',
    lastName: 'Customer',
    email: emailWithRunID('carol'),
    password: 'Test1234!',
  },
  bob: {
    firstName: 'Bob',
    lastName: 'teller',
    email: emailWithRunID('bob'),
    password: 'Test1234!',
  },
  ben: {
    firstName: 'Ben',
    lastName: 'Admin',
    email: emailWithRunID('ben'),
    password: 'Test1234!',
  },
} as const;

// ── Listing payloads ───────────────────────────────────────────────────

export interface ListingPayload {
  appName: string;
  appSlug: string;
  description: string;
  // backendUrl: string;
  /** OAuth scopes the app requires (comma/space separated). */
  scopes?: string;
  /** CIBA (OpenID 2 / RFC decoupled-flow) declaration - mirrors the
   *  app8-listing.json `ciba_defaults` block for eteller. */
  grantTypes?: string[];
  cibaDefaults?: {
    delivery: string;
    requestMode: string;
    defaultExpirySeconds: number;
    pollIntervalSeconds: number;
    bindingMessageTemplate: string;
    customerScopes: string[];
  };
}

/** Common scopes for an eBank retail customer - read-only access to
 *  their own accounts + ability to initiate payments. */
const EBANK_CUSTOMER_SCOPES = [
  'bank8:ledger:accounts:read',
  'bank8:ledger:accounts:write',
  'bank8:ledger:products:read',
  'bank8:ledger:postings:read',
  'bank8:ledger:balances:read',
  'bank8:payments:instructions:read',
  'bank8:payments:instructions:write',
  'bank8:payments:payments:read',
  'db:data:read',
  'storage:env:read',
  'post:read',
];

/** Teller-only scopes (the deltas over the customer set). The
 *  full teller scope set is resolved server-side as
 *  `EBANK_CUSTOMER_SCOPES ∪ EBANK_TELLER_DELTA_SCOPES` via the
 *  `includes: ['ebank:customer']` field on the teller role. */
const EBANK_TELLER_DELTA_SCOPES = [
  'bank8:ledger:postings:write',
  'bank8:ledger:products:write',
  'bank8:payments:payments:write',
];

/** Admin-only scopes (the deltas over the teller set, which itself
 *  pulls in customer via `includes`).  The full admin scope set
 *  is resolved server-side as
 *  `EBANK_CUSTOMER_SCOPES ∪ EBANK_TELLER_DELTA_SCOPES ∪
 *   EBANK_ADMIN_DELTA_SCOPES`. */
const EBANK_ADMIN_DELTA_SCOPES = [
  'openfin8:ca:provider:read',
  'openfin8:ca:provider:write',
  'openfin8:ca:admin',
  'bank8:ledger:accounts:write:any',
  'db:data:write',
  'storage:env:write',
];

export const EBankListingPayload: ListingPayload = {
  appName: 'eBank',
  appSlug: 'ebank',
  description:
    'Digital banking with current accounts, savings, loans, credit cards, mortgages, and FDX Data Provider capability.',

  scopes: EBANK_CUSTOMER_SCOPES
    .concat(EBANK_TELLER_DELTA_SCOPES, EBANK_ADMIN_DELTA_SCOPES)
    .join(' '),
};

/** eTeller scopes - teller staff with Ledg8 + Paym8 access for branch operations.
 *  Mirrors apps/eteller/app8-listing.json (the single source of truth):
 *  the manual-decisions scopes use the registry hyphen form, and the
 *  manifest carries only scopes with real handler gates. */
const ETELLER_STAFF_SCOPES = [
  'bank8:ledger:accounts:read',
  'bank8:ledger:accounts:write',
  'bank8:ledger:products:read',
  'bank8:ledger:postings:read',
  'bank8:ledger:postings:write',
  'bank8:ledger:balances:read',
  'bank8:ledger:customers:write',
  'bank8:ledger:dlq:read',
  'bank8:ledger:dlq:republish',
  'bank8:ledger:schedules:read',
  'bank8:ledger:schedules:write',
  'bank8:ledger:audit:read',
  'bank8:payments:instructions:read',
  'bank8:payments:instructions:write',
  'bank8:payments:payments:read',
  'bank8:payments:routing:read',
  'bank8:payments:manual-decisions:read',
  'bank8:payments:manual-decisions:write',
  'bank8:payments:tasks:read',
  'bank8:payments:tasks:write',
  'bank8:payments:tasks:approve',
  'bank8:payments:mandates:read',
  'bank8:payments:mandates:write',
];

export const ETellerListingPayload: ListingPayload = {
  appName: 'eTeller',
  appSlug: 'eteller',
  description:
    'Branch teller terminal for cash deposits, cheque deposits, withdrawals, transfers, and customer account management.',
  //backendUrl: 'http://localhost:3007',
  scopes: ETELLER_STAFF_SCOPES.join(' '),
  grantTypes: ['authorization_code', 'refresh_token', 'urn:openid:params:grant-type:ciba'],
  cibaDefaults: {
    delivery: 'assisted_link',
    requestMode: 'poll',
    defaultExpirySeconds: 300,
    pollIntervalSeconds: 5,
    bindingMessageTemplate: 'eTeller request from {teller_name} - {operation_label}',
    customerScopes: [
      'bank8:ledger:accounts:read', 'bank8:ledger:accounts:write',
      'bank8:ledger:postings:read', 'bank8:ledger:postings:write',
      'bank8:ledger:balances:read', 'bank8:ledger:customers:read',
      'bank8:ledger:products:read',
      'bank8:payments:instructions:read', 'bank8:payments:instructions:write',
      'bank8:payments:cards:read', 'bank8:payments:cards:write',
      'bank8:payments:mandates:read', 'bank8:payments:mandates:write',
    ],
  },
};
