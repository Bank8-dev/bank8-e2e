// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/harness.ts - Playwright helpers for the bank8 tenant e2e suites.
//
// This suite drives ONLY the four bank8 tenant apps through a real
// browser - platform setup happens in tests/global-setup.ts via the
// sentin8-cli binary, so the harness carries no Dash flows. Provides:
//   - clickFlutterButton / waitForFlutterText / typeFlutterField / etc.
//   - gotoCertWarm - first-goto TLS cert-warmup retry
//   - signOutViaUI, signInOnAuth8, signUpViaApp, signInToTenantAuth8
//   - assertSessionCookieSet and other assertion helpers
//
// All Flutter interactions dispatch synthetic MouseEvents on
// flt-semantics nodes because Flutter CanvasKit FilledButtons don't
// respond to Playwright's native clicks.

import { type Page, type BrowserContext, expect } from '@playwright/test';
// testdata helpers re-exported at the tail
// ── Sign-in / sign-up flows ───────────────────────────────────────────

/**
 * Goto with a cert-warmup retry: an app-served hostname on a freshly
 * created env has no TLS cert yet - the browser's first handshake loses
 * the race against the on-demand Acme fetch (the cert lands ~100ms
 * later; observed `net::ERR_SSL_PROTOCOL_ERROR` on the very first
 * goto). One bounded retry absorbs that window for every caller.
 */
export async function gotoCertWarm(page: Page, url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (e) {
      const msg = String(e);
      const transient =
        msg.includes('ERR_SSL_PROTOCOL_ERROR') ||
        msg.includes('ERR_CONNECTION_RESET') ||
        msg.includes('net::ERR_ABORTED');
      if (!transient || Date.now() >= deadline) throw e;
      logStep(`[step] gotoCertWarm: attempt ${attempt} failed (${msg.slice(0, 80)}), retrying`);
      await page.waitForTimeout(750);
    }
  }
}

/** Sign out via the Flutter test bridge (clears cookies, redirects to /sign-in). */
export async function signOutViaUI(page: Page): Promise<void> {
  logStep(`[step] signOutViaUI: signing out via test bridge`);
  await waitForBridge(page, 'sentin8TestSignOut', 2_000);
  const ok = await callBridge(page, 'sentin8TestSignOut');
  if (!ok) throw new Error('sentin8TestSignOut bridge returned false');
  await waitForURLContains(page, '/sign-in', 2_000);
  try {
    await waitForFlutterText(page, 'Sign in', 2_000);
  } catch {
    // page might still be loading
    await page.waitForTimeout(500);
  }
}

/** Fill and submit the Auth8 sign-up form (shared by signUpAs and signUpViaApp). */
async function signUpOnAuth8(
  page: Page,
  email: string,
  firstName: string,
  lastName: string,
  password: string,
): Promise<void> {
  logStep(`[step] signUpOnAuth8: filling form for ${email}`);
  await waitForFlutterSemantics(page, 2_000);
  // The auth8-ui may land on the sign-in page first - click "Sign up"
  // to switch to the sign-up form, but only if the sign-up form isn't
  // already visible (e.g. when navigated directly to /sign-up).
  let hasSignUpForm = false;
  try {
    hasSignUpForm = await page.evaluate((needle: string) => {
      // Check flt-semantics (textContent + aria-label)
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        if (t.includes(needle)) return true;
      }
      // Check input/textarea elements (CanvasKit text fields)
      const inputs = document.querySelectorAll('input, textarea');
      for (const el of Array.from(inputs)) {
        const t = (el.getAttribute('aria-label') ?? '').toLowerCase();
        if (t.includes(needle)) return true;
      }
      return false;
    }, 'first name (optional)');
  } catch {
    // Navigation in progress - assume sign-up form not visible yet.
  }
  if (!hasSignUpForm) {
    await clickFlutterButton(page, 'Sign up');
    // The "Sign up" click may cause a full page navigation to /sign-up,
    // which requires Flutter to re-boot. Wait for the page to settle
    // and the sign-up form to appear.
    await page.waitForTimeout(500);
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'First name (optional)', 2_000);
  }
  await typeFlutterField(page, 'First name (optional)', firstName);
  await typeFlutterField(page, 'Last name (optional)', lastName);
  await typeFlutterField(page, 'Email', email);
  await typeFlutterField(page, 'Password', password);
  await typeFlutterField(page, 'Confirm password', password);
  // Accept the Terms of Service checkbox (required by the sign-up form).
  await clickFlutterCheckbox(page, 'Terms of Service');
  // Submit the form by clicking the "Create account" button.
  // Try multiple approaches since CanvasKit buttons can be tricky.
  await clickFlutterButton(page, 'Create account');
  await page.waitForTimeout(300);
  // If the form is still visible (click didn't work), try pressing
  // Enter on the focused element.
  let stillOnSignUp = false;
  try {
    stillOnSignUp = await page.evaluate(() => {
      return !!document.querySelector('flt-semantics[role="checkbox"]');
    });
  } catch {
    // Execution context destroyed (navigation in progress) - the form
    // submitted successfully, so we're no longer on the sign-up page.
    stillOnSignUp = false;
  }
  if (stillOnSignUp) {
    await page.keyboard.press('Enter');
  }
  // Wait for the sign-up API response (Set-Cookie + redirect).
  await page.waitForTimeout(500);
}

export async function signInOnAuth8(page: Page, email: string, password: string): Promise<void> {
  logStep(`[step] signInOnAuth8: signing in ${email}`);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the sign-in form to be ready before typing. The auth redirect
  // chain may still be in flight when this runs - poll for the form (3
  // attempts) before failing; if the OAuth callback completes the sign-in
  // client-side in the meantime (auto-session), the URL check in the caller
  // handles it and this wait is moot.
  let emailVisible = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await waitForFlutterText(page, 'Email', 2_000);
      emailVisible = true;
      break;
    } catch {
      const url = page.url();
      if (!url.includes('sign-in') && !url.includes('auth')) {
        // Already redirected away from the auth page - the session is live.
        emailVisible = true;
        break;
      }
      await page.waitForTimeout(500);
    }
  }
  if (!emailVisible) {
    throw new Error(`signInOnAuth8: sign-in form never rendered on ${page.url()}`);
  }
  // The sign-up → auto-session path can complete the OAuth callback WHILE we
  // were waiting for the form: the page may now be back at the app (or on the
  // consent page), not on /sign-in. Typing into the form then fails with "No
  // Flutter text field found" - treat a redirect-away as success instead.
  const urlBeforeType = page.url();
  if (!urlBeforeType.includes('sign-in') && !urlBeforeType.includes('auth')) {
    logStep(`[step] signInOnAuth8: page already redirected away (session live) - skipping sign-in`);
    return;
  }
  await page.waitForTimeout(500);
  await typeFlutterField(page, 'Email', email);
  await page.waitForTimeout(300);
  await typeFlutterField(page, 'Password', password);
  await page.waitForTimeout(300);
  // Submit the form by clicking the "Continue" button. Use exact matching
  // to avoid clicking "Continue with SSO".
  await clickFlutterButton(page, 'Continue', true);
  // Wait for the sign-in API response (Set-Cookie + OAuth callback redirect).
  await page.waitForTimeout(500);
}

