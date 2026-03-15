import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type NvimConfigMode = 'system' | 'bundled' | 'custom';

export interface MineoCfg {
  port: number;
  workspace: string;
  password: string;
  nvim: {
    bin: string;
    /** How neovim's config is resolved:
     *   'system'  — use ~/.config/nvim (neovim default, no override)
     *   'bundled' — use the config bundled inside this app (<app>/nvim-config)
     *   'custom'  — use configDir specified below
     */
    configMode: NvimConfigMode;
    /** Absolute path to the nvim config dir when configMode === 'custom'. */
    configDir: string;
  };
}

export const DEFAULTS: MineoCfg = {
  port: 3000,
  workspace: path.join(os.homedir(), 'projects'),
  password: '',
  nvim: {
    bin: 'nvim',
    configMode: 'system',
    configDir: '',
  },
};

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function loadConfig(configPath: string): MineoCfg {
  let raw: Record<string, unknown> = {};

  if (!fs.existsSync(configPath)) {
    process.stderr.write('[config] config.json not found, using defaults\n');
    return { ...DEFAULTS, nvim: { ...DEFAULTS.nvim } };
  }

  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`[config] Failed to parse config.json: ${e}\n`);
    return { ...DEFAULTS, nvim: { ...DEFAULTS.nvim } };
  }

  const cfg: MineoCfg = { ...DEFAULTS, nvim: { ...DEFAULTS.nvim } };

  if ('port' in raw) {
    if (typeof raw.port !== 'number') {
      process.stderr.write('[config] port must be a number, using default 3000\n');
    } else {
      cfg.port = raw.port;
    }
  }

  if ('workspace' in raw) {
    if (typeof raw.workspace !== 'string') {
      process.stderr.write('[config] workspace must be a string, using default\n');
    } else {
      cfg.workspace = expandTilde(raw.workspace);
    }
  }

  if ('password' in raw) {
    if (typeof raw.password !== 'string') {
      process.stderr.write('[config] password must be a string, using default\n');
    } else {
      cfg.password = raw.password;
    }
  }

  if ('nvim' in raw && typeof raw.nvim === 'object' && raw.nvim !== null) {
    const nvim = raw.nvim as Record<string, unknown>;
    if ('bin' in nvim) {
      if (typeof nvim.bin !== 'string') {
        process.stderr.write('[config] nvim.bin must be a string, using default\n');
      } else {
        cfg.nvim.bin = expandTilde(nvim.bin);
      }
    }
    if ('configMode' in nvim) {
      const m = nvim.configMode;
      if (m === 'system' || m === 'bundled' || m === 'custom') {
        cfg.nvim.configMode = m;
      } else {
        process.stderr.write('[config] nvim.configMode must be system|bundled|custom, using system\n');
      }
    }
    if ('configDir' in nvim) {
      if (typeof nvim.configDir !== 'string') {
        process.stderr.write('[config] nvim.configDir must be a string\n');
      } else {
        cfg.nvim.configDir = expandTilde(nvim.configDir as string);
      }
    }
  }

  return cfg;
}

/** Persist top-level fields (workspace, password) back to config.json. */
export function saveConfig(
  configPath: string,
  patch: Partial<Pick<MineoCfg, 'workspace' | 'password'>>,
): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* corrupt — overwrite */ }
  }
  if ('workspace' in patch && patch.workspace !== undefined) raw.workspace = patch.workspace;
  if ('password' in patch && patch.password !== undefined) raw.password = patch.password;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/** Persist the nvim section of config back to config.json. */
export function saveNvimConfig(
  configPath: string,
  nvimPatch: Partial<MineoCfg['nvim']>,
): void {
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch { /* corrupt — overwrite */ }
  }
  const existing = (typeof raw.nvim === 'object' && raw.nvim !== null)
    ? (raw.nvim as Record<string, unknown>)
    : {};
  raw.nvim = { ...existing, ...nvimPatch };
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}
