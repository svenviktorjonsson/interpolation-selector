const EPSILON = 1e-9;

/**
 * Builds the renderer/editor-facing 3D interpolation model.
 *
 * The model keeps topology in index form and exposes exact source boundaries
 * plus deterministic cuts. Surface tessellation is deliberately a preview
 * representation; analytic patch evaluation belongs behind the VKF seam.
 */
export function createInterpolation3dModel(topology = {}) {
  const points = normalizePoints(topology.points);
  const edgeRecords = normalizeEdges(topology.add_simplices?.edges);
  const edges = edgeRecords.map(({ vertices }) => vertices);
  const faces = normalizeFaces(topology.add_simplices?.faces);
  const edgeIndexByKey = new Map();
  edgeRecords.forEach(({ vertices }, index) => {
    const key = unorderedPairKey(vertices[0], vertices[1]);
    if (!edgeIndexByKey.has(key)) edgeIndexByKey.set(key, index);
  });
  const edgePathsByIndex = edgeRecords.map(({ path }) => path);

  const faceRecords = faces.map((face, index) => buildFaceRecord(
    face,
    index,
    points,
    edgeIndexByKey,
    edgePathsByIndex
  ));
  const pointBounds = boundsOfPoints(points);

  return Object.freeze({
    kind: 'interpolation-3d-model',
    dimension: 3,
    points: freezeNested(points),
    edges: freezeNested(edges),
    faces: Object.freeze(faceRecords),
    bounds: pointBounds,
    face(faceId) {
      return faceRecords.find(({ id }) => id === faceId) || null;
    },
    sampleFace(faceId, u, v) {
      const face = faceRecords.find(({ id }) => id === faceId);
      return face ? sampleFacePatch(face, u, v) : null;
    }
  });
}

function buildFaceRecord(face, index, points, edgeIndexByKey, edgePathsByIndex) {
  const vertexIndices = face.vertices || face;
  if (!Array.isArray(vertexIndices) || vertexIndices.length < 3) {
    throw new TypeError(`3D Face ${index} requires at least three vertices.`);
  }
  const positions = vertexIndices.map((pointIndex) => {
    if (!Number.isInteger(pointIndex) || !points[pointIndex]) {
      throw new RangeError(`3D Face ${index} references unknown point ${pointIndex}.`);
    }
    return points[pointIndex];
  });
  const id = face.id || `face-${index}`;
  const cuts = vertexIndices.map((fromIndex, cutIndex) => {
    const toIndex = vertexIndices[(cutIndex + 1) % vertexIndices.length];
    const edgeIndex = edgeIndexByKey.get(unorderedPairKey(fromIndex, toIndex));
    const edgePath = orientedEdgePath(edgePathsByIndex[edgeIndex], fromIndex, toIndex, points);
    return Object.freeze({
      id: `${id}:cut:${cutIndex}`,
      faceId: id,
      edgeIndex: edgeIndex ?? null,
      fromIndex,
      toIndex,
      t0: cutIndex / vertexIndices.length,
      t1: (cutIndex + 1) / vertexIndices.length,
      path: Object.freeze(edgePath)
    });
  });
  const domain = vertexIndices.length === 3
    ? 'triangle'
    : vertexIndices.length === 4 ? 'quad' : 'ngon';
  return Object.freeze({
    id,
    domain,
    vertexIndices: Object.freeze([...vertexIndices]),
    boundary: Object.freeze(joinCutPaths(cuts, positions[0])),
    cuts: Object.freeze(cuts),
    surfaceTriangles: Object.freeze(buildSurfaceTriangles(positions))
  });
}

function buildSurfaceTriangles(positions) {
  if (positions.length === 3) return [Object.freeze([...positions])];
  if (positions.length === 4) {
    return [
      Object.freeze([positions[0], positions[1], positions[2]]),
      Object.freeze([positions[0], positions[2], positions[3]])
    ];
  }
  const center = averagePoint(positions);
  return positions.map((position, index) => Object.freeze([
    center,
    position,
    positions[(index + 1) % positions.length]
  ]));
}

function sampleFacePatch(face, u, v) {
  const uu = finiteNumber(u);
  const vv = finiteNumber(v);
  if (uu == null || vv == null) return null;
  const points = face.boundary.slice(0, -1);
  if (face.domain === 'triangle') {
    if (uu < -EPSILON || vv < -EPSILON || uu + vv > 1 + EPSILON) return null;
    return weightedPoint(points[0], 1 - uu - vv, points[1], uu, points[2], vv);
  }
  if (face.domain === 'quad') {
    if (uu < -EPSILON || vv < -EPSILON || uu > 1 + EPSILON || vv > 1 + EPSILON) return null;
    return bilinearPoint(points[0], points[1], points[2], points[3], uu, vv);
  }
  return null;
}

