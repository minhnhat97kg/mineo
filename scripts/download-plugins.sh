#!/usr/bin/env bash
set -euo pipefail

VSIX_VERSION="v1.18.24"
VSIX_URL="https://github.com/vscode-neovim/vscode-neovim/releases/download/${VSIX_VERSION}/vscode-neovim-${VSIX_VERSION}.vsix"
EXPECTED_SHA256="228a27f94f0ae15d640be7c04b860a20c2d8ac7bdc36ca22b24d9d716f24ca09"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="${SCRIPT_DIR}/../plugins"
VSIX_DEST="${PLUGINS_DIR}/vscode-neovim.vsix"
# Theia local-dir: handler requires UNPACKED extension directories, not .vsix archives.
# The unpacked dir name follows the convention: <publisher>.<name>-<version>
# (read from the VSIX extension/package.json after unpacking).
UNPACK_DIR="${PLUGINS_DIR}/vscode-neovim"

mkdir -p "${PLUGINS_DIR}"

echo "Downloading vscode-neovim ${VSIX_VERSION}..."
curl -fsSL "$VSIX_URL" -o "$VSIX_DEST"

echo "Verifying checksum..."
if command -v sha256sum &>/dev/null; then
  ACTUAL=$(sha256sum "$VSIX_DEST" | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  ACTUAL=$(shasum -a 256 "$VSIX_DEST" | awk '{print $1}')
else
  echo "Error: sha256sum or shasum not found. Cannot verify checksum." >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED_SHA256" ]; then
  echo "Error: SHA-256 mismatch!" >&2
  echo "  Expected: $EXPECTED_SHA256" >&2
  echo "  Actual:   $ACTUAL" >&2
  rm -f "$VSIX_DEST"
  exit 1
fi

echo "Unpacking vscode-neovim into ${UNPACK_DIR}..."
rm -rf "${UNPACK_DIR}"
mkdir -p "${UNPACK_DIR}"
# A .vsix is a ZIP archive; extension files live under extension/ inside the zip.
# Theia's local-dir plugin handler expects package.json at the plugin root,
# so we strip the leading "extension/" prefix when extracting.
TMP_DIR=$(mktemp -d)
unzip -o -q "$VSIX_DEST" "extension/*" -d "${TMP_DIR}"
cp -r "${TMP_DIR}/extension/." "${UNPACK_DIR}/"
rm -rf "${TMP_DIR}"

echo "OK — vscode-neovim ${VSIX_VERSION} downloaded, verified, and unpacked."

# ── TypeScript Language Features ──────────────────────────────────────────────
# This provides full TypeScript/JavaScript LSP (IntelliSense, go-to-def, etc.)
# and rich syntax highlighting inside the Theia/Monaco editor.
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
