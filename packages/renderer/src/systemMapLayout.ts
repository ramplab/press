/*
 * The system-map layout engine — the single source of truth for where a
 * map's nodes sit, shared by the in-lab `SystemMap` widget (#22) and the
 * Atlas Codex catalog hero (#26). Extracting it here means the hero's etched
 * cover map and the interactive lab map are laid out by the exact same code:
 * one layered layout, never two forks of coordinate math.
 *
 * Layout: top-to-bottom layered (longest-path layering — the committed eval
 * maps are 4–12 nodes with rows ≤4 wide). A layer wider than the available
 * width splits into legible sub-rows rather than shrinking below a minimum
 * node size. Everything here is a pure function of (widget, width): no DOM,
 * no React, so it is trivially testable and safe to call during SSR.
 */
import type { SystemMapNode, SystemMapWidget } from '@ramplab/spec';

/** Box height. */
export const NODE_H = 62;
/** Vertical gap between layers. */
export const V_GAP = 56;
/** Horizontal gap between siblings in a layer. */
export const H_GAP = 20;
/** A node never renders narrower than this (legibility floor). */
export const MIN_NODE_W = 150;
/** …nor wider than this (so a lone node doesn't sprawl). */
export const MAX_NODE_W = 300;

export interface PlacedNode {
  node: SystemMapNode;
  x: number;
  y: number;
  w: number;
}

export interface MapLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  width: number;
  height: number;
}

/** Longest-path layer per node; bounded so a (spec-invalid) cycle can't hang. */
export function layersOf(widget: SystemMapWidget): SystemMapNode[][] {
  const layer = new Map<string, number>(widget.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < widget.nodes.length; pass++) {
    let moved = false;
    for (const edge of widget.edges) {
      const from = layer.get(edge.from);
      const to = layer.get(edge.to);
      if (from !== undefined && to !== undefined && to < from + 1) {
        layer.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const rows: SystemMapNode[][] = [];
  for (const node of widget.nodes) {
    const depth = layer.get(node.id) ?? 0;
    (rows[depth] ??= []).push(node);
  }
  return rows.filter((row) => row !== undefined && row.length > 0);
}

/** Split a layer into sub-rows so every node keeps a legible minimum width. */
export function chunkRow(row: SystemMapNode[], width: number): SystemMapNode[][] {
  const perRow = Math.max(1, Math.floor((width + H_GAP) / (MIN_NODE_W + H_GAP)));
  if (row.length <= perRow) return [row];
  const chunks: SystemMapNode[][] = [];
  for (let start = 0; start < row.length; start += perRow) {
    chunks.push(row.slice(start, start + perRow));
  }
  return chunks;
}

export function layoutMap(widget: SystemMapWidget, width: number): MapLayout {
  const visualRows = layersOf(widget).flatMap((row) => chunkRow(row, width));
  const placed: PlacedNode[] = [];
  visualRows.forEach((row, rowIndex) => {
    const nodeWidth = Math.max(
      MIN_NODE_W,
      Math.min(MAX_NODE_W, (width - (row.length - 1) * H_GAP) / row.length),
    );
    const total = row.length * nodeWidth + (row.length - 1) * H_GAP;
    const left = Math.max(0, (width - total) / 2);
    row.forEach((node, columnIndex) => {
      placed.push({
        node,
        x: left + columnIndex * (nodeWidth + H_GAP),
        y: rowIndex * (NODE_H + V_GAP),
        w: nodeWidth,
      });
    });
  });
  const height = visualRows.length * NODE_H + Math.max(0, visualRows.length - 1) * V_GAP;
  return { placed, byId: new Map(placed.map((p) => [p.node.id, p])), width, height };
}

/**
 * The node ids in reading/trace order — top-to-bottom, left-to-right — the
 * canonical order the request flows through a trace map. Width-independent
 * (it depends only on the layering), so it is the honest "journey order" the
 * hero lights along the fore-edge and cover seam. For a linear recap map (the
 * flagship trace) this is exactly the request's sequence of stops.
 */
export function traceNodeOrder(widget: SystemMapWidget): string[] {
  return layersOf(widget).flat().map((node) => node.id);
}
