import { injectable, inject } from '@theia/core/shared/inversify';
import { MessagingService } from '@theia/core/lib/node/messaging/messaging-service';
import { Channel } from '@theia/core';
import { execFile } from 'child_process';
import { PtyManager } from './pty-manager';
import {
    PTY_CONTROL_PATH,
    ptyDataPath,
    ptyResizePath,
    ptyBufferWatchPath,
} from '../common/pty-protocol';
import type {
    PtyControlRequest,
    PtyControlResponse,
} from '../common/pty-protocol';
import type { PtyInstanceId } from '../common/layout-types';

@injectable()
export class NeovimPtyContribution implements MessagingService.Contribution {
    @inject(PtyManager) private readonly ptyManager!: PtyManager;

    /** MessagingService reference — needed to register channels dynamically after spawn. */
    private messagingService: MessagingService | undefined;

    /** Track registered channel paths to avoid double-registration. */
    private registeredPaths = new Set<string>();

    configure(service: MessagingService): void {
        this.messagingService = service;

        // ── Control channel — handles spawn/kill requests ──────────────────
        service.registerChannelHandler(PTY_CONTROL_PATH, (_params, channel) => {
            channel.onMessage(e => {
                const msg = e().readString();
                let req: PtyControlRequest;
                try {
                    req = JSON.parse(msg);
                } catch {
                    this.sendControlResponse(channel, { instanceId: '', status: 'error', error: 'Invalid JSON' });
                    return;
                }

                if (req.action === 'spawn') {
                    try {
                        this.ptyManager.spawn(req.instanceId, req.role, req.cols, req.rows, req.cwd);
                        this.registerInstanceChannels(req.instanceId);
                        this.sendControlResponse(channel, { instanceId: req.instanceId, status: 'ok' });
                    } catch (err: any) {
                        this.sendControlResponse(channel, {
                            instanceId: req.instanceId,
                            status: 'error',
                            error: err?.message ?? 'spawn failed',
                        });
                    }
                } else if (req.action === 'kill') {
                    this.ptyManager.kill(req.instanceId);
                    this.sendControlResponse(channel, { instanceId: req.instanceId, status: 'ok' });
                }
            });
        });

        // ── Legacy backward-compat aliases ─────────────────────────────────
        // Route old paths to the primary PTY so existing code works during migration.
        service.registerChannelHandler('/services/neovim-pty', (_params, channel) => {
            // Wait for a primary PTY to exist, then bridge
            const tryBridge = (): void => {
                const primaryId = this.ptyManager.getPrimaryId();
                if (!primaryId) {
                    // No primary yet — wait and retry
                    setTimeout(tryBridge, 100);
                    return;
                }
                this.bridgeDataChannel(primaryId, channel);
            };
            tryBridge();
        });

        service.registerChannelHandler('/services/neovim-pty-resize', (_params, channel) => {
            channel.onMessage(e => {
                const msg = e().readString();
                const [cols, rows] = msg.split(',').map(Number);
                const primaryId = this.ptyManager.getPrimaryId();
                if (primaryId && cols > 0 && rows > 0) {
                    this.ptyManager.resize(primaryId, cols, rows);
                }
            });
        });

        service.registerChannelHandler('/services/nvim-buffer-watch', (_params, channel) => {
            const primaryId = this.ptyManager.getPrimaryId();
            if (primaryId) {
                this.bridgeBufferWatch(primaryId, channel);
            }
        });
    }

    /**
     * Register data, resize, and buffer-watch channels for a PTY instance.
     * Called after a successful spawn.
     */
    private registerInstanceChannels(id: PtyInstanceId): void {
        if (!this.messagingService) return;

        const dataPath = ptyDataPath(id);
        const resizePath = ptyResizePath(id);

        // Only register if not already registered (channels persist across reconnects)
        if (!this.registeredPaths.has(dataPath)) {
            this.registeredPaths.add(dataPath);
            this.messagingService.registerChannelHandler(dataPath, (_params, channel) => {
                this.bridgeDataChannel(id, channel);
            });
        }

        if (!this.registeredPaths.has(resizePath)) {
            this.registeredPaths.add(resizePath);
            this.messagingService.registerChannelHandler(resizePath, (_params, channel) => {
                channel.onMessage(e => {
                    const msg = e().readString();
                    const [cols, rows] = msg.split(',').map(Number);
                    this.ptyManager.resize(id, cols, rows);
                });
            });
        }

        // Buffer-watch only for editor PTYs
        if (this.ptyManager.getRole(id) === 'neovim') {
            const bwPath = ptyBufferWatchPath(id);
            if (!this.registeredPaths.has(bwPath)) {
                this.registeredPaths.add(bwPath);
                this.messagingService.registerChannelHandler(bwPath, (_params, channel) => {
                    this.bridgeBufferWatch(id, channel);
                });
            }
        }
    }

    /** Bridge PTY data to/from a channel. */
    private bridgeDataChannel(id: PtyInstanceId, channel: Channel): void {
        // PTY → channel
        const sub = this.ptyManager.onData(id, (data: string) => {
            const bytes = Buffer.from(data, 'utf8');
            channel.getWriteBuffer().writeBytes(bytes).commit();
        });

        // channel → PTY
        channel.onMessage(e => {
            const bytes = e().readBytes();
            this.ptyManager.write(id, Buffer.from(bytes) as any);
        });

        channel.onClose(() => {
            sub?.dispose();
        });
    }

    /** Bridge buffer-watch polling to a channel. */
    private bridgeBufferWatch(id: PtyInstanceId, channel: Channel): void {
        const socketPath = this.ptyManager.getSocketPath(id);
        if (!socketPath) return;

        let lastPath = '';
        let inFlight = false;
        const nvimBin = this.ptyManager.getNvimBin();

        const timer = setInterval(() => {
            if (inFlight) return;
            inFlight = true;
            execFile(nvimBin, ['--server', socketPath, '--remote-expr', 'expand("%:p")'], {
                timeout: 300,
            }, (err, stdout) => {
                inFlight = false;
                if (err || !stdout) return;
                const result = stdout.trim();
                if (result && result !== lastPath) {
                    lastPath = result;
                    channel.getWriteBuffer().writeString(result).commit();
                }
            });
        }, 500);

        channel.onClose(() => {
            clearInterval(timer);
        });
    }

    private sendControlResponse(channel: Channel, response: PtyControlResponse): void {
        channel.getWriteBuffer().writeString(JSON.stringify(response)).commit();
    }
}
