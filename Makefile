.DEFAULT_GOAL := help
SHELL := /usr/bin/env bash

.PHONY: help install install-cc install-skill verify doctor test test-engine test-engine-ci scan lint check-docs ci ci-clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n",$$1,$$2}'

install: ## Install launchers to ~/bin (mirrors backends/bin)
	npm run install:backends

install-cc: ## Install launchers and put pinned claude-code into each env
	npm run install:backends -- --install-claude-code

verify: ## Launcher self-test + cc-models doctor
	npm run verify:launchers && cc-models doctor

doctor: ## Environment recon + workflow recommendation (run on any machine)
	bash orchestration/fuguectl/fuguectl doctor

install-skill: ## Install as a Claude Code skill (~/.claude/skills/fugue, backs up first if present)
	npm run install:skill

test: ## Run plugin + fuguectl tests
	npm test

test-engine: ## Run TypeScript engine checks
	npm run test:engine

test-engine-ci: ## Clean-install engine deps, then run TypeScript engine checks
	npm run test:engine:ci

scan: ## Secret-leak scan (local gate)
	npm run scan

lint: ## Launcher syntax + shellcheck
	npm run lint:shell

check-docs: ## Docs-drift gate (fuguectl README + Self-Harness guide == actual code)
	npm run check:docs

ci: scan lint check-docs test test-engine ## Full local CI using installed deps

ci-clean: scan lint check-docs test test-engine-ci ## Full clean CI with engine npm ci
