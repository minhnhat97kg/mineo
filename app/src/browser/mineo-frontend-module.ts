import '../../src/browser/style/suppress.css';
import '../../src/browser/style/theme.css';

import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { BreadcrumbsContribution, Breadcrumb } from '@theia/core/lib/browser/breadcrumbs/breadcrumbs-constants';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { ApplicationShellOptions } from '@theia/core/lib/browser/shell/application-shell';
import URI from '@theia/core/lib/common/uri';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { Disposable } from '@theia/core/lib/common/disposable';

// No-op MenuContribution — registers nothing
@injectable()
class NoOpMenuContribution implements MenuContribution {
  registerMenus(_registry: MenuModelRegistry): void {
    // intentionally empty
  }
}

// No-op BreadcrumbsContribution — satisfies the full BreadcrumbsContribution interface
// from @theia/core/lib/browser/breadcrumbs/breadcrumbs-constants (Theia 1.69)
@injectable()
class NoOpBreadcrumbsContribution implements BreadcrumbsContribution {
  readonly type: symbol = Symbol('NoOpBreadcrumbs');
  readonly priority: number = 0;
  private readonly _onDidChangeBreadcrumbs = new Emitter<URI>();
  readonly onDidChangeBreadcrumbs: Event<URI> = this._onDidChangeBreadcrumbs.event;
  async computeBreadcrumbs(_uri: URI): Promise<Breadcrumb[]> { return []; }
  async attachPopupContent(_breadcrumb: Breadcrumb, _parent: HTMLElement): Promise<Disposable | undefined> { return undefined; }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // Suppress breadcrumbs
  try {
    rebind(BreadcrumbsContribution).to(NoOpBreadcrumbsContribution).inSingletonScope();
  } catch {
    bind(BreadcrumbsContribution).to(NoOpBreadcrumbsContribution).inSingletonScope();
  }

  // Suppress menu bar via no-op MenuContribution.
  // MenuContribution is a multi-binding — always use bind(), not rebind().
  // Actual menu chrome hidden by suppress.css; this prevents new menus being added.
  bind(MenuContribution).to(NoOpMenuContribution).inSingletonScope();

  // Suppress side panel (activity bar) by overriding shell options.
  // Use the imported ApplicationShellOptions symbol — NOT a string token.
  // The string 'ApplicationShellOptions' is ignored by Theia; only the real symbol works.
  try {
    rebind(ApplicationShellOptions).toConstantValue({
      leftPanelSize: 0,
      rightPanelSize: 0,
      bottomPanelSize: 0,
      leftPanelExpandThreshold: 0,
    });
  } catch {
    bind(ApplicationShellOptions).toConstantValue({
      leftPanelSize: 0,
      rightPanelSize: 0,
      bottomPanelSize: 0,
      leftPanelExpandThreshold: 0,
    });
  }
});
