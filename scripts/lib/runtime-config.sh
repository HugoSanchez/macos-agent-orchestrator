#!/usr/bin/env bash
# Pinned inputs for the embedded runtimes. This file is sourced by both the
# local bundle builder and CI so release and verification cannot drift.

NODE_VERSION="24.15.0"
PBS_TAG="20260510"
PYTHON_VERSION="3.11.15"

HERMES_REPO="https://github.com/NousResearch/hermes-agent.git"
HERMES_REF="3ef6bbd201263d354fd83ec55b3c306ded2eb72a"
HERMES_EXTRAS="mcp,cli,cron"
# aiohttp serves the loopback API gateway. DDGS is Hermes' bundled, no-key
# search provider; its provider module ships in the base wheel, but the Python
# dependency is intentionally optional upstream. Verso must include it because
# Release builds are self-contained and cannot lazy-install packages later.
HERMES_EXTRA_PINS=("aiohttp==3.13.3" "ddgs==9.14.4")

# Application order is part of the contract: request overrides build on the
# reasoning callback introduced by the first patch. Every .patch file in the
# directory must be listed in one of the inventories below or verification
# fails. Source-test patches are applied only to a Hermes source checkout;
# release site-packages intentionally do not ship upstream's tests/ tree.
HERMES_PATCHES=(
    "api-server-reasoning-stream.patch"
    "codex-tool-schema-required.patch"
    "verso-browser-guardrails.patch"
    "verso-cron-running-status.patch"
    "verso-gateway-mcp-oauth.patch"
    "verso-personal-assistant-prompts.patch"
    "verso-web-routing.patch"
    "verso-request-overrides.patch"
    "verso-tool-search-pinned.patch"
    "verso-credential-env-filter.patch"
)

HERMES_SOURCE_TEST_PATCHES=(
    "verso-web-routing-tests.patch"
    "verso-credential-env-filter-tests.patch"
)

hermes_runtime_patch_stamp() {
    local patch_dir="$1"
    local patch_name
    for patch_name in "${HERMES_PATCHES[@]}"; do
        # Hash contents only. Including shasum's filename column would make
        # identical patches produce different stamps in different worktrees.
        shasum -a 256 "${patch_dir}/${patch_name}" | awk '{print $1}'
    done | shasum -a 256 | awk '{print $1}'
}
