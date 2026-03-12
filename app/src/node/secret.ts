import * as crypto from 'crypto';
import * as fs from 'fs';

export function loadOrCreateSecret(secretPath: string): string {
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`Error: Cannot write session secret to ${secretPath}. Check file permissions.\n`);
    process.exit(1);
  }
  return secret;
}
