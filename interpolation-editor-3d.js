import { createDomElement } from './dom-element.js';
import { createInterpolation3dModel, surfaceLightIntensity } from './interpolation-3d.js';
import { applyInputCapabilities, createDialogLifecycle } from 'selector';

const FACE_COLORS = ['#67e8f9', '#a78bfa', '#fbbf24', '#86efac', '#f9a8d4'];

/**
 * Small, isolated 3D interpolation view. It previews the canonical Face
 * topology and its cuts; analytic patch evaluation will later arrive through
 * the VKF adapter without changing this editor seam.
 */
export function createInterpolation3dEditor({
  documentRef = globalThis.document,
  getTopology = () => ({}),
  onClose = () => {}
} = {}) {
  let root = null;
  let canvas = null;
  let faceSelect = null;
  let continuitySelect = null;
  let status = null;
  let model = null;
  let selectedFaceId = '';
  let camera = { yaw: -0.62, pitch: 0.42, zoom: 1 };
  let drag = null;
  let dialogLifecycle = null;
  let inputCapabilities = null;

  function mount(target = documentRef?.body) {
    if (root) return root;
    if (!documentRef || !target) throw new Error('3D interpolation editor needs a document target.');
    root = createDomElement(documentRef, 'section', {
      className: 'selector-shell interpolation-3d-editor',
      hidden: true,
      role: 'dialog',
      'aria-modal': 'true',
      tabindex: '-1',
      'aria-label': '3D interpolation editor'
    }, [
      createDomElement(documentRef, 'div', { className: 'interpolation-3d-editor-header' }, [
        createDomElement(documentRef, 'div', {}, [
          createDomElement(documentRef, 'h2', { text: '3D interpolation' }),
          createDomElement(documentRef, 'p', {
            className: 'interpolation-3d-editor-subtitle',
            text: 'Preview Face patches, shared boundaries, and deterministic cuts.'
          })
        ]),
        createDomElement(documentRef, 'button', {
          className: 'interpolation-3d-editor-close',
          type: 'button',
          text: '×',
          title: 'Close 3D interpolation editor',
          'aria-label': 'Close 3D interpolation editor',
          'data-selector-initial-focus': '',
          onClick: close
        })
      ]),
      createDomElement(documentRef, 'div', { className: 'interpolation-3d-editor-controls' }, [
        createDomElement(documentRef, 'label', { text: 'Face' }, [
          faceSelect = createDomElement(documentRef, 'select', {
            'aria-label': 'Face to preview',
            onChange: () => {
              selectedFaceId = faceSelect.value;
              render();
            }
          })
        ]),
        createDomElement(documentRef, 'label', { text: 'Continuity target' }, [
          continuitySelect = createDomElement(documentRef, 'select', {
            'aria-label': 'Continuity target',
            onChange: render
          }, [
            createDomElement(documentRef, 'option', { value: 'G0', text: 'G0 — position' }),
            createDomElement(documentRef, 'option', { value: 'G1', text: 'G1 — tangent plane' }),
            createDomElement(documentRef, 'option', { value: 'G2', text: 'G2 — curvature' })
          ])
        ]),
        createDomElement(documentRef, 'button', {
          className: 'interpolation-3d-editor-fit',
          type: 'button',
          text: 'Fit',
          onClick: () => {
            camera.zoom = 1;
            render();
          }
        })
      ]),
      canvas = createDomElement(documentRef, 'canvas', {
        className: 'interpolation-3d-editor-canvas',
        width: 860,
        height: 540,
        'aria-label': '3D interpolation preview'
      }),
      status = createDomElement(documentRef, 'p', {
        className: 'interpolation-3d-editor-status',
        'aria-live': 'polite'
      })
    ]);
    target.append(root);
    inputCapabilities = applyInputCapabilities(root, documentRef.defaultView || globalThis);
    dialogLifecycle = createDialogLifecycle({ root, documentRef, onEscape: close });
    installCanvasHandlers();
    return root;
  }

  function installCanvasHandlers() {
    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      canvas.setPointerCapture?.(event.pointerId);
      drag = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      camera.yaw += (event.clientX - drag.x) * 0.01;
      camera.pitch = clamp(camera.pitch + (event.clientY - drag.y) * 0.01, -1.45, 1.45);
      drag = { x: event.clientX, y: event.clientY };
      render();
    });
    const release = () => { drag = null; };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      camera.zoom = clamp(camera.zoom * Math.exp(-event.deltaY * 0.001), 0.2, 8);
      render();
    }, { passive: false });
  }

  function open() {
    mount();
    dialogLifecycle.open();
    refresh();
  }

  function close() {
    drag = null;
    dialogLifecycle?.close();
    onClose();
  }

  function refresh() {
    try {
      model = createInterpolation3dModel(getTopology());
      populateFaceSelect();
      render();
    } catch (error) {
      model = null;
      if (status) status.textContent = `3D interpolation unavailable: ${error.message}`;
      clearCanvas();
    }
  }

  function populateFaceSelect() {
    if (!faceSelect || !model) return;
    faceSelect.replaceChildren(...model.faces.map((face, index) => createDomElement(documentRef, 'option', {
      value: face.id,
      text: `Face ${index + 1} — ${face.domain}`
    })));
    if (!model.faces.some(({ id }) => id === selectedFaceId)) selectedFaceId = model.faces[0]?.id || '';
    faceSelect.value = selectedFaceId;
  }

  function render() {
    if (!canvas || !model) {
      clearCanvas();
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#090d14';
    context.fillRect(0, 0, width, height);
    const projected = model.points.map((point) => project(point, width, height));
    const triangles = model.faces.flatMap((face, faceIndex) => face.surfaceTriangles.map((triangle) => ({
      face,
      faceIndex,
      worldPoints: triangle,
      points: triangle.map((point) => project(point, width, height)),
      depth: triangle.reduce((sum, point) => sum + project(point, width, height)[2], 0) / 3
    }))).sort((left, right) => left.depth - right.depth);
    for (const triangle of triangles) drawTriangle(context, triangle);
    for (const face of model.faces) {
      const points = face.boundary.map((point) => project(point, width, height)).filter(Boolean);
      if (points.length < 3) continue;
      context.beginPath();
      points.forEach((point, index) => index ? context.lineTo(point[0], point[1]) : context.moveTo(point[0], point[1]));
      context.closePath();
      context.strokeStyle = face.id === selectedFaceId ? '#f8fafc' : 'rgba(226,232,240,0.58)';
      context.lineWidth = face.id === selectedFaceId ? 3 : 1.4;
      context.stroke();
    }
    for (const point of projected) {
      context.fillStyle = '#f8fafc';
      context.beginPath();
      context.arc(point[0], point[1], 3.5, 0, Math.PI * 2);
      context.fill();
    }
    const selected = model.face(selectedFaceId);
    if (status) status.textContent = selected
      ? `${model.faces.length} Face${model.faces.length === 1 ? '' : 's'} · ${selected.cuts.length} boundary cuts · ${continuitySelect?.value || 'G0'} preview`
      : 'No 3D Faces in the current topology.';
  }

  function drawTriangle(context, triangle) {
    const selected = triangle.face.id === selectedFaceId;
    const color = FACE_COLORS[triangle.faceIndex % FACE_COLORS.length];
    const light = surfaceLightIntensity(triangle.worldPoints, [0.35, 0.55, 1]);
    context.beginPath();
    triangle.points.forEach((point, index) => index ? context.lineTo(point[0], point[1]) : context.moveTo(point[0], point[1]));
    context.closePath();
    context.fillStyle = shadeHex(color, light, selected ? 0.72 : 0.36);
    context.fill();
    context.strokeStyle = selected ? `rgba(248,250,252,${0.45 + light * 0.35})` : `rgba(226,232,240,${0.12 + light * 0.16})`;
    context.lineWidth = selected ? 1.2 : 0.7;
    context.stroke();
  }

  function project(point, width, height) {
    const center = model.bounds.center;
    let x = point[0] - center[0];
    let y = point[1] - center[1];
    let z = point[2] - center[2];
    const cosYaw = Math.cos(camera.yaw);
    const sinYaw = Math.sin(camera.yaw);
    const rotatedX = x * cosYaw - z * sinYaw;
    z = x * sinYaw + z * cosYaw;
    const cosPitch = Math.cos(camera.pitch);
    const sinPitch = Math.sin(camera.pitch);
    const rotatedY = y * cosPitch - z * sinPitch;
    const depth = y * sinPitch + z * cosPitch;
    const scale = Math.min(canvas.width, canvas.height) * 0.42 * camera.zoom / Math.max(model.bounds.radius, 1e-6);
    return [width / 2 + rotatedX * scale, height / 2 - rotatedY * scale, depth];
  }

  function clearCanvas() {
    const context = canvas?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#090d14';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  function destroy() {
    dialogLifecycle?.destroy();
    inputCapabilities?.destroy();
    root?.remove();
    root = null;
    canvas = null;
    faceSelect = null;
    continuitySelect = null;
    status = null;
    model = null;
    dialogLifecycle = null;
    inputCapabilities = null;
  }

  return Object.freeze({ mount, open, close, refresh, destroy });
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function shadeHex(hex, intensity, alpha) {
  const value = String(hex || '#94a3b8').replace('#', '');
  const red = parseInt(value.slice(0, 2), 16) || 0;
  const green = parseInt(value.slice(2, 4), 16) || 0;
  const blue = parseInt(value.slice(4, 6), 16) || 0;
  const scale = 0.45 + clamp(intensity, 0, 1) * 0.75;
  return `rgba(${Math.round(red * scale)},${Math.round(green * scale)},${Math.round(blue * scale)},${alpha})`;
}
