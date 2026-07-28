// The shared system-map layout engine (#26): one source of truth for node
// placement, used by both the in-lab SystemMap widget and the Atlas Codex
// hero. Pure functions of (widget, width) — no DOM — so tested directly.
import { describe, expect, it } from 'vitest';
import type { SystemMapWidget } from '@ramplab/spec';
import {
  MAX_NODE_W,
  MIN_NODE_W,
  NODE_H,
  V_GAP,
  chunkRow,
  layersOf,
  layoutMap,
  traceNodeOrder,
} from '../src/systemMapLayout.js';

/** A linear chain a → b → c → d, the shape of a flagship trace recap map. */
function chain(...ids: string[]): SystemMapWidget {
  return {
    id: 'map',
    type: 'system-map',
    nodes: ids.map((id) => ({ id, label: id.toUpperCase() })),
    edges: ids.slice(1).map((id, index) => ({ from: ids[index] as string, to: id })),
  };
}

describe('layersOf', () => {
  it('puts each node of a linear chain on its own layer, in order', () => {
    const rows = layersOf(chain('a', 'b', 'c', 'd'));
    expect(rows.map((row) => row.map((node) => node.id))).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('groups siblings that share a depth onto one layer (longest path)', () => {
    // a → b, a → c, b → d, c → d : d sits below both branches.
    const widget: SystemMapWidget = {
      id: 'diamond',
      type: 'system-map',
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id })),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    };
    const rows = layersOf(widget).map((row) => row.map((node) => node.id));
    expect(rows[0]).toEqual(['a']);
    expect(rows[1]?.sort()).toEqual(['b', 'c']);
    expect(rows[2]).toEqual(['d']);
  });

  it('does not hang on a spec-invalid cycle', () => {
    const cyclic: SystemMapWidget = {
      id: 'cycle',
      type: 'system-map',
      nodes: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(() => layersOf(cyclic)).not.toThrow();
  });
});

describe('chunkRow', () => {
  it('keeps a row that fits as a single row', () => {
    const nodes = ['a', 'b'].map((id) => ({ id, label: id }));
    expect(chunkRow(nodes, 600)).toHaveLength(1);
  });

  it('splits a row too wide for the legible minimum into sub-rows', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, label: `n${i}` }));
    // ~2 nodes fit at 360px (MIN_NODE_W 150 + gap); expect multiple sub-rows.
    const chunks = chunkRow(nodes, 360);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(6);
  });
});

describe('layoutMap', () => {
  it('places a linear chain as a centered single column with no overlap', () => {
    const layout = layoutMap(chain('a', 'b', 'c'), 240);
    expect(layout.placed).toHaveLength(3);
    // One node per row: y advances by NODE_H + V_GAP, x centers identically.
    const [a, b, c] = layout.placed;
    expect(a?.y).toBe(0);
    expect(b?.y).toBe(NODE_H + V_GAP);
    expect(c?.y).toBe(2 * (NODE_H + V_GAP));
    expect(a?.x).toBe(b?.x);
    expect(a?.x).toBe(c?.x);
    expect(layout.height).toBe(3 * NODE_H + 2 * V_GAP);
  });

  it('clamps node width between the legible min and max', () => {
    for (const node of layoutMap(chain('a', 'b'), 5000).placed) {
      expect(node.w).toBeLessThanOrEqual(MAX_NODE_W);
      expect(node.w).toBeGreaterThanOrEqual(MIN_NODE_W);
    }
  });

  it('indexes placed nodes by id', () => {
    const layout = layoutMap(chain('a', 'b'), 240);
    expect(layout.byId.get('a')?.node.id).toBe('a');
    expect(layout.byId.get('missing')).toBeUndefined();
  });
});

describe('traceNodeOrder', () => {
  it('returns node ids in reading (trace) order for a linear chain', () => {
    expect(traceNodeOrder(chain('client', 'server', 'handler'))).toEqual([
      'client',
      'server',
      'handler',
    ]);
  });
});
