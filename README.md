
# bank8-e2e - Playwright TypeScript end-to-end suite

> The bank8 vertical's proof that the product works for the person using
> it: a real browser, a real sign-up, a real org - with the same
> restrictions a user has. Built on the official **@playwright/test**
> runner.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/docs/read-3aa757.svg)](https://bank8.dev/docs/services/e2e)
[![Website](https://img.shields.io/badge/website-bank8.dev-1a73e8.svg)](https://bank8.dev)

The suite drives **only the four bank8 tenant apps** (bank8-admin,
bank8-ebank, bank8-efintech, bank8-eteller) through the browser and the
BFF8 proxy - platform setup happens in `tests/global-setup.ts` via the
**sentin8-cli** binary, and Dash flows live in the platform's own e2e
repo (`sentin8-e2e`). Per `AGENTS.md`, e2e **never touches the database
directly** - no psql, no backdoor API access from the UI suites.

## Suites

| Suite | Path | Description |
|-------|------|-------------|
| Lifecycle | `tests/bank8_lifecycle.spec.ts` | Serial UI journey across all four apps: Ben creates ledger products in Admin, Alice signs up via eBank and opens accounts, Bob finds her in eTeller and deposits, Alice verifies her balance, Alice completes the FDX consent flow at eFintech. |
| Tenant auth flows | `tests/protocol/suite4_tenant_auth_flows.spec.ts` | HTTP-only: OIDC discovery, JWKS, token, health on tenant auth hosts. |
| Tenant resolution | `tests/protocol/suite6_tenant_resolution_enforcement.spec.ts` | HTTP-only: cross-tenant isolation, host resolution, 401 on cross-tenant. |
| Token exchange | `tests/protocol/suite8_token_exchange.spec.ts` | HTTP-only: RFC 8693 token-exchange protocol behavior. |

## Tenancy model - where every URL comes from

All URLs the suite touches are **tenant org/env** URLs, derived from the
run's personas (`fixtures/testdata.ts`):

| Surface | Form |
|---------|------|
| App runtime | `https://{app-slug}.{env-slug}.{org-domain}` |
| BFF8 proxy | `https://bff8.{app-slug}.{env-slug}.{org-domain}` |
| Tenant auth (customer) | `https://auth.{org-domain}` |
| Staff auth env | `https://auth.{env-slug}.{org-domain}` |

`org-domain` is the platform default `{org-slug}.{SENTIN8_DOMAIN}` or the
org's custom domain (the personas declare theirs, e.g. `ibank8NNNN.local`).
The single platform-surface exception is Sentin8:Auth's system-realm
endpoint (`Auth8URL`), which the CLI's device-flow sign-in in
global-setup posts against and the protocol suites probe for system-realm
issuer checks.

## Prerequisites

1. **A running bank8 + platform stack** - from the tree root:
   ```bash
   make infra-up && make start          # platform group: infra + services
   cd bank8 && make start               # vertical: enrolled services + apps
   ```
2. **Node 20+ and a package manager** (npm or pnpm).
3. **Local CA trust** - `scripts/with-ca.sh` installs the Sentin8 local
   root CA into the trust store and exports `NODE_EXTRA_CA_CERTS` before
   launching the runner (Node's bundled store ignores the system store).

## Setup

```bash
make install          # pnpm install + Chromium download
```

## Running

```bash
# Full UI lifecycle (headed by default, failfast on first failure)
./scripts/with-ca.sh make test

# Lifecycle / protocol suites individually
./scripts/with-ca.sh make test-lifecycle
./scripts/with-ca.sh make test-protocol

# Direct runner invocation (equivalent)
./scripts/with-ca.sh npx playwright test tests/bank8_lifecycle.spec.ts

# Type check / HTML report
make lint
make report
```

Environment toggles: `PLAYWRIGHT_HEADLESS=true` (CI), `SENTIN8_DOMAIN`
(overrides the default `local.sentin8.dev`), `SENTIN8_CLI_BIN` (CLI path
override), `PLAYWRIGHT_MAX_FAILURES=0` (disable failfast).

## Layout

```
bank8-e2e/
├── package.json / tsconfig.json / playwright.config.ts
├── fixtures/
│   ├── testdata.ts    - tenant-first URL helpers + personas + listing payloads
│   ├── state.ts       - cross-suite state via .e2e-state.json
│   ├── harness.ts     - Flutter semantics helpers, tenant sign-in/up flows
│   ├── apiclient.ts   - direct HTTP client (local CA)
│   ├── cli.ts         - sentin8-cli subprocess runner + setup call helpers
│   ├── strictpage.ts  - console-error / HTTP-error assertions
│   └── index.ts       - barrel export
├── scripts/
│   └── with-ca.sh     - CA trust wrapper
└── tests/
    ├── global-setup.ts          - platform setup via sentin8-cli (once per run)
    ├── bank8_lifecycle.spec.ts  - the serial UI lifecycle
    └── protocol/                - HTTP-only suites (4/6/8)
```

## The read-your-writes rule

Every mutation test asserts the **server-side effect** (through the BFF8
proxy or the CLI), not UI text. History: the ledger audit-INSERT arity
bug produced exactly this blind spot - every posting rolled back
server-side while the teller UI reported "$500 deposited successfully",
and the suite stayed green for weeks. Two corollaries:

- Tenant data is resolved **through the same surface the human uses** -
  e.g. the eTeller account list is fetched via the delegated BFF session
  (`/proxy/bank8-ledger/v1/accounts`), never with a platform-operator
  token (env-locking makes that path empty by design).
- The suite is a **product-gap detector, not a workaround engine** - a
  state that cannot be reached through the UI/API is a backend gap to
  fix, never something to paper over with direct data access.

## Strict page assertions

`StrictPage` records console errors and HTTP ≥ 400 responses during
browser interactions; any console error or HTTP failure fails the test.

## What is NOT tested here

- **Dash/platform flows** - live in the platform e2e repo (`sentin8-e2e`).
- **Flutter unit/widget tests** - in the app repos themselves.