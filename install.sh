#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Mineo — installation script
# Usage:  curl -fsSL https://raw.githubusercontent.com/minhnhat97kg/mineo/main/install.sh | bash
#         or just:  bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}  →${NC} $*"; }
success() { echo -e "${GREEN}  ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}  ⚠${NC} $*"; }
die()     { echo -e "${RED}  ✗${NC} $*" >&2; exit 1; }

REPO="minhnhat97kg/mineo"
BINARY_NAME="mineo"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="${HOME}/.config/mineo"
CONFIG_FILE="${CONFIG_DIR}/config.json"

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        Mineo — Installer             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── 1. Detect OS / arch ──────────────────────────────────────────────────────
detect_platform() {
    local os arch

    os="$(uname -s)"
    arch="$(uname -m)"

    case "$os" in
        Linux*)   OS_TYPE="linux"   ;;
        Darwin*)  OS_TYPE="darwin"  ;;
        MINGW*|MSYS*|CYGWIN*)
                  OS_TYPE="windows" ;;
        *)        die "Unsupported OS: $os" ;;
    esac

    case "$arch" in
        x86_64|amd64)  ARCH_TYPE="amd64" ;;
        aarch64|arm64) ARCH_TYPE="arm64" ;;
        *)             die "Unsupported architecture: $arch" ;;
    esac

    success "Platform: ${OS_TYPE}/${ARCH_TYPE}"
}

# ── 2. Check / install Neovim ────────────────────────────────────────────────
ensure_neovim() {
    if command -v nvim >/dev/null 2>&1; then
        local ver
        ver=$(nvim --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
        success "Neovim already installed (${ver})"
        return
    fi

    warn "Neovim not found — installing now..."

    case "$OS_TYPE" in
        darwin)
            if command -v brew >/dev/null 2>&1; then
                info "Using Homebrew..."
                brew install neovim
            else
                # Download pre-built macOS tarball from Neovim releases
                info "Downloading Neovim (macOS)..."
                local nvim_arch="macos-arm64"
                [[ "$ARCH_TYPE" == "amd64" ]] && nvim_arch="macos-x86_64"
                local nvim_url="https://github.com/neovim/neovim/releases/latest/download/nvim-${nvim_arch}.tar.gz"
                local tmp
                tmp="$(mktemp -d)"
                curl -fsSL "$nvim_url" -o "${tmp}/nvim.tar.gz"
                tar -xzf "${tmp}/nvim.tar.gz" -C "$tmp"
                sudo mkdir -p /usr/local/bin /usr/local/lib /usr/local/share
                sudo cp -r "${tmp}/nvim-"*/bin/nvim       /usr/local/bin/nvim
                sudo cp -r "${tmp}/nvim-"*/lib/nvim       /usr/local/lib/  2>/dev/null || true
                sudo cp -r "${tmp}/nvim-"*/share/nvim     /usr/local/share/ 2>/dev/null || true
                rm -rf "$tmp"
            fi
            ;;

        linux)
            if command -v apt-get >/dev/null 2>&1; then
                info "Using apt-get..."
                sudo apt-get update -qq
                # Try to install a recent enough version; fall back to appimage if too old
                if apt-cache show neovim 2>/dev/null | grep -qE 'Version: 0\.[89]|Version: [1-9]'; then
                    sudo apt-get install -y -qq neovim
                else
                    info "apt version too old — downloading Neovim AppImage..."
                    _install_nvim_appimage
                fi
            elif command -v dnf >/dev/null 2>&1; then
                info "Using dnf..."
                sudo dnf install -y -q neovim
            elif command -v pacman >/dev/null 2>&1; then
                info "Using pacman..."
                sudo pacman -Sy --noconfirm neovim
            elif command -v zypper >/dev/null 2>&1; then
                info "Using zypper..."
                sudo zypper install -y neovim
            else
                info "No known package manager found — downloading Neovim AppImage..."
                _install_nvim_appimage
            fi
            ;;

        windows)
            warn "Automatic Neovim install on Windows is not supported."
            warn "Please install it manually: https://github.com/neovim/neovim/releases"
            ;;
    esac

    if command -v nvim >/dev/null 2>&1; then
        success "Neovim installed successfully"
    else
        die "Neovim installation failed. Please install it manually: https://github.com/neovim/neovim/releases"
    fi
}

