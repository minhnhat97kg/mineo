/**
 * TilingCommandContribution — registers commands and keybindings for the
 * tmux-like tiling layout system: split, close, navigate, resize, tab operations.
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    CommandContribution,
    CommandRegistry,
    Command,
} from '@theia/core/lib/common/command';
import {
    KeybindingContribution,
    KeybindingRegistry,
} from '@theia/core/lib/browser/keybinding';
import { TilingLayoutService } from './tiling-layout-service';
import { LayoutTreeManager } from './layout-tree-manager';

// ── Command definitions ────────────────────────────────────────────────────

export namespace TilingCommands {
    export const SPLIT_HORIZONTAL: Command = {
        id: 'mineo.split.horizontal',
        label: 'Mineo: Split Horizontal',
    };
    export const SPLIT_VERTICAL: Command = {
        id: 'mineo.split.vertical',
        label: 'Mineo: Split Vertical',
    };
    export const PANE_CLOSE: Command = {
        id: 'mineo.pane.close',
        label: 'Mineo: Close Pane',
    };
    export const FOCUS_LEFT: Command = {
        id: 'mineo.focus.left',
        label: 'Mineo: Focus Left',
    };
    export const FOCUS_RIGHT: Command = {
        id: 'mineo.focus.right',
        label: 'Mineo: Focus Right',
    };
    export const FOCUS_UP: Command = {
        id: 'mineo.focus.up',
        label: 'Mineo: Focus Up',
    };
    export const FOCUS_DOWN: Command = {
        id: 'mineo.focus.down',
        label: 'Mineo: Focus Down',
    };
    export const TAB_NEW: Command = {
        id: 'mineo.tab.new',
        label: 'Mineo: New Tab',
    };
    export const TAB_CLOSE: Command = {
        id: 'mineo.tab.close',
        label: 'Mineo: Close Tab',
    };
    export const TAB_NEXT: Command = {
        id: 'mineo.tab.next',
        label: 'Mineo: Next Tab',
    };
    export const TAB_PREV: Command = {
        id: 'mineo.tab.prev',
        label: 'Mineo: Previous Tab',
    };
    export const PANE_TERMINAL: Command = {
        id: 'mineo.pane.terminal',
        label: 'Mineo: Add Terminal Pane',
    };
}

@injectable()
export class TilingCommandContribution implements CommandContribution, KeybindingContribution {
    @inject(TilingLayoutService) protected readonly tilingLayoutService!: TilingLayoutService;
    @inject(LayoutTreeManager) protected readonly layoutTreeManager!: LayoutTreeManager;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(TilingCommands.SPLIT_HORIZONTAL, {
            execute: () => this.tilingLayoutService.splitFocusedPane('horizontal'),
        });
        commands.registerCommand(TilingCommands.SPLIT_VERTICAL, {
            execute: () => this.tilingLayoutService.splitFocusedPane('vertical'),
        });
        commands.registerCommand(TilingCommands.PANE_CLOSE, {
            execute: () => this.tilingLayoutService.closeFocusedPane(),
        });
        commands.registerCommand(TilingCommands.FOCUS_LEFT, {
            execute: () => this.tilingLayoutService.navigateFocus('left'),
        });
        commands.registerCommand(TilingCommands.FOCUS_RIGHT, {
            execute: () => this.tilingLayoutService.navigateFocus('right'),
        });
        commands.registerCommand(TilingCommands.FOCUS_UP, {
            execute: () => this.tilingLayoutService.navigateFocus('up'),
        });
        commands.registerCommand(TilingCommands.FOCUS_DOWN, {
            execute: () => this.tilingLayoutService.navigateFocus('down'),
        });
        commands.registerCommand(TilingCommands.TAB_NEW, {
            execute: () => this.tilingLayoutService.addNewTab(),
        });
        commands.registerCommand(TilingCommands.TAB_CLOSE, {
            execute: () => this.tilingLayoutService.closeActiveTab(),
        });
        commands.registerCommand(TilingCommands.TAB_NEXT, {
            execute: () => this.tilingLayoutService.nextTab(),
        });
        commands.registerCommand(TilingCommands.TAB_PREV, {
            execute: () => this.tilingLayoutService.prevTab(),
        });
        commands.registerCommand(TilingCommands.PANE_TERMINAL, {
            execute: () => this.tilingLayoutService.splitFocusedPane('vertical', 'terminal'),
        });
    }

    registerKeybindings(keybindings: KeybindingRegistry): void {
        keybindings.registerKeybinding({
            command: TilingCommands.SPLIT_HORIZONTAL.id,
            keybinding: 'ctrlcmd+shift+\\',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.SPLIT_VERTICAL.id,
            keybinding: 'ctrlcmd+shift+-',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.PANE_CLOSE.id,
            keybinding: 'ctrlcmd+shift+x',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.FOCUS_LEFT.id,
            keybinding: 'ctrlcmd+shift+h',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.FOCUS_RIGHT.id,
            keybinding: 'ctrlcmd+shift+l',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.FOCUS_UP.id,
            keybinding: 'ctrlcmd+shift+k',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.FOCUS_DOWN.id,
            keybinding: 'ctrlcmd+shift+j',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.TAB_NEW.id,
            keybinding: 'ctrlcmd+shift+t',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.TAB_CLOSE.id,
            keybinding: 'ctrlcmd+shift+w',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.TAB_NEXT.id,
            keybinding: 'ctrlcmd+shift+]',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.TAB_PREV.id,
            keybinding: 'ctrlcmd+shift+[',
        });
        keybindings.registerKeybinding({
            command: TilingCommands.PANE_TERMINAL.id,
            keybinding: 'ctrlcmd+shift+`',
        });
    }
}
