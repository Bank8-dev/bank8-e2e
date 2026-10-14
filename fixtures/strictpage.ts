// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/strictpage.ts — wraps a Playwright Page and asserts that no
// console errors or unexpected HTTP error responses occur during a test.
//
// Mirrors fixtures/strictpage.go from the Go suite.  The Dash/Auth8
// Flutter Web apps emit `flt-semantics` nodes that the harness
// interacts with, but they also may emit console warnings/errors
// during normal operation (e.g. web-socket reconnects).  Tests should
// ignore expected noise and only fail on truly unexpected errors.

import { type Page, type ConsoleMessage, type Response } from '@playwright/test';

export class StrictPage {
  readonly page: Page;
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly badResponses: Array<{ url: string; status: number }> = [];

  private boundConsole = false;
  private boundResponse = false;

  constructor(page: Page) {
    this.page = page;
    this.bind();
  }

  private bind(): void {
    if (!this.boundConsole) {
      this.page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') this.errors.push(msg.text());
        else if (msg.type() === 'warning') this.warnings.push(msg.text());
      });
      this.boundConsole = true;
    }
    if (!this.boundResponse) {
      this.page.on('response', (res: Response) => {
        if (res.status() >= 400) {
          this.badResponses.push({ url: res.url(), status: res.status() });
        }
      });
      this.boundResponse = true;
    }
  }

  /**
   * Fail the test if any unexpected console errors or ≥400 responses
   * were captured since the page was created.
   */
  assertNoFailures(): void {
    if (this.errors.length > 0) {
      throw new Error(
        `Console errors observed:\n  - ${this.errors.join('\n  - ')}`,
      );
    }
    if (this.badResponses.length > 0) {
      const list = this.badResponses
        .map((r) => `${r.status} ${r.url}`)
        .join('\n  - ');
      throw new Error(`HTTP error responses observed:\n  - ${list}`);
    }
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => {});
  }
}