/** Sign up a customer through an app (e.g. eBank at www.ibank.local). */
export async function signUpViaApp(
  page: Page,
  context: BrowserContext,
  appURL: string,
  email: string,
  firstName: string,
  lastName: string,
  password: string,
): Promise<void> {
  logStep(`[step] signUpViaApp: signing up ${email} at ${appURL}`);
  // A stale __Host-bff-session cookie from a previous run would skip the
  // landing page entirely (the app renders the signed-in dashboard). Clear
  // cookies and storage so we genuinely test the sign-up path.
  await context.clearCookies();
  // Navigate to the app. Retry on connection reset - the proxy may need
  // to fetch a TLS cert from ACME on the first request (1-2s).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(appURL, { waitUntil: 'domcontentloaded' });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        logStep(`signUpViaApp: retry ${attempt + 1}/3 after connection reset`);
        await page.waitForTimeout(500);
      }
    }
  }
  if (lastErr && !(await page.url()).includes(appURL.replace('https://', ''))) {
    throw lastErr;
  }
  await waitForFlutterSemantics(page, 2_000);
  // Cold-boot poll: the engine boot (runtime context + session check +
  // canvaskit load) can exceed 8s on a fresh run even with certs warmed -
  // poll for the landing state instead of a fixed 3-attempt click storm.
  let clicked = false;
  const clickDeadline = Date.now() + 30_000;
  while (Date.now() < clickDeadline) {
    try {
      await clickFlutterButton(page, 'Sign Up');
      clicked = true;
      break;
    } catch {
      await page.waitForTimeout(750);
    }
  }
  if (!clicked) throw new Error('Could not click Sign Up on app landing page');
  await waitForURLContains(page, '/sign-up', 2_000);
  await waitForFlutterSemantics(page, 2_000);
  await signUpOnAuth8(page, email, firstName, lastName, password);
  // After sign-up, the auth flow may either:
  // (a) redirect to /sign-in for the user to sign in, or
  // (b) go directly to the OAuth consent page (/oauth/authorize) if the
  //     sign-up auto-creates a session.
  // Handle both paths - poll for either URL pattern.
  // NOTE: the sign-up → sign-in path can chain: sign-up lands on /sign-in,
  // the sign-in redirect then lands on the consent page. So path (a) does
  // NOT break - it loops back so path (b) can click Authorize on the
  // consent page that follows.
  let pathResolved = false;
  for (let retry = 0; retry < 30; retry++) {
    await page.waitForTimeout(1000);
    const url = page.url();
    // Path (c): back at the app - the OAuth callback completed and BFF
    // redirected to the app dashboard (first-party clients skip consent).
    // Check FIRST: once we're at the app, neither /sign-in nor /consent
    // will match again.
    if (url.startsWith(appURL.replace(/\/$/, ''))) {
      pathResolved = true;
      break;
    }
    if (url.includes('/sign-in')) {
      // Path (a): sign in with the new credentials, then keep polling -
      // the sign-in may redirect to the consent page (a recipient client is
      // consent_required = true), which path (b) handles below.
      await waitForFlutterSemantics(page, 2_000);
      await signInOnAuth8(page, email, password);
      continue;
    } else if (url.includes('/oauth/') || url.includes('authorize') || url.includes('/consent')) {
      // Path (b): consent page - click "Authorize" to continue.
      // FAIL FAST with context if the auth-ui consent page never becomes
      // interactive (Flutter semantics attached).
      try {
        await waitForFlutterSemantics(page, 2_000);
      } catch {
        throw new Error(`signUpViaApp: consent page did not attach semantics - still on ${page.url()}`);
      }
      // The consent page's "Authorize" button triggers a POST to
      // /oauth/authorize/continue. Try multiple click strategies.
      let authorized = false;
      // Strategy 1: Playwright getByRole (most reliable for Flutter CanvasKit).
      try {
        const btn = page.getByRole('button', { name: 'Authorize', exact: true });
        if (await btn.count() > 0) {
          await btn.first().click({ force: true });
          authorized = true;
        }
      } catch { /* fall through */ }
      // Strategy 2: coordinate-based click on flt-semantics.
      if (!authorized) {
        try {
          await clickFlutterButton(page, 'Authorize');
          authorized = true;
        } catch { /* fall through */ }
      }
      // Strategy 3: dispatch click event directly on the semantics element.
      if (!authorized) {
        await page.evaluate(() => {
          const els = document.querySelectorAll('flt-semantics');
          for (const el of Array.from(els)) {
            const t = (el.textContent ?? '').trim();
            if (t === 'Authorize' && el.getAttribute('role') === 'button') {
              const r = (el as HTMLElement).getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true,
                clientX: r.x + r.width / 2,
                clientY: r.y + r.height / 2,
              }));
              return;
            }
          }
        });
      }
      // Wait for the consent to actually take effect: auth POSTs
      // /oauth/authorize/continue and redirects through the BFF callback
      // back to the app (leaves the auth domain). The auth-ui may take a
      // moment to attach semantics + issue the POST.
      try {
        await page.waitForURL((u) => !u.toString().includes('auth.'), { timeout: 5_000 });
      } catch {
        throw new Error(`signUpViaApp: Authorize click did not redirect away from auth - still on ${page.url()}`);
      }
      pathResolved = true;
      break;
    }
  }
  if (!pathResolved) {
    throw new Error(`signUpViaApp: unexpected URL after sign-up: ${page.url()}`);
  }
  // Wait for the OAuth callback to complete (BFF8 → /auth/callback → app).
  await page.waitForURL((u) => !u.toString().includes('auth.'), {
    timeout: 2_000,
  });
}

