#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-License-Identifier: Apache-2.0

// scripts/android-e2e.mjs - the Android leg of the e2e suite.
//
// Playwright cannot drive a native app, so this leg:
//   1. checks the device is attached and reachable,
//   2. derives the eBank instance origin for the app's enrollment screen,
//   3. runs `flutter test integration_test` inside bank8-ebank,
//   4. always captures a screenshot + logcat tail into test-results/.
//
// The SCENARIOS are the same as the web leg. The DRIVER is different, and this
// script is the seam.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = resolve(HERE, '..');
const GROUP = resolve(E2E_ROOT, '..');
const TREE_ROOT = resolve(GROUP, '..');
const EBANK = join(GROUP, 'bank8-ebank');
const RESULTS = join(E2E_ROOT, 'test-results', 'android');

const ADB = process.env.ADB_BIN
  ?? join(process.env.HOME ?? '', 'Android', 'Sdk', 'platform-tools', 'adb');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

function sh(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts).trim();
  } catch (e) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${e.stderr || e.message}`);
  }
}

function step(msg) {
  console.log(`\n▶ ${msg}`);
}

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}

mkdirSync(RESULTS, { recursive: true });

// ── 1. Device ───────────────────────────────────────────────────────────
step('Checking for an attached Android device');
if (!existsSync(ADB)) {
  console.error(`  ❌ adb not found at ${ADB}. Set ADB_BIN or install the Android SDK.`);
  process.exit(2);
}
const devices = sh(ADB, ['devices'])
  .split('\n')
  .slice(1)
  .map((l) => l.trim())
  .filter((l) => l.endsWith('device'))
  .map((l) => l.split(/\s+/)[0]);
if (devices.length === 0) {
  console.error('  ❌ no device/emulator attached. Start one, or run `flutter emulators --launch <id>`.');
  process.exit(2);
}
const device = process.env.ANDROID_DEVICE_ID ?? devices[0];
if (!devices.includes(device)) {
  console.error(`  ❌ ANDROID_DEVICE_ID=${device} is not attached (found: ${devices.join(', ')})`);
  process.exit(2);
}
ok(`device ${device}`);

const booted = sh(ADB, ['-s', device, 'shell', 'getprop', 'sys.boot_completed']).trim();
if (booted !== '1') {
  console.error('  ❌ device is attached but not booted yet');
  process.exit(2);
}
ok('boot completed');

// ── 2. Target origin ────────────────────────────────────────────────────
// The app enrolls by typing an https origin. Derive the same one the web leg
// uses, from the fleet's own .env - never a literal.
step('Resolving the eBank instance origin');
const domain = (process.env.SENTIN8_DOMAIN ?? '').trim();
if (!domain) {
  console.error('  ❌ SENTIN8_DOMAIN is not set and no fallback exists. Source the tree-root .env.');
  process.exit(2);
}
const envSlug = (process.env.E2E_ENV_SLUG ?? '').trim();
const orgDomain = (process.env.E2E_ORG_DOMAIN ?? '').trim();
if (!envSlug || !orgDomain) {
  console.error(
    '  ❌ E2E_ENV_SLUG and E2E_ORG_DOMAIN are required: the instance host is\n' +
    '     {app_slug}.{env_slug}.{org_domain}. global-setup writes them to\n' +
    '     .e2e-state.json; export them from there.',
  );
  process.exit(2);
}
const appHost = `bank8-ebank.${envSlug}.${orgDomain}`;
const appOrigin = `https://${appHost}`;
ok(`origin ${appOrigin}`);

// The emulator reaches the host loopback at 10.0.2.2, but the app talks to the
// instance by NAME through the same TLS proxy the browser uses. That requires
// the device to resolve the fleet domain - host-side DNS overrides do not
// reach the emulator. Detect the mismatch early instead of failing mid-test
// with an opaque socket error.
step('Checking the device can resolve the instance host');
let resolveOk = true;
try {
  sh(ADB, ['-s', device, 'shell', 'ping', '-c', '1', '-W', '2', appHost]);
  ok('host resolves and answers');
} catch {
  resolveOk = false;
  console.error(
    `  ⚠️  the device cannot resolve/ping ${appHost}.\n` +
    '     The app will enroll and then fail closed (correctly) at bootstrap.\n' +
    '     To make it reachable, either:\n' +
    '       - add the host to the emulator\'s DNS (e.g. `adb shell settings put global\n' +
    '         private_dns_mode off` plus a resolv.conf override on a rootable image), or\n' +
    '       - use the instance through 10.0.2.2 with an SNI-preserving reverse proxy.',
  );
}

// ── 3. Run the Flutter integration test ─────────────────────────────────
step('Running the Flutter integration test on the device');
const flutterArgs = [
  'test',
  'integration_test/e2e_android_test.dart',
  '-d',
  device,
  '--dart-define=E2E_APP_ORIGIN=' + appOrigin,
];
if (process.env.E2E_EXPECT_REACHABLE === '1') {
  flutterArgs.push('--dart-define=E2E_EXPECT_REACHABLE=1');
}

let testStatus = 0;
try {
  const out = run('flutter', flutterArgs, { cwd: EBANK, stdio: 'inherit' });
  void out;
  ok('integration test passed');
} catch (e) {
  testStatus = e.status ?? 1;
  console.error(`  ❌ integration test failed (exit ${testStatus})`);
}

// ── 4. Artefacts (always) ───────────────────────────────────────────────
step('Capturing artefacts');
try {
  const png = execFileSync(ADB, ['-s', device, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(join(RESULTS, 'final-screen.png'), png);
  ok('test-results/android/final-screen.png');
} catch {
  log('  ⚠️  screenshot capture failed');
}

try {
  const logcat = sh(ADB, ['-s', device, 'logcat', '-d', '-t', '2000']);
  const interesting = logcat
    .split('\n')
    .filter((l) => /flutter|sentin8|ebank|FATAL|AndroidRuntime/i.test(l))
    .join('\n');
  writeFileSync(join(RESULTS, 'logcat.txt'), interesting);
  ok('test-results/android/logcat.txt');
} catch {
  log('  ⚠️  logcat capture failed');
}

function log(m) { console.log(m); }

if (!resolveOk && process.env.E2E_EXPECT_REACHABLE === '1') {
  console.error('\nThe device could not reach the instance and E2E_EXPECT_REACHABLE=1.');
  process.exit(1);
}

process.exit(testStatus);