# Install Neovim AppImage (x86_64 Linux) or tarball (arm64 Linux)
_install_nvim_appimage() {
    local tmp
    tmp="$(mktemp -d)"
    if [[ "$ARCH_TYPE" == "amd64" ]]; then
        curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.appimage" -o "${tmp}/nvim"
        chmod +x "${tmp}/nvim"
        sudo mv "${tmp}/nvim" /usr/local/bin/nvim
    else
        # arm64 Linux: use tarball
        curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-arm64.tar.gz" -o "${tmp}/nvim.tar.gz"
        tar -xzf "${tmp}/nvim.tar.gz" -C "$tmp"
        sudo cp "${tmp}/nvim-linux-arm64/bin/nvim" /usr/local/bin/nvim
        sudo chmod +x /usr/local/bin/nvim
    fi
    rm -rf "$tmp"
}

# ── 3. Fetch latest release version ─────────────────────────────────────────
get_latest_version() {
    info "Fetching latest release..."

    LATEST_VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name":' \
        | sed -E 's/.*"([^"]+)".*/\1/')

    if [[ -z "$LATEST_VERSION" ]]; then
        die "Could not determine latest version. Check your network or https://github.com/${REPO}/releases"
    fi

    success "Latest version: ${LATEST_VERSION}"
}

# ── 4. Download the binary ───────────────────────────────────────────────────
download_binary() {
    local ext=""
    [[ "$OS_TYPE" == "windows" ]] && ext=".exe"

    ASSET_NAME="${BINARY_NAME}_${OS_TYPE}_${ARCH_TYPE}${ext}"
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_VERSION}/${ASSET_NAME}"

    info "Downloading ${ASSET_NAME}..."

    TMP_DIR="$(mktemp -d)"
    TMP_BIN="${TMP_DIR}/${BINARY_NAME}${ext}"

    if ! curl -fsSL -o "$TMP_BIN" "$DOWNLOAD_URL"; then
        rm -rf "$TMP_DIR"
        die "Download failed: ${DOWNLOAD_URL}"
    fi

    chmod +x "$TMP_BIN"
    success "Downloaded"
}

# ── 5. Install the binary ────────────────────────────────────────────────────
install_binary() {
    local dest="${INSTALL_DIR}/${BINARY_NAME}"
    info "Installing to ${dest}..."

    if [[ -w "$INSTALL_DIR" ]]; then
        mv "$TMP_BIN" "$dest"
    else
        sudo mv "$TMP_BIN" "$dest"
    fi

    rm -rf "$TMP_DIR"
    success "Installed to ${dest}"
}

# ── 6. Create default config if missing ─────────────────────────────────────
create_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        info "Config already exists at ${CONFIG_FILE} — skipping"
        return
    fi

    info "Creating default config at ${CONFIG_FILE}..."
    mkdir -p "$CONFIG_DIR"

    cat > "$CONFIG_FILE" <<'EOF'
{
    "port": 3000,
    "workspace": "~/projects",
    "password": "",
    "nvim": {
        "bin": "nvim",
        "configMode": "bundled"
    }
}
EOF
    success "Config created"
    warn "Edit ${CONFIG_FILE} to set your workspace path and (optionally) a password."
}

# ── 7. PATH hint ─────────────────────────────────────────────────────────────
check_path() {
    if command -v "$BINARY_NAME" >/dev/null 2>&1; then
        success "${BINARY_NAME} is in PATH and ready to use"
    else
        warn "${BINARY_NAME} was installed to ${INSTALL_DIR} but that directory is not in your PATH."
        warn "Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo ""
        echo -e "    ${CYAN}export PATH=\"${INSTALL_DIR}:\$PATH\"${NC}"
        echo ""
    fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
    detect_platform
    ensure_neovim
    get_latest_version
    download_binary
    install_binary
    create_config
    check_path

    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║        Installation Complete!        ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  Start Mineo:   ${CYAN}MINEO_CONFIG=${CONFIG_FILE} mineo${NC}"
    echo -e "  Then open:     ${CYAN}http://localhost:3000${NC}"
    echo ""
}

main
