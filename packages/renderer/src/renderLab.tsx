import { createRoot, type Root } from 'react-dom/client';
import type { LabSpec } from '@ramplab/spec';
import { Lab } from './Lab.js';

/**
 * Convenience entry point: mount a lab spec into a DOM container.
 * Returns the React root so callers can unmount or re-render.
 */
export function renderLab(spec: LabSpec, container: Element): Root {
  const root = createRoot(container);
  root.render(<Lab spec={spec} />);
  return root;
}
