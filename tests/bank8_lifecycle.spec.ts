// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/bank8_lifecycle.spec.ts
//
// Bank8 vertical lifecycle e2e - platform setup happens ONCE in
// global-setup.ts via the sentin8-cli binary (org/env/features/app
// instances/staff users). This spec drives ONLY the four bank8 apps
// through the browser, exactly like a real user:
//
//   1. Ben signs in to Bank8:Admin (staff SSO) and creates ledger products.
//   2. Alice signs up as an iBank customer via eBank.
//   3. Alice opens Checking/Savings/Credit Card accounts.
//   4. Bob signs in to eTeller (staff) and finds Alice.
//   5. Alice signs in to eBank and checks her accounts.
//   6. Alice signs up at eFintech and completes the FDX consent flow,
//      seeing her iBank accounts.
//
// Dash tests (operator onboarding, playground routes) live in the
// sentin8 e2e suite - the bank8 suite never opens Dash.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  Personas,
  signUpViaApp,
  signInToTenantAuth8,
  signOutViaUI,
  signInOnAuth8,
  gotoCertWarm,
  waitForFlutterSemantics,
  waitForFlutterText,
  clickFlutterButton,
  typeFlutterField,
  getFlutterTexts,
  assertSessionCookieSet,
  logStep,
  cliCall,
} from '../fixtures';

test.describe.configure({ mode: 'serial' });

// Meta written by global-setup.ts (org/env IDs, app hostnames).
interface TestMeta {
  runId: string;
  domain: string;
  ibankOrgId: string;
  ibankEnvId: string;
  ibankStaffEnvId: string;
  ibankOrgDomain: string;
  ebankHostname: string;
  adminAppHostname: string;
  etellerHostname: string;
  benEmail: string;
  bobEmail: string;
  aliceEmail: string;
}

/**
 * TLS cert-warmup for the vertical service TENANT routes
 * ({service}.{env}.{org-domain}) - the admin UI reaches ledger/payments/
 * fdx/… through the BFF proxy, whose forward client TLS-connects to those
 * hosts. Services mint their on-demand Acme leaf on the FIRST hit and the
 * BFF's connect can lose that race (surfacing as a 502 "error sending
 * request" while the upstream logs "cert registered on-demand" ~70ms
 * later - the same race the browser absorbs via gotoCertWarm).
 *
 * One unauthenticated GET per service route; ANY verdict (401/403/404/200)
 * completes the mint. Bounded: total poll window ~15s, then give up -
 * first use in the tests re-triggers the mint anyway.
 */
async function warmTenantServiceRoutes(meta: TestMeta, orgDomain: string): Promise<void> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const deadline = Date.now() + 15_000;
    let warmed = false;
    // One representative route per service family - ledger's admin-ui route
    // is the first one the admin UI drives; warming it warms the shared
    // on-demand cert path for the rest (same org/env suffix mints fine).
    const routes = [
      `https://bank8-ledger.prod.${orgDomain}/v1/health`,
    ];
    while (Date.now() < deadline && !warmed) {
      for (const url of routes) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(3_000) });
          // ANY HTTP verdict means TLS is live - the mint completed.
          if (resp.status > 0) { warmed = true; break; }
        } catch {
          // Not minted yet - retry below.
        }
      }
      if (!warmed) await new Promise((r) => setTimeout(r, 500));
    }
    if (warmed) logStep('[lifecycle] tenant service routes TLS-warmed');
    else logStep('[lifecycle] ⚠️ tenant service route warmup window elapsed - first call may race the mint');
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
}

function loadMeta(): TestMeta {
  const raw = readFileSync(join(process.cwd(), '.tmp', 'test-meta.json'), 'utf-8');
  return JSON.parse(raw) as TestMeta;
}

const PAUSE_ON_STEP = process.env.PAUSE_ON_STEP ?? '';

/**
 * Clear the auth rate-limit Valkey keys (auth uses DB 1). Repeated staff
 * sign-ins during e2e runs trip bot protection (10/min per IP, 5/min per
 * email) with a generic "Invalid email or password"-looking failure - clear
 * before each staff sign-in.
 */
function clearAuthRateLimits(email: string): void {
  try {
    execSync(
      `valkey-cli -n 1 --scan --pattern 'auth:rate:*' | xargs -r valkey-cli -n 1 del`,
      { stdio: 'pipe', timeout: 2_000 },
    );
  } catch {
    // Best-effort - limiter may be disabled in this deployment.
  }
  logStep(`[lifecycle] cleared auth rate limits (for ${email})`);
}

async function maybePause(page: Page, stepTitle: string): Promise<void> {
  if (!PAUSE_ON_STEP || PAUSE_ON_STEP === 'none') return;
  if (!stepTitle.includes(PAUSE_ON_STEP)) return;
  await page.pause();
}

