#!/usr/bin/env bash
set -euo pipefail

VSIX_VERSION="v1.18.12"
VSIX_URL="https://github.com/vscode-neovim/vscode-neovim/releases/download/${VSIX_VERSION}/vscode-neovim-${VSIX_VERSION}.vsix"
EXPECTED_SHA256="14debbcb31e99ac5c9a1163f3462bbed3032ca1982a61fdffa8df7010367963c"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${SCRIPT_DIR}/../plugins/vscode-neovim.vsix"

mkdir -p "$(dirname "$DEST")"

echo "Downloading vscode-neovim ${VSIX_VERSION}..."
curl -fsSL "$VSIX_URL" -o "$DEST"

echo "Verifying checksum..."
if command -v sha256sum &>/dev/null; then
  ACTUAL=$(sha256sum "$DEST" | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  ACTUAL=$(shasum -a 256 "$DEST" | awk '{print $1}')
else
  echo "Error: sha256sum or shasum not found. Cannot verify checksum." >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED_SHA256" ]; then
  echo "Error: SHA-256 mismatch!" >&2
  echo "  Expected: $EXPECTED_SHA256" >&2
  echo "  Actual:   $ACTUAL" >&2
  rm -f "$DEST"
  exit 1
fi

echo "OK — vscode-neovim ${VSIX_VERSION} downloaded and verified."
