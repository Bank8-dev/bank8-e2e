// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-License-Identifier: Apache-2.0

// fixtures/target.ts - which client platform the suite drives.
//
// The SAME eBank instance serves both transports: a browser gets the Flutter
// web bundle and authenticates with the `bff-session` cookie; the Android app
// authenticates with an opaque bearer session obtained through the native
// handoff. So the platform is a test-run property, not a product variant.
//
//   E2E_TARGET=web      (default) Playwright + Chromium
//   E2E_TARGET=android            flutter integration_test on a device/emulator
//
// Why two runners rather than one: Playwright drives a browser. It cannot see
// inside a native Flutter app - there is no DOM, no accessibility tree it can
// query, and no way to start an Activity. The Android leg therefore runs inside
// the app via `flutter test integration_test`, and its assertions are Flutter
// widget assertions. Sharing the *scenarios* across both is the goal; sharing
// the *driver* is not possible.

export type E2ETarget = 'web' | 'android';

const VALID: readonly E2ETarget[] = ['web', 'android'];

/** The platform under test. Defaults to `web` to keep existing runs unchanged. */
export function e2eTarget(): E2ETarget {
  const raw = (process.env.E2E_TARGET ?? 'web').trim().toLowerCase();
  if (!VALID.includes(raw as E2ETarget)) {
    throw new Error(
      `E2E_TARGET must be one of ${VALID.join(' | ')}, got '${raw}'.`,
    );
  }
  return raw as E2ETarget;
}

/** True when the current run drives the native app. */
export function isAndroid(): boolean {
  return e2eTarget() === 'android';
}

/**
 * The Android device/emulator serial that `flutter test` should target.
 *
 * Unset means "the only attached device", which is what a developer wants and
 * what CI has. Set it when more than one is attached.
 */
export function androidDeviceId(): string | undefined {
  const id = process.env.ANDROID_DEVICE_ID?.trim();
  return id && id.length > 0 ? id : undefined;
}