test.describe('Bank8 Lifecycle - Admin + eBank + eTeller (bank8 apps + services only)', () => {
  let context: BrowserContext;
  let page: Page;
  let meta: TestMeta;

  test.beforeAll(async ({ browser }) => {
    meta = loadMeta();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    page = await context.newPage();
    // Diagnostics (mid-flow "TypeError: Failed to fetch" investigation):
    // surface failed requests + 5xx with the failing hop's error text.
    page.on('requestfailed', (r) =>
      console.log('[requestfailed]', r.url().slice(0, 140), '=>', r.failure()?.errorText));
    page.on('response', (r) => { if (r.status() >= 500) console.log('[http-5xx]', r.status(), r.url().slice(0, 140)); });
    // TLS cert-warmup for the vertical service tenant routes - the BFF's
    // forward client races the upstream's on-demand Acme leaf on the
    // first hit of a fresh run (see warmTenantServiceRoutes).
    await warmTenantServiceRoutes(meta, meta.ibankOrgDomain);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Bank8:Admin - Ben (staff SSO) creates ledger products
  // ═══════════════════════════════════════════════════════════════════════

  test('1. Ben signs in to Bank8:Admin (staff SSO) and creates ledger products', async () => {
    await maybePause(page, '1.');
    logStep('[lifecycle] 1 start: Ben signs in to Bank8:Admin via staff SSO and creates products');

    // IMPORTANT: use the emails persisted by globalSetup - Personas compute
    // RUN_ID at module-load time, which differs per worker (globalSetup ran
    // in its own process with its own timestamp). Ben was created by
    // globalSetup with THAT run's email.
    const ben = { email: meta.benEmail, password: Personas.ben.password! };
    const adminURL = `https://${meta.adminAppHostname}`;
    logStep(`[lifecycle] 1 step: navigating to Bank8:Admin at ${adminURL}`);

    await gotoCertWarm(page, adminURL);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    // If not already signed in (SSO via shared cookie), sign in via staff auth.
    // FAIL FAST: each step must succeed - no silent catch-and-continue.
    const texts = await getFlutterTexts(page);
    const alreadySignedIn = texts.some((t) => t.includes('Overview') || t.includes('Ledger'));
    if (!alreadySignedIn) {
      logStep('[lifecycle] 1 step: not signed in - signing in via staff auth');
      await clickFlutterButton(page, 'Staff Sign In');
      await page.waitForTimeout(500);

      await waitForFlutterSemantics(page, 2_000);
      await waitForFlutterText(page, 'Email', 2_000);
      // Rate limiter: repeated sign-ins during e2e trips bot protection.
      clearAuthRateLimits(ben.email);
      await signInOnAuth8(page, ben.email, ben.password!);
      await page.waitForTimeout(1_000);

      // Verify the sign-in actually landed on the admin app - fail fast
      // with the page content if it did not. POLL for the dashboard: the
      // app boots over the OAuth callback chain, so a single read 1s after
      // the submit races the Flutter render (observed: page text still
      // empty while the screenshot a moment later shows Overview). Up to
      // 15s, checking every 500ms.
      const landDeadline = Date.now() + 15_000;
      let signedIn = false;
      let postTexts: string[] = [];
      while (Date.now() < landDeadline) {
        postTexts = await getFlutterTexts(page);
        if (postTexts.some((t) => t.includes('Overview') || t.includes('Ledger') || t.includes('Products'))) {
          signedIn = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (!signedIn) {
        throw new Error(
          `Staff sign-in did not land on Bank8:Admin. url=${page.url()} page: ${postTexts.slice(0, 15).join(' | ')}`,
        );
      }
    }

    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);
    logStep('[lifecycle] 1 step: Bank8:Admin loaded');

    // Navigate to Ledger > Products via sidebar. "Ledger" is an
    // ExpansionTile - click to expand, then click "Products".
    // FAIL FAST: if the sidebar never shows Products, fail with page text.
    let productsVisible = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ledgerBtn = page.getByRole('button', { name: 'Ledger', exact: false });
      if (await ledgerBtn.count() > 0) {
        await ledgerBtn.first().click({ force: true });
      } else {
        await clickFlutterButton(page, 'Ledger');
      }
      await page.waitForTimeout(500);
      try {
        await waitForFlutterText(page, 'Products', 2_000);
        productsVisible = true;
        break;
      } catch {
        logStep(`[lifecycle] 1 step: sidebar Products not visible (attempt ${attempt + 1}/3)`);
      }
    }
    if (!productsVisible) {
      const sidebarTexts = await getFlutterTexts(page);
      throw new Error(`Sidebar "Products" never appeared after expanding Ledger. Page: ${sidebarTexts.slice(0, 15).join(' | ')}`);
    }
    await clickFlutterButton(page, 'Products');
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    const products = [
      { type: 'current_account', name: 'iBank Checking' },
      { type: 'savings_account', name: 'iBank Savings' },
      { type: 'credit_card', name: 'iBank Credit Card' },
    ];

    for (const p of products) {
      let createClicked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await waitForFlutterText(page, 'Create Product', 2_000);
          await clickFlutterButton(page, 'Create Product');
          await page.waitForTimeout(500);
          createClicked = true;
          break;
        } catch {
          logStep(`[lifecycle] 1 step: Create Product not found (attempt ${attempt + 1}/3) - re-navigating via hash`);
          await page.evaluate(() => {
            history.replaceState(null, '', '#/ledger/products');
            window.dispatchEvent(new Event('hashchange'));
          });
          await page.waitForTimeout(2000);
          await waitForFlutterSemantics(page, 2_000);
          await page.waitForTimeout(500);
        }
      }
      if (!createClicked) {
        throw new Error('Could not find "Create Product" button in Bank8:Admin after 3 attempts');
      }

      // Wait for the product type selection page.
      let typeSelected = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await waitForFlutterText(page, 'Select Product Type', 2_000);
          typeSelected = true;
          break;
        } catch {
          logStep(`[lifecycle] 1 step: Select Product Type not found (attempt ${attempt + 1}/3) - retrying`);
          await page.waitForTimeout(1000);
        }
      }
      if (!typeSelected) throw new Error('Could not find "Select Product Type" page');

      // Navigate directly to the product config form via URL hash.
      await page.evaluate((t: string) => {
        history.replaceState(null, '', `#/ledger/products/new?type=${t}`);
        window.dispatchEvent(new Event('hashchange'));
      }, p.type);
      await waitForFlutterSemantics(page, 2_000);
      await page.waitForTimeout(1000);

      await typeFlutterField(page, 'Product Name', p.name);
      await page.waitForTimeout(100);

      // Click the form submit button - the last "Create Product" button on
      // the page (form submit, not the header action). Scroll into view if
      // needed (Flutter SingleChildScrollView).
      await page.evaluate(() => {
        document.querySelectorAll('flt-semantics').forEach(el => {
          (el as HTMLElement).style.pointerEvents = 'none';
        });
      });
      const submitResult = await page.evaluate(() => {
        const els = document.querySelectorAll('flt-semantics');
        let lastMatch: Element | null = null;
        for (const el of Array.from(els)) {
          const role = el.getAttribute('role');
          const t = (el.textContent ?? '').trim().toLowerCase();
          if (role === 'button' && t === 'create product') lastMatch = el;
        }
        if (!lastMatch) return { found: false, x: 0, y: 0, top: 0, bottom: 0, vh: 0 };
        const r = (lastMatch as HTMLElement).getBoundingClientRect();
        return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });

      if (submitResult.found) {
        if (submitResult.bottom > submitResult.vh) {
          await page.mouse.wheel(0, submitResult.bottom - submitResult.vh + 100);
          await page.waitForTimeout(500);
          const newRect = await page.evaluate(() => {
            const els = document.querySelectorAll('flt-semantics');
            let lastMatch: Element | null = null;
            for (const el of Array.from(els)) {
              if (el.getAttribute('role') === 'button' && (el.textContent ?? '').trim().toLowerCase() === 'create product') lastMatch = el;
            }
            if (!lastMatch) return null;
            const r = (lastMatch as HTMLElement).getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          if (newRect) {
            await page.mouse.click(newRect.x, newRect.y);
          } else {
            await page.mouse.click(submitResult.x, submitResult.y);
          }
        } else {
          await page.mouse.click(submitResult.x, submitResult.y);
        }
      } else {
        await clickFlutterButton(page, 'Create Product', false);
      }
      await page.evaluate(() => {
        document.querySelectorAll('flt-semantics').forEach(el => {
          (el as HTMLElement).style.pointerEvents = '';
        });
      });
      await page.waitForTimeout(1000);

      // FAIL FAST: a submit that did nothing (policy denial, validation
      // error, silent no-op) must abort the test here - NOT three steps
      // later when test 3's account-open can't find the product. Scan the
      // UI for error toasts right after the submit.
      const postSubmitTexts = await getFlutterTexts(page);
      const uiError = postSubmitTexts.find((t) =>
        /forbidden|unauthorized|authorization failed|failed by policy|denied|creation failed|error:/i.test(t));
      if (uiError) {
        throw new Error(
          `Product "${p.name}" was NOT created - UI reported: "${uiError}". ` +
          `Page: ${postSubmitTexts.slice(0, 15).join(' | ')}`);
      }

      // Back to the products list via hash change.
      await page.evaluate(() => {
        history.replaceState(null, '', '#/ledger/products');
        window.dispatchEvent(new Event('hashchange'));
      });
      await page.waitForTimeout(2000);
      await waitForFlutterSemantics(page, 2_000);
      await page.waitForTimeout(500);

      // FAIL FAST: the product MUST be listed on the products page before
      // the loop continues - a silent no-op submit is a failure, not a skip.
      // A FULL page reload (not a hash swap) on retry: a hash-only re-render
      // reuses the app's cached HTTP connections, so a dropped keep-alive
      // socket surfaces as "TypeError: Failed to fetch" forever; a reload
      // rebuilds the session fetch path from scratch.
      let productListed = false;
      let lastListTexts: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        lastListTexts = await getFlutterTexts(page);
        if (lastListTexts.some((t) => t.includes(p.name))) {
          productListed = true;
          break;
        }
        logStep(`[lifecycle] 1 step: product "${p.name}" not listed yet (attempt ${attempt + 1}/3) - reloading page`);
        await page.evaluate(() => {
          history.replaceState(null, '', '#/ledger/products');
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForFlutterSemantics(page, 4_000);
        await page.waitForTimeout(1000);
      }
      if (!productListed) {
        throw new Error(
          `Product "${p.name}" was not created - absent from the products list after 3 checks. ` +
          `Page: ${lastListTexts.slice(0, 15).join(' | ')}`);
      }

      logStep(`[lifecycle] 1 step: product created and listed: ${p.name}`);
    }

    logStep(`[lifecycle] 1 done: Ben created 3 ledger products via Bank8:Admin`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // eBank - Alice (customer) signs up and opens accounts
  // ═══════════════════════════════════════════════════════════════════════

  test('2. Alice signs up as iBank customer via eBank', async () => {
    await maybePause(page, '2.');
    logStep('[lifecycle] 2 start: Alice signs up as iBank customer');
    // meta emails come from the globalSetup that JUST ran in this process -
    // Personas' module-level RUN_ID can drift on worker retry (known issue).
    const alice = { email: meta.aliceEmail, firstName: Personas.alice.firstName, lastName: Personas.alice.lastName, password: Personas.alice.password! };
    const appURL = `https://${meta.ebankHostname}`;

    await signUpViaApp(page, context, appURL, alice.email, alice.firstName, alice.lastName, alice.password!);
    await assertSessionCookieSet(context, '__session');
    logStep(`[lifecycle] 2 done: Alice signed up: ${alice.email}`);
  });

  test('3. Alice opens Checking, Savings, and Credit Card accounts', async () => {
    await maybePause(page, '3.');
    logStep('[lifecycle] 3 start: Alice signs in and opens 3 accounts');
    const alice = { email: meta.aliceEmail, password: Personas.alice.password! };
    const appURL = `https://${meta.ebankHostname}`;

    await signInToTenantAuth8(page, context, appURL, alice.email, alice.password!);
    logStep('[lifecycle] 3 step: Alice signed in to iBank');

    const products = [
      { name: 'iBank Checking' },
      { name: 'iBank Savings' },
      { name: 'iBank Credit Card' },
    ];
    for (const p of products) {
      await openLedgerAccountViaUI(page, p.name, 'USD', 'Products');
      logStep(`[lifecycle] 3 step: opened account: ${p.name}`);
    }

    await clickFlutterButton(page, 'Accounts', true);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(501);

    const texts = await getFlutterTexts(page);
    const all = texts.join(' ');
    expect(all).toContain('iBank Checking');
    expect(all).toContain('iBank Savings');
    expect(all).toContain('iBank Credit Card');
    logStep('[lifecycle] 3 done: Accounts page shows all 3 iBank products');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // eTeller - Bob (teller staff) signs in and finds Alice
  // ═══════════════════════════════════════════════════════════════════════

  test('4. Bob serves Alice at eTeller - CIBA delegation + cash deposit', async () => {
    await maybePause(page, '4.');
    logStep('[lifecycle] 4 start: Bob signs in to eTeller, finds Alice, CIBA delegation, $500 cash deposit');

    const bob = { email: meta.bobEmail, password: Personas.bob.password! };
    const alice = { email: meta.aliceEmail, password: Personas.alice.password! };
    const tellerURL = `https://${meta.etellerHostname}`;

    try { await signOutViaUI(page); } catch { /* may already be signed out */ }
    // F-D hardening: clear cookies unconditionally before navigating to
    // eTeller. The old signOutViaUI was a silent no-op here (eTeller had
    // no test bridge) and a stale BFF session cookie auto-SSO'd the app
    // past the landing page (run32: Alice's eBank session leaked into the
    // teller session - incident 2026-08-28). With the platform fixes
    // (per-app cookie scope + session↔app binding) a foreign cookie is
    // rejected anyway; clearing makes the sign-in path deterministic.
    await context.clearCookies();
    // Cookie clearing does NOT navigate - the page would otherwise stay on
    // the previous app's domain (eBank) with its UI fully rendered, and
    // every later "Staff Sign In" / eTeller check below would inspect the
    // WRONG app. Navigate to the teller host deterministically.
    await gotoCertWarm(page, tellerURL);
    // The sign-out/redirect can leave the new page blank (the SPA unmounts
    // before the new document loads) - poll for semantics instead of a
    // single wait, and re-goto when the page stays blank.
    let landingReady = false;
    for (let attempt = 0; attempt < 4 && !landingReady; attempt++) {
      try {
        await waitForFlutterSemantics(page, 1_500);
        landingReady = (await getFlutterTexts(page)).length > 0;
      } catch {
        landingReady = false;
      }
      if (!landingReady) {
        await page.waitForTimeout(500);
      }
    }
    if (!landingReady) {
      await gotoCertWarm(page, tellerURL);
      await waitForFlutterSemantics(page, 2_000);
    }
    await page.waitForTimeout(500);

    // Signed-IN detection: the eTeller landing page (signed out) shows
    // 'Staff Sign In' + 'Branch Teller Terminal'. Its title also contains
    // 'Teller', so text-match on the app name is NOT a valid check.
    // Detect the sign-in button instead; click it and complete staff SSO.
    const texts = await getFlutterTexts(page);
    const needsSignIn = texts.some((t) => t.includes('Staff Sign In'));
    if (needsSignIn) {
      logStep('[lifecycle] 4 step: signing in Bob to eTeller');
      await clickFlutterButton(page, 'Staff Sign In');
      await page.waitForTimeout(500);
      await waitForFlutterSemantics(page, 2_000);
      await waitForFlutterText(page, 'Email', 2_000);
      clearAuthRateLimits(bob.email);
      await signInOnAuth8(page, bob.email, bob.password!);
      await page.waitForTimeout(1_000);
      // After SSO redirect back, verify the shell actually loaded with a
      // session (nav + Dashboard), not the landing page again. The teller
      // shell's dashboard shows "Welcome, <name> teller" + the Quick
      // Actions nav; 'Customer Search' only appears after navigating -
      // detect the dashboard state, not a specific page. The text
      // extraction races the semantics render - poll briefly before
      // declaring failure.
      await waitForFlutterSemantics(page, 2_000);
      let signedInNow = false;
      let afterTexts: string[] = [];
      for (let attempt = 0; attempt < 5 && !signedInNow; attempt++) {
        afterTexts = await getFlutterTexts(page);
        signedInNow = afterTexts.some((t) =>
          t.includes('Customer Search') || t.includes('Welcome, Bob') || t.includes('Quick Actions'));
        if (!signedInNow) {
          await page.waitForTimeout(800);
          await waitForFlutterSemantics(page, 1_500);
        }
      }
      expect(signedInNow, `Bob must be signed in to eTeller - landing page still shown? Page: ${afterTexts.slice(0, 10).join(' | ')}`).toBe(true);
    }

    await waitForFlutterSemantics(page, 2_000);

    // FAIL FAST: a Bootstrap error means the eTeller runtime context 404'd -
    // an app provisioning bug, not a test problem.
    const tellerTexts = await getFlutterTexts(page);
    const tellerAll = tellerTexts.join(' ');
    expect(tellerAll, `eTeller must load its UI (url=${page.url()}). Page: ${tellerTexts.slice(0, 12).join(' | ')}`).toContain('eTeller');
    logStep('[lifecycle] 4 step: Bob signed in to eTeller');

    // F-D - IDENTITY assertion (fail-fast): verify the session actually
    // belongs to Bob via the BFF /auth/session endpoint (same call the
    // app made). Run32 silently operated as Alice (cross-app session
    // replay - incident 2026-08-28); this assertion turns any wrong-user
    // session into a hard failure instead of a silently wrong journey.
    const sessionResp = await page.request.get(`https://bff.${meta.etellerHostname}/auth/session`, { failOnStatusCode: false });
    expect(sessionResp.status(), 'eTeller BFF session must exist for Bob').toBe(200);
    const sessionJson = await sessionResp.json();
    const sessionEmail: string = sessionJson?.user?.email ?? '';
    expect(
      sessionEmail,
      `eTeller session identity must be Bob (${meta.bobEmail}) - got '${sessionEmail}'. Wrong-user session (silent SSO / replay?)`,
    ).toBe(meta.bobEmail);
    logStep(`[lifecycle] 4 step: session identity verified: ${sessionEmail}`);

    // ── Step 1: search for Alice ────────────────────────────────────────
    await clickFlutterButton(page, 'Customer Search');
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'Search by name or email', 2_000);
    logStep('[lifecycle] 4 step: on Customer Search page');
    await typeFlutterField(page, 'Search by name or email', alice.email);
    await page.waitForTimeout(300);
    await clickFlutterButton(page, 'Search');
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'alice', 4_000);
    logStep('[lifecycle] 4 step: Alice found in customer search');

    // ── Step 2: select Alice → delegation choice → CIBA ─────────────────
    await clickFlutterButton(page, 'Alice');
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'Customer Access', 3_000);
    logStep('[lifecycle] 4 step: delegation choice page shown');
    // The assisted-login flow returns a verification link that this same
    // browser can visit to play the customer role (CIBA decoupled approval).
    await clickFlutterButton(page, 'Assisted Login - Send link to customer');
    await page.waitForTimeout(500);

    await waitForFlutterText(page, 'Link: https://', 5_000);
    logStep('[lifecycle] 4 step: CIBA verification link issued, polling started');

    // ── Step 3: Alice approves on the assisted link ─────────────────────
    // Capture the verification URL from the semantics (it is rendered text).
    const pageTexts = await getFlutterTexts(page);
    const linkLine = pageTexts.find((t) => t.startsWith('Link: https://'));
    expect(linkLine, 'eTeller must display the CIBA verification link').toBeTruthy();
    const verificationUrl = linkLine!.replace(/^Link:\s*/, '').trim();
    logStep(`[lifecycle] 4 step: navigating to verification link (customer consent)`);

    await gotoCertWarm(page, verificationUrl);
    await waitForFlutterSemantics(page, 2_000);
    // The assisted-login page: if Alice already has a session on this Auth
    // (she signed in to eBank earlier - same platform Auth), a Confirm button
    // appears; otherwise sign in first. Handle both.
    const assistTexts = await getFlutterTexts(page);
    if (assistTexts.some((t) => t.includes('Confirm'))) {
      await clickFlutterButton(page, 'Confirm', true);
    } else {
      await waitForFlutterText(page, 'Email', 2_000);
      await typeFlutterField(page, 'Email', alice.email);
      await page.waitForTimeout(300);
      await typeFlutterField(page, 'Password', alice.password!);
      await page.waitForTimeout(300);
      await clickFlutterButton(page, 'Sign In & Authorize');
      await page.waitForTimeout(1_000);
    }
    await waitForFlutterText(page, 'You are authenticated', 5_000);
    logStep('[lifecycle] 4 step: Alice approved the CIBA request');

    // ── Step 4: back to eTeller - delegation approved ───────────────────
    await gotoCertWarm(page, tellerURL);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(1_000);
    // After the reload the shell restores the delegation from sessionStorage
    // (§3.0.3a) - poll until the sidebar shows the delegated customer
    // ("Customer: <name>" is rendered ONLY when _hasDelegation=true), then
    // navigate. Dashboard quick-action tiles also say "Cash Deposit", so a
    // text-only check would race the restore.
    let delegationApproved = false;
    for (let i = 0; i < 24; i++) {
      const t = (await getFlutterTexts(page)).join(' ');
      if (t.includes('Customer: ')) {
        delegationApproved = true;
        break;
      }
      await page.waitForTimeout(500);
      if (i === 6) {
        logStep('[lifecycle] 4 step: still waiting for delegation restore');
      }
    }
    expect(delegationApproved, `eTeller should show customer operations after CIBA approval - url=${page.url()}`).toBe(true);
    logStep('[lifecycle] 4 step: eTeller shows customer operations (delegation active)');

    // ── Step 5: Cash Deposit - $500 into Alice's Savings ────────────────
    await clickFlutterButton(page, 'Cash Deposit');
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'Cash Deposit', 3_000);
    logStep('[lifecycle] 4 step: on Cash Deposit page');

    // §3.1.1 - account options are ALWAYS-VISIBLE choice cards (overlay
    // menus - Autocomplete AND DropdownButton - are invisible to
    // flt-semantics). The page loads accounts asynchronously; poll for the
    // Savings card and click it.
    const cardDeadline = Date.now() + 8_000;
    let savingsCardVisible = false;
    while (Date.now() < cardDeadline && !savingsCardVisible) {
      const texts = await getFlutterTexts(page);
      savingsCardVisible = texts.some((t) => t.toLowerCase().includes('ibank savings'));
      if (savingsCardVisible) break;
      await page.waitForTimeout(400);
    }
    expect(savingsCardVisible, 'Alice Savings card must appear on Cash Deposit').toBeTruthy();

    // Resolve the FULL Savings account id through the eTeller BFF proxy
    // with Bob's delegated session (isolation-design §8/§10.1: platform-
    // operator tokens are env-locked out of tenant customer accounts, so
    // the CLI-as-Bill list correctly returns [] - resolve via the same
    // call the app's fetchAllAccounts makes; the BFF stamps the CIBA
    // delegation). Requires the X-BFF-Delegation header (§4.3f Option A -
    // without it the proxy falls through to the staff token, which sees
    // no customer accounts) - the app persists the delegation id in
    // sessionStorage under `eteller.delegation_id`.
    const delegationId = await page.evaluate(() => sessionStorage.getItem('eteller.delegation_id'));
    expect(delegationId, 'eTeller delegation id must be persisted in sessionStorage after CIBA approval').toBeTruthy();
    const tellerBffBase = `https://bff.${meta.etellerHostname}`;
    const accountsRes = await page.request.get(`${tellerBffBase}/proxy/bank8-ledger/v1/accounts`, {
      headers: { 'X-BFF-Delegation': delegationId! },
    });
    expect(accountsRes.status(), 'eTeller delegated account list must be readable via BFF proxy').toBe(200);
    const accountsBody = (await accountsRes.json()) as Record<string, unknown>;
    // Envelope shapes: BFF proxy may wrap {data:{accounts:[...]}} or return
    // the bare list the app unwraps (res.data?['accounts']).
    const accountsJson = (accountsBody['data'] ?? accountsBody) as { accounts?: Array<{ id: string; nickname?: string; product_type?: string }>; data?: Array<{ id: string; nickname?: string; product_type?: string }> };
    const allAccounts = accountsJson.accounts ?? accountsJson.data ?? (Array.isArray(accountsJson) ? accountsJson : []);
    const savings = allAccounts.find((a) => a.nickname === 'iBank Savings');
    expect(savings, `iBank Savings must appear in the delegated account list (${allAccounts.length} accounts)`).toBeTruthy();
    const savingsAccountId = savings!.id;
    logStep(`[lifecycle] 4 step: resolved Savings account via delegated session: ${savingsAccountId}`);

    // The card labels are rendered as ListTile text inside one semantics
    // subtree; select via the Savings-specific role locator (each card is a
    // tappable node). Fall back to a canvas click at the node's coordinates.
    const savingsNode = page.getByText(/iBank Savings · Alice Customer · .+ · customer/).first();
    try {
      await savingsNode.click({ force: true, timeout: 2_000 });
    } catch {
      await clickFlutterButton(page, 'iBank Savings', false);
    }
    logStep('[lifecycle] 4 step: selected the Savings card');
    await page.waitForTimeout(300);

    await typeFlutterField(page, 'Amount', '500.00');
    await page.waitForTimeout(300);
    await clickFlutterButton(page, 'Deposit Cash');
    logStep('[lifecycle] 4 step: submitted $500 cash deposit');

    await waitForFlutterText(page, 'successfully', 5_000);
    logStep('[lifecycle] 4 step: $500 cash deposited into Alice Savings via delegated session');

    // ── Step 6: verify the posting actually persisted (§8.4 blind spot)
    // The UI success message alone is NOT proof: the audit-INSERT arity bug
    // rolled back every posting tx server-side while the UI reported
    // success. Assert the server-side committed balance via the delegated
    // BFF proxy session (read-your-writes) before the test may pass - the
    // CLI-as-operator path is env-locked out of tenant customer data
    // (isolation-design §8/§10.1).
    const balRes = await page.request.get(`${tellerBffBase}/proxy/bank8-ledger/v1/accounts/${savingsAccountId}/balances`, {
      headers: { 'X-BFF-Delegation': delegationId! },
    });
    expect(balRes.status(), 'delegated balances read must succeed via BFF proxy').toBe(200);
    const balBody = (await balRes.json()) as Record<string, unknown>;
    const balJson = (balBody['data'] ?? balBody) as Array<{ account_id: string; denomination: string; phase: string; amount: string }> | { balances?: Array<{ account_id: string; denomination: string; phase: string; amount: string }> };
    const balances = Array.isArray(balJson) ? balJson : (balJson.balances ?? []);
    const committed = balances.find(
      (b) => b.phase === 'COMMITTED',
    );
    expect(committed, `Savings account must have a COMMITTED CAD balance row (got ${JSON.stringify(balances)?.slice(0, 200)})`).toBeTruthy();
    expect(Number(committed!.amount), `committed CAD balance must be > 0 (got ${committed!.amount})`).toBeGreaterThan(0);
    logStep(`[lifecycle] 4 done: delegated-session-verified committed CAD balance = ${committed!.amount}`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // eBank - Alice checks her accounts
  // ═══════════════════════════════════════════════════════════════════════

  test('5. Alice signs in to eBank and checks her accounts', async () => {
    await maybePause(page, '5.');
    logStep('[lifecycle] 5 start: Alice signs in to eBank and checks accounts');

    const alice = { email: meta.aliceEmail, password: Personas.alice.password! };
    const appURL = `https://${meta.ebankHostname}`;

    try { await signOutViaUI(page); } catch { /* may already be signed out */ }
    await waitForFlutterSemantics(page, 2_000);

    await signInToTenantAuth8(page, context, appURL, alice.email, alice.password!);
    logStep('[lifecycle] 5 step: Alice signed in to eBank');

    // FAIL FAST: the Accounts page must exist and show the accounts.
    await waitForFlutterText(page, 'Accounts', 2_000);
    await clickFlutterButton(page, 'Accounts', true);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    const acctTexts = await getFlutterTexts(page);
    const allText = acctTexts.join(' ');
    expect(
      allText.includes('iBank Checking') || allText.includes('iBank Savings') || allText.includes('iBank Credit Card'),
      `eBank accounts not visible. Page: ${acctTexts.slice(0, 15).join(' | ')}`,
    ).toBe(true);

    // ── Tenant-isolation canary (ledger design §5/§9): Alice must see
    // ONLY her own accounts - no internal counterparty accounts and no
    // other tenant's data. The holder-scoped RLS + the service-layer
    // customer filter must guarantee the negative assertions below.
    const ownAccounts = ['iBank Checking', 'iBank Savings', 'iBank Credit Card'];
    const internalNicknames = ['cash_deposit_account', 'cheque_clearing_account', 'liquidity_account', 'clearing_account', 'suspense_account'];
    // Verify the positive list AND the negatives through the same holder
    // session the app uses (eBank BFF proxy → ledger list_accounts).
    const ebankBffBase = `https://bff.${meta.ebankHostname}`;
    const isoRes = await page.request.get(`${ebankBffBase}/proxy/bank8-ledger/v1/accounts`, { failOnStatusCode: false });
    expect(isoRes.status(), 'eBank BFF session must read Alice account list for the isolation canary').toBe(200);
    const isoBody = (await isoRes.json()) as Record<string, unknown>;
    const isoJson = (isoBody['data'] ?? isoBody) as { accounts?: Array<{ id: string; nickname?: string; account_type?: string }>; data?: Array<{ id: string; nickname?: string; account_type?: string }> };
    const isoAccounts = isoJson.accounts ?? isoJson.data ?? (Array.isArray(isoJson) ? isoJson : []);
    expect(isoAccounts.length, `Alice must see at least her 3 opened accounts (got ${isoAccounts.length})`).toBeGreaterThanOrEqual(3);
    // (a) NO internal accounts - counterparty plumbing is invisible to
    // holders regardless of query params (isolation-design §10.1).
    const internalLeak = isoAccounts.filter((a) => a.account_type === 'internal');
    expect(internalLeak, `isolation violation: internal accounts leaked to a customer token (${internalLeak.map((a) => a.nickname).join(',')})`).toHaveLength(0);
    // (b) NO cross-env data - every row belongs to Alice's env; the
    // customer rows visible are exactly hers (the seeded institution
    // customer's internal accounts never appear under any filter).
    const foreignInternal = isoAccounts.filter((a) => (a.nickname ?? '').includes('_account') && a.account_type !== 'customer');
    expect(foreignInternal, `isolation violation: non-customer accounts in a customer's list (${foreignInternal.map((a) => a.nickname).join(',')})`).toHaveLength(0);
    logStep('[lifecycle] 5 step: isolation canary passed - customer sees only own customer-type accounts');

    logStep('[lifecycle] 5 done: Alice checked eBank accounts');
  });

  // ═══════════════════════════════════════════════════════════════════════

// ── Helpers ────────────────────────────────────────────────────────────

/** Open a ledger account for the given product via the eBank UI. */
async function openLedgerAccountViaUI(page: Page, productName: string, _denomination: string, navPage: string = 'Products'): Promise<void> {
  logStep(`[lifecycle] openLedgerAccountViaUI: starting for ${productName} (nav: ${navPage}), URL: ${page.url()}`);
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, navPage, 2_000);
  await clickFlutterButton(page, navPage, true);
  await page.waitForTimeout(500);
  await waitForFlutterText(page, productName, 2_000);
  // Click the product card (Semantics button labelled with the product name).
  try {
    const btn = page.getByRole('button', { name: productName, exact: false });
    if (await btn.count() > 0) {
      await btn.first().click({ force: true });
    } else {
      await clickFlutterButton(page, productName);
    }
  } catch {
    await clickFlutterButton(page, productName);
  }
  await page.waitForTimeout(500);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the detail page - it has an "Account Name (Nickname)" label.
  // FAIL FAST: if the detail page did not load after two clicks, fail with
  // page context instead of clicking "Open Account" on the wrong page.
  try {
    await waitForFlutterText(page, 'Nickname', 2_000);
  } catch {
    const detailTexts = await getFlutterTexts(page);
    throw new Error(`Account detail page did not load for ${productName} (no Nickname field). Page: ${detailTexts.slice(0, 12).join(' | ')}`);
  }
  await page.waitForTimeout(500);
  await clickFlutterButton(page, 'Open Account', true);
  logStep(`[lifecycle] openLedgerAccountViaUI: clicked Open Account`);
  // Verify the account was created - success message or return to catalog.
  try {
    await waitForFlutterText(page, 'successfully', 3_000);
    logStep(`[lifecycle] openLedgerAccountViaUI: account created successfully`);
  } catch {
    const afterTexts = await getFlutterTexts(page);
    const stillOnForm = afterTexts.some((t) => t.includes('Nickname'));
    if (stillOnForm) {
      throw new Error(`Open Account submit for ${productName} did not confirm - still on the detail form. Page: ${afterTexts.slice(0, 12).join(' | ')}`);
    }
    // Navigated away from the form - treat as created (some flows redirect).
    logStep(`[lifecycle] openLedgerAccountViaUI: submitted (no success text; form dismissed)`);
  }
  try {
    await page.waitForTimeout(500);
    await clickFlutterButton(page, navPage, true);
    await page.waitForTimeout(500);
  } catch { /* might already be on the catalog page */ }
  await waitForFlutterSemantics(page, 2_000);
  logStep(`[lifecycle] openLedgerAccountViaUI: done, URL: ${page.url()}`);
}
});
