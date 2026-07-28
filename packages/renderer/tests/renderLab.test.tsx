import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { renderLab } from '../src/index.js';
import twoModuleLab from './fixtures/two-module-lab.json';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('renderLab', () => {
  it('mounts a lab spec into a plain DOM container', async () => {
    const spec = parseLabSpec(structuredClone(twoModuleLab));
    const container = document.createElement('div');
    document.body.appendChild(container);

    let root!: ReturnType<typeof renderLab>;
    await act(async () => {
      root = renderLab(spec, container);
    });

    // Uncontrolled mount opens the edition's contents page.
    expect(container.textContent).toContain('Renderer Fixture Lab');
    expect(container.textContent).toContain('First Module');
    expect(container.textContent).toContain('Second Module');

    await act(async () => {
      root.unmount();
    });
    expect(container.textContent).toBe('');
    container.remove();
  });
});
