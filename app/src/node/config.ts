import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MineoCfg {
  port: number;
  workspace: string;
  password: string;
  nvim: { bin: string };
}

export const DEFAULTS: MineoCfg = {
  port: 3000,
  workspace: path.join(os.homedir(), 'projects'),
  password: '',
  nvim: { bin: 'nvim' },
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
    return { ...DEFAULTS };
  }

  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`[config] Failed to parse config.json: ${e}\n`);
    return { ...DEFAULTS };
  }

  const cfg: MineoCfg = { ...DEFAULTS };

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
        cfg.nvim = { bin: expandTilde(nvim.bin) };
      }
    }
  }

  return cfg;
}
