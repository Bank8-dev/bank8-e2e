// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/log.ts - shared step-log helper with a consistent timestamp prefix.
//
// Every e2e log line is emitted as:
//   [YYYY-MM-DDTHH:MM:SS.sssZ] [scope] message...
// The timestamp is the UTC ISO-8601 form (with millisecond precision
// and a trailing `Z`) so logs are unambiguous across machines, easy
// to sort/parse, and diff cleanly against Playwright's own
// timestamps. Local-clock timestamps caused confusion when comparing
// runs from different timezones, so ISO is the canonical format.
//
// Usage:
//   import { logStep } from '../fixtures';
//   logStep('[lifecycle] 2.1 step: iBank org created id=…');
//
// Anywhere a `console.log(\`[<scope>] …\`)` would have been written,
// write `logStep(\`[<scope>] …\`)` instead. The helper is intentionally
// a thin wrapper so existing call sites stay readable.

/**
 * Format a Date as `YYYY-MM-DDTHH:MM:SS.sssZ` in UTC. The trailing
 * `Z` and the `T` separator are the standard ISO-8601 forms; the
 * millisecond fraction is included so per-step latency is visible
 * in the log output without needing a separate timer.
 */
function fmtTimestamp(d: Date = new Date()): string {
  return d.toISOString();
}

/**
 * Emit a single e2e step log line with a leading ISO-8601 timestamp.
 * Replaces raw `console.log` calls so the timestamp prefix is
 * consistent across every spec and helper.
 */
export function logStep(message: string, ...rest: unknown[]): void {
  console.log(`[${fmtTimestamp()}] ${message}`, ...rest);
}
