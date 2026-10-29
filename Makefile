# SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
# SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
# SPDX-FileCopyrightText: Copyright Contributors to the Bank8:E2E
# SPDX-License-Identifier: Apache-2.0

# Makefile — bank8-e2e (e2e repo, RS §4.5)
#
# Self-contained dev controls for THIS e2e suite. The suite drives the
# four bank8 apps through a real browser (UI lifecycle) plus the
# protocol-level HTTP suites — no direct DB/psql access. Platform setup
# happens in tests/global-setup.ts via the sentin8-cli binary; the CLI is
# resolved from the sibling platform group's checkout (absolute,
# cwd-independent), with a system-installed sentin8-cli as fallback.
SHELL := /bin/bash

TREE_ROOT := $(abspath ../..)
GROUP := $(abspath ..)
CLI_DIR := $(TREE_ROOT)/sentin8/sentin8-cli
PROFILED := 
PROFILE := debug
CLI_BIN := $(firstword $(wildcard $(CLI_DIR)/target/$(PROFILE)/sentin8-cli))
ifeq ($(CLI_BIN),)
CLI_BIN := $(shell command -v sentin8-cli 2>/dev/null)
endif
ifneq ($(CLI_BIN),)
CLI_EXPORT := SENTIN8_CLI_BIN="$(CLI_BIN)"
endif

.PHONY: help install lint test test-lifecycle test-protocol report clean

help: ## Show this help
	@echo "bank8-e2e (Playwright e2e)"
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## pnpm install (frozen lockfile) + Chromium download
	@pnpm install --frozen-lockfile
	@pnpm run install-browsers

lint: ## tsc --noEmit type check
	@pnpm run lint

test: ## UI lifecycle suite, headed, failfast (server up first — make start in bank8-ebank)
	@$(CLI_EXPORT) pnpm run test

test-lifecycle: ## Lifecycle spec only
	@$(CLI_EXPORT) pnpm run test:lifecycle

test-protocol: ## HTTP-only protocol suites (4/6/8)
	@$(CLI_EXPORT) pnpm run test:protocol

report: ## Open the Playwright HTML report
	@pnpm exec playwright show-report

clean: ## Remove node_modules + reports + run artifacts
	@rm -rf node_modules test-results playwright-report .tmp .e2e-state.json
	@rm -rf .run .run/logs .tmp
