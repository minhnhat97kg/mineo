import { injectable } from '@theia/core/shared/inversify';
import { MessagingService } from '@theia/core/lib/node/messaging/messaging-service';
import { spawn, IPty } from 'node-pty';
import { loadConfig } from './config';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

const CONFIG_PATH = process.env.MINEO_CONFIG || path.resolve(__dirname, '../../../config.json');
const cfg = loadConfig(CONFIG_PATH);
const NVIM_SOCK = '/tmp/mineo-nvim.sock';

@injectable()
export class NeovimPtyContribution implements MessagingService.Contribution {
    private pty: IPty | undefined;

    configure(service: MessagingService): void {
        service.registerChannelHandler('/services/neovim-pty', (_params, channel) => {
            // Spawn nvim only if not already running — reconnect on page refresh
            if (!this.pty) {
                // Remove stale socket file before spawning nvim.
                try { fs.unlinkSync(NVIM_SOCK); } catch { /* doesn't exist — fine */ }

                this.pty = spawn(cfg.nvim.bin, ['--listen', NVIM_SOCK, '-c', 'set mouse=a'], {
                    name: 'xterm-256color',
                    cols: 120,
                    rows: 30,
                    cwd: cfg.workspace,
                    env: {
                        ...process.env,
                        TERM: 'xterm-256color',
                        COLORTERM: 'truecolor',
                    } as Record<string, string>,
                });

                // Handle PTY exit — nvim quit intentionally (e.g. :q)
                this.pty.onExit(() => {
                    this.pty = undefined;
                    channel.close();
                });
            } else {
                // Reconnecting — redraw so the terminal is up to date
                this.pty.write('\x0c'); // Ctrl-L to force redraw
            }

            // PTY stdout → channel (frontend) as raw bytes.
            // Translate ISO 8613-6 colon-separated RGB params to semicolon-separated,
            // because xterm.js only understands the legacy semicolon form.
            // e.g. ESC[38:2:R:G:Bm  →  ESC[38;2;R;G;Bm
            //      ESC[48:2:R:G:Bm  →  ESC[48;2;R;G;Bm
            const colonRgbRe = /\x1b\[(\d+):2:(\d+):(\d+):(\d+)m/g;
            const onData = this.pty.onData((data: any) => {
                const str: string = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
                const translated = str.replace(colonRgbRe, '\x1b[$1;2;$2;$3;$4m');
                const bytes = Buffer.from(translated, 'utf8');
                channel.getWriteBuffer().writeBytes(bytes).commit();
            });

            // Channel (frontend) → PTY stdin
            channel.onMessage(e => {
                const bytes = e().readBytes();
                this.pty?.write(Buffer.from(bytes) as any);
            });

            // Channel close = browser disconnected, NOT nvim quit — keep nvim alive
            channel.onClose(() => {
                onData.dispose();
            });
        });

        // Resize endpoint — frontend sends resize requests via a separate channel
        service.registerChannelHandler('/services/neovim-pty-resize', (_params, channel) => {
            channel.onMessage(e => {
                const msg = e().readString();
                // Format: "cols,rows"
                const [cols, rows] = msg.split(',').map(Number);
                if (this.pty && cols > 0 && rows > 0) {
                    this.pty.resize(cols, rows);
                }
            });
        });

        // Buffer-watch endpoint — polls nvim for the current buffer path every 500ms
        // and pushes it to the frontend whenever it changes, so the file explorer
        // can reveal and select the active file.
        //
        // Uses execFile (async) instead of execSync to avoid blocking the event loop.
        // An in-flight guard prevents overlapping calls if nvim responds slowly.
        service.registerChannelHandler('/services/nvim-buffer-watch', (_params, channel) => {
            let lastPath = '';
            let inFlight = false;
            let timer: ReturnType<typeof setInterval> | undefined;

            timer = setInterval(() => {
                if (inFlight) return; // skip tick if previous call hasn't returned yet
                inFlight = true;
                execFile(cfg.nvim.bin, ['--server', NVIM_SOCK, '--remote-expr', 'expand("%:p")'], {
                    timeout: 300,
                }, (err, stdout) => {
                    inFlight = false;
                    if (err || !stdout) return; // nvim not ready yet or no file open
                    const result = stdout.trim();
                    if (result && result !== lastPath) {
                        lastPath = result;
                        channel.getWriteBuffer().writeString(result).commit();
                    }
                });
            }, 500);

            channel.onClose(() => {
                if (timer !== undefined) {
                    clearInterval(timer);
                    timer = undefined;
                }
            });
        });
    }
}

