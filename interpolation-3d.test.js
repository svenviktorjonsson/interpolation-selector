import { describe, expect, it } from 'vitest';
import {
  createInterpolation3dModel,
  surfaceLightIntensity,
  surfaceTriangleNormal
} from './interpolation-3d.js';

describe('3D interpolation model', () => {
  it('preserves a triangular Face boundary and assigns one cut per source edge', () => {
    const model = createInterpolation3dModel({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [0, 2, 1]
      ],
      add_simplices: {
        edges: [[0, 1], [1, 2], [2, 0]],
        faces: [[0, 1, 2]]
      }
    });

    expect(model.faces).toHaveLength(1);
    expect(model.faces[0].domain).toBe('triangle');
    expect(model.faces[0].boundary).toEqual([
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 1],
      [0, 0, 0]
    ]);
    expect(model.faces[0].cuts.map(({ edgeIndex }) => edgeIndex)).toEqual([0, 1, 2]);
    expect(model.faces[0].surfaceTriangles).toHaveLength(1);
  });

  it('samples a quadrilateral patch through its corner positions', () => {
    const model = createInterpolation3dModel({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 1],
        [0, 2, 1]
      ],
      add_simplices: { faces: [[0, 1, 2, 3]] }
    });
    const face = model.faces[0];

    expect(face.domain).toBe('quad');
    expect(model.sampleFace(face.id, 0, 0)).toEqual([0, 0, 0]);
    expect(model.sampleFace(face.id, 1, 1)).toEqual([2, 2, 1]);
    expect(model.sampleFace(face.id, 0.5, 0.5)).toEqual([1, 1, 0.5]);
    expect(model.sampleFace(face.id, -0.01, 0.5)).toBeNull();
    expect(model.sampleFace(face.id, 0.5, 1.01)).toBeNull();
  });

  it('uses a deterministic center fan for an n-sided preview surface', () => {
    const model = createInterpolation3dModel({
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [3, 1, 0],
        [1, 3, 0],
        [-1, 1, 0]
      ],
      add_simplices: { faces: [[0, 1, 2, 3, 4]] }
    });

    const face = model.faces[0];
    expect(face.domain).toBe('ngon');
    expect(face.surfaceTriangles).toHaveLength(5);
    expect(face.surfaceTriangles[0][0]).toEqual([1, 1, 0]);
    expect(face.cuts.map(({ t0, t1 }) => [t0, t1])).toEqual([
      [0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1]
    ]);
  });

  it('rejects non-3D points instead of silently projecting them', () => {
    expect(() => createInterpolation3dModel({
      points: [[0, 0]],
      add_simplices: { faces: [] }
    })).toThrow(/three finite coordinates/);
  });

  it('keeps shared Face boundaries positional and cut-identifiable', () => {
    const model = createInterpolation3dModel({
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
      ],
      add_simplices: {
        edges: [[0, 1], [1, 2], [2, 0], [0, 3], [3, 1]],
        faces: [[0, 1, 2], [1, 0, 3]]
      }
    });
    const first = model.faces[0];
    const second = model.faces[1];
    const firstShared = first.cuts.find(({ fromIndex, toIndex }) => fromIndex === 0 && toIndex === 1);
    const secondShared = second.cuts.find(({ fromIndex, toIndex }) => fromIndex === 1 && toIndex === 0);

    expect(firstShared.edgeIndex).toBe(secondShared.edgeIndex);
    expect(firstShared.path).toEqual([[0, 0, 0], [1, 0, 0]]);
    expect(secondShared.path).toEqual([[1, 0, 0], [0, 0, 0]]);
  });

  it('provides stable normals and directional light intensity for surface preview', () => {
    const triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];

    expect(surfaceTriangleNormal(triangle)).toEqual([0, 0, 1]);
    expect(surfaceLightIntensity(triangle, [0, 0, 1])).toBeGreaterThan(
      surfaceLightIntensity(triangle, [0, 0, -1])
    );
    expect(surfaceLightIntensity(triangle, [0, 0, 1])).toBeGreaterThanOrEqual(0.18);
    expect(surfaceLightIntensity(triangle, [0, 0, 1])).toBeLessThanOrEqual(1);
    expect(surfaceLightIntensity([[0, 0, 0], [0, 0, 0], [0, 0, 0]], [0, 0, 1])).toBe(0.18);
  });

  it('keeps supplied curved edge samples in their dedicated cuts and Face boundary', () => {
    const model = createInterpolation3dModel({
      points: [[0, 0, 0], [2, 0, 0], [0, 2, 0]],
      add_simplices: {
        edges: [
          { vertices: [0, 1], path: [[0, 0, 0], [1, 0.35, 0], [2, 0, 0]] },
          [1, 2],
          [2, 0]
        ],
        faces: [[0, 1, 2]]
      }
    });
    const face = model.faces[0];

    expect(face.cuts[0].path).toEqual([[0, 0, 0], [1, 0.35, 0], [2, 0, 0]]);
    expect(face.boundary).toContainEqual([1, 0.35, 0]);
    expect(face.boundary[0]).toEqual(face.boundary.at(-1));
  });
});
