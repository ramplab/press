import type { BaseWidget, LabModule, LabSpec, OverlayWidget } from './schema.js';

/**
 * A widget ready for rendering: any base widget, or an overlay widget
 * (callout with optional anchors), tagged with its origin so the renderer
 * can distinguish machine content from human notes.
 */
export interface ResolvedWidget {
  widget: BaseWidget | OverlayWidget;
  origin: 'base' | 'overlay';
}

export interface ResolvedModule {
  id: LabModule['id'];
  title: string;
  summary?: string;
  widgets: ResolvedWidget[];
}

/**
 * Merge the human overlay into the machine-owned base, producing the module
 * list the renderer displays. Overlay entries are inserted after their
 * `afterWidgetId` target, or appended to the module if no target (or a
 * no-longer-existing target) is given. Entries pointing at unknown modules
 * are ignored — never an error, so a stale overlay cannot break rendering.
 */
export function resolveModules(spec: LabSpec): ResolvedModule[] {
  const modules: ResolvedModule[] = spec.base.modules.map((module) => ({
    id: module.id,
    title: module.title,
    ...(module.summary !== undefined ? { summary: module.summary } : {}),
    widgets: module.widgets.map((widget) => ({ widget, origin: 'base' as const })),
  }));

  const byId = new Map(modules.map((module) => [module.id, module]));

  for (const entry of spec.overlay) {
    const module = byId.get(entry.target.moduleId);
    if (!module) continue;

    const resolved: ResolvedWidget = { widget: entry.widget, origin: 'overlay' };
    const afterIndex =
      entry.target.afterWidgetId === undefined
        ? -1
        : module.widgets.findIndex((w) => w.widget.id === entry.target.afterWidgetId);

    if (afterIndex === -1) {
      module.widgets.push(resolved);
    } else {
      module.widgets.splice(afterIndex + 1, 0, resolved);
    }
  }

  return modules;
}
