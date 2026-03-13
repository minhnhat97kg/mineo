#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="${SCRIPT_DIR}/../plugins"

mkdir -p "${PLUGINS_DIR}"

# ── TypeScript Language Features ──────────────────────────────────────────────
# This provides full TypeScript/JavaScript LSP (IntelliSense, go-to-def, etc.)
# and rich syntax highlighting inside the Theia/Monaco editor (monaco mode).
TS_EXT_VERSION="1.95.3"
TS_EXT_URL="https://open-vsx.org/api/vscode/typescript-language-features/${TS_EXT_VERSION}/file/vscode.typescript-language-features-${TS_EXT_VERSION}.vsix"
TS_VSIX_DEST="${PLUGINS_DIR}/typescript-language-features.vsix"
TS_UNPACK_DIR="${PLUGINS_DIR}/vscode.typescript-language-features"

echo "Downloading TypeScript Language Features ${TS_EXT_VERSION}..."
curl -fsSL "${TS_EXT_URL}" -o "${TS_VSIX_DEST}"

echo "Unpacking TypeScript Language Features into ${TS_UNPACK_DIR}..."
rm -rf "${TS_UNPACK_DIR}"
mkdir -p "${TS_UNPACK_DIR}"
TMP_TS=$(mktemp -d)
unzip -o -q "${TS_VSIX_DEST}" "extension/*" -d "${TMP_TS}"
cp -r "${TMP_TS}/extension/." "${TS_UNPACK_DIR}/"
rm -rf "${TMP_TS}"

echo "OK — TypeScript Language Features ${TS_EXT_VERSION} downloaded and unpacked."
