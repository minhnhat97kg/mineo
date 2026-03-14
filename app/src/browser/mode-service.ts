import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';

/** The two mutually exclusive editor modes. */
export type EditorMode = 'neovim' | 'monaco';

const STORAGE_KEY = 'mineo.editorMode';

/**
 * Interface that NvimTerminalContribution implements to perform the actual
 * widget manipulation. ModeService calls these during activate().
 * This avoids a circular DI dependency.
 */
export interface ModeActivator {
  activateNeovimMode(startup: boolean): Promise<void>;
  activateMonacoMode(): Promise<void>;
}

/**
 * ModeService — owns editor mode state.
 * - Reads initial mode from localStorage on construction.
 * - activate(mode) runs the activation sequence via the registered ModeActivator,
 *   then updates state and fires onModeChange on success.
 *   On failure (activator throws), rolls back state and re-throws.
 * - toggle() activates the opposite mode.
 * - registerActivator(activator) must be called before activate() is used
 *   (NvimTerminalContribution calls this in its onStart).
 */
@injectable()
export class ModeService {
  private _currentMode: EditorMode;
  private readonly _onModeChange = new Emitter<EditorMode>();
  readonly onModeChange: Event<EditorMode> = this._onModeChange.event;
  private _activator: ModeActivator | undefined;

  constructor() {
    const stored = localStorage.getItem(STORAGE_KEY);
    this._currentMode = (stored === 'neovim' || stored === 'monaco') ? stored : 'neovim';
  }

  get currentMode(): EditorMode {
    return this._currentMode;
  }

  registerActivator(activator: ModeActivator): void {
    this._activator = activator;
  }

  async activate(mode: EditorMode, options: { startup?: boolean } = {}): Promise<void> {
    if (!this._activator) {
      throw new Error('ModeService: no activator registered');
    }
    const previous = this._currentMode;
    try {
      if (mode === 'neovim') {
        await this._activator.activateNeovimMode(options.startup ?? false);
      } else {
        await this._activator.activateMonacoMode();
      }
      // Only update state AFTER the activator succeeds
      this._currentMode = mode;
      localStorage.setItem(STORAGE_KEY, mode);  // written only on success
      this._onModeChange.fire(mode);
    } catch (err) {
      // Restore in-memory state; localStorage was NOT written (written above only on success)
      this._currentMode = previous;
      // Re-throw so the caller can toast with context-appropriate messaging
      throw err;
    }
  }

  async toggle(): Promise<void> {
    await this.activate(this._currentMode === 'neovim' ? 'monaco' : 'neovim');
  }
}