function bilinearPoint(p00, p10, p11, p01, u, v) {
  return [0, 1, 2].map((axis) => (
    (1 - u) * (1 - v) * p00[axis]
    + u * (1 - v) * p10[axis]
    + u * v * p11[axis]
    + (1 - u) * v * p01[axis]
  ));
}

function weightedPoint(...terms) {
  const result = [0, 0, 0];
  for (let index = 0; index < terms.length; index += 2) {
    const point = terms[index];
    const weight = terms[index + 1];
    result[0] += point[0] * weight;
    result[1] += point[1] * weight;
    result[2] += point[2] * weight;
  }
  return result;
}

function normalizePoints(points) {
  if (!Array.isArray(points)) throw new TypeError('3D topology requires points.');
  return points.map((point, index) => {
    if (!Array.isArray(point) || point.length < 3 || point.slice(0, 3).some((value) => !Number.isFinite(value))) {
      throw new TypeError(`3D point ${index} must contain three finite coordinates.`);
    }
    return [point[0], point[1], point[2]];
  });
}

function normalizeEdges(edges) {
  if (!edges) return [];
  if (!Array.isArray(edges)) throw new TypeError('3D topology edges must be an array.');
  return edges.map((edge, index) => {
    const values = edge?.vertices || edge;
    if (!Array.isArray(values) || values.length !== 2 || values.some((value) => !Number.isInteger(value))) {
      throw new TypeError(`3D edge ${index} must contain two point indices.`);
    }
    const path = edge?.path || edge?.curve || edge?.interpolationPath;
    return {
      vertices: [values[0], values[1]],
      path: normalizeOptionalPath(path)
    };
  });
}

function normalizeOptionalPath(path) {
  if (!Array.isArray(path) || path.length < 2) return null;
  try {
    return normalizePoints(path);
  } catch {
    return null;
  }
}

function orientedEdgePath(path, fromIndex, toIndex, points) {
  const fallback = [points[fromIndex], points[toIndex]];
  if (!path) return fallback;
  const forward = samePoint(path[0], points[fromIndex]) && samePoint(path.at(-1), points[toIndex]);
  const reverse = samePoint(path[0], points[toIndex]) && samePoint(path.at(-1), points[fromIndex]);
  if (forward) return path.map((point) => [...point]);
  if (reverse) return [...path].reverse().map((point) => [...point]);
  return fallback;
}

function joinCutPaths(cuts, firstPosition) {
  const boundary = [];
  cuts.forEach((cut, index) => {
    const path = cut.path || [];
    if (!path.length) return;
    boundary.push(...(index ? path.slice(1) : path));
  });
  if (!boundary.length) boundary.push(firstPosition);
  if (!samePoint(boundary[0], boundary.at(-1))) boundary.push(boundary[0]);
  return boundary.map((point) => Object.freeze([...point]));
}

function normalizeFaces(faces) {
  if (!faces) return [];
  if (!Array.isArray(faces)) throw new TypeError('3D topology faces must be an array.');
  return faces.map((face) => ({
    id: face?.id,
    vertices: face?.vertices || face
  }));
}

function boundsOfPoints(points) {
  if (!points.length) return Object.freeze({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 });
  const min = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis])));
  const max = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])));
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  const radius = Math.max(...points.map((point) => Math.hypot(...point.map((value, axis) => value - center[axis]))));
  return Object.freeze({
    min: Object.freeze(min),
    max: Object.freeze(max),
    center: Object.freeze(center),
    radius: Number.isFinite(radius) ? radius : 0
  });
}

function averagePoint(points) {
  return [0, 1, 2].map((axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
}

function unorderedPairKey(left, right) {
  return left < right ? `${left}:\u0000${right}` : `${right}:\u0000${left}`;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function samePoint(left, right) {
  return left?.length >= 3 && right?.length >= 3
    && Math.abs(left[0] - right[0]) <= EPSILON
    && Math.abs(left[1] - right[1]) <= EPSILON
    && Math.abs(left[2] - right[2]) <= EPSILON;
}

function freezeNested(values) {
  return Object.freeze(values.map((value) => Object.freeze([...value])));
}

export function surfaceTriangleNormal(triangle) {
  if (!Array.isArray(triangle) || triangle.length < 3) return [0, 0, 1];
  const a = triangle[0];
  const b = triangle[1];
  const c = triangle[2];
  const normal = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  ];
  if (Math.hypot(normal[0], normal[1], normal[2]) <= EPSILON) return [0, 0, 0];
  return normalize3(normal);
}

export function surfaceLightIntensity(triangle, lightDirection = [0.35, 0.55, 1]) {
  const light = normalize3(lightDirection);
  const normal = surfaceTriangleNormal(triangle);
  const diffuse = Math.max(0, dot3(normal, light));
  return clamp01(0.18 + diffuse * 0.82);
}

function normalize3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length <= EPSILON) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot3(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