/** Sign in to a tenant Auth8 from the app URL. */
export async function signInToTenantAuth8(
  page: Page,
  context: BrowserContext,
  appURL: string,
  email: string,
  password: string,
): Promise<void> {
  logStep(`[step] signInToTenantAuth8: signing in ${email} at ${appURL}`);
  // Do NOT clear cookies - see signInToDash for rationale.
  await page.goto(appURL, { waitUntil: 'domcontentloaded' });
  await waitForFlutterSemantics(page, 2_000);
  // The app may already have a valid BFF8 session (e.g. if the user
  // signed up moments ago and the session cookie is still valid). In
  // that case the app shows the authenticated dashboard directly - no
  // "Sign In" button. Check for "Sign In" first; if it's not visible
  // within a few seconds, assume we're already authenticated and skip
  // the sign-in flow.
  let needsSignIn = false;
  try {
    await waitForFlutterText(page, 'Sign In', 2_000);
    needsSignIn = true;
  } catch {
    // No "Sign In" button - already authenticated (dashboard visible).
  }
  if (!needsSignIn) {
    // Already authenticated - wait for the dashboard to settle and return.
    const authDeadline = Date.now() + 2_000;
    while (Date.now() < authDeadline) {
      const texts = await getFlutterTexts(page);
      if (texts.join(' ').toLowerCase().includes('products')) break;
      await page.waitForTimeout(500);
    }
    return;
  }
  // The app shows a landing page with "Sign In" and "Sign Up" buttons.
  // Click "Sign In" to redirect to the Auth8 sign-in page via BFF8 OAuth flow.
  await clickFlutterButton(page, 'Sign In');
  // Wait for redirect to auth8 sign-in page.
  await waitForURLContains(page, '/sign-in', 2_000);
  // Wait for the auth8 Flutter app to fully boot after the full page
  // navigation from the eBank app. The form fields need to be ready
  // before typing.
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Email', 2_000);
  await page.waitForTimeout(500);
  // Use the same signInOnAuth8 helper that signUpViaApp uses.
  await signInOnAuth8(page, email, password);
  // Wait for the OAuth callback redirect chain to complete.
  // auth8 /sign-in → /oauth/authorize → BFF8 /auth/callback → app URL.
  // The BFF8 callback creates the bff8-session cookie and redirects the
  // browser to the app frontend (derived from the OAuth `state`).
  const callbackDeadline = Date.now() + 2_000;
  while (Date.now() < callbackDeadline) {
    const url = page.url();
    if (!url.includes('/sign-in') && !url.includes('/oauth/') && !url.includes('/auth/callback')) {
      break; // Redirected to the app frontend - OAuth callback completed.
    }
    await page.waitForTimeout(500);
  }
  // The browser is now on the app frontend URL (e.g.
  // prod.ibank.ebank.app8.local.sentin8.dev) with the BFF8 session cookie set.
  // Wait for the Flutter app to boot. We do NOT navigate back to the
  // original appURL because it may be a custom domain (e.g. www.ibank.local)
  // that doesn't share the BFF8 session cookie's registrable domain.
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the app to establish the BFF8 session and transition from
  // the login page to the authenticated dashboard. The app initially
  // shows the login page while the /auth/session check is in flight;
  // once the session is confirmed, it shows the dashboard with "Products"
  // (or "Sign In" disappears). Poll for up to 30 seconds.
  const authDeadline = Date.now() + 2_000;
  while (Date.now() < authDeadline) {
    const texts = await getFlutterTexts(page);
    const all = texts.join(' ');
    // If we see "Products" (sidebar item in eBank), we're authenticated.
    if (all.toLowerCase().includes('products')) break;
    // If we still see "Sign In", the session check hasn't completed yet.
    // Wait and retry.
    await page.waitForTimeout(500);
  }
}


import type { E2EState } from './state.js';
import { logStep } from './log.js';

// ── Low-level Flutter helpers ─────────────────────────────────────────

/**
 * Normalize typographic dashes (em '—' U+2014, en '–' U+2013, math
 * minus '−' U+2212) to the ASCII hyphen '-' that test needles use.
 * Flutter labels use em dashes while the specs type plain '-'; without
 * this normalization the matchers below never find the element
 * (observed 2026-10-20, lifecycle step 4: label
 * 'Assisted Login  - Send link to customer' never matched needle
 * 'Assisted Login - Send link to customer').
 */
const DASH_RE = /[\u2014\u2013\u2212]/g;
function normDash(s: string): string {
  return s.replace(DASH_RE, '-');
}

/**
 * Find a flt-semantics element containing the given text and dispatch
 * a synthetic click.  This is the only way to trigger Flutter
 * CanvasKit button presses - Playwright's locator click is
 * intercepted by the canvas.
 */
export async function clickFlutterButton(page: Page, text: string, exact: boolean = false): Promise<void> {
  // Find the flt-semantics button element containing the text, get its
  // bounding rect, and click at its center using Playwright's mouse.
  // This sends real pointer events that Flutter CanvasKit processes.
  // Retry for up to 10 seconds - the button might not be rendered yet.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rect = await page.evaluate(({ needle, exact }: { needle: string; exact: boolean }) => {
      // Normalize typographic dashes on both needle and label so an
      // ASCII-needle ('Foo - Bar') matches an em-dash label ('Foo  - Bar').
      const dash = (s: string): string => s.replace(/[\u2014\u2013\u2212]/g, '-');
      const n = dash(needle).toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      let buttonMatch: Element | null = null;
      let leafMatch: Element | null = null;
      for (const el of Array.from(els)) {
        const t = dash(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`).trim().toLowerCase();
        const matches = exact ? t === n : t.includes(n);
        if (!matches) continue;
        // Skip zero-size elements (stale/hidden)
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const hasChild = el.querySelector('flt-semantics') !== null;
        const role = el.getAttribute('role');
        if (role === 'button') {
          buttonMatch = el;
        } else if (!hasChild && role !== 'textbox') {
          leafMatch = el;
        }
      }
      const best = buttonMatch ?? leafMatch;
      if (!best) return null;
      const r = best.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, { needle: text, exact });
    if (rect) {
      await page.mouse.click(rect.x, rect.y);
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`No Flutter element found containing "${text}"`);
}

/**
 * Click a Flutter button (by label) that is near - i.e. inside the same
 * flt-semantics subtree as - another text label. Useful for clicking a
 * "View" button in a card that also contains the row's name.
 *
 * Strategy: find the flt-semantics container whose text includes `nearText`,
 * then search within that subtree for a button matching `buttonText`.
 * Fallback: if no container is found, click the first button matching
 * `buttonText` anywhere on the page.
 */
export async function clickFlutterButtonNearText(
  page: Page,
  buttonText: string,
  nearText: string,
  timeout = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rect = await page.evaluate(({ btn, near }: { btn: string; near: string }) => {
      const dash = (s: string): string => s.replace(/[\u2014\u2013\u2212]/g, '-');
      const btnLower = dash(btn).toLowerCase();
      const nearLower = dash(near).toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      // First, find the container element that includes the near text.
      let container: Element | null = null;
      for (const el of Array.from(els)) {
        const t = dash(el.textContent ?? '').toLowerCase();
        if (t.includes(nearLower)) {
          // Pick the smallest element that contains the text (leaf-ish).
          if (!container || (container.textContent ?? '').length > (el.textContent ?? '').length) {
            container = el;
          }
        }
      }
      // If no container found, search the entire page.
      const searchRoot = container ?? document.body;
      // Search within the container's subtree for the button.
      const candidates = searchRoot.querySelectorAll('flt-semantics');
      for (const el of Array.from(candidates)) {
        const t = dash(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`).trim().toLowerCase();
        if (!t.includes(btnLower)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'link') {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, { btn: buttonText, near: nearText });
    if (rect) {
      await page.mouse.click(rect.x, rect.y);
      return;
    }
    await page.waitForTimeout(200);
  }
  // Fallback: try clicking the button anywhere on the page.
  try {
    await clickFlutterButton(page, buttonText);
  } catch {
    throw new Error(`No Flutter button "${buttonText}" near "${nearText}"`);
  }
}

