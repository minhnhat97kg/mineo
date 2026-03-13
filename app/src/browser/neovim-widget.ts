import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { BaseWidget, Widget, Message } from '@theia/core/lib/browser/widgets/widget';
import { ServiceConnectionProvider, RemoteConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { Channel, Disposable, DisposableCollection } from '@theia/core';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { TouchGestureHandler } from './touch-gesture-handler';
import { TouchToolbar } from './touch-toolbar';

@injectable()
export class NvimWidget extends BaseWidget {
    static readonly ID = 'mineo.nvim-widget';
    static readonly LABEL = 'Neovim';

    protected term!: Terminal;
    protected fitAddon!: FitAddon;
    protected termOpened = false;
    protected dataChannel: Channel | undefined;
    protected resizeChannel: Channel | undefined;
    protected dataListeners = new DisposableCollection();
    protected resizeListeners = new DisposableCollection();

    @inject(RemoteConnectionProvider) protected readonly connectionProvider!: ServiceConnectionProvider;

    @postConstruct()
    protected init(): void {
        this.id = NvimWidget.ID;
        this.title.label = NvimWidget.LABEL;
        this.title.closable = false;
        this.title.iconClass = 'fa fa-terminal';
        this.addClass('nvim-widget');

        // Minimal xterm theme: only background/cursor/selection.
        // With COLORTERM=truecolor, nvim uses termguicolors and emits raw
        // RGB escape codes — the ANSI color palette is irrelevant. We let
        // nvim's own colorscheme dictate all text colors.
        // Background is set to a neutral dark so the xterm canvas doesn't
        // flash white before nvim draws its first frame.
        this.term = new Terminal({
            cursorStyle: 'block',
            cursorBlink: false, // nvim controls blink via its own escape sequences
            fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
            fontSize: 14,
            lineHeight: 1.2,
            theme: {
                background: '#1e1e2f', // catppuccin-mocha base — avoids flash before nvim draws
                foreground: '#cdd6f4',
                cursor: '#f5e0dc',     // catppuccin-mocha rosewater — visible on any bg
                cursorAccent: '#1e1e2f',
                selectionBackground: '#45475a',
            },
        });

        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);

        this.toDispose.push(Disposable.create(() => this.term.dispose()));

        // Register channel handlers eagerly — must happen before the WebSocket
        // connection is established so the initial channel open event is caught.
        this.connectChannels();
    }

    protected connectChannels(): void {
        // Connect data channel
        this.connectionProvider.listen('/services/neovim-pty', (_path, channel) => {
            // Dispose previous listeners to avoid duplicate onData handlers
            // when the WebSocket reconnects and a new channel is opened.
            this.dataListeners.dispose();
            this.dataChannel = channel;

            // Backend → xterm.js (raw bytes)
            this.dataListeners.push(channel.onMessage(e => {
                this.term.write(e().readBytes());
            }));

            // xterm.js → Backend (raw bytes)
            const enc = new TextEncoder();
            this.dataListeners.push(this.term.onData(data => {
                channel.getWriteBuffer().writeBytes(enc.encode(data)).commit();
            }));
            this.dataListeners.push(this.term.onBinary(data => {
                const bytes = new Uint8Array(data.length);
                for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
                channel.getWriteBuffer().writeBytes(bytes).commit();
            }));

            channel.onClose(() => {
                this.dataListeners.dispose();
                this.dataChannel = undefined;
            });
        }, false);

        // Connect resize channel
        this.connectionProvider.listen('/services/neovim-pty-resize', (_path, channel) => {
            this.resizeListeners.dispose();
            this.resizeChannel = channel;
            this.resizeListeners.push(channel.onClose(() => {
                this.resizeChannel = undefined;
            }));
            // Send initial size once resize channel is ready
            this.sendResize();
        }, false);
    }

    async start(): Promise<void> {
        // Channel handlers registered in postConstruct — nothing extra to do here.
        // Kept as a no-op so callers don't need to change.
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        if (!this.termOpened) {
            this.term.open(this.node);
            this.termOpened = true;
            this.term.focus();
            this.fitAndResize();

            // Touch support — only attach when a touch device is detected
            if (window.matchMedia('(pointer: coarse)').matches) {
                const gestureHandler = new TouchGestureHandler(this.node, this.term, () => this.fitAndResize());
                this.toDispose.push(gestureHandler);

                const enc = new TextEncoder();
                const toolbar = new TouchToolbar(this.node, {
                    sendKey: (data: string) => {
                        if (this.dataChannel) {
                            this.dataChannel.getWriteBuffer()
                                .writeBytes(enc.encode(data))
                                .commit();
                        }
                    },
                });
                this.toDispose.push(toolbar);
            }
        }
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.term.focus();
    }

    protected override onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.fitAndResize();
    }

    protected fitAndResize(): void {
        if (!this.termOpened) return;
        try {
            this.fitAddon.fit();
        } catch { /* not attached yet */ }
        this.sendResize();
    }

    protected sendResize(): void {
        if (this.resizeChannel && this.term.cols > 0 && this.term.rows > 0) {
            this.resizeChannel.getWriteBuffer()
                .writeString(`${this.term.cols},${this.term.rows}`)
                .commit();
        }
    }
}
