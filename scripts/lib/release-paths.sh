#!/usr/bin/env bash
# Shared locations for every release step. Override these variables when a
# release must be built or packaged somewhere else.

_VERSO_RELEASE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${VERSO_RELEASE_ROOT:=$(cd "${_VERSO_RELEASE_LIB_DIR}/../.." && pwd)}"
: "${VERSO_RELEASE_DERIVED_DATA:=${VERSO_RELEASE_ROOT}/DerivedData-release}"
: "${VERSO_RELEASE_APP:=${VERSO_RELEASE_DERIVED_DATA}/Build/Products/Release/verso.app}"
: "${VERSO_RELEASE_DIST:=${VERSO_RELEASE_ROOT}/dist}"
unset _VERSO_RELEASE_LIB_DIR