/** Wait for flt-semantics to be present (Flutter booted). */
export async function waitForFlutterSemantics(page: Page, timeout = 2_000): Promise<void> {
  await page.waitForSelector('flt-semantics', { timeout });
}

/** Poll for a flt-semantics node or input element containing the given text. */
export async function waitForFlutterText(page: Page, text: string, timeout = 2_000): Promise<void> {
  const needle = normDash(text).toLowerCase();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate((n: string) => {
        const dash = (s: string): string => s.replace(/[\u2014\u2013\u2212]/g, '-');
        const els = document.querySelectorAll('flt-semantics');
        // First pass: check non-zero-size elements (visible on screen)
        for (const el of Array.from(els)) {
          const t = dash(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`).toLowerCase();
          if (!t.includes(n)) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        // Second pass: accept zero-size elements too. CanvasKit renders
        // text on the canvas, not in the DOM - the flt-semantics element
        // may have zero size but the text IS visible on the canvas.
        // Skip elements that are not connected to the DOM (stale/removed).
        for (const el of Array.from(els)) {
          const t = dash(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`).toLowerCase();
          if (!t.includes(n)) continue;
          if (el.isConnected) return true;
        }
        // Check input/textarea elements (CanvasKit text fields)
        const inputs = document.querySelectorAll('input, textarea');
        for (const el of Array.from(inputs)) {
          const t = dash(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`).toLowerCase();
          if (t.includes(n)) return true;
        }
        return false;
      }, needle);
      if (found) return;
    } catch {
      // Execution context destroyed (navigation in progress) - retry.
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for Flutter text "${text}"`);
}

/** Wait until page.url() contains the given substring. */
export async function waitForURLContains(page: Page, substr: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.url().includes(substr)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for URL to contain "${substr}" (current: ${page.url()})`);
}

/**
 * Click a Flutter checkbox/switch near a given text label.  Flutter
 * renders Checkbox/Switch and Text as separate semantics nodes inside
 * a Row, so we look for the toggle inside the same ancestor as the
 * label. Retries for up to 1 seconds.
 */
export async function clickFlutterCheckbox(page: Page, nearbyText: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  // Map feature names to their switch index in the settings page.
  // The order matches the _envNavItems / _featureInfo order in Dash.
  const featureOrder = ['auth8', 'app8', 'storage8', 'db8', 'ledg8', 'paym8', 'fdx8'];
  const switchIndex = featureOrder.indexOf(nearbyText.toLowerCase());

  while (Date.now() < deadline) {
    // For feature toggles on the settings page, find the switch by index
    // (the switches are rendered in a fixed vertical order).
    // For other checkboxes (e.g. "Terms of Service"), use the text-matching
    // approach below.
    if (switchIndex >= 0) {
      const rect = await page.evaluate((idx: number) => {
        const els = document.querySelectorAll('flt-semantics');
        const switches = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'switch' || role === 'checkbox';
        });
        if (idx >= switches.length) return null;
        const sw = switches[idx];
        // Get the parent Row's bounding rect (the feature card) - the InkWell
        // wraps the entire Row, so clicking the center of the Row triggers it.
        const row = sw.parentElement;
        if (row) {
          const r = (row as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        // Fallback: use the switch's own rect.
        const r = (sw as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      }, switchIndex);
      if (rect) {
        // Disable pointer-events on ALL flt-semantics overlays so mouse
        // events go directly to the canvas underneath. Flutter CanvasKit
        // processes pointer events on the canvas element.
        await page.evaluate(() => {
          const container = document.querySelector('flt-semantics-host');
          if (container) {
            (container as HTMLElement).style.pointerEvents = 'none';
          }
          const els = document.querySelectorAll('flt-semantics');
          els.forEach(el => {
            (el as HTMLElement).style.pointerEvents = 'none';
          });
        });
        // Click at the card center - the GestureDetector with
        // HitTestBehavior.opaque should receive the pointer event.
        await page.mouse.click(rect.x, rect.y);
        await page.waitForTimeout(300);
        // Restore pointer events.
        await page.evaluate(() => {
          const container = document.querySelector('flt-semantics-host');
          if (container) {
            (container as HTMLElement).style.pointerEvents = '';
          }
          const els = document.querySelectorAll('flt-semantics');
          els.forEach(el => {
            (el as HTMLElement).style.pointerEvents = '';
          });
        });
        return;
      }
      await page.waitForTimeout(200);
      continue;
    }

    // For non-feature checkboxes (Terms of Service, etc.), use text matching.
    // First, scroll the target into view.
    const targetVisible = await page.evaluate((needle: string) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').trim().toLowerCase();
        if (t === n || t.includes(n)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          // Check if the element is within the viewport vertically.
          if (r.top >= 0 && r.bottom <= window.innerHeight) {
            return true;
          }
        }
      }
      return false;
    }, nearbyText);

    if (!targetVisible) {
      // Scroll down - try mouse wheel first, then keyboard Page Down.
      // Flutter CanvasKit processes wheel events on the canvas.
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
      // Also try keyboard scroll (some Flutter scrollables respond to this).
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(300);
      continue; // Re-check if the target is now visible.
    }

    const rect = await page.evaluate((needle: string) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      // Find the text element whose text content or aria-label EXACTLY matches
      // the needle (case-insensitive). Try aria-label first (more specific),
      // then textContent. If no exact match, fall back to shortest partial.
      // If still no match, try matching by the text of child elements (Flutter
      // may nest the display name in a child flt-semantics inside a container).
      let textEl: Element | null = null;
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').trim().toLowerCase();
        const a = (el.getAttribute('aria-label') ?? '').trim().toLowerCase();
        if (t === n || a === n) { textEl = el; break; }
      }
      if (!textEl) {
        // Try child elements - the display name might be in a child node.
        for (const el of Array.from(els)) {
          const child = el.querySelector('flt-semantics');
          if (child) {
            const ct = (child.textContent ?? '').trim().toLowerCase();
            if (ct === n) { textEl = child as Element; break; }
          }
        }
      }
      if (!textEl) {
        let bestLen = Infinity;
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').trim().toLowerCase();
          const a = (el.getAttribute('aria-label') ?? '').trim().toLowerCase();
          if ((t.includes(n) || a.includes(n)) && t.length < bestLen) {
            bestLen = t.length;
            textEl = el;
          }
        }
      }
      if (!textEl) {
        // Fallback: no text match found. If there's only one checkbox/switch
        // on the page (e.g. Terms of Service on sign-up), click it.
        const allToggles = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'checkbox' || role === 'switch';
        });
        if (allToggles.length === 1) {
          const rowEl = allToggles[0].parentElement;
          if (rowEl) {
            // Scroll the element into view before getting coordinates.
            (rowEl as HTMLElement).scrollIntoView({ block: 'center' });
            const rowRect = (rowEl as HTMLElement).getBoundingClientRect();
            if (rowRect.width > 0 && rowRect.height > 0) {
              return {
                x: rowRect.x + rowRect.width - 30,
                y: rowRect.y + rowRect.height / 2,
              };
            }
          }
        }
        return null;
      }
      // Scroll the text element into view so the switch is visible on the canvas.
      (textEl as HTMLElement).scrollIntoView({ block: 'center' });
      // Remove debug logging.
      // Find the switch/checkbox that is closest to the text element by
      // vertical position. In a feature card Row, the text and switch share
      // approximately the same y center, but the text might be at the top
      // of the card while the switch is centered. We find all switches
      // within 80px of the text's y center and pick the closest.
      const textRect = (textEl as HTMLElement).getBoundingClientRect();
      const textY = textRect.y + textRect.height / 2;
      const allSwitches = Array.from(els).filter(el => {
        const role = el.getAttribute('role');
        return role === 'checkbox' || role === 'switch';
      });
      if (allSwitches.length === 0) return null;
      // Find the switch closest to the text's y position.
      let bestSwitch: Element | null = null;
      let bestDist = Infinity;
      for (const sw of allSwitches) {
        const r = (sw as HTMLElement).getBoundingClientRect();
        const swY = r.y + r.height / 2;
        const dist = Math.abs(swY - textY);
        if (dist < bestDist) {
          bestDist = dist;
          bestSwitch = sw;
        }
      }
      if (!bestSwitch || bestDist > 80) return null;
      // Use the switch's own bounding rect (it has non-zero size in CanvasKit).
      const swRect = (bestSwitch as HTMLElement).getBoundingClientRect();
      if (swRect.width > 0 && swRect.height > 0) {
        return {
          x: swRect.x + swRect.width / 2,
          y: swRect.y + swRect.height / 2,
        };
      }
      // Fallback: use the text element's Row rect.
      const isCheckbox = bestSwitch.getAttribute('role') === 'checkbox';
      const rowRect = textRect;
      if (isCheckbox) {
        return { x: rowRect.x + 20, y: rowRect.y + rowRect.height / 2 };
      } else {
        return { x: rowRect.x + rowRect.width - 30, y: rowRect.y + rowRect.height / 2 };
      }
    }, nearbyText);
    if (rect) {
      // Try multiple approaches to toggle the switch:
      // 1. Simulate a proper tap gesture (move, down, wait, up) - Flutter
      //    CanvasKit requires a proper tap gesture, not just a click event.
      // 2. Dispatch a click event on the flt-semantics element
      // 3. Playwright's getByRole locator with force click
      await page.mouse.move(rect.x, rect.y);
      await page.mouse.down();
      await page.waitForTimeout(50);
      await page.mouse.up();
      await page.waitForTimeout(300);
      // Verify the switch toggled by checking aria-checked on the switch
      // closest to the text element's y position (same approach as the
      // coordinate computation above).
      const toggled = await page.evaluate((needle: string) => {
        const n = needle.toLowerCase();
        const els = document.querySelectorAll('flt-semantics');
        // Find the text element with exact match (same approach as above).
        let textEl: Element | null = null;
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').trim().toLowerCase();
          if (t === n) { textEl = el; break; }
        }
        if (!textEl) {
          let bestLen = Infinity;
          for (const el of Array.from(els)) {
            const t = (el.textContent ?? '').trim().toLowerCase();
            if (t.includes(n) && t.length < bestLen) { bestLen = t.length; textEl = el; }
          }
        }
        if (!textEl) return false;
        const textRect = (textEl as HTMLElement).getBoundingClientRect();
        const textY = textRect.y + textRect.height / 2;
        // Find the switch closest to the text's y position.
        const allSwitches = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'checkbox' || role === 'switch';
        });
        let bestSwitch: Element | null = null;
        let bestDist = Infinity;
        for (const sw of allSwitches) {
          const r = (sw as HTMLElement).getBoundingClientRect();
          const swY = r.y + r.height / 2;
          const dist = Math.abs(swY - textY);
          if (dist < bestDist) { bestDist = dist; bestSwitch = sw; }
        }
        if (!bestSwitch) return false;
        return bestSwitch.getAttribute('aria-checked') === 'true' ||
               bestSwitch.getAttribute('aria-pressed') === 'true';
      }, nearbyText).catch(() => false);
      if (toggled) return;
      // Not toggled by mouse click - try dispatching a click event on the
      // flt-semantics switch element directly. Use the same y-coordinate
      // matching to find the right switch.
      const dispatched = await page.evaluate((needle: string) => {
        const n = needle.toLowerCase();
        const els = document.querySelectorAll('flt-semantics');
        // Find the text element with exact match (same approach as above).
        let textEl: Element | null = null;
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').trim().toLowerCase();
          if (t === n) { textEl = el; break; }
        }
        if (!textEl) {
          let bestLen = Infinity;
          for (const el of Array.from(els)) {
            const t = (el.textContent ?? '').trim().toLowerCase();
            if (t.includes(n) && t.length < bestLen) { bestLen = t.length; textEl = el; }
          }
        }
        if (!textEl) return false;
        const textRect = (textEl as HTMLElement).getBoundingClientRect();
        const textY = textRect.y + textRect.height / 2;
        // Find the switch closest to the text's y position.
        const allSwitches = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'checkbox' || role === 'switch';
        });
        let bestSwitch: Element | null = null;
        let bestDist = Infinity;
        for (const sw of allSwitches) {
          const r = (sw as HTMLElement).getBoundingClientRect();
          const swY = r.y + r.height / 2;
          const dist = Math.abs(swY - textY);
          if (dist < bestDist) { bestDist = dist; bestSwitch = sw; }
        }
        if (!bestSwitch) return false;
        // Dispatch a click event on the switch element.
        (bestSwitch as HTMLElement).click();
        return true;
      }, nearbyText).catch(() => false);
      if (dispatched) {
        await page.waitForTimeout(300);
        return;
      }
      // Last resort: Playwright locator with force.
      try {
        const switchLocator = page.getByRole('switch', { name: nearbyText, exact: false });
        if (await switchLocator.count() > 0) {
          await switchLocator.first().click({ force: true });
          await page.waitForTimeout(300);
          return;
        }
      } catch { /* give up */ }
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`No checkbox found near "${nearbyText}"`);
}

/** Type into a Flutter text field identified by its label. */
export async function typeFlutterField(page: Page, label: string, value: string): Promise<void> {
  // Flutter web text fields can be found via:
  // 1. Regular <input>/<textarea> elements with aria-label (CanvasKit)
  // 2. Playwright's getByRole('textbox') using the accessibility tree
  //    (works even when flt-semantics[role=textbox] is not in the DOM)
  // 3. flt-semantics[role="textbox"] with aria-label (when semantics are in DOM)
  //
  // IMPORTANT: Flutter CanvasKit text fields use a custom editing host that
  // listens to real keyboard events. We focus the host, then send the
  // whole value in one shot via `page.keyboard.insertText` (a single
  // `input` event - paste-like).  We MUST NOT use character-by-character
  // `keyboard.type(...)` because (a) it's slow and (b) the per-character
  // `input` events can race with Flutter's text-editing controller.
  //
  // IMPORTANT: Flutter CanvasKit may lazy-build semantics nodes. The textbox
  // may not be in the accessibility tree immediately after page navigation.
  // We retry all approaches with short waits for up to 10 seconds.

  const deadline = Date.now() + 2_000;
  let lastError: Error | null = null;

  // Helper: focus a target, clear any existing value via Ctrl+A + Delete
  // (real keyboard events, picked up by Flutter), then insert the value
  // in one shot via `insertText` (a single `input` event - paste-like).
  const fillFocused = async (): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.insertText(value);
      await page.waitForTimeout(100);
      // Verify the value landed - Flutter's IME can race insertText and
      // drop/duplicate the last character (observed: '...@a.coe' → 401).
      const current = await page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement | null;
        return el && 'value' in el ? el.value : null;
      });
      if (current === null || current === value) return;
    }
  };

  while (Date.now() < deadline) {
    lastError = null;

    // Approach 1: Try regular input/textarea elements.
    const inputs = page.locator('input, textarea');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const aria = await inputs.nth(i).getAttribute('aria-label');
      if (aria && aria.toLowerCase() === label.toLowerCase()) {
        await inputs.nth(i).click();
        await page.waitForTimeout(50);
        await fillFocused();
        return;
      }
    }

    // Approach 2: Use Playwright's getByRole (accessibility tree) to find
    // the textbox and click it with force (bypasses actionability checks
    // since flt-semantics elements have zero size). This triggers Flutter's
    // text editing host to create a real <input> element on the canvas.
    try {
      const textbox = page.getByRole('textbox', { name: label, exact: false });
      if (await textbox.count() > 0) {
        await textbox.first().click({ force: true });
        await page.waitForTimeout(200); // Wait for Flutter to create the <input>
        await fillFocused();
        return;
      }
    } catch (e) {
      lastError = e as Error;
    }

    // Approach 3: Fall back to flt-semantics elements.
    const found = await page.evaluate((n: string) => {
      const els = document.querySelectorAll(
        'flt-semantics[role="textbox"], flt-semantics[contenteditable="true"]',
      );
      for (const el of Array.from(els)) {
        const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        if (t.includes(n)) {
          (el as HTMLElement).focus();
          return true;
        }
      }
      return false;
    }, label.toLowerCase());
    if (found) {
      await fillFocused();
      return;
    }

    // None of the approaches found the textbox yet - wait briefly and retry.
    await page.waitForTimeout(500);
  }

  throw new Error(`No Flutter text field found with label "${label}"${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

/**
 * Focus a Flutter text field at the given 0-based index in DOM order
 * and type `value` into it.  Used by the create-listing helpers to
 * target the bare-hint fields inside [ScopeSelector] / [RoleSelector]
 * which have no `labelText` to match against.
 *
 * Indexing: Playwright's `getByRole('textbox')` walks the
 * accessibility tree in DOM order, so the index corresponds to the
 * order the user would tab through the visible fields.
 *
 * The textbox is clicked with `force: true` because `flt-semantics`
 * elements have zero size and Playwright's actionability checks
 * would otherwise fail.  After focus, Flutter creates a real
 * `<input>` element that receives the keyboard events.
 *
 * @param submit  If true, press Enter after typing.  The create
 *   form's scope/description inputs are committed on submit.
 */
export async function typeFlutterFieldByIndex(
  page: Page,
  index: number,
  value: string,
  options: { submit?: boolean } = {},
): Promise<void> {
  const { submit = false } = options;
  const deadline = Date.now() + 2_000;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    lastError = null;
    try {
      // Wait for the textbox at the given index to exist.
      const textbox = page.getByRole('textbox').nth(index);
      if ((await textbox.count()) > 0) {
        await textbox.click({ force: true });
        await page.waitForTimeout(150);
        // Clear and type the new value using the same paste-like
        // pattern as [typeFlutterField].
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(value);
        if (submit) {
          await page.keyboard.press('Enter');
        }
        return;
      }
    } catch (e) {
      lastError = e as Error;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(
    `No Flutter text field at index ${index} found${lastError ? ` (last error: ${lastError.message})` : ''}`,
  );
}

/**
 * Add a single scope to a [ScopeSelector] in the create-listing form.
 * The scope input is the next textbox after the form's known prefix
 * fields (App Name, Description, Backend URL) at `baseIndex` +
 * any prefix offset.
 *
 *   - For the outer OAuth Scopes selector: `baseIndex = 3`
 *     (textboxes 0..2 are App Name, Description, Backend URL).
 *   - For the inner ScopeSelector of role `k`: the scope textbox
 *     is at `baseIndex + 2` where `baseIndex` is the index of the
 *     role's name field.  The first role has 3 textboxes
 *     (name, description, scope); every subsequent role has 4
 *     (name, description, scope, includes).  See
 *     [createListingViaUI] for the baseIndex formula.
 *
 * Each call:
 *   1. Clicks the scope input (clearing any leftover text).
 *   2. Types the scope via `insertText` (paste-like, single input event).
 *   3. Presses Enter to commit the scope via the field's `onSubmitted`
 *      handler, which calls `_add()` on the ScopeSelector state.
 *
 * This exercises the real widget code path - the e2e test no longer
 * relies on a textual TextField that was removed in favour of the
 * structured chip-based selector.
 */
export async function addScopeViaUI(
  page: Page,
  scope: string,
  baseIndex: number,
): Promise<void> {
  // The scope input may be off-screen if the form has scrolled due
  // to many chips being added above. Scroll it into view first so
  // the subsequent click and keyboard events land on the visible
  // input - Flutter CanvasKit text fields require the input host
  // to be in the viewport to receive focus.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  await typeFlutterFieldByIndex(page, baseIndex, scope, { submit: true });
  // Small wait for the chip to render + onChanged to fire.
  await page.waitForTimeout(100);
}

/**
 * Add multiple scopes in a single submit by typing them as a
 * comma-separated list.  The widget's `onSubmitted` handler splits
 * on `,` and whitespace, validates each token, and adds the
 * valid ones in one pass.  The duplicate check inside the widget
 * means already-added scopes are silently dropped - callers can
 * safely re-submit the full list.
 *
 * @param page  Playwright page.
 * @param scopes  Scope names (or a single space/comma-separated
 *   string) to add.  Empty entries are dropped.
 * @param baseIndex  Index of the scope input textbox in the global
 *   textbox ordering.
 */
export async function addScopesBatchViaUI(
  page: Page,
  scopes: string[],
  baseIndex: number,
): Promise<void> {
  if (!scopes || scopes.length === 0) return;
  // The scope input may be off-screen if the form has scrolled due
  // to many chips being added above. Scroll it into view first.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  // Join with comma + space so the user could have typed the same
  // thing in the UI; whitespace and commas are both delimiters.
  const value = scopes.join(', ');
  await typeFlutterFieldByIndex(page, baseIndex, value, { submit: true });
  // Small wait for all chips to render + onChanged to fire once
  // per added scope.
  await page.waitForTimeout(200);
}

/**
 * Add a single include to a role's includes-picker via the
 * autocomplete text input.  The widget renders a `RawAutocomplete`
 * textbox; the user types the included role name and presses
 * Enter to commit.  Selected names then appear as removable
 * `InputChip`s below the input.
 *
 * The autocomplete enforces that the typed name matches an
 * existing candidate (defined above this row in the listing) -
 * otherwise the typed value is silently ignored.  This is by
 * design: dangling includes are impossible by construction.
 *
 * @param page  Playwright page.
 * @param name  Role name to include.  Must match a role defined
 *   earlier in the same listing.
 * @param baseIndex  Index of the includes-picker textbox in the
 *   global textbox ordering.  The first role has no includes
 *   textbox rendered (no candidates yet) - callers should only
 *   pass `baseIndex >= 11` (i.e. the third role onward; the
 *   second role already has one at index 10).
 */
export async function addIncludeViaUI(
  page: Page,
  names: string | string[],
  baseIndex: number,
): Promise<void> {
  // Scroll the includes textbox into view first - the includes
  // section sits at the bottom of the role, often off-screen.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  // Accept a single name or an array.  Multiple names are typed
  // as a comma-separated list and committed in a single Enter,
  // which exercises the widget's batch-add path.  Each token is
  // resolved against the candidate list (case-sensitive) and
  // added if it matches and isn't already selected.
  const list = Array.isArray(names) ? names : [names];
  const value = list.join(', ');
  await typeFlutterFieldByIndex(page, baseIndex, value, { submit: true });
  // Wait for the chips to render + onChanged to fire.
  await page.waitForTimeout(250);
  // Verify the chips were actually added - guards against silent
  // drops if the typed names didn't match candidates.  Selected
  // includes are rendered as Material `InputChip`s, which Flutter
  // exposes as a `role="checkbox"` (with the chip label as the
  // accessible name) wrapping a Delete `button`.  We check each
  // name individually so callers can detect a partial success.
  for (const name of list) {
    const chip = page.getByRole('checkbox', { name, exact: true });
    if ((await chip.count()) === 0) {
      throw new Error(
        `addIncludeViaUI: include "${name}" was not committed - the autocomplete may have ` +
          `rejected it (typo? or this role is not defined above the current row?).`,
      );
    }
  }
}

/**
 * Add a security role to the create-listing form's [RoleSelector].
 * Clicks the "Add Role" button, then fills the role's name
 * (appending `*` if it's the default signup role), description,
 * and nested scopes - all via the actual UI controls.
 *
 * @param baseIndex  Index of the FIRST textbox for the new role.
 *   The form has 4 prefix textboxes (App Name, Description,
 *   Backend URL, OAuth Scopes) + 3 textboxes for the first role
 *   (no includes picker).  Each subsequent role adds 4 textboxes
 *   (name, description, scopes, includes).  So:
 *     - k=0:  baseIndex = 4
 *     - k=1:  baseIndex = 7
 *     - k=2:  baseIndex = 11
 *     - k=3:  baseIndex = 15
 *   See [createListingViaUI] for the formula.
 * @param isDefaultSignup  If true, append `*` to the name so the
 *   RoleSelector marks the role as default_signup_role.
 */
export async function addRoleViaUI(
  page: Page,
  role: {
    name: string;
    description?: string;
    scopes: string[];
    /**
     * Names of OTHER roles (defined earlier in the same listing)
     * whose scopes should be merged into this role's permissions
     * at install time.  Same listing only - the RoleSelector UI
     * only offers roles defined above the current row.
     */
    includes?: string[];
  },
  baseIndex: number,
  isDefaultSignup: boolean,
): Promise<void> {
  // The "Add Role" button is at the bottom of the [RoleSelector].
  // After a previous role has been filled in (with chips wrapping
  // below its scope input), the form may have scrolled down so the
  // button is just below the fold.  Flutter CanvasKit's click
  // handlers only fire when the InkWell is in the viewport, so we
  // scroll the button into view first.
  await scrollFlutterButtonIntoView(page, 'Add Role');
  // Click the "Add Role" button to create a new row.
  await clickFlutterButton(page, 'Add Role');
  // Wait for the new row's textboxes to appear.
  await page.waitForTimeout(300);
  // The new role's name field is at the top of its row; the form
  // has just grown, so scroll the new textbox into view before
  // typing.  Without this, the input may be off-screen and Flutter
  // may not focus it correctly.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  // Fill the role name (textbox at baseIndex). Append `*` if this
  // is the default signup role - the RoleSelector strips the
  // marker and sets the default-signup pointer.
  const nameValue = isDefaultSignup ? `${role.name}*` : role.name;
  await typeFlutterFieldByIndex(page, baseIndex, nameValue);
  await page.waitForTimeout(100);
  // Fill the description if provided (textbox at baseIndex + 1).
  if (role.description) {
    await scrollFlutterTextboxIntoView(page, baseIndex + 1);
    await typeFlutterFieldByIndex(page, baseIndex + 1, role.description);
    await page.waitForTimeout(100);
  }
  // Fill the nested scope input (textbox at baseIndex + 2) by
  // typing the entire list of scopes as a comma-separated string
  // and submitting once.  The widget's `onSubmitted` splits on
  // `,`/whitespace and adds all valid scopes in a single pass,
  // which exercises the batch-add path the same way the user
  // would experience it.
  const scopeIndex = baseIndex + 2;
  await addScopesBatchViaUI(page, role.scopes ?? [], scopeIndex);
  // Add the `includes` autocomplete selections.  The widget renders
  // a text input where the user types the name of an existing role
  // (defined above this row in the listing) and presses Enter to
  // add it.  Selected roles are then shown as removable chips.
  // The first role (k=0) sees no candidates because no roles are
  // defined above it yet, so the autocomplete is not rendered for
  // that row.
  if (role.includes && role.includes.length > 0) {
    // The includes textbox sits at baseIndex + 3 (name, desc,
    // scopes, includes).  The first role (baseIndex=4) has no
    // includes textbox rendered (no candidates yet) - reject this
    // so the caller knows.
    if (baseIndex === 4) {
      throw new Error(
        `addRoleViaUI: includes on the first role ("${role.name}") are not supported - ` +
          `the autocomplete has no candidates until at least one role is defined above.`,
      );
    }
    // Pass the whole list at once so the widget's batch-add
    // path is exercised (one Enter submits everything).  The
    // helper verifies each chip was committed.
    await addIncludeViaUI(page, role.includes, baseIndex + 3);
  }
}

/**
 * Scroll the Flutter button containing the given text into the
 * viewport.  Flutter CanvasKit InkWells must be in the viewport to
 * fire their onPressed - a click at off-screen coordinates is
 * silently dropped.
 *
 * Strategy: find the button's flt-semantics rect, then scroll the
 * enclosing scrollable (window) until the button is visible.
 * Retries for up to 5 seconds.
 */
export async function scrollFlutterButtonIntoView(
  page: Page,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const visible = await page.evaluate(({ needle }: { needle: string }) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
        if (!raw.toLowerCase().includes(n)) continue;
        if (el.getAttribute('role') !== 'button') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        // Visible if any part of the rect is within the viewport.
        const inView = r.bottom > 0 && r.top < window.innerHeight &&
                       r.right > 0 && r.left < window.innerWidth;
        if (inView) return true;
      }
      return false;
    }, { needle: text });
    if (visible) return;
    // Scroll down using wheel + keyboard. Flutter CanvasKit
    // scrollables respond to wheel events on the canvas.
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
  }
  // Don't throw - clickFlutterButton will throw a clear error if
  // the button still can't be found after scrolling.
}

/**
 * Scroll the textbox at the given 0-based index into the viewport.
 * Same viewport requirement as [scrollFlutterButtonIntoView].
 */
export async function scrollFlutterTextboxIntoView(
  page: Page,
  index: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const visible = await page.evaluate((idx: number) => {
      const textboxes = document.querySelectorAll(
        'flt-semantics[role="textbox"], input, textarea',
      );
      if (idx >= textboxes.length) return false;
      const el = textboxes[idx] as HTMLElement;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return true; // can't tell
      const inView = r.bottom > 0 && r.top < window.innerHeight &&
                     r.right > 0 && r.left < window.innerWidth;
      return inView;
    }, index);
    if (visible) return;
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
  }
}

/** Wait for a window test bridge function to be registered. */
export async function waitForBridge(page: Page, fn: string, timeout = 2_000): Promise<void> {
  await page.waitForFunction(
    (name: string) => typeof (window as unknown as Record<string, unknown>)[name] === 'function',
    fn,
    { timeout },
  );
}

/** Invoke a window test bridge function with string args. */
export async function callBridge(page: Page, fn: string, ...args: string[]): Promise<boolean> {
  const ok = await page.evaluate(
    ({ fn: name, args: a }: { fn: string; args: string[] }) => {
      const w = window as unknown as Record<string, (...args: unknown[]) => boolean>;
      if (typeof w[name] === 'function') return w[name](...a);
      return false;
    },
    { fn, args },
  );
  return Boolean(ok);
}

/** Return all flt-semantics text content (concatenated). */
export async function getFlutterTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    return Array.from(els).map((el) => (el.textContent ?? '').trim()).filter((t) => t.length > 0);
  });
}

// ── Assertions ────────────────────────────────────────────────────────

export async function assertSessionCookieSet(context: BrowserContext, name: string = '__session'): Promise<void> {
  const cookies = await context.cookies();
  const has = cookies.some((c) => c.name === name && c.value.length > 0);
  expect(has, `expected cookie ${name} to be set`).toBe(true);
}

// ── Re-exports for convenience ────────────────────────────────────────
export type { E2EState };
export {
  tenantAppURL,
  tenantBff8URL,
  tenantAuthURL,
  staffAuthURL,
  orgDomain,
} from './testdata.js';
