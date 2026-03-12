import { ContainerModule } from '@theia/core/shared/inversify';
import { BreadcrumbsContribution, Breadcrumb } from '@theia/core/lib/browser/breadcrumbs/breadcrumbs-contribution';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { ApplicationShellOptions } from '@theia/core/lib/browser/shell/application-shell';
import { URI } from '@theia/core/lib/common/uri';
import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry } from '@theia/core/lib/common/menu';

// No-op MenuContribution — registers nothing
@injectable()
class NoOpMenuContribution implements MenuContribution {
  registerMenus(_registry: MenuModelRegistry): void {
    // intentionally empty
  }
}

// No-op BreadcrumbsContribution
// Check app/node_modules/@theia/core/lib/browser/breadcrumbs/breadcrumbs-contribution.d.ts
// for required interface methods and add stub implementations here if tsc errors occur.
// Common required methods: computeBreadcrumbs(uri), labelForCrumb(breadcrumb)
@injectable()
class NoOpBreadcrumbsContribution implements BreadcrumbsContribution {
  // Required method stubs — TypeScript strict mode requires all interface methods.
  // Exact signatures must match what @theia/core/lib/browser/breadcrumbs/breadcrumbs-contribution.d.ts declares.
  // If tsc errors on these stubs, check the .d.ts and adjust signatures accordingly.
  async computeBreadcrumbs(_uri: URI): Promise<Breadcrumb[]> { return []; }
  labelForCrumb(_breadcrumb: Breadcrumb): string { return ''; }
  iconForCrumb(_breadcrumb: Breadcrumb): string { return ''; }
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
