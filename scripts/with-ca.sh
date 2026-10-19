#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
# SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
# SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
# SPDX-License-Identifier: Apache-2.0
# ── bank8 e2e test runner with CA trust auto-configured ──────────────
#
# Installs the Sentin8 local root CA into the system trust store,
# exports NODE_EXTRA_CA_CERTS for Node's bundled store, then invokes
# the supplied command.
#
# Usage:
#   ./scripts/with-ca.sh make test
#   ./scripts/with-ca.sh npx playwright test tests/bank8_lifecycle.spec.ts

set -eu

if [[ -n "${SENTIN8_CA_CERT:-}" && -f "${SENTIN8_CA_CERT}" ]]; then
  CA_FILE="${SENTIN8_CA_CERT}"
else
  candidates=(
    "/usr/local/share/ca-certificates/sentin8-local-ca.crt"
    "/usr/local/share/ca-certificates/sentin8-local-root.crt"
    "/etc/ssl/certs/sentin8-local-ca.pem"
    "/etc/ssl/certs/sentin8-local-root.pem"
    "${HOME}/.sentin8/acme/ca/root-ca.crt"
  )
  CA_FILE=""
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then
      CA_FILE="$c"
      break
    fi
  done
fi

if [[ -n "${CA_FILE:-}" ]]; then
  echo "[e2e-ts] Using CA cert: ${CA_FILE}" >&2
  export NODE_EXTRA_CA_CERTS="${CA_FILE}"
  if command -v update-ca-certificates >/dev/null 2>&1; then
    if [[ -w "/usr/local/share/ca-certificates/" ]] || sudo -n true 2>/dev/null; then
      cp -f "${CA_FILE}" /usr/local/share/ca-certificates/ 2>/dev/null || true
      sudo update-ca-certificates 2>/dev/null || true
    fi
  fi
else
  echo "[e2e-ts] WARNING: No CA cert found - TLS may fail" >&2
fi

exec "$@"