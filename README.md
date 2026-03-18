# Mineo

A self-hosted, browser-based Neovim IDE. Run it on any machine and access your full development environment from any browser — including iPad.

![License](https://img.shields.io/github/license/minhnhat97kg/mineo)
![Release](https://img.shields.io/github/v/release/minhnhat97kg/mineo)

## Features

- **Neovim in the browser** — full terminal with true color support
- **Multiple panes** — split layout with neovim and terminal tabs
- **File explorer** — browse, create, rename, delete, upload and download files
- **LSP support** — language server integration via WebSocket bridge
- **Git status** — file status indicators in the explorer
- **Persistent sessions** — tmux keeps your session alive across reconnects
- **Password protection** — optional auth for remote access
- **Self-hosted** — single binary, no cloud dependency

## Requirements

- [Neovim](https://neovim.io) 0.8+
- [tmux](https://github.com/tmux/tmux) 3.0+

## Installation

### One-liner (Linux & macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/minhnhat97kg/mineo/master/install.sh | bash
```

This will:
1. Detect your platform
2. Install Neovim if not present
3. Download the latest Mineo binary to `/usr/local/bin`
4. Create a default config at `~/.config/mineo/config.json`

### Manual download

Download the binary for your platform from the [latest release](https://github.com/minhnhat97kg/mineo/releases/latest):

| Platform | Binary |
|---|---|
| Linux x86_64 | `mineo_linux_amd64` |
| Linux arm64 | `mineo_linux_arm64` |
| macOS Intel | `mineo_darwin_amd64` |
| macOS Apple Silicon | `mineo_darwin_arm64` |
| Windows x86_64 | `mineo_windows_amd64.exe` |

```bash
# Example: macOS Apple Silicon
curl -L https://github.com/minhnhat97kg/mineo/releases/latest/download/mineo_darwin_arm64 -o mineo
chmod +x mineo
sudo mv mineo /usr/local/bin/mineo
```

## Usage

```bash
# Serve current directory on port 3000
mineo

# Specify a workspace
mineo --workspace=/path/to/project

# Set a password and custom address
mineo --password=secret --address=0.0.0.0:8080

# Use a specific config file
mineo --config=/etc/mineo/config.json
```

Then open `http://localhost:3000` in your browser.

### CLI flags

| Flag | Description | Default |
|---|---|---|
| `--workspace` | Workspace directory to open | Current directory |
| `--address` | Listen address | `0.0.0.0:3000` |
| `--password` | Password to protect the server | _(none)_ |
| `--config` | Path to `config.json` | Next to binary |

Flags override values in `config.json`.

## Configuration

Mineo looks for `config.json` next to the binary (or at the path given by `--config`/`MINEO_CONFIG`).

```json
{
  "port": 3000,
  "workspace": "~/projects",
  "password": "",
  "nvim": {
    "bin": "nvim",
    "configMode": "bundled"
  }
}
```

### Neovim config modes

| Mode | Description |
|---|---|
| `system` | Use your existing `~/.config/nvim` |
| `bundled` | Use Mineo's built-in config |
| `custom` | Use a custom directory |

## Remote access

To access Mineo from another machine or the internet:

```bash
mineo --address=0.0.0.0:3000 --password=yourpassword
```

Then open `http://<your-server-ip>:3000`. For HTTPS, put it behind a reverse proxy like nginx or Caddy.

## Building from source

Requirements: Go 1.22+, Node 20+, tmux, Neovim

```bash
git clone https://github.com/minhnhat97kg/mineo.git
cd mineo
make install   # install client npm deps
make build     # build client + Go binary
./mineo
```

For development with hot reload:

```bash
# Terminal 1 — watch client
cd client && npm run watch

# Terminal 2 — run server
make dev
```

## License

MIT
