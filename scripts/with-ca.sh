#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
# SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
# SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
# SPDX-License-Identifier: Apache-2.0
# ── bank8 e2e test runner with CA trust auto-configured ──────────────
#
# Points Node at the platform CA the fleet in THIS tree actually booted
# with, then invokes the supplied command.
#
# Nothing here is pinned to a domain or to one TLS family: the CA lives at
# `{SENTIN8_ACME_DATA_DIR}/{SENTIN8_TLS_PQ_MODE}/ca/` (PQCA-1 namespaces the
# hierarchy per transport posture, so classical/hybrid/exclusive are three
# unrelated authorities), and the installed anchors carry the family name
# (`sentin8-{family}-root-ca.crt`, acme DESIGN §4.0b). Both are resolved
# from the SAME tree-root `.env` the fleet and the suite are configured
# from - real env wins, the file fills in the rest.
#
# This script does NOT install anything: the platform owns trust-store
# installation at boot, and `make ca-trust` installs all three families.
# It only assembles one bundle Node can consume (NODE_EXTRA_CA_CERTS takes
# a single file) and passes it to the child process.
#
# Usage:
#   ./scripts/with-ca.sh make test
#   ./scripts/with-ca.sh npx playwright test tests/bank8_lifecycle.spec.ts

set -eu

# ── Tree root + fleet configuration (same precedence as fixtures/env.ts) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TREE_ROOT="${SENTIN8_REPO_ROOT:-$(cd "$SUITE_ROOT/../.." && pwd)}"

# Read one KEY=VALUE from the tree-root `.env` (last assignment wins,
# quotes stripped). Returns empty when the file or key is absent.
env_from_file() {
  local key="$1" file="$TREE_ROOT/.env" value
  [[ -f "$file" ]] || return 0
  value="$(grep -h "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')" || return 0
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  [[ -n "$value" ]] && printf '%s' "$value"
  return 0
}

# A variable already in the environment wins - an operator's explicit
# export overrides the `.env` file (dotenv semantics).
for key in SENTIN8_ACME_DATA_DIR SENTIN8_TLS_PQ_MODE SENTIN8_CA_CERT; do
  if [[ -z "${!key:-}" ]]; then
    value="$(env_from_file "$key")"
    [[ -n "$value" ]] && export "$key=$value"
  fi
done

ACME_BASE="${SENTIN8_ACME_DATA_DIR:-${HOME}/.sentin8/acme}"
ACME_MODE="${SENTIN8_TLS_PQ_MODE:-classical}"

ANCHOR_DIRS=()
for d in /usr/local/share/ca-certificates /etc/pki/ca-trust/source/anchors; do
  [[ -d "$d" ]] && ANCHOR_DIRS+=("$d")
done

# Every path that could hold the platform CA, most specific first.
candidate_certs() {
  local dir name
  # 1. Operator override - EXCLUSIVE. An explicit SENTIN8_CA_CERT means
  #    "trust exactly this", which is how an operator points the suite at
  #    a CA outside this tree (a hosted fleet, a sysroot, a test anchor).
  #    Mixing in the local family's roots would silently re-trust a plane
  #    the operator deliberately bypassed.
  if [[ -n "${SENTIN8_CA_CERT:-}" ]]; then
    printf '%s\n' "$SENTIN8_CA_CERT"
    return 0
  fi
  # 2. The fleet's ACTIVE family - root AND intermediate, because several
  #    verifiers cannot build leaf -> intermediate -> root from a
  #    root-only anchor.
  printf '%s\n' \
    "$ACME_BASE/$ACME_MODE/ca/root-ca.crt" \
    "$ACME_BASE/$ACME_MODE/ca/intermediate-ca.crt"
  # 3. Pre-PQCA-1 layout (no family segment).
  printf '%s\n' "$ACME_BASE/ca/root-ca.crt" "$ACME_BASE/ca/intermediate-ca.crt"
  # 4. System anchors: family-named first, then the legacy unnamespaced
  #    names an older boot-time install may have left behind.
  for dir in "${ANCHOR_DIRS[@]}"; do
    for name in \
      "sentin8-$ACME_MODE-root-ca.crt" "sentin8-$ACME_MODE-intermediate-ca.crt" \
      sentin8-root-ca.crt sentin8-intermediate-ca.crt \
      sentin8-local-root-ca.crt sentin8-local-ca.crt; do
      printf '%s\n' "$dir/$name"
    done
  done
  return 0
}

# ── Assemble one deduplicated PEM bundle ──────────────────────────────────
BUNDLE_DIR="$SUITE_ROOT/.tmp"
BUNDLE="$BUNDLE_DIR/ca-bundle.pem"
mkdir -p "$BUNDLE_DIR"
: > "$BUNDLE"

declare -A seen_hashes=()
added=()
while IFS= read -r f; do
  [[ -n "$f" && -f "$f" && -s "$f" ]] || continue
  h="$(sha256sum "$f" | cut -d' ' -f1)"
  [[ -n "${seen_hashes[$h]:-}" ]] && continue
  seen_hashes[$h]=1
  cat "$f" >> "$BUNDLE"
  added+=("$f")
done < <(candidate_certs)

if [[ ${#added[@]} -gt 0 ]]; then
  if [[ -n "${SENTIN8_CA_CERT:-}" ]]; then
    echo "[e2e-ts] CA trust: ${#added[@]} file(s) from SENTIN8_CA_CERT (override)" >&2
  else
    echo "[e2e-ts] CA trust: ${#added[@]} certificate file(s), family '$ACME_MODE'" >&2
  fi
  for f in "${added[@]}"; do echo "[e2e-ts]   $f" >&2; done
  echo "[e2e-ts] NODE_EXTRA_CA_CERTS=$BUNDLE" >&2
  export NODE_EXTRA_CA_CERTS="$BUNDLE"
else
  # Never leave an empty bundle behind: NODE_EXTRA_CA_CERTS pointing at a
  # zero-byte file makes every TLS handshake fail with a misleading
  # "unable to get local issuer certificate" instead of the real cause.
  rm -f "$BUNDLE"
  echo "[e2e-ts] WARNING: no Sentin8 CA found for family '$ACME_MODE'." >&2
  echo "[e2e-ts]   Looked under $ACME_BASE/$ACME_MODE/ca and ${ANCHOR_DIRS[*]}" >&2
  echo "[e2e-ts]   Fix: run 'make ca-trust' in the sentin8/ group, or set SENTIN8_CA_CERT." >&2
fi

exec "$@"