// interpolation-editor.js
import * as C from './constants.js';
import { applyInputCapabilities, createDialogLifecycle } from 'selector';

const DEFAULT_STYLE = {
    id: null,
    preset: 'closed',
    type: 'spline',
    mode: 'piecewise',
    order: 3,
    tension: 0.5,
    radiusMode: 'absolute',
    radiusValue: 0.5,
    relRadiusValue: 0.5,
    absRadiusValue: 0.5,
    linearStyle: 'lines',
    linearArrowEndMode: 'radius',
    linearArrowMode: 'absolute',
    linearArrowRelativeMode: 'end',
    linearArrowRelativeValue: 0,
    linearArrowAbsoluteMode: 'dist',
    linearArrowAbsoluteValue: 1,
    nurbsDegree: 3,
    pointHandling: 'anchor',
    smoothingAmount: 0.5,
    smoothingQuality: 1,
    nurbsMixedSide: 'left',
    fractalPointCount: 2,
    fractalControlPoints: [
        { u: 0.33, v: 1 / 3 },
        { u: 0.66, v: -(1 / 3) }
    ]
};

const MAX_ABS_RADIUS = 500;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const clampRange = (value, min, max) => Math.max(min, Math.min(max, value));
const clampAbsRadius = (value) => Math.max(0, Math.min(MAX_ABS_RADIUS, value));
const absSliderToRadius = (sliderValue) => {
    const clamped = clamp01(Number(sliderValue) || 0);
    return clamped * clamped * MAX_ABS_RADIUS;
};
const absRadiusToSlider = (radiusValue) => {
    const clamped = clampAbsRadius(Number(radiusValue) || 0);
    return Math.sqrt(clamped / MAX_ABS_RADIUS);
};

const PRESET_DEFS = [
    { id: 'closed', label: 'Closed' },
    { id: 'open', label: 'Open' },
    { id: 'figure8', label: 'Figure 8' },
    { id: 'branching', label: 'Branching' },
    { id: 'branching4', label: 'Branching (4)' },
    { id: 'branching5', label: 'Branching (5)' }
];

const ORDER_OPTIONS = [
    { value: 1, label: 'Linear', note: 'C0' },
    { value: 3, label: 'Cubic', note: 'C2' }
];

const TYPE_OPTIONS = [
    { id: 'linear', label: 'Linear' },
    { id: 'spline', label: 'Spline' },
    { id: 'radius', label: 'Radius' },
    { id: 'smoothing', label: 'Smoothing' },
    { id: 'fractal', label: 'Fractal' }
];

const ENGINE_INTERPOLATION_ENABLED = true;
const PREVIEW_SAMPLES_PER_SEGMENT = 80;
const FRACTAL_MIN_SEGMENT_PX = 5;
const FRACTAL_V_LIMIT = 1 / 3;

export default class InterpolationEditor {
    constructor(options = {}) {
        this.container = options.container || document.body;
        this.onSelect = options.onSelect || (() => {});
        this.engineWasmApi = options.engineWasmApi || null;
        this.state = {
            style: this._createStyle(),
            previewPoints: this._createDefaultPresetPoints()
        };

        this.wrapper = null;
        this.elements = {};
        this.previewCards = new Map();
        this.dragState = { presetId: null, pathIndex: null, pointIndex: null, vertexIndex: null, ioType: null, ioIndex: null };
        this.branching4Pairing = null;
        this.engineInterpolation = null;
        this.fractalDragIndex = null;
        this.fractalSnapFractions = [];
        this.fractalUSnapGrid = this._buildFractalUSnapGrid();
        this.fractalVSnapGrid = this._buildFractalVSnapGrid();
        this._renderThrottleMs = 33;
        this._renderThrottleTimer = null;
        this._pendingRenderAll = false;
        this._pendingRenderPresets = new Set();
        this.inputCapabilities = null;
        this.dialogLifecycle = null;
        this.activePointerId = null;
        this.fractalPointerId = null;
    }

    initialize() {
        if (this.wrapper) return;
        this._initializeDOM();
        this.inputCapabilities = applyInputCapabilities(this.wrapper, window);
        this.dialogLifecycle = createDialogLifecycle({
            root: this.wrapper,
            documentRef: document,
            onEscape: () => this.hide()
        });
        this._setupEventListeners();
        this._initEngineInterpolationBridge();
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    show(styleToEdit = null) {
        this.state.style = this._normalizeStyle(styleToEdit);
        this._updateUIFromState();
        this.dialogLifecycle.open();
        requestAnimationFrame(() => {
            this._renderAllPreviews();
        });
    }

    hide() {
        this.dialogLifecycle?.close();
    }

    _createStyle() {
        const fractalControlPoints = (DEFAULT_STYLE.fractalControlPoints || []).map((pt) => ({
            u: pt.u,
            v: pt.v
        }));
        return {
            ...DEFAULT_STYLE,
            fractalControlPoints,
            id: `style_${Date.now()}`
        };
    }

    _normalizeStyle(style) {
        const base = this._createStyle();
        if (!style) return base;
        const incomingNurbsPointMode = style.nurbsPointMode ?? style.nurbs_point_mode;
        const incomingNurbsMixedRule = style.nurbsMixedRule ?? style.nurbs_mixed_rule;
        const incomingNurbsSide = style.nurbsMixedSide ?? style.nurbsSide ?? style.nurbs_side;
        const requestedOrder = Number(style.order);
        const order = requestedOrder === 3 ? 3 : 1;
        let inferredType = style.type === 'px_radius' ? 'abs_radius' : style.type;
        let normalizedRadiusMode = style.radiusMode === 'fixed' ? 'absolute' : style.radiusMode;
        let inferredHandling = style.pointHandling;
        let inferredNurbsMixedSide = incomingNurbsSide || base.nurbsMixedSide;
        if (incomingNurbsMixedRule === 'convex_control_concave_anchor') {
            inferredNurbsMixedSide = 'right';
        } else if (incomingNurbsMixedRule === 'convex_anchor_concave_control') {
            inferredNurbsMixedSide = 'left';
        }
        if (inferredType === 'cubic_spline') {
            inferredType = 'spline';
            inferredHandling = 'anchor';
        } else if (inferredType === 'circular_arc') {
            inferredType = 'radius';
        } else if (inferredType === 'smoothing') {
            inferredType = 'smoothing';
            inferredHandling = inferredHandling || 'control';
        } else if (inferredType === 'fractal') {
            inferredType = 'fractal';
        } else if (inferredType === 'linear') {
            inferredType = 'linear';
        }
        if (inferredType === 'catmull') {
            inferredType = 'spline';
            inferredHandling = 'anchor';
        } else if (inferredType === 'nurbs') {
            inferredType = 'spline';
            inferredHandling = incomingNurbsPointMode === 'mixed' ? 'mixed' : 'control';
        } else if (inferredType === 'rel_radius') {
            inferredType = 'radius';
            normalizedRadiusMode = 'relative';
        } else if (inferredType === 'abs_radius') {
            inferredType = 'radius';
            normalizedRadiusMode = 'absolute';
        }
        const relRadiusValue = style.relRadiusValue
            ?? (normalizedRadiusMode === 'relative' ? clamp01(style.radiusValue) : base.relRadiusValue);
        const absRadiusValue = style.absRadiusValue
            ?? (normalizedRadiusMode === 'absolute' ? absRadiusToSlider(style.radiusValue) : base.absRadiusValue);
        const radiusValue = normalizedRadiusMode === 'relative'
            ? relRadiusValue
            : absSliderToRadius(absRadiusValue);
        const hasExplicitArrowControls = style.linearArrowMode !== undefined
            || style.linearArrowRelativeMode !== undefined
            || style.linearArrowRelativeValue !== undefined
            || style.linearArrowAbsoluteMode !== undefined
            || style.linearArrowAbsoluteValue !== undefined;
        let linearArrowMode = style.linearArrowMode === 'absolute' ? 'absolute' : 'relative';
        let linearArrowRelativeMode = style.linearArrowRelativeMode === 'over' ? 'over' : 'end';
        let linearArrowRelativeValue = clamp01(Number(style.linearArrowRelativeValue ?? base.linearArrowRelativeValue));
        let linearArrowAbsoluteMode = style.linearArrowAbsoluteMode === 'length' ? 'length' : 'dist';
        let linearArrowAbsoluteValueRaw = Number(style.linearArrowAbsoluteValue ?? base.linearArrowAbsoluteValue);
        if (!Number.isFinite(linearArrowAbsoluteValueRaw)) {
            linearArrowAbsoluteValueRaw = base.linearArrowAbsoluteValue;
        }
        let linearArrowAbsoluteValue = linearArrowAbsoluteMode === 'length'
            ? clampRange(linearArrowAbsoluteValueRaw, 1, 5)
            : clampRange(linearArrowAbsoluteValueRaw, 0, 4);
        if (!hasExplicitArrowControls) {
            if (style.linearArrowEndMode === 'endpoint') {
                linearArrowMode = 'relative';
                linearArrowRelativeMode = 'end';
                linearArrowRelativeValue = 0;
            } else if (style.linearArrowEndMode === '2radius') {
                linearArrowMode = 'absolute';
                linearArrowAbsoluteMode = 'dist';
                linearArrowAbsoluteValue = 2;
            } else if (style.linearArrowEndMode === 'radius') {
                linearArrowMode = 'absolute';
                linearArrowAbsoluteMode = 'dist';
                linearArrowAbsoluteValue = 1;
            }
        }
        if (!inferredType) {
            if (style.mode === 'radius') {
                inferredType = 'radius';
            } else if (order === 3 && style.tension !== undefined) {
                inferredType = 'spline';
                inferredHandling = 'anchor';
            } else if (order === 3) {
                inferredType = 'spline';
            } else {
                inferredType = 'spline';
                inferredHandling = 'anchor';
            }
        }
        let resolvedHandling = inferredHandling ?? style.pointHandling ?? base.pointHandling;
        if (inferredType === 'linear') {
            resolvedHandling = 'anchor';
        } else if (inferredType === 'radius') {
            resolvedHandling = resolvedHandling === 'mixed' ? 'mixed' : 'control';
        } else if (inferredType === 'smoothing') {
            if (!['anchor', 'control', 'mixed'].includes(resolvedHandling)) {
                resolvedHandling = 'control';
            }
        } else if (inferredType === 'spline') {
            if (!['anchor', 'control', 'mixed'].includes(resolvedHandling)) {
                resolvedHandling = 'anchor';
            }
        }
        const fractalPointCount = Math.max(1, Math.min(3, Math.round(Number(style.fractalPointCount ?? base.fractalPointCount))));
        const smoothingAmount = clamp01(Number(style.smoothingAmount ?? base.smoothingAmount));
        const smoothingQuality = Math.max(1, Math.min(5, Math.round(Number(style.smoothingQuality ?? base.smoothingQuality))));
        const fractalControlPoints = this._normalizeFractalControlPoints(
            style.fractalControlPoints ?? base.fractalControlPoints,
            fractalPointCount
        );
        return {
            ...base,
            ...style,
            id: style.id || base.id,
            preset: style.preset || base.preset,
            order,
            type: inferredType || base.type,
            radiusMode: normalizedRadiusMode || base.radiusMode,
            radiusValue,
            relRadiusValue,
            absRadiusValue,
            linearStyle: style.linearStyle || base.linearStyle,
            linearArrowEndMode: style.linearArrowEndMode || base.linearArrowEndMode,
            linearArrowMode,
            linearArrowRelativeMode,
            linearArrowRelativeValue,
            linearArrowAbsoluteMode,
            linearArrowAbsoluteValue,
            nurbsDegree: style.nurbsDegree || base.nurbsDegree,
            pointHandling: resolvedHandling,
            smoothingAmount,
            smoothingQuality,
            nurbsMixedSide: inferredNurbsMixedSide === 'right' ? 'right' : 'left',
            fractalPointCount,
            fractalControlPoints
        };
    }

    _defaultFractalControlPoints(count) {
        if (count === 1) return [{ u: 0.5, v: FRACTAL_V_LIMIT }];
        if (count === 3) {
            return [
                { u: 0.25, v: FRACTAL_V_LIMIT },
                { u: 0.5, v: -FRACTAL_V_LIMIT },
                { u: 0.75, v: FRACTAL_V_LIMIT }
            ];
        }
        return [
            { u: 0.33, v: FRACTAL_V_LIMIT },
            { u: 0.66, v: -FRACTAL_V_LIMIT }
        ];
    }

    _normalizeFractalControlPoints(points, count) {
        const defaults = this._defaultFractalControlPoints(count);
        const src = Array.isArray(points) ? points : defaults;
        const out = src.slice(0, count).map((pt, idx) => ({
            u: Math.max(0.05, Math.min(0.95, Number(pt?.u ?? defaults[idx]?.u ?? ((idx + 1) / (count + 1))))),
            v: Math.max(-FRACTAL_V_LIMIT, Math.min(FRACTAL_V_LIMIT, Number(pt?.v ?? defaults[idx]?.v ?? 0)))
        }));
        while (out.length < count) {
            const idx = out.length;
            out.push({
                u: defaults[idx]?.u ?? ((idx + 1) / (count + 1)),
                v: defaults[idx]?.v ?? 0
            });
        }
        return out;
    }

    _gcd(a, b) {
        let x = Math.abs(a);
        let y = Math.abs(b);
        while (y !== 0) {
            const t = x % y;
            x = y;
            y = t;
        }
        return x || 1;
    }

    _buildFractalUSnapGrid() {
        const unique = new Map();
        for (let m = 1; m <= 8; m++) {
            for (let n = 1; n <= 8; n++) {
                if (n >= m) continue;
                const g = this._gcd(n, m);
                const num = n / g;
                const den = m / g;
                const key = `${num}/${den}`;
                if (!unique.has(key)) {
                    unique.set(key, {
                        u: num / den,
                        num,
                        den
                    });
                }
            }
        }
        return Array.from(unique.values()).sort((a, b) => a.u - b.u);
    }

    _snapFractalU(rawU, minU = 0.05, maxU = 0.95) {
        const candidates = this.fractalUSnapGrid.filter((c) => c.u >= minU - 1e-9 && c.u <= maxU + 1e-9);
        let best = candidates[0] || { u: Math.max(minU, Math.min(maxU, rawU)), num: 0, den: 1 };
        let bestDist = Math.abs(rawU - best.u);
        for (let i = 1; i < candidates.length; i++) {
            const candidate = candidates[i];
            const dist = Math.abs(rawU - candidate.u);
            if (dist < bestDist) {
                best = candidate;
                bestDist = dist;
            }
        }
        return best;
    }

    _buildFractalVSnapGrid() {
        const unique = new Map();
        unique.set('0/1', { v: 0, num: 0, den: 1 });
        for (let den = 1; den <= 8; den++) {
            for (let num = -8; num <= 8; num++) {
                const value = num / den;
                if (Math.abs(value) > FRACTAL_V_LIMIT + 1e-12) continue;
                const g = this._gcd(num, den);
                const rNum = num / g;
                const rDen = den / g;
                const key = `${rNum}/${rDen}`;
                if (!unique.has(key)) {
                    unique.set(key, { v: rNum / rDen, num: rNum, den: rDen });
                }
            }
        }
        return Array.from(unique.values()).sort((a, b) => a.v - b.v);
    }

    _snapFractalV(rawV) {
        let best = this.fractalVSnapGrid[0] || { v: rawV, num: 0, den: 1 };
        let bestDist = Math.abs(rawV - best.v);
        for (let i = 1; i < this.fractalVSnapGrid.length; i++) {
            const candidate = this.fractalVSnapGrid[i];
            const dist = Math.abs(rawV - candidate.v);
            if (dist < bestDist) {
                best = candidate;
                bestDist = dist;
            }
        }
        return best;
    }

    _createDefaultPresetPoints() {
        const branchJunction = { x: 0.6, y: 0.25 };
        const branch4Junction = { x: 0.55, y: 0.45 };
        const branch5Junction = { x: 0.55, y: 0.5 };
        const closedVertices = [
            { x: 0.2, y: 0.2 },
            { x: 0.8, y: 0.25 },
            { x: 0.7, y: 0.6 },
            { x: 0.5, y: 0.45 },
            { x: 0.3, y: 0.75 }
        ];
        const openVertices = [
            { x: 0.05, y: 0.8 },
            { x: 0.25, y: 0.4 },
            { x: 0.45, y: 0.7 },
            { x: 0.65, y: 0.2 },
            { x: 0.85, y: 0.55 }
        ];
        const figure8Vertices = [
            { x: 0.72, y: 0.5 },
            { x: 0.61, y: 0.31 },
            { x: 0.39, y: 0.31 },
            { x: 0.28, y: 0.5 },
            { x: 0.39, y: 0.69 },
            { x: 0.61, y: 0.69 },
            { x: 0.5, y: 0.5 }
        ];
        return {
            closed: {
                vertices: closedVertices,
                edges: closedVertices.map((_, idx) => [idx, (idx + 1) % closedVertices.length])
            },
            open: {
                vertices: openVertices,
                edges: openVertices.slice(0, -1).map((_, idx) => [idx, idx + 1])
            },
            figure8: {
                vertices: figure8Vertices,
                edges: [
                    [0, 1],
                    [1, 2],
                    [2, 3],
                    [3, 4],
                    [4, 5],
                    [5, 0],
                    [0, 6],
                    [6, 3]
                ],
                faces: [
                    [0, 1, 2, 3, 4, 5]
                ]
            },
            branching: [
                [
                    { x: 0.1, y: 0.85 },
                    { x: 0.3, y: 0.6 },
                    { x: 0.5, y: 0.4 },
                    branchJunction
                ],
                [
                    branchJunction,
                    { x: 0.75, y: 0.15 },
                    { x: 0.9, y: 0.1 }
                ],
                [
                    branchJunction,
                    { x: 0.75, y: 0.35 },
                    { x: 0.9, y: 0.45 }
                ]
            ],
            branching4: {
                in: [
                    [
                        { x: 0.12, y: 0.15 },
                        { x: 0.32, y: 0.3 },
                        branch4Junction
                    ],
                    [
                        { x: 0.18, y: 0.75 },
                        { x: 0.35, y: 0.58 },
                        branch4Junction
                    ]
                ],
                out: [
                    [
                        branch4Junction,
                        { x: 0.75, y: 0.25 },
                        { x: 0.92, y: 0.2 }
                    ],
                    [
                        branch4Junction,
                        { x: 0.75, y: 0.6 },
                        { x: 0.9, y: 0.72 }
                    ]
                ]
            },
            branching5: {
                in: [
                    [
                        { x: 0.1, y: 0.25 },
                        { x: 0.32, y: 0.38 },
                        branch5Junction
                    ],
                    [
                        { x: 0.18, y: 0.8 },
                        { x: 0.35, y: 0.64 },
                        branch5Junction
                    ]
                ],
                out: [
                    [
                        branch5Junction,
                        { x: 0.78, y: 0.25 },
                        { x: 0.92, y: 0.2 }
                    ],
                    [
                        branch5Junction,
                        { x: 0.78, y: 0.5 },
                        { x: 0.92, y: 0.52 }
                    ],
                    [
                        branch5Junction,
                        { x: 0.78, y: 0.78 },
                        { x: 0.9, y: 0.85 }
                    ]
                ]
            }
        };
    }

    _initializeDOM() {
        const createEl = (tag, options = {}) => {
            const el = document.createElement(tag);
            if (options.id) {
                el.id = options.id;
                const camelCaseId = options.id.replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
                this.elements[camelCaseId] = el;
            }
            if (options.className) el.className = options.className;
            if (options.text) el.textContent = options.text;
            if (options.type) el.type = options.type;
            if (options.value !== undefined) el.value = options.value;
            if (options.attrs) {
                Object.entries(options.attrs).forEach(([key, value]) => el.setAttribute(key, value));
            }
            return el;
        };

        this.wrapper = createEl('div', {
            id: 'interpolation-editor-wrapper',
            className: 'selector-shell interpolation-editor-container',
            attrs: {
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': 'Interpolation selector',
                tabindex: '-1',
                hidden: ''
            }
        });

        const layout = createEl('div', { className: 'selector-grid interpolation-editor-layout' });

        const previewPanel = createEl('div', { className: 'selector-panel editor-panel preview-panel' });
        previewPanel.append(createEl('div', { className: 'selector-panel-header panel-header', text: 'Preview Presets' }));
        const previewList = createEl('div', { className: 'preview-list' });

        PRESET_DEFS.forEach(preset => {
            const card = createEl('button', { className: 'preview-card', attrs: { 'data-preset': preset.id, type: 'button' } });
            const label = createEl('div', { className: 'preview-card-label', text: preset.label });
            const canvas = createEl('canvas', { className: 'preview-card-canvas' });
            card.append(canvas, label);
            previewList.append(card);
            this.previewCards.set(preset.id, { card, canvas });
        });
        previewPanel.append(previewList);

        const typePanel = createEl('div', { className: 'selector-panel editor-panel type-panel' });
        typePanel.append(createEl('div', { className: 'selector-panel-header panel-header', text: 'Interpolation Type' }));
        const typeList = createEl('div', { className: 'toggle-stack', id: 'type-list' });
        TYPE_OPTIONS.forEach(option => {
            const button = createEl('button', {
                className: 'toggle-row',
                text: option.label,
                attrs: { 'data-type': option.id, type: 'button' }
            });
            typeList.append(button);
        });
        typePanel.append(typeList);

        const paramsPanel = createEl('div', { className: 'selector-panel editor-panel params-panel' });
        paramsPanel.append(createEl('div', { className: 'selector-panel-header panel-header', text: 'Parameters' }));
        const tensionSection = createEl('div', { className: 'param-section', id: 'tension-section' });
        tensionSection.append(createEl('div', { className: 'section-caption', text: 'Catmull-Rom tension.' }));
        const tensionRow = createEl('div', { className: 'param-row' });
        this.elements.tensionSlider = createEl('input', { id: 'tension-slider', type: 'range', attrs: { min: '0', max: '1', step: '0.01' } });
        this.elements.tensionInput = createEl('input', { id: 'tension-input', type: 'number', attrs: { min: '0', max: '1', step: '0.01' } });
        tensionRow.append(this.elements.tensionSlider, this.elements.tensionInput);
        tensionSection.append(tensionRow);

        const linearSection = createEl('div', { className: 'param-section', id: 'linear-section' });
        linearSection.append(createEl('div', { className: 'section-caption', text: 'Linear marker style.' }));
        const linearRow = createEl('div', { className: 'param-row' });
        const linearToggle = createEl('div', { className: 'toggle-group', id: 'linear-style-toggle' });
        linearToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Lines', attrs: { 'data-linear-style': 'lines', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Arrows', attrs: { 'data-linear-style': 'arrows', type: 'button' } })
        );
        linearRow.append(linearToggle);
        linearSection.append(linearRow);

        const arrowEndSection = createEl('div', { className: 'param-section', id: 'arrow-end-section' });
        arrowEndSection.append(createEl('div', { className: 'section-caption', text: 'Arrow placement.' }));
        const arrowSwitchesRow = createEl('div', { className: 'param-row', id: 'arrow-switches-row' });
        const arrowModeToggle = createEl('div', { className: 'toggle-group', id: 'arrow-mode-toggle' });
        arrowModeToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Relative', attrs: { 'data-arrow-mode': 'relative', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Absolute', attrs: { 'data-arrow-mode': 'absolute', type: 'button' } })
        );
        arrowSwitchesRow.append(arrowModeToggle);
        const arrowRelativeRow = createEl('div', { id: 'arrow-relative-row' });
        const arrowRelativeToggle = createEl('div', { className: 'toggle-group', id: 'arrow-relative-toggle' });
        arrowRelativeToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Over', attrs: { 'data-arrow-relative-mode': 'over', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'End', attrs: { 'data-arrow-relative-mode': 'end', type: 'button' } })
        );
        arrowRelativeRow.append(arrowRelativeToggle);
        arrowSwitchesRow.append(arrowRelativeRow);
        const arrowAbsoluteRow = createEl('div', { id: 'arrow-absolute-row' });
        const arrowAbsoluteToggle = createEl('div', { className: 'toggle-group', id: 'arrow-absolute-toggle' });
        arrowAbsoluteToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Length', attrs: { 'data-arrow-absolute-mode': 'length', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Dist', attrs: { 'data-arrow-absolute-mode': 'dist', type: 'button' } })
        );
        arrowAbsoluteRow.append(arrowAbsoluteToggle);
        arrowSwitchesRow.append(arrowAbsoluteRow);
        arrowEndSection.append(arrowSwitchesRow);
        const arrowValueRow = createEl('div', { className: 'param-row', id: 'arrow-value-row' });
        this.elements.arrowValueSlider = createEl('input', { id: 'arrow-value-slider', type: 'range', attrs: { min: '0', max: '1', step: '0.01' } });
        this.elements.arrowValueUnit = createEl('span', { id: 'arrow-value-unit', text: 'r' });
        this.elements.arrowValueInput = createEl('input', { id: 'arrow-value-input', type: 'number', attrs: { min: '0', max: '1', step: '0.01' } });
        arrowValueRow.append(this.elements.arrowValueSlider, this.elements.arrowValueUnit, this.elements.arrowValueInput);
        arrowEndSection.append(arrowValueRow);

        const handlingSection = createEl('div', { className: 'param-section', id: 'handling-section' });
        handlingSection.append(createEl('div', { className: 'section-caption', text: 'Point handling mode.' }));
        const handlingRow = createEl('div', { className: 'param-row' });
        const handlingToggle = createEl('div', { className: 'toggle-group', id: 'point-handling-toggle' });
        handlingToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Control', attrs: { 'data-point-handling': 'control', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Anchor', attrs: { 'data-point-handling': 'anchor', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Mixed', attrs: { 'data-point-handling': 'mixed', type: 'button' } })
        );
        handlingRow.append(handlingToggle);
        handlingSection.append(handlingRow);

        const radiusSection = createEl('div', { className: 'param-section', id: 'radius-section' });
        radiusSection.append(createEl('div', { className: 'section-caption', text: 'Clamped to half each adjacent edge.' }));
        const radiusRow = createEl('div', { className: 'param-row' });
        this.elements.radiusSlider = createEl('input', { id: 'radius-slider', type: 'range', attrs: { min: '0', max: '1', step: '0.01' } });
        this.elements.radiusInput = createEl('input', { id: 'radius-input', type: 'number', attrs: { min: '0', max: '1', step: '0.01' } });
        radiusRow.append(this.elements.radiusSlider, this.elements.radiusInput);
        radiusSection.append(radiusRow);
        const radiusModeToggle = createEl('div', { className: 'toggle-group', id: 'radius-mode-toggle' });
        radiusModeToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Relative', attrs: { 'data-radius-mode': 'relative', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Absolute', attrs: { 'data-radius-mode': 'absolute', type: 'button' } })
        );
        radiusSection.append(radiusModeToggle);

        const smoothingSection = createEl('div', { className: 'param-section', id: 'smoothing-section' });
        smoothingSection.append(createEl('div', { className: 'section-caption', text: 'Smoothing amount (0 = none, 1 = 1/3 on each side).' }));
        const smoothingRow = createEl('div', { className: 'param-row' });
        this.elements.smoothingSlider = createEl('input', { id: 'smoothing-slider', type: 'range', attrs: { min: '0', max: '1', step: '0.01' } });
        this.elements.smoothingInput = createEl('input', { id: 'smoothing-input', type: 'number', attrs: { min: '0', max: '1', step: '0.01' } });
        smoothingRow.append(this.elements.smoothingSlider, this.elements.smoothingInput);
        smoothingSection.append(smoothingRow);
        const smoothingQualityRow = createEl('div', { className: 'param-row' });
        const smoothingQualityToggle = createEl('div', { className: 'toggle-group', id: 'smoothing-quality-toggle' });
        smoothingQualityToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Fast', attrs: { 'data-smoothing-quality': '1', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Balanced', attrs: { 'data-smoothing-quality': '2', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Full', attrs: { 'data-smoothing-quality': '5', type: 'button' } })
        );
        smoothingQualityRow.append(smoothingQualityToggle);
        smoothingSection.append(smoothingQualityRow);

        const nurbsSection = createEl('div', { className: 'param-section', id: 'nurbs-section' });
        nurbsSection.append(createEl('div', { className: 'section-caption', text: 'NURBS degree.' }));
        const nurbsRow = createEl('div', { className: 'param-row' });
        this.elements.nurbsDegreeSlider = createEl('input', { id: 'nurbs-degree-slider', type: 'range', attrs: { min: '2', max: '5', step: '1' } });
        this.elements.nurbsDegreeInput = createEl('input', { id: 'nurbs-degree-input', type: 'number', attrs: { min: '2', max: '5', step: '1' } });
        nurbsRow.append(this.elements.nurbsDegreeSlider, this.elements.nurbsDegreeInput);
        nurbsSection.append(nurbsRow);
        const nurbsSideSection = createEl('div', { className: 'param-section', id: 'nurbs-side-section' });
        nurbsSideSection.append(createEl('div', { className: 'section-caption', text: 'Mixed side (along point index direction).' }));
        const nurbsSideRow = createEl('div', { className: 'param-row' });
        const nurbsSideToggle = createEl('div', { className: 'toggle-group', id: 'nurbs-side-toggle' });
        nurbsSideToggle.append(
            createEl('button', { className: 'toggle-button', text: 'Left', attrs: { 'data-nurbs-mixed-side': 'left', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: 'Right', attrs: { 'data-nurbs-mixed-side': 'right', type: 'button' } })
        );
        nurbsSideRow.append(nurbsSideToggle);
        nurbsSideSection.append(nurbsSideRow);
        nurbsSection.append(nurbsSideSection);

        const fractalSection = createEl('div', { className: 'param-section', id: 'fractal-section' });
        fractalSection.append(createEl('div', { className: 'section-caption', text: 'Fractal generator (drag interior points).' }));
        const fractalCountRow = createEl('div', { className: 'param-row' });
        const fractalCountToggle = createEl('div', { className: 'toggle-group', id: 'fractal-count-toggle' });
        fractalCountToggle.append(
            createEl('button', { className: 'toggle-button', text: '1', attrs: { 'data-fractal-count': '1', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: '2', attrs: { 'data-fractal-count': '2', type: 'button' } }),
            createEl('button', { className: 'toggle-button', text: '3', attrs: { 'data-fractal-count': '3', type: 'button' } })
        );
        fractalCountRow.append(fractalCountToggle);
        fractalSection.append(fractalCountRow);
        const fractalCanvasRow = createEl('div', { className: 'param-row' });
        const fractalCanvasWrap = createEl('div', { id: 'fractal-canvas-wrap' });
        fractalCanvasWrap.style.position = 'relative';
        fractalCanvasWrap.style.width = '100%';
        fractalCanvasWrap.style.overflow = 'visible';
        this.elements.fractalCanvas = createEl('canvas', { id: 'fractal-canvas', attrs: { width: '240', height: '72' } });
        this.elements.fractalCanvas.style.width = '100%';
        this.elements.fractalCanvas.style.height = '72px';
        this.elements.fractalCanvas.style.border = '1px solid rgba(148, 163, 184, 0.35)';
        this.elements.fractalCanvas.style.borderRadius = '4px';
        this.elements.fractalSnapLabels = createEl('div', { id: 'fractal-snap-labels' });
        this.elements.fractalSnapLabels.style.position = 'absolute';
        this.elements.fractalSnapLabels.style.left = '0';
        this.elements.fractalSnapLabels.style.top = '0';
        this.elements.fractalSnapLabels.style.width = '100%';
        this.elements.fractalSnapLabels.style.height = '100%';
        this.elements.fractalSnapLabels.style.pointerEvents = 'none';
        this.elements.fractalSnapLabels.style.overflow = 'visible';
        fractalCanvasWrap.append(this.elements.fractalCanvas, this.elements.fractalSnapLabels);
        fractalCanvasRow.append(fractalCanvasWrap);
        fractalSection.append(fractalCanvasRow);

        paramsPanel.append(linearSection, arrowEndSection, handlingSection, tensionSection, radiusSection, smoothingSection, nurbsSection, fractalSection);

        const actionsPanel = createEl('div', { className: 'selector-panel editor-panel actions-panel' });
        actionsPanel.append(createEl('div', { className: 'selector-panel-header panel-header', text: 'Actions' }));
        const buttonContainer = createEl('div', { className: 'button-container' });
        this.elements.closeButton = createEl('button', { id: 'close-button', className: 'selector-control close-button', text: 'Close', attrs: { type: 'button', 'data-selector-initial-focus': '' } });
        this.elements.selectButton = createEl('button', { id: 'select-button', className: 'selector-control select-button', text: 'Select', attrs: { type: 'button' } });
        buttonContainer.append(this.elements.closeButton, this.elements.selectButton);
        actionsPanel.append(buttonContainer);

        layout.append(previewPanel, typePanel, paramsPanel, actionsPanel);
        this.wrapper.append(layout);
        this.container.appendChild(this.wrapper);
    }

    _setupEventListeners() {
        window.addEventListener('resize', () => {
            if (this.wrapper && this.wrapper.style.display !== 'none') {
                this._renderAllPreviews();
            }
        });

        this.previewCards.forEach((cardInfo, preset) => {
            cardInfo.card.addEventListener('click', () => {
                this._setStyle({ preset });
            });
            cardInfo.canvas.addEventListener('pointerdown', (event) => {
                this._handlePreviewMouseDown(event, preset);
                if (this.dragState.presetId !== null) {
                    this.activePointerId = event.pointerId;
                    cardInfo.canvas.setPointerCapture?.(event.pointerId);
                }
            });
        });

        const typeList = this.wrapper.querySelector('#type-list');
        typeList.querySelectorAll('.toggle-row').forEach(button => {
            button.addEventListener('click', () => {
                this._applyTypeSelection(button.dataset.type);
            });
        });

        const linearStyleToggle = this.wrapper.querySelector('#linear-style-toggle');
        linearStyleToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._setStyle({ linearStyle: button.dataset.linearStyle });
            });
        });

        const arrowModeToggle = this.wrapper.querySelector('#arrow-mode-toggle');
        arrowModeToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._applyArrowMode(button.dataset.arrowMode);
            });
        });
        const arrowRelativeToggle = this.wrapper.querySelector('#arrow-relative-toggle');
        arrowRelativeToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._applyArrowRelativeMode(button.dataset.arrowRelativeMode);
            });
        });
        const arrowAbsoluteToggle = this.wrapper.querySelector('#arrow-absolute-toggle');
        arrowAbsoluteToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._applyArrowAbsoluteMode(button.dataset.arrowAbsoluteMode);
            });
        });
        this.elements.arrowValueSlider.addEventListener('input', (event) => {
            this._applyArrowValue(Number(event.target.value), true);
        });
        this.elements.arrowValueInput.addEventListener('change', (event) => {
            this._applyArrowValue(Number(event.target.value), false);
        });

        const handlingToggle = this.wrapper.querySelector('#point-handling-toggle');
        handlingToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._setStyle({ pointHandling: button.dataset.pointHandling });
            });
        });

        this.elements.radiusSlider.addEventListener('input', (event) => {
            const value = Number(event.target.value);
            this._applyRadiusValue(value, true);
        });

        this.elements.radiusInput.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            this._applyRadiusValue(value, false);
        });

        const radiusModeToggle = this.wrapper.querySelector('#radius-mode-toggle');
        radiusModeToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._applyRadiusMode(button.dataset.radiusMode);
            });
        });

        this.elements.tensionSlider.addEventListener('input', (event) => {
            const value = Number(event.target.value);
            this._applyTensionValue(value, true);
        });

        this.elements.tensionInput.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            this._applyTensionValue(value, false);
        });
        this.elements.smoothingSlider.addEventListener('input', (event) => {
            const value = Number(event.target.value);
            this._applySmoothingAmount(value, true);
        });
        this.elements.smoothingInput.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            this._applySmoothingAmount(value, false);
        });
        const smoothingQualityToggle = this.wrapper.querySelector('#smoothing-quality-toggle');
        smoothingQualityToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._applySmoothingQuality(Number(button.dataset.smoothingQuality));
            });
        });

        this.elements.nurbsDegreeSlider.addEventListener('input', (event) => {
            const value = Number(event.target.value);
            this._applyNurbsDegreeValue(value, true);
        });

        this.elements.nurbsDegreeInput.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            this._applyNurbsDegreeValue(value, false);
        });
        const nurbsSideToggle = this.wrapper.querySelector('#nurbs-side-toggle');
        nurbsSideToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._setStyle({ nurbsMixedSide: button.dataset.nurbsMixedSide });
            });
        });
        const fractalCountToggle = this.wrapper.querySelector('#fractal-count-toggle');
        fractalCountToggle.querySelectorAll('.toggle-button').forEach(button => {
            button.addEventListener('click', () => {
                this._applyFractalPointCount(Number(button.dataset.fractalCount));
            });
        });
        this.elements.fractalCanvas.addEventListener('pointerdown', (event) => {
            const idx = this._findFractalControlHit(event);
            if (idx !== null) {
                this.fractalDragIndex = idx;
                this.fractalPointerId = event.pointerId;
                this.elements.fractalCanvas.setPointerCapture?.(event.pointerId);
                this.fractalSnapFractions = new Array(this.state.style.fractalPointCount).fill(null);
                event.preventDefault();
            }
        });

        this.elements.closeButton.addEventListener('click', () => {
            this.hide();
        });

        this.elements.selectButton.addEventListener('click', () => {
            this.onSelect(this._exportStyleForHost());
            this.hide();
        });

        window.addEventListener('pointermove', (event) => {
            if (this.activePointerId === event.pointerId) this._handlePreviewMouseMove(event);
            if (this.fractalDragIndex !== null && this.fractalPointerId === event.pointerId) {
                const controls = this.state.style.fractalControlPoints.map((pt) => ({ ...pt }));
                const next = this._fractalControlFromMouse(event, this.fractalDragIndex, controls);
                if (next) {
                    controls[this.fractalDragIndex] = next;
                    this.state.style = {
                        ...this.state.style,
                        fractalControlPoints: this._normalizeFractalControlPoints(
                            controls,
                            this.state.style.fractalPointCount
                        )
                    };
                    this._updateUIFromState();
                    this._requestPreviewRender();
                }
            }
        });
        const endPointerInteraction = (event) => {
            if (this.activePointerId === event.pointerId) {
                this._handlePreviewMouseUp();
                this.activePointerId = null;
            }
            if (this.fractalPointerId === event.pointerId) {
                this.fractalDragIndex = null;
                this.fractalPointerId = null;
            }
            this._flushPendingPreviewRender();
        };
        window.addEventListener('pointerup', endPointerInteraction);
        window.addEventListener('pointercancel', endPointerInteraction);
    }

    _setStyle(next) {
        this.state.style = { ...this.state.style, ...next };
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _exportStyleForHost() {
        const {
            id,
            name,
            type,
            tension,
            radiusMode,
            radiusValue,
            pointHandling,
            order,
            preset,
            mode,
            linearStyle,
            linearArrowEndMode,
            linearArrowMode,
            linearArrowRelativeMode,
            linearArrowRelativeValue,
            linearArrowAbsoluteMode,
            linearArrowAbsoluteValue,
            nurbsDegree,
            nurbsMixedSide,
            smoothingAmount,
            smoothingQuality
        } = this.state.style;
        const linearArrowLegacyEndMode = this._legacyArrowEndModeFromStyle(this.state.style);
        const base = {
            id,
            name,
            order,
            preset,
            mode,
            linearStyle,
            linearArrowEndMode: linearArrowLegacyEndMode,
            linearArrowMode,
            linearArrowRelativeMode,
            linearArrowRelativeValue,
            linearArrowAbsoluteMode,
            linearArrowAbsoluteValue
        };
        if (type === 'spline') {
            const usingNurbs = pointHandling === 'control' || pointHandling === 'mixed';
            return {
                ...base,
                type: usingNurbs ? 'nurbs' : 'cubic_spline',
                cornerHandling: 'pass_through',
                tension: Number(tension ?? 0.5),
                nurbsDegree: Math.max(2, Math.min(5, Math.round(Number(nurbsDegree ?? 3)))),
                nurbsPointMode: pointHandling === 'mixed' ? 'mixed' : 'control_only',
                nurbsMixedRule: pointHandling === 'mixed' ? 'convex_anchor_concave_control' : null,
                nurbsSide: pointHandling === 'mixed' ? (nurbsMixedSide === 'right' ? 'right' : 'left') : null,
                nurbsMixedSide: pointHandling === 'mixed' ? (nurbsMixedSide === 'right' ? 'right' : 'left') : null
            };
        }
        if (type === 'fractal') {
            return {
                ...base,
                type: 'fractal',
                fractalPointCount: this.state.style.fractalPointCount,
                fractalControlPoints: this.state.style.fractalControlPoints.map((pt) => ({ u: pt.u, v: pt.v }))
            };
        }
        if (type === 'smoothing') {
            return {
                ...base,
                type: 'smoothing',
                pointHandling,
                mixedSide: nurbsMixedSide === 'right' ? 'right' : 'left',
                smoothingAmount: clamp01(Number(smoothingAmount ?? 0.5)),
                smoothingQuality: Math.max(1, Math.min(5, Math.round(Number(smoothingQuality ?? 1))))
            };
        }
        if (type === 'radius') {
            return {
                ...base,
                type: 'circular_arc',
                cornerHandling: pointHandling === 'mixed' ? 'mixed' : 'cut_all',
                radiusMode,
                radiusValue
            };
        }
        return {
            ...base,
            type: 'linear',
            cornerHandling: 'pass_through'
        };
    }

    _applyRadiusValue(value, fromSlider) {
        if (Number.isNaN(value)) return;
        const nextStyle = { ...this.state.style };
        if (nextStyle.radiusMode === 'relative') {
            const clamped = clamp01(value);
            nextStyle.radiusValue = clamped;
            nextStyle.relRadiusValue = clamped;
        } else {
            const sliderValue = fromSlider ? clamp01(value) : absRadiusToSlider(value);
            nextStyle.absRadiusValue = sliderValue;
            nextStyle.radiusValue = absSliderToRadius(sliderValue);
        }
        this.state.style = nextStyle;
        if (fromSlider) {
            this.elements.radiusInput.value = nextStyle.radiusValue.toFixed(nextStyle.radiusMode === 'absolute' ? 0 : 2);
        } else {
            this.elements.radiusSlider.value = nextStyle.radiusMode === 'absolute'
                ? nextStyle.absRadiusValue
                : nextStyle.radiusValue;
        }
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyTensionValue(value, fromSlider) {
        if (Number.isNaN(value)) return;
        const nextStyle = { ...this.state.style };
        nextStyle.tension = Math.max(0, Math.min(1, value));
        this.state.style = nextStyle;
        if (fromSlider) {
            this.elements.tensionInput.value = nextStyle.tension.toFixed(2);
        } else {
            this.elements.tensionSlider.value = nextStyle.tension;
        }
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applySmoothingAmount(value, fromSlider) {
        if (Number.isNaN(value)) return;
        const nextStyle = { ...this.state.style };
        nextStyle.smoothingAmount = clamp01(value);
        this.state.style = nextStyle;
        if (fromSlider) {
            this.elements.smoothingInput.value = nextStyle.smoothingAmount.toFixed(2);
        } else {
            this.elements.smoothingSlider.value = nextStyle.smoothingAmount;
        }
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applySmoothingQuality(value) {
        const nextStyle = { ...this.state.style };
        nextStyle.smoothingQuality = Math.max(1, Math.min(5, Math.round(Number(value) || 1)));
        this.state.style = nextStyle;
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyArrowMode(mode) {
        if (mode !== 'relative' && mode !== 'absolute') return;
        this.state.style = { ...this.state.style, linearArrowMode: mode };
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyArrowRelativeMode(mode) {
        if (mode !== 'over' && mode !== 'end') return;
        this.state.style = { ...this.state.style, linearArrowRelativeMode: mode };
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyArrowAbsoluteMode(mode) {
        if (mode !== 'length' && mode !== 'dist') return;
        const nextStyle = { ...this.state.style, linearArrowAbsoluteMode: mode };
        nextStyle.linearArrowAbsoluteValue = mode === 'length'
            ? clampRange(Number(nextStyle.linearArrowAbsoluteValue ?? 1), 1, 5)
            : clampRange(Number(nextStyle.linearArrowAbsoluteValue ?? 0), 0, 4);
        this.state.style = nextStyle;
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyArrowValue(value, fromSlider) {
        if (Number.isNaN(value)) return;
        const nextStyle = { ...this.state.style };
        if (nextStyle.linearArrowMode === 'relative') {
            nextStyle.linearArrowRelativeValue = clamp01(value);
            if (fromSlider) {
                this.elements.arrowValueInput.value = nextStyle.linearArrowRelativeValue.toFixed(2);
            } else {
                this.elements.arrowValueSlider.value = nextStyle.linearArrowRelativeValue;
            }
        } else if (nextStyle.linearArrowAbsoluteMode === 'length') {
            nextStyle.linearArrowAbsoluteValue = clampRange(value, 1, 5);
            if (fromSlider) {
                this.elements.arrowValueInput.value = nextStyle.linearArrowAbsoluteValue.toFixed(2);
            } else {
                this.elements.arrowValueSlider.value = nextStyle.linearArrowAbsoluteValue;
            }
        } else {
            nextStyle.linearArrowAbsoluteValue = clampRange(value, 0, 4);
            if (fromSlider) {
                this.elements.arrowValueInput.value = nextStyle.linearArrowAbsoluteValue.toFixed(2);
            } else {
                this.elements.arrowValueSlider.value = nextStyle.linearArrowAbsoluteValue;
            }
        }
        this.state.style = nextStyle;
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyRadiusMode(mode) {
        if (mode !== 'relative' && mode !== 'absolute') return;
        const nextStyle = { ...this.state.style };
        nextStyle.radiusMode = mode;
        if (mode === 'relative') {
            nextStyle.radiusValue = nextStyle.relRadiusValue ?? nextStyle.radiusValue;
        } else {
            nextStyle.radiusValue = absSliderToRadius(nextStyle.absRadiusValue ?? nextStyle.radiusValue);
        }
        this.state.style = nextStyle;
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyNurbsDegreeValue(value, fromSlider) {
        if (Number.isNaN(value)) return;
        const nextStyle = { ...this.state.style };
        nextStyle.nurbsDegree = Math.max(2, Math.min(5, Math.round(value)));
        this.state.style = nextStyle;
        if (fromSlider) {
            this.elements.nurbsDegreeInput.value = nextStyle.nurbsDegree;
        } else {
            this.elements.nurbsDegreeSlider.value = nextStyle.nurbsDegree;
        }
        this._updateUIFromState();
    }

    _applyFractalPointCount(value) {
        const nextCount = Math.max(1, Math.min(3, Math.round(Number(value) || 2)));
        this.fractalSnapFractions = new Array(nextCount).fill(null);
        this.state.style = {
            ...this.state.style,
            fractalPointCount: nextCount,
            fractalControlPoints: this._defaultFractalControlPoints(nextCount)
        };
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _applyTypeSelection(type) {
        const nextStyle = { ...this.state.style, type };
        switch (type) {
            case 'linear':
                nextStyle.mode = 'piecewise';
                nextStyle.order = 1;
                nextStyle.pointHandling = 'anchor';
                break;
            case 'spline':
                nextStyle.mode = 'piecewise';
                nextStyle.order = 3;
                nextStyle.pointHandling = 'anchor';
                break;
            case 'radius':
                nextStyle.mode = 'radius';
                nextStyle.radiusMode = nextStyle.radiusMode || 'relative';
                nextStyle.radiusValue = nextStyle.radiusMode === 'relative'
                    ? (nextStyle.relRadiusValue ?? nextStyle.radiusValue)
                    : absSliderToRadius(nextStyle.absRadiusValue ?? nextStyle.radiusValue);
                nextStyle.pointHandling = nextStyle.pointHandling === 'mixed' ? 'mixed' : 'control';
                break;
            case 'fractal':
                nextStyle.mode = 'piecewise';
                nextStyle.order = 1;
                nextStyle.pointHandling = 'anchor';
                break;
            case 'smoothing':
                nextStyle.mode = 'piecewise';
                nextStyle.order = 1;
                nextStyle.pointHandling = 'control';
                break;
            default:
                break;
        }
        this.state.style = nextStyle;
        this._updateUIFromState();
        this._renderAllPreviews();
    }

    _updateUIFromState() {
        const { preset, mode, order, radiusMode, radiusValue, tension, type, linearStyle, linearArrowMode, linearArrowRelativeMode, linearArrowRelativeValue, linearArrowAbsoluteMode, linearArrowAbsoluteValue, nurbsDegree, pointHandling, nurbsMixedSide, fractalPointCount, smoothingAmount, smoothingQuality } = this.state.style;

        this.previewCards.forEach((cardInfo, cardPreset) => {
            cardInfo.card.classList.toggle('is-active', cardPreset === preset);
        });

        this.wrapper.querySelectorAll('#type-list .toggle-row').forEach(button => {
            button.classList.toggle('is-active', button.dataset.type === type);
        });

        this.wrapper.querySelectorAll('#linear-style-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.linearStyle === linearStyle);
        });
        this.wrapper.querySelectorAll('#arrow-mode-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.arrowMode === linearArrowMode);
        });
        this.wrapper.querySelectorAll('#arrow-relative-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.arrowRelativeMode === linearArrowRelativeMode);
        });
        this.wrapper.querySelectorAll('#arrow-absolute-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.arrowAbsoluteMode === linearArrowAbsoluteMode);
        });

        this.wrapper.querySelectorAll('#point-handling-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.pointHandling === pointHandling);
        });
        this.wrapper.querySelectorAll('#nurbs-side-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.nurbsMixedSide === nurbsMixedSide);
        });
        this.wrapper.querySelectorAll('#fractal-count-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', Number(button.dataset.fractalCount) === fractalPointCount);
        });
        this.wrapper.querySelectorAll('#smoothing-quality-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', Number(button.dataset.smoothingQuality) === smoothingQuality);
        });

        const linearSection = this.wrapper.querySelector('#linear-section');
        const arrowEndSection = this.wrapper.querySelector('#arrow-end-section');
        const arrowRelativeRow = this.wrapper.querySelector('#arrow-relative-row');
        const arrowAbsoluteRow = this.wrapper.querySelector('#arrow-absolute-row');
        const handlingSection = this.wrapper.querySelector('#handling-section');
        const tensionSection = this.wrapper.querySelector('#tension-section');
        const radiusSection = this.wrapper.querySelector('#radius-section');
        const smoothingSection = this.wrapper.querySelector('#smoothing-section');
        const nurbsSection = this.wrapper.querySelector('#nurbs-section');
        const nurbsSideSection = this.wrapper.querySelector('#nurbs-side-section');
        const fractalSection = this.wrapper.querySelector('#fractal-section');

        linearSection.classList.toggle('is-hidden', type !== 'linear');
        arrowEndSection.classList.toggle('is-hidden', !(type === 'linear' && linearStyle === 'arrows'));
        arrowRelativeRow.classList.toggle('is-hidden', linearArrowMode !== 'relative');
        arrowAbsoluteRow.classList.toggle('is-hidden', linearArrowMode !== 'absolute');
        handlingSection.classList.toggle('is-hidden', !(type === 'spline' || type === 'smoothing'));
        tensionSection.classList.toggle('is-hidden', !(type === 'spline' && pointHandling === 'anchor'));
        radiusSection.classList.toggle('is-hidden', type !== 'radius');
        smoothingSection.classList.toggle('is-hidden', type !== 'smoothing');
        nurbsSection.classList.toggle('is-hidden', !(type === 'spline' && pointHandling !== 'anchor'));
        nurbsSideSection.classList.toggle('is-hidden', !((type === 'spline' || type === 'smoothing') && pointHandling === 'mixed'));
        fractalSection.classList.toggle('is-hidden', type !== 'fractal');

        this.wrapper.querySelectorAll('#radius-mode-toggle .toggle-button').forEach(button => {
            button.classList.toggle('is-active', button.dataset.radiusMode === radiusMode);
        });

        if (radiusMode === 'absolute') {
            this.elements.radiusSlider.value = clamp01(this.state.style.absRadiusValue);
            this.elements.radiusInput.value = clampAbsRadius(radiusValue).toFixed(0);
            this.elements.radiusInput.min = '0';
            this.elements.radiusInput.max = String(MAX_ABS_RADIUS);
            this.elements.radiusInput.step = '1';
        } else {
            this.elements.radiusSlider.value = clamp01(radiusValue);
            this.elements.radiusInput.value = Number(this.elements.radiusSlider.value).toFixed(2);
            this.elements.radiusInput.min = '0';
            this.elements.radiusInput.max = '1';
            this.elements.radiusInput.step = '0.01';
        }

        this.elements.tensionSlider.value = Math.max(0, Math.min(1, tension));
        this.elements.tensionInput.value = Number(tension).toFixed(2);
        if (linearArrowMode === 'relative') {
            this.elements.arrowValueSlider.min = '0';
            this.elements.arrowValueSlider.max = '1';
            this.elements.arrowValueSlider.step = '0.01';
            this.elements.arrowValueSlider.value = clamp01(linearArrowRelativeValue);
            this.elements.arrowValueSlider.title = 'relative L';
            this.elements.arrowValueInput.min = '0';
            this.elements.arrowValueInput.max = '1';
            this.elements.arrowValueInput.step = '0.01';
            this.elements.arrowValueInput.value = clamp01(linearArrowRelativeValue).toFixed(2);
            this.elements.arrowValueInput.title = 'relative L';
            this.elements.arrowValueUnit.textContent = 'L';
        } else if (linearArrowAbsoluteMode === 'length') {
            this.elements.arrowValueSlider.min = '1';
            this.elements.arrowValueSlider.max = '5';
            this.elements.arrowValueSlider.step = '0.05';
            this.elements.arrowValueSlider.value = clampRange(linearArrowAbsoluteValue, 1, 5);
            this.elements.arrowValueSlider.title = 'absolute length (r)';
            this.elements.arrowValueInput.min = '1';
            this.elements.arrowValueInput.max = '5';
            this.elements.arrowValueInput.step = '0.05';
            this.elements.arrowValueInput.value = clampRange(linearArrowAbsoluteValue, 1, 5).toFixed(2);
            this.elements.arrowValueInput.title = 'absolute length (r)';
            this.elements.arrowValueUnit.textContent = 'r';
        } else {
            this.elements.arrowValueSlider.min = '0';
            this.elements.arrowValueSlider.max = '4';
            this.elements.arrowValueSlider.step = '0.05';
            this.elements.arrowValueSlider.value = clampRange(linearArrowAbsoluteValue, 0, 4);
            this.elements.arrowValueSlider.title = 'absolute dist (r)';
            this.elements.arrowValueInput.min = '0';
            this.elements.arrowValueInput.max = '4';
            this.elements.arrowValueInput.step = '0.05';
            this.elements.arrowValueInput.value = clampRange(linearArrowAbsoluteValue, 0, 4).toFixed(2);
            this.elements.arrowValueInput.title = 'absolute dist (r)';
            this.elements.arrowValueUnit.textContent = 'r';
        }
        this.elements.smoothingSlider.value = clamp01(smoothingAmount);
        this.elements.smoothingInput.value = clamp01(smoothingAmount).toFixed(2);
        this.elements.nurbsDegreeSlider.value = nurbsDegree;
        this.elements.nurbsDegreeInput.value = nurbsDegree;
        this._renderFractalControlLine();
    }

    _renderFractalControlLine() {
        const canvas = this.elements.fractalCanvas;
        if (!canvas) return;
        if (this.elements.fractalSnapLabels) {
            this.elements.fractalSnapLabels.replaceChildren();
        }
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const pad = 10;
        const x0 = pad;
        const x1 = w - pad;
        const yMid = h / 2;
        const px = (u) => x0 + (x1 - x0) * u;
        const py = (v) => yMid - (v / FRACTAL_V_LIMIT) * (h * 0.35);
        const controls = this.state.style.fractalControlPoints || [];
        const pattern = [{ u: 0, v: 0 }, ...controls, { u: 1, v: 0 }];

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, w, h);
        const yTop = py(FRACTAL_V_LIMIT);
        const yBottom = py(-FRACTAL_V_LIMIT);
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, yTop);
        ctx.lineTo(x1, yTop);
        ctx.moveTo(x0, yBottom);
        ctx.lineTo(x1, yBottom);
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, yMid);
        ctx.lineTo(x1, yMid);
        ctx.stroke();

        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        pattern.forEach((pt, i) => {
            const x = px(pt.u);
            const y = py(pt.v);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        pattern.forEach((pt, i) => {
            ctx.beginPath();
            ctx.arc(px(pt.u), py(pt.v), i === 0 || i === pattern.length - 1 ? 3 : 4, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 || i === pattern.length - 1 ? '#60a5fa' : '#f59e0b';
            ctx.fill();
        });
        const labelsLayer = this.elements.fractalSnapLabels;
        if (!labelsLayer) return;
        controls.forEach((pt, index) => {
            const snap = this.fractalSnapFractions[index];
            if (!snap || !Number.isFinite(pt.u) || !Number.isFinite(pt.v)) return;
            const label = document.createElement('div');
            label.style.position = 'absolute';
            label.style.left = `${px(pt.u)}px`;
            label.style.top = `${Math.min(h - 4, py(pt.v) + 8)}px`;
            label.style.transform = 'translateX(-50%)';
            label.style.fontSize = '11px';
            label.style.lineHeight = '1';
            label.style.color = '#f8fafc';
            label.style.textShadow = '0 0 2px rgba(0,0,0,0.7)';
            if (snap.mode === 'fraction') {
                const xText = `\\frac{${snap.uNum}}{${snap.uDen}}`;
                const yText = snap.vNum === 0
                    ? '0'
                    : `${snap.vNum < 0 ? '-' : ''}\\frac{${Math.abs(snap.vNum)}}{${snap.vDen}}`;
                const coordText = `\\left(${xText},\\,${yText}\\right)`;
                if (globalThis.katex?.renderToString) {
                    label.innerHTML = globalThis.katex.renderToString(coordText, {
                        throwOnError: false
                    });
                } else {
                    label.textContent = `(${snap.uNum}/${snap.uDen}, ${snap.vNum}/${snap.vDen})`;
                }
            } else {
                label.textContent = `(${snap.u.toFixed(3)}, ${snap.v.toFixed(3)})`;
            }
            labelsLayer.appendChild(label);
        });
    }

    _fractalControlFromMouse(event, index = null, currentControls = null) {
        const canvas = this.elements.fractalCanvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
        const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
        const pad = 10;
        const x0 = pad;
        const x1 = canvas.width - pad;
        const yMid = canvas.height / 2;
        let u = Math.max(0.05, Math.min(0.95, (x - x0) / (x1 - x0)));
        const uMin = 0.05;
        const uMax = 0.95;
        if (event.shiftKey) {
            const uSnap = this._snapFractalU(u, uMin, uMax);
            u = uSnap.u;
            let vRaw = ((yMid - y) / (canvas.height * 0.35)) * FRACTAL_V_LIMIT;
            vRaw = Math.max(-FRACTAL_V_LIMIT, Math.min(FRACTAL_V_LIMIT, vRaw));
            const vSnap = this._snapFractalV(vRaw);
            const v = vSnap.v;
            if (index !== null) {
                this.fractalSnapFractions[index] = {
                    mode: 'fraction',
                    uNum: uSnap.num,
                    uDen: uSnap.den,
                    vNum: vSnap.num,
                    vDen: vSnap.den
                };
            }
            return { u, v };
        }
        const v = Math.max(-FRACTAL_V_LIMIT, Math.min(FRACTAL_V_LIMIT, ((yMid - y) / (canvas.height * 0.35)) * FRACTAL_V_LIMIT));
        if (index !== null) {
            this.fractalSnapFractions[index] = {
                mode: 'decimal',
                u,
                v
            };
        }
        return { u, v };
    }

    _findFractalControlHit(event) {
        const canvas = this.elements.fractalCanvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
        const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
        const pad = 10;
        const x0 = pad;
        const x1 = canvas.width - pad;
        const yMid = canvas.height / 2;
        const hitRadius = this.wrapper?.dataset.inputCoarse === 'true' ? 14 : 8;
        const controls = this.state.style.fractalControlPoints || [];
        for (let i = 0; i < controls.length; i++) {
            const cx = x0 + (x1 - x0) * controls[i].u;
            const cy = yMid - (controls[i].v / FRACTAL_V_LIMIT) * (canvas.height * 0.35);
            if (Math.hypot(x - cx, y - cy) <= hitRadius) return i;
        }
        return null;
    }

    _renderAllPreviews() {
        PRESET_DEFS.forEach(preset => {
            const card = this.previewCards.get(preset.id);
            if (!card) return;
            this._renderPreviewCard(card.canvas, preset.id, preset.id === this.state.style.preset);
        });
    }

    _renderSinglePreview(presetId) {
        const card = this.previewCards.get(presetId);
        if (!card) return;
        this._renderPreviewCard(card.canvas, presetId, presetId === this.state.style.preset);
    }

    _requestPreviewRender(presetId = null) {
        if (presetId) {
            this._pendingRenderPresets.add(presetId);
        } else {
            this._pendingRenderAll = true;
        }
        if (this._renderThrottleTimer !== null) return;
        this._renderThrottleTimer = setTimeout(() => {
            this._flushPendingPreviewRender();
        }, this._renderThrottleMs);
    }

    _flushPendingPreviewRender() {
        if (this._renderThrottleTimer !== null) {
            clearTimeout(this._renderThrottleTimer);
            this._renderThrottleTimer = null;
        }
        if (this._pendingRenderAll) {
            this._pendingRenderAll = false;
            this._pendingRenderPresets.clear();
            this._renderAllPreviews();
            return;
        }
        if (!this._pendingRenderPresets.size) return;
        const presets = Array.from(this._pendingRenderPresets);
        this._pendingRenderPresets.clear();
        presets.forEach((presetId) => this._renderSinglePreview(presetId));
    }

    _renderPreviewCard(canvas, presetId, isActive) {
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.floor(rect.width * dpr));
        const height = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, rect.width, rect.height);
        this._drawPreset(ctx, rect.width, rect.height, presetId, isActive);
        ctx.restore();
    }

    _drawPreset(ctx, width, height, presetId, isActive) {
        const padding = 16;
        const usableW = width - padding * 2;
        const usableH = height - padding * 2;

        const toCanvas = (pt) => ({
            x: padding + pt.x * usableW,
            y: padding + pt.y * usableH
        });

        const preset = this._getPresetPoints(presetId);
        const strokeColor = isActive ? '#3b82f6' : '#6b7280';
        const pointColor = isActive ? '#60a5fa' : '#94a3b8';

        ctx.lineWidth = this._getStrokeWidth();
        ctx.lineJoin = this.state.style.mode === 'radius' ? 'round' : 'miter';
        ctx.lineCap = 'round';
        ctx.strokeStyle = strokeColor;

        const uniqueNormalized = [];
        const seenNormalized = new Set();
        const seenSegments = new Set();
        const trackPoint = (pt) => {
            if (seenNormalized.has(pt)) return;
            seenNormalized.add(pt);
            uniqueNormalized.push(pt);
        };

        const isBranchingRadius = this.state.style.mode === 'radius' && presetId === 'branching';
        const distanceToLine = (point, lineStart, lineEnd) => {
            const vx = lineEnd.x - lineStart.x;
            const vy = lineEnd.y - lineStart.y;
            const wx = point.x - lineStart.x;
            const wy = point.y - lineStart.y;
            const len = Math.hypot(vx, vy);
            if (len < 1e-6) return Math.hypot(wx, wy);
            return Math.abs(vx * wy - vy * wx) / len;
        };
        const projectT = (point, lineStart, lineEnd) => {
            const vx = lineEnd.x - lineStart.x;
            const vy = lineEnd.y - lineStart.y;
            const wx = point.x - lineStart.x;
            const wy = point.y - lineStart.y;
            const denom = vx * vx + vy * vy;
            if (denom < 1e-6) return 0;
            return (wx * vx + wy * vy) / denom;
        };
        const trimHalfLinear = (points, line, trimStartHalf, trimEndHalf) => {
            if (!line || points.length < 3) return points;
            const eps = 0.25;
            const dir = {
                x: line.b.x - line.a.x,
                y: line.b.y - line.a.y
            };
            const dirLen = Math.hypot(dir.x, dir.y) || 1;
            const filtered = points.filter((pt, index) => {
                const distance = distanceToLine(pt, line.a, line.b);
                if (distance > eps) return true;
                const t = projectT(pt, line.a, line.b);
                const prev = points[Math.max(0, index - 1)];
                const next = points[Math.min(points.length - 1, index + 1)];
                const sx = next.x - prev.x;
                const sy = next.y - prev.y;
                const segLen = Math.hypot(sx, sy) || 1;
                const cross = dir.x * sy - dir.y * sx;
                const dot = dir.x * sx + dir.y * sy;
                const aligned = Math.abs(cross) <= 0.01 * dirLen * segLen && dot >= 0;
                if (!aligned) return true;
                if (trimStartHalf && t <= 0.5) return false;
                if (trimEndHalf && t >= 0.5) return false;
                return true;
            });
            return filtered.length >= 2 ? filtered : filtered;
        };
        const getArcFraction = (line) => {
            if (!line) return 0;
            const len = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y);
            if (len <= 1e-6) return 0;
            if (this.state.style.radiusMode === 'relative') {
                return Math.max(0, Math.min(0.5, this.state.style.radiusValue * 0.5));
            }
            return Math.max(0, Math.min(0.5, this.state.style.radiusValue / len));
        };
        const keepLineOnEdge = (points, edgeIndex, cornerAtEnd, line, keepEndpointHalf) => {
            if (points.length < 3) return points;
            if (!line) return points;
            const arcFraction = getArcFraction(line);
            const tMin = cornerAtEnd
                ? (keepEndpointHalf ? 0 : 0.5)
                : arcFraction;
            const tMax = cornerAtEnd
                ? (1 - arcFraction)
                : (keepEndpointHalf ? 1 : 0.5);
            const filtered = points.filter((pt) => {
                if (pt.tag === 'line' && pt.edgeIndex !== undefined) {
                    if (pt.edgeIndex !== edgeIndex) return true;
                    const t = projectT(pt, line.a, line.b);
                    return t >= tMin && t <= tMax;
                }
                return pt.tag !== 'line';
            });
            return filtered.length >= 2 ? filtered : filtered;
        };

        const faceVertices = preset.faces && preset.vertices ? preset.vertices : null;
        const faceList = preset.faces || null;
        const hasFaces = !!(faceVertices && faceList && faceList.length);
        let boundaryFillPoints = null;
        let boundaryVertexSet = null;
        const mixedDebugHiddenPoints = [];
        const mixedDebugAnchorPoints = [];
        const mixedDebugByPath = [];
        const referenceScale = Math.hypot(usableW, usableH);
        preset.paths.forEach((path, pathIndex) => {
            const normalizedPoints = path.points;
            const points = normalizedPoints.map(toCanvas);
            normalizedPoints.forEach(trackPoint);
            if (this.state.style.type === 'spline' && this.state.style.pointHandling === 'mixed') {
                const debug = this._computeMixedHiddenPoints(normalizedPoints, path.closed);
                mixedDebugHiddenPoints.push(...debug.hidden.map(toCanvas));
                mixedDebugAnchorPoints.push(...debug.anchors.map(toCanvas));
                mixedDebugByPath.push({
                    pathIndex,
                    closed: !!path.closed,
                    pointCount: normalizedPoints.length,
                    start: normalizedPoints[0] || null,
                    end: normalizedPoints[normalizedPoints.length - 1] || null,
                    anchors: debug.anchors.length,
                    hidden: debug.hidden.length
                });
            }
            if (points.length >= 2 && (this.state.style.pointHandling !== 'mixed' || presetId === 'open')) {
                ctx.save();
                ctx.lineWidth = Math.max(1, this._getStrokeWidth() * 0.6);
                ctx.strokeStyle = '#94a3b8';
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.setLineDash(C.PREVIEW_DASH_PATTERN);
                const segments = [];
                for (let i = 0; i < points.length - 1; i++) {
                    if (isBranchingRadius && presetId === 'branching' && pathIndex === 0 && i === points.length - 2) {
                        // Skip fake stem end segment at the junction.
                        continue;
                    }
                    segments.push([points[i], points[i + 1]]);
                }
                if (path.closed) {
                    segments.push([points[points.length - 1], points[0]]);
                }
                segments.forEach(([a, b]) => {
                    const ax = Math.round(a.x);
                    const ay = Math.round(a.y);
                    const bx = Math.round(b.x);
                    const by = Math.round(b.y);
                    const keyA = `${ax}:${ay}`;
                    const keyB = `${bx}:${by}`;
                    const key = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
                    if (seenSegments.has(key)) return;
                    seenSegments.add(key);
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                    ctx.stroke();
                });
                ctx.restore();
            }
            let drawPoints = this._getInterpolatedPoints(points, path.closed, referenceScale);
            if (drawPoints.length < 2) {
                return;
            }
            if (isBranchingRadius) {
                drawPoints = this._sampleWithEngine(points, path.closed);
                const allowStart = path.trueEndpointStart === true;
                const allowEnd = path.trueEndpointEnd === true;
                if (pathIndex === 0) {
                    const startLine = points.length >= 2 ? { a: points[0], b: points[1] } : null;
                    drawPoints = keepLineOnEdge(drawPoints, 0, true, startLine, allowStart);
                    const endLine = points.length >= 2 ? { a: points[points.length - 2], b: points[points.length - 1] } : null;
                    drawPoints = keepLineOnEdge(drawPoints, points.length - 2, false, endLine, allowEnd);
                } else {
                    const startLine = points.length >= 2 ? { a: points[0], b: points[1] } : null;
                    const endLine = points.length >= 2 ? { a: points[points.length - 2], b: points[points.length - 1] } : null;
                    drawPoints = keepLineOnEdge(drawPoints, 0, true, startLine, allowStart);
                    drawPoints = keepLineOnEdge(drawPoints, points.length - 2, false, endLine, allowEnd);
                }
                if (drawPoints.length < 2) return;
                drawPoints = drawPoints.map(pt => ({ x: pt.x, y: pt.y }));
            }
            if (this.state.style.mode !== 'radius'
                && (this.state.style.type !== 'spline' || path.forceTrim)) {
                if (path.trimFromPoint) {
                    const trimTarget = toCanvas(path.trimFromPoint);
                    let closestIndex = 0;
                    let closestDistance = Infinity;
                    drawPoints.forEach((pt, index) => {
                        const distance = Math.hypot(pt.x - trimTarget.x, pt.y - trimTarget.y);
                        if (distance < closestDistance) {
                            closestDistance = distance;
                            closestIndex = index;
                        }
                    });
                    drawPoints = drawPoints.slice(closestIndex);
                    if (!drawPoints.length || Math.hypot(drawPoints[0].x - trimTarget.x, drawPoints[0].y - trimTarget.y) > 1e-6) {
                        drawPoints.unshift(trimTarget);
                    } else {
                        drawPoints[0] = trimTarget;
                    }
                }
                if (path.trimToPoint) {
                    const trimTarget = toCanvas(path.trimToPoint);
                    let closestIndex = 0;
                    let closestDistance = Infinity;
                    drawPoints.forEach((pt, index) => {
                        const distance = Math.hypot(pt.x - trimTarget.x, pt.y - trimTarget.y);
                        if (distance < closestDistance) {
                            closestDistance = distance;
                            closestIndex = index;
                        }
                    });
                    drawPoints = drawPoints.slice(0, closestIndex + 1);
                    if (!drawPoints.length || Math.hypot(drawPoints[drawPoints.length - 1].x - trimTarget.x, drawPoints[drawPoints.length - 1].y - trimTarget.y) > 1e-6) {
                        drawPoints.push(trimTarget);
                    } else {
                        drawPoints[drawPoints.length - 1] = trimTarget;
                    }
                }
            }
            if (drawPoints.length < 2) return;
            const drawLinearArrows = this.state.style.type === 'linear' && this.state.style.linearStyle === 'arrows';
            ctx.beginPath();
            ctx.moveTo(drawPoints[0].x, drawPoints[0].y);
            drawPoints.slice(1).forEach(pt => ctx.lineTo(pt.x, pt.y));
            if (path.closed && (this.state.style.mode !== 'radius' || this.state.style.radiusValue <= 1e-6)) {
                ctx.closePath();
            }
            if (!drawLinearArrows) {
                ctx.stroke();
            }
            if (path.isBoundary && path.closed) {
                boundaryFillPoints = drawPoints;
                boundaryVertexSet = new Set(normalizedPoints);
            } else if (!hasFaces && (presetId === 'closed' && path.closed && !Object.prototype.hasOwnProperty.call(path, 'isBoundary'))) {
                boundaryFillPoints = drawPoints;
            }

            // Removed radius helper dots for cleaner preview.

            if (drawLinearArrows) {
                this._drawEdgeArrows(ctx, points, path.closed);
            }

            // Debug segment markers removed.
        });

        if (isActive && this.state.style.type === 'spline' && this.state.style.pointHandling === 'mixed') {
            ctx.save();
            ctx.fillStyle = '#f59e0b';
            mixedDebugHiddenPoints.forEach((pt) => {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.fillStyle = '#fbbf24';
            mixedDebugAnchorPoints.forEach((pt) => {
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.restore();

            const minDistanceToCurve = (target) => {
                let best = Infinity;
                preset.paths.forEach((path) => {
                    const pathCanvasPoints = path.points.map(toCanvas);
                    const sampled = this._sampleWithEngine(pathCanvasPoints, path.closed);
                    sampled.forEach((pt) => {
                        const d = Math.hypot(pt.x - target.x, pt.y - target.y);
                        if (d < best) best = d;
                    });
                });
                return best;
            };
            console.groupCollapsed('[mixed-debug]');
            console.log('preset', presetId);
            console.log('side', this.state.style.nurbsMixedSide);
            console.log('tension', this.state.style.tension);
            console.log('hidden_count', mixedDebugHiddenPoints.length);
            console.log('anchor_count', mixedDebugAnchorPoints.length);
            const anchorDistances = mixedDebugAnchorPoints.map((pt) => minDistanceToCurve(pt));
            console.log('anchor_min_dists_px', anchorDistances);
            console.log('paths', mixedDebugByPath);
            console.groupEnd();
        }

        if (boundaryFillPoints && boundaryFillPoints.length >= 2) {
            ctx.save();
            ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
            ctx.beginPath();
            ctx.moveTo(boundaryFillPoints[0].x, boundaryFillPoints[0].y);
            boundaryFillPoints.slice(1).forEach(pt => ctx.lineTo(pt.x, pt.y));
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        if (hasFaces) {
            ctx.save();
            ctx.fillStyle = 'rgba(59, 130, 246, 0.2)';
            let boundaryFilled = false;
            faceList.forEach(face => {
                if (!Array.isArray(face) || face.length < 3) return;
                const facePoints = face.map(idx => faceVertices[idx]).filter(Boolean);
                if (facePoints.length < 3) return;
                const isBoundaryFace = boundaryVertexSet
                    ? facePoints.every(pt => boundaryVertexSet.has(pt))
                    : false;
                if (isBoundaryFace && boundaryFillPoints && !boundaryFilled) {
                    ctx.beginPath();
                    ctx.moveTo(boundaryFillPoints[0].x, boundaryFillPoints[0].y);
                    boundaryFillPoints.slice(1).forEach(pt => ctx.lineTo(pt.x, pt.y));
                    ctx.closePath();
                    ctx.fill();
                    boundaryFilled = true;
                    return;
                }
                if (isBoundaryFace && boundaryFillPoints) {
                    return;
                }
                const canvasFace = facePoints.map(toCanvas);
                const fillPoints = this._getInterpolatedPoints(canvasFace, true, referenceScale);
                if (!fillPoints || fillPoints.length < 2) return;
                ctx.beginPath();
                ctx.moveTo(fillPoints[0].x, fillPoints[0].y);
                fillPoints.slice(1).forEach(pt => ctx.lineTo(pt.x, pt.y));
                ctx.closePath();
                ctx.fill();
            });
            ctx.restore();
        }

        ctx.fillStyle = pointColor;
        uniqueNormalized.map(toCanvas).forEach(pt => {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    _computeMixedHiddenPoints(points, closed) {
        if (!Array.isArray(points) || points.length < 3) {
            return { hidden: [], anchors: [] };
        }
        const side = this.state.style.nurbsMixedSide === 'right' ? 'right' : 'left';
        const sideSign = side === 'right' ? -1 : 1;
        const tension = Math.max(0, Math.min(1, Number(this.state.style.tension ?? 0.5)));
        const handleScale = 1 / 3;
        const convexEps = 1e-9;
        const orientation = (() => {
            if (!closed || points.length < 3) return 1;
            let area = 0;
            for (let i = 0; i < points.length; i++) {
                const n = points[(i + 1) % points.length];
                area += points[i].x * n.y - n.x * points[i].y;
            }
            return Math.abs(area) < 1e-9 ? 1 : area;
        })();
        const hidden = [];
        const anchors = [];
        const n = points.length;
        for (let i = 0; i < n; i++) {
            if (!closed && (i === 0 || i === n - 1)) continue;
            const prev = points[(i + n - 1) % n];
            const curr = points[i];
            const next = points[(i + 1) % n];
            const vin = { x: curr.x - prev.x, y: curr.y - prev.y };
            const vout = { x: next.x - curr.x, y: next.y - curr.y };
            const cross = (vin.x * vout.y - vin.y * vout.x) * sideSign;
            const isConvex = orientation >= 0 ? cross >= convexEps : cross <= -convexEps;
            if (!isConvex) continue;
            const vinLen = Math.hypot(vin.x, vin.y) || 1;
            const voutLen = Math.hypot(vout.x, vout.y) || 1;
            const uIn = { x: vin.x / vinLen, y: vin.y / vinLen };
            const uOut = { x: vout.x / voutLen, y: vout.y / voutLen };
            const tRaw = { x: uIn.x + uOut.x, y: uIn.y + uOut.y };
            const tLen = Math.hypot(tRaw.x, tRaw.y);
            const tangent = tLen < 1e-9 ? uOut : { x: tRaw.x / tLen, y: tRaw.y / tLen };
            const dIn = handleScale * (1 - tension) * vinLen;
            const dOut = handleScale * (1 - tension) * voutLen;
            anchors.push(curr);
            hidden.push(
                { x: curr.x - tangent.x * dIn, y: curr.y - tangent.y * dIn },
                { x: curr.x + tangent.x * dOut, y: curr.y + tangent.y * dOut }
            );
        }
        return { hidden, anchors };
    }

    _getStrokeWidth() {
        return 2;
    }

    _drawEdgeArrows(ctx, points, closed) {
        if (points.length < 2) return;
        const arrowStrokeWidth = 2;
        const r = 3.5;
        const arrowCapWidth = 8;
        const arrowCapHeight = 8;
        const count = points.length;
        const last = closed ? count : count - 1;

        ctx.save();
        ctx.strokeStyle = ctx.fillStyle = ctx.strokeStyle;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = arrowStrokeWidth;
        ctx.fillStyle = ctx.strokeStyle;
        for (let i = 0; i < last; i++) {
            const start = points[i];
            const end = points[(i + 1) % count];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-3) continue;
            const ux = dx / len;
            const uy = dy / len;
            const mode = this.state.style.linearArrowMode === 'absolute' ? 'absolute' : 'relative';
            const relMode = this.state.style.linearArrowRelativeMode === 'over' ? 'over' : 'end';
            const relValue = clamp01(Number(this.state.style.linearArrowRelativeValue ?? 0));
            const absMode = this.state.style.linearArrowAbsoluteMode === 'length' ? 'length' : 'dist';
            const absValue = absMode === 'length'
                ? clampRange(Number(this.state.style.linearArrowAbsoluteValue ?? 1), 1, 5)
                : clampRange(Number(this.state.style.linearArrowAbsoluteValue ?? 0), 0, 4);
            const minAbsoluteLength = r;
            if (mode === 'absolute' && len < minAbsoluteLength) {
                continue;
            }
            const minTipDistance = Math.min(len, arrowCapHeight + 0.25);
            let tipDistanceAlongEdge;
            if (mode === 'relative') {
                tipDistanceAlongEdge = len * (1 - relValue);
            } else if (absMode === 'length') {
                const absoluteLength = clampRange(absValue * r, minAbsoluteLength, len);
                tipDistanceAlongEdge = absoluteLength;
            } else {
                const maxInset = Math.max(0, len - minAbsoluteLength);
                const insetAbs = clampRange(absValue * r, 0, maxInset);
                tipDistanceAlongEdge = len - insetAbs;
            }
            tipDistanceAlongEdge = clampRange(tipDistanceAlongEdge, minTipDistance, len);
            const tip = {
                x: start.x + ux * tipDistanceAlongEdge,
                y: start.y + uy * tipDistanceAlongEdge
            };
            const baseDistanceAlongEdge = Math.max(0, tipDistanceAlongEdge - arrowCapHeight);
            const base = {
                x: start.x + ux * baseDistanceAlongEdge,
                y: start.y + uy * baseDistanceAlongEdge
            };
            const keepEdgeVisibleUnderArrow = mode === 'relative' && relMode === 'over';
            const lineEnd = keepEdgeVisibleUnderArrow ? end : tip;
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(lineEnd.x, lineEnd.y);
            ctx.stroke();
            const left = {
                x: base.x + -uy * (arrowCapWidth / 2),
                y: base.y + ux * (arrowCapWidth / 2)
            };
            const right = {
                x: base.x + uy * (arrowCapWidth / 2),
                y: base.y - ux * (arrowCapWidth / 2)
            };
            ctx.beginPath();
            ctx.moveTo(tip.x, tip.y);
            ctx.lineTo(left.x, left.y);
            ctx.lineTo(right.x, right.y);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _initEngineInterpolationBridge() {
        if (!ENGINE_INTERPOLATION_ENABLED) {
            throw new Error('Engine interpolation is disabled. This editor requires wasm engine interpolation.');
        }
        const provided = this.engineWasmApi;
        const globalBridge = globalThis && globalThis.vektorWasm;
        const api = provided || globalBridge;
        if (!api || typeof api.compute_interpolation !== 'function') {
            throw new Error('Missing wasm engine bridge: expected compute_interpolation(payload) on options.engineWasmApi or globalThis.vektorWasm.');
        }
        this.engineInterpolation = (payload) => api.compute_interpolation(payload);
    }

    _styleToEnginePayload() {
        const { type, tension, radiusMode, radiusValue, linearStyle, pointHandling, nurbsDegree, nurbsMixedSide, smoothingAmount, smoothingQuality } = this.state.style;
        if (type === 'fractal') {
            const controls = this._normalizeFractalControlPoints(
                this.state.style.fractalControlPoints,
                this.state.style.fractalPointCount
            );
            return {
                type: 'fractal',
                nurbs_knots: controls.map((pt) => Number(pt.u)),
                nurbs_weights: controls.map((pt) => Number(pt.v)),
                radius_value: FRACTAL_MIN_SEGMENT_PX
            };
        }
        if (type === 'smoothing') {
            return {
                type: 'smoothing',
                tension: Number(smoothingAmount ?? 0.5),
                corner_handling: pointHandling,
                nurbs_side: nurbsMixedSide === 'right' ? 'right' : 'left',
                nurbs_degree: Math.max(1, Math.min(5, Math.round(Number(smoothingQuality ?? 1))))
            };
        }
        const useNurbs = type === 'spline' && (pointHandling === 'control' || pointHandling === 'mixed');
        const mappedType = type === 'radius'
            ? 'circular_arc'
            : (type === 'linear' ? 'linear' : (useNurbs ? 'nurbs' : 'cubic_spline'));
        const mappedMode = radiusMode === 'absolute'
            ? 'absolute'
            : (radiusMode === 'fixed' ? 'fixed' : 'relative');
        return {
            type: mappedType,
            tension: Number(tension ?? 0.5),
            radius_mode: mappedMode,
            radius_value: Number(radiusValue ?? 0),
            linear_style: linearStyle === 'arrows' ? 'arrows' : 'lines',
            linear_arrow_end_mode: this._legacyArrowEndModeFromStyle(this.state.style) === 'endpoint'
                ? 'endpoint'
                : (this._legacyArrowEndModeFromStyle(this.state.style) === '2radius' ? 'two_radius' : 'radius'),
            nurbs_degree: useNurbs ? Math.max(2, Math.min(5, Math.round(Number(nurbsDegree ?? 3)))) : undefined,
            nurbs_point_mode: useNurbs ? (pointHandling === 'mixed' ? 'mixed' : 'control_only') : undefined,
            nurbs_mixed_rule: useNurbs && pointHandling === 'mixed' ? 'convex_anchor_concave_control' : undefined,
            nurbs_side: useNurbs && pointHandling === 'mixed'
                ? (nurbsMixedSide === 'right' ? 'right' : 'left')
                : undefined
        };
    }

    _legacyArrowEndModeFromStyle(style = this.state.style) {
        const mode = style.linearArrowMode === 'absolute' ? 'absolute' : 'relative';
        if (mode === 'relative') {
            const relMode = style.linearArrowRelativeMode === 'over' ? 'over' : 'end';
            const relValue = clamp01(Number(style.linearArrowRelativeValue ?? 0));
            if (relMode === 'over' || relValue <= 0.15) return 'endpoint';
            if (relValue <= 0.35) return 'radius';
            return '2radius';
        }
        const absMode = style.linearArrowAbsoluteMode === 'length' ? 'length' : 'dist';
        const absValue = Number(style.linearArrowAbsoluteValue ?? 1);
        if (absMode === 'dist') {
            if (absValue <= 0.5) return 'endpoint';
            if (absValue <= 1.5) return 'radius';
            return '2radius';
        }
        if (absValue <= 2) return 'endpoint';
        if (absValue <= 3.5) return 'radius';
        return '2radius';
    }

    _sampleWithEngine(points, closed) {
        if (!this.engineInterpolation) {
            throw new Error('Wasm engine interpolation is not initialized.');
        }
        if (points.length < 2) return points;
        const vertices = points.map((pt) => ({ x: pt.x, y: pt.y }));
        const edges = [];
        for (let i = 0; i < points.length - 1; i++) {
            edges.push({ from: i, to: i + 1 });
        }
        if (closed) {
            edges.push({ from: points.length - 1, to: 0 });
        }
        const type = this.state.style.type;
        const samplesPerSegment = (type === 'fractal' || type === 'smoothing')
            ? ((type === 'smoothing' && Number(this.state.style.smoothingQuality) <= 1) ? 1 : 2)
            : PREVIEW_SAMPLES_PER_SEGMENT;
        const payload = {
            graph: { vertices, edges },
            style: this._styleToEnginePayload(),
            samples_per_segment: samplesPerSegment
        };
        const result = this.engineInterpolation(payload);
        if (!result || typeof result === 'string') {
            throw new Error(`Engine interpolation failed: ${typeof result === 'string' ? result : 'empty response'}`);
        }
        if (!Array.isArray(result.paths) || !result.paths.length) {
            throw new Error('Engine interpolation returned no paths.');
        }
        const first = result.paths[0];
        if (!first || !Array.isArray(first.points)) {
            throw new Error('Engine interpolation response missing path points.');
        }
        return first.points.map((pt) => ({ x: pt.x, y: pt.y }));
    }

    _getInterpolatedPoints(points, closed, referenceScale = 1) {
        const _ = referenceScale;
        return this._sampleWithEngine(points, closed);
    }

    _getArrowEndModeIconSvg(mode) {
        const tipX = mode === 'endpoint' ? 22 : (mode === '2radius' ? 14 : 18);
        const baseX = tipX - 6;
        return `
            <svg viewBox="0 0 26 16" width="26" height="16" class="arrow-end-mode-icon" aria-hidden="true">
                <circle cx="22" cy="8" r="3" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2 2"></circle>
                <line x1="3" y1="8" x2="${baseX}" y2="8" stroke="#e2e8f0" stroke-width="1.6" stroke-linecap="round"></line>
                <path d="M ${tipX} 8 L ${baseX} 5 L ${baseX} 11 Z" fill="#e2e8f0"></path>
            </svg>
        `;
    }

    _buildControlCatmullTargets(points, closed) {
        if (points.length < 2) return points;
        const result = [];
        const count = points.length;
        const last = closed ? count : count - 1;
        if (!closed) {
            result.push(points[0]);
        }
        for (let i = 0; i < last; i++) {
            const a = points[i];
            const b = points[(i + 1) % count];
            result.push({
                x: (a.x + b.x) * 0.5,
                y: (a.y + b.y) * 0.5
            });
        }
        if (!closed) {
            result.push(points[count - 1]);
        }
        return result;
    }

    _buildMixedCatmullTargets(points, closed) {
        if (points.length < 2) return points;
        const orientation = this._getPathOrientation(points, closed);
        const result = [];
        const count = points.length;
        for (let i = 0; i < count; i++) {
            if (!closed && (i === 0 || i === count - 1)) {
                result.push(points[i]);
                continue;
            }
            const prev = points[(i - 1 + count) % count];
            const current = points[i];
            const next = points[(i + 1) % count];
            const cross = (current.x - prev.x) * (next.y - current.y) - (current.y - prev.y) * (next.x - current.x);
            const isConvex = orientation >= 0 ? cross >= 0 : cross <= 0;
            if (isConvex) {
                result.push(current);
            } else {
                result.push({
                    x: (prev.x + current.x) * 0.5,
                    y: (prev.y + current.y) * 0.5
                });
                result.push({
                    x: (current.x + next.x) * 0.5,
                    y: (current.y + next.y) * 0.5
                });
            }
        }
        return result;
    }

    _buildMixedControlPoints(points, closed, degree) {
        if (points.length < 3) return points;
        const orientation = this._getPathOrientation(points, closed);
        const extraCount = Math.max(0, degree - 1);
        const result = [];
        const last = closed ? points.length : points.length - 1;
        for (let i = 0; i < points.length; i++) {
            const prevIndex = (i - 1 + points.length) % points.length;
            const nextIndex = (i + 1) % points.length;
            const prev = points[prevIndex];
            const current = points[i];
            const next = points[nextIndex];
            const cross = (current.x - prev.x) * (next.y - current.y) - (current.y - prev.y) * (next.x - current.x);
            const isEndpoint = !closed && (i === 0 || i === points.length - 1);
            const isConvex = isEndpoint || (orientation >= 0 ? cross >= 0 : cross <= 0);
            result.push(current);
            if (isConvex) {
                for (let j = 0; j < extraCount; j++) {
                    result.push({ x: current.x, y: current.y });
                }
            }
        }
        return result;
    }

    _getPathOrientation(points, closed) {
        if (!closed) return 1;
        let area = 0;
        for (let i = 0; i < points.length; i++) {
            const next = points[(i + 1) % points.length];
            area += points[i].x * next.y - next.x * points[i].y;
        }
        return area;
    }

    _getPresetPoints(presetId) {
        const presetData = this.state.previewPoints[presetId];
        if (presetId === 'open' && presetData && presetData.vertices && presetData.edges) {
            // Keep the open preset deterministic as a single open chain.
            return {
                paths: [{
                    closed: false,
                    points: presetData.vertices
                }]
            };
        }
        if (presetData && presetData.vertices && presetData.edges) {
            return this._buildPathsFromGraph(presetData);
        }
        if (presetId === 'open') {
            return {
                paths: this.state.previewPoints.open.map(points => ({
                    closed: false,
                    points
                }))
            };
        }

        if (presetId === 'branching') {
            const stem = this.state.previewPoints.branching[0] || [];
            if (stem.length < 4) {
                return {
                    paths: this.state.previewPoints.branching.map(points => ({
                        closed: false,
                        points
                    }))
                };
            }
            // Phantom-point split model:
            // stem a-b-c-d -> sample with a-b-c-d, draw only a-b-c (phantom d)
            // branch d-e-f -> sample with b-c-d-e-f, draw c-d-e-f (phantom b)
            // branch d-g-h -> sample with b-c-d-g-h, draw c-d-g-h (phantom b)
            const b = stem[stem.length - 3];
            const c = stem[stem.length - 2];
            const d = stem[stem.length - 1];
            const branchPaths = this.state.previewPoints.branching.slice(1).map((branch) => {
                const head = branch[0];
                const startsAtJunction = head
                    && Math.abs(head.x - d.x) < 1e-6
                    && Math.abs(head.y - d.y) < 1e-6;
                const tail = startsAtJunction ? branch.slice(1) : branch;
                return {
                    closed: false,
                    points: [b, c, d, ...tail],
                    trimFromPoint: c,
                    forceTrim: true,
                    trueEndpointStart: false,
                    trueEndpointEnd: true
                };
            });
            return {
                paths: [
                    {
                        closed: false,
                        points: stem,
                        trimToPoint: c,
                        forceTrim: true,
                        trueEndpointStart: true,
                        trueEndpointEnd: false
                    },
                    ...branchPaths
                ]
            };
        }

        if (presetId === 'branching4') {
            const data = this.state.previewPoints.branching4;
            if (!data) return { paths: [] };
            const incoming = data.in || [];
            const outgoing = data.out || [];
            const normalizeDir = (v) => {
                const len = Math.hypot(v.x, v.y);
                return len > 1e-6 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
            };
            const inDirs = incoming.map(path => {
                if (path.length < 2) return null;
                const junction = path[path.length - 1];
                const prev = path[path.length - 2];
                return normalizeDir({ x: junction.x - prev.x, y: junction.y - prev.y });
            });
            const outDirs = outgoing.map(path => {
                if (path.length < 2) return null;
                const junction = path[0];
                const next = path[1];
                return normalizeDir({ x: next.x - junction.x, y: next.y - junction.y });
            });
            if (incoming.length !== 1 && outgoing.length !== 1) {
                // Pair by smallest overall turn (global 2x2 assignment) so the
                // two paths cross naturally through the junction.
                const paths = [];
                if (incoming.length === 2 && outgoing.length === 2) {
                    const lockPairing = this.dragState?.presetId === 'branching4' && this.dragState.pointIndex !== null;
                    const applyPairingLock = (pairing) => {
                        if (!lockPairing) {
                            this.branching4Pairing = null;
                            return pairing;
                        }
                        if (!this.branching4Pairing) {
                            this.branching4Pairing = pairing;
                        }
                        return this.branching4Pairing;
                    };
                    const inOutDirs = inDirs.map(dir => dir ? { x: -dir.x, y: -dir.y } : null);
                    const angleOf = (dir) => Math.atan2(dir.y, dir.x);
                    const score = (iIdx, oIdx) => {
                        const inDir = inOutDirs[iIdx];
                        const outDir = outDirs[oIdx];
                        if (!inDir || !outDir) return -Infinity;
                        return inDir.x * outDir.x + inDir.y * outDir.y;
                    };
                    const cross = (a, b) => a.x * b.y - a.y * b.x;
                    const dirs = [
                        { type: 'in', idx: 0, dir: inOutDirs[0] },
                        { type: 'in', idx: 1, dir: inOutDirs[1] },
                        { type: 'out', idx: 0, dir: outDirs[0] },
                        { type: 'out', idx: 1, dir: outDirs[1] }
                    ].filter(item => item.dir);
                    const ordered = dirs.slice().sort((a, b) => angleOf(a.dir) - angleOf(b.dir));
                    const inIndices = ordered
                        .map((item, idx) => (item.type === 'in' ? idx : null))
                        .filter(idx => idx !== null);
                    const isAdjacentIn = inIndices.length === 2
                        && (Math.abs(inIndices[0] - inIndices[1]) === 1
                            || Math.abs(inIndices[0] - inIndices[1]) === 3);
                    const pairingScore = (pairing) => score(0, pairing[0]) + score(1, pairing[1]);
                    const pairA = [0, 1];
                    const pairB = [1, 0];
                    let pairing = pairA;
                    if (isAdjacentIn) {
                        const cyclicDistance = (fromIdx, toIdx) => {
                            const diff = Math.abs(fromIdx - toIdx);
                            return Math.min(diff, 4 - diff);
                        };
                        const indexOfOut = (outIdx) => ordered.findIndex(item => item.type === 'out' && item.idx === outIdx);
                        const indexOfIn = (inIdx) => ordered.findIndex(item => item.type === 'in' && item.idx === inIdx);
                        const distSum = (pair) => {
                            const a = cyclicDistance(indexOfIn(0), indexOfOut(pair[0]));
                            const b = cyclicDistance(indexOfIn(1), indexOfOut(pair[1]));
                            return a + b;
                        };
                        pairing = distSum(pairB) > distSum(pairA) ? pairB : pairA;
                    } else {
                        const scoreA = pairingScore(pairA);
                        const scoreB = pairingScore(pairB);
                        if (scoreB === scoreA && this.state.style.type === 'spline') {
                            const rightTurns = (pair) => {
                                const r0 = inOutDirs[0] && outDirs[pair[0]] ? Math.sign(cross(inOutDirs[0], outDirs[pair[0]])) : 0;
                                const r1 = inOutDirs[1] && outDirs[pair[1]] ? Math.sign(cross(inOutDirs[1], outDirs[pair[1]])) : 0;
                                return (r0 < 0 ? 1 : 0) + (r1 < 0 ? 1 : 0);
                            };
                            pairing = rightTurns(pairB) > rightTurns(pairA) ? pairB : pairA;
                        } else {
                            pairing = scoreB > scoreA ? pairB : pairA;
                        }
                    }
                    pairing = applyPairingLock(pairing);
                    incoming.forEach((inPath, inIdx) => {
                        const outIdx = pairing[inIdx];
                        const outPath = outgoing[outIdx];
                        const tail = outPath[0] === inPath[inPath.length - 1] ? outPath.slice(1) : outPath;
                        paths.push({ closed: false, points: [...inPath, ...tail] });
                    });
                    return { paths };
                }
                const usedOut = new Set();
                incoming.forEach((inPath, inIdx) => {
                    let bestOut = -1;
                    let bestDot = -Infinity;
                    const inDir = inDirs[inIdx];
                    outgoing.forEach((outPath, outIdx) => {
                        if (usedOut.has(outIdx)) return;
                        const outDir = outDirs[outIdx];
                        if (!inDir || !outDir) return;
                        const dot = inDir.x * outDir.x + inDir.y * outDir.y;
                        if (dot > bestDot) {
                            bestDot = dot;
                            bestOut = outIdx;
                        }
                    });
                    if (bestOut >= 0) {
                        usedOut.add(bestOut);
                        const outPath = outgoing[bestOut];
                        const tail = outPath[0] === inPath[inPath.length - 1] ? outPath.slice(1) : outPath;
                        paths.push({ closed: false, points: [...inPath, ...tail] });
                    } else {
                        paths.push({ closed: false, points: inPath });
                    }
                });
                outgoing.forEach((outPath, outIdx) => {
                    if (!usedOut.has(outIdx)) {
                        paths.push({ closed: false, points: outPath });
                    }
                });
                return { paths };
            }
            const paths = [];
            if (incoming.length === 1) {
                outgoing.forEach(outPath => {
                    const inPath = incoming[0];
                    const tail = outPath[0] === inPath[inPath.length - 1] ? outPath.slice(1) : outPath;
                    paths.push({ closed: false, points: [...inPath, ...tail] });
                });
            } else {
                incoming.forEach(inPath => {
                    const outPath = outgoing[0];
                    const tail = outPath[0] === inPath[inPath.length - 1] ? outPath.slice(1) : outPath;
                    paths.push({ closed: false, points: [...inPath, ...tail] });
                });
            }
            return { paths };
        }

        if (presetId === 'branching5') {
            const data = this.state.previewPoints.branching5;
            if (!data) return { paths: [] };
            const incoming = data.in || [];
            const outgoing = data.out || [];
            const paths = [
                ...incoming.map(points => ({ closed: false, points })),
                ...outgoing.map(points => ({ closed: false, points }))
            ];
            return { paths };
        }

        return {
            paths: [
                {
                    closed: true,
                    points: this.state.previewPoints.closed[0]
                }
            ]
        };
    }

    _buildPathsFromGraph(presetData) {
        const vertices = presetData.vertices || [];
        const edges = presetData.edges || [];
        if (!vertices.length || !edges.length) return { paths: [] };

        const adjacencyOut = new Map();
        const adjacencyIn = new Map();
        const undirectedDegree = new Map();
        edges.forEach(([from, to]) => {
            if (!adjacencyOut.has(from)) adjacencyOut.set(from, []);
            adjacencyOut.get(from).push(to);
            if (!adjacencyIn.has(to)) adjacencyIn.set(to, []);
            adjacencyIn.get(to).push(from);
            undirectedDegree.set(from, (undirectedDegree.get(from) || 0) + 1);
            undirectedDegree.set(to, (undirectedDegree.get(to) || 0) + 1);
        });

        const undirectedAdjacency = new Map();
        const undirectedEdges = new Map();
        const undirectedKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
        edges.forEach(([from, to]) => {
            const key = undirectedKey(from, to);
            if (!undirectedEdges.has(key)) {
                undirectedEdges.set(key, [from, to]);
            }
            if (!undirectedAdjacency.has(from)) undirectedAdjacency.set(from, new Set());
            if (!undirectedAdjacency.has(to)) undirectedAdjacency.set(to, new Set());
            undirectedAdjacency.get(from).add(to);
            undirectedAdjacency.get(to).add(from);
        });
        const getAngle = (from, to) => Math.atan2(vertices[to].y - vertices[from].y, vertices[to].x - vertices[from].x);
        const neighborOrder = new Map();
        vertices.forEach((_, vIdx) => {
            const neighbors = [...(undirectedAdjacency.get(vIdx) || [])];
            neighbors.sort((a, b) => getAngle(vIdx, a) - getAngle(vIdx, b));
            neighborOrder.set(vIdx, neighbors);
        });
        const nextRightNeighbor = (from, at) => {
            const neighbors = neighborOrder.get(at) || [];
            if (!neighbors.length) return null;
            const idx = neighbors.indexOf(from);
            if (idx < 0) return neighbors[0];
            return neighbors[(idx - 1 + neighbors.length) % neighbors.length];
        };
        const traceFaces = () => {
            const faces = [];
            const visitedHalfEdges = new Set();
            const halfKey = (a, b) => `${a}->${b}`;
            undirectedEdges.forEach(([a, b]) => {
                [[a, b], [b, a]].forEach(([startA, startB]) => {
                    const startKey = halfKey(startA, startB);
                    if (visitedHalfEdges.has(startKey)) return;
                    const face = [];
                    let from = startA;
                    let to = startB;
                    let guard = 0;
                    while (guard++ < edges.length * 4) {
                        visitedHalfEdges.add(halfKey(from, to));
                        face.push(from);
                        const next = nextRightNeighbor(from, to);
                        if (next === null || next === undefined) break;
                        const nextFrom = to;
                        const nextTo = next;
                        from = nextFrom;
                        to = nextTo;
                        if (from === startA && to === startB) {
                            break;
                        }
                    }
                    if (face.length >= 3) {
                        faces.push(face);
                    }
                });
            });
            return faces;
        };
        const faces = traceFaces();
        const faceKey = (face) => [...face].sort((a, b) => a - b).join('_');
        const uniqueFaces = [];
        const seenFaces = new Set();
        faces.forEach(face => {
            const key = faceKey(face);
            if (seenFaces.has(key)) return;
            seenFaces.add(key);
            uniqueFaces.push(face);
        });
        const faceArea = (face) => {
            let area = 0;
            for (let i = 0; i < face.length; i++) {
                const a = vertices[face[i]];
                const b = vertices[face[(i + 1) % face.length]];
                area += a.x * b.y - b.x * a.y;
            }
            return area * 0.5;
        };
        let boundaryCycle = null;
        if (uniqueFaces.length) {
            let best = null;
            let bestArea = -Infinity;
            uniqueFaces.forEach(face => {
                const area = Math.abs(faceArea(face));
                if (area > bestArea) {
                    bestArea = area;
                    best = face;
                }
            });
            boundaryCycle = best;
        }
        const boundaryVertices = new Set(boundaryCycle || []);
        const boundaryEdges = new Set();
        if (boundaryCycle && boundaryCycle.length >= 2) {
            for (let i = 0; i < boundaryCycle.length; i++) {
                const a = boundaryCycle[i];
                const b = boundaryCycle[(i + 1) % boundaryCycle.length];
                boundaryEdges.add(undirectedKey(a, b));
            }
        }

        const pairingMap = new Map();
        const angleOf = (dir) => Math.atan2(dir.y, dir.x);
        const cross = (a, b) => a.x * b.y - a.y * b.x;
        const dot = (a, b) => a.x * b.x + a.y * b.y;
        const toVec = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
        const norm = (v) => {
            const len = Math.hypot(v.x, v.y);
            return len > 1e-6 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
        };

        vertices.forEach((_, vIdx) => {
            if (boundaryVertices.has(vIdx)) return;
            const incoming = adjacencyIn.get(vIdx) || [];
            const outgoing = adjacencyOut.get(vIdx) || [];
            if (incoming.length === 2 && outgoing.length === 2) {
                const inDirs = incoming.map(from => norm(toVec(vertices[from], vertices[vIdx])));
                const outDirs = outgoing.map(to => norm(toVec(vertices[vIdx], vertices[to])));
                const inOutDirs = inDirs.map(dir => ({ x: -dir.x, y: -dir.y }));
                const score = (iIdx, oIdx) => dot(inOutDirs[iIdx], outDirs[oIdx]);
                const pairA = [0, 1];
                const pairB = [1, 0];
                const scoreA = score(0, 0) + score(1, 1);
                const scoreB = score(0, 1) + score(1, 0);
                const dirs = [
                    { type: 'in', idx: 0, dir: inOutDirs[0] },
                    { type: 'in', idx: 1, dir: inOutDirs[1] },
                    { type: 'out', idx: 0, dir: outDirs[0] },
                    { type: 'out', idx: 1, dir: outDirs[1] }
                ].filter(item => item.dir);
                const ordered = dirs.slice().sort((a, b) => angleOf(a.dir) - angleOf(b.dir));
                const inIndices = ordered
                    .map((item, idx) => (item.type === 'in' ? idx : null))
                    .filter(idx => idx !== null);
                const isAdjacentIn = inIndices.length === 2
                    && (Math.abs(inIndices[0] - inIndices[1]) === 1
                        || Math.abs(inIndices[0] - inIndices[1]) === 3);
                let pairing = pairA;
                if (isAdjacentIn) {
                    const cyclicDistance = (fromIdx, toIdx) => {
                        const diff = Math.abs(fromIdx - toIdx);
                        return Math.min(diff, 4 - diff);
                    };
                    const indexOfOut = (outIdx) => ordered.findIndex(item => item.type === 'out' && item.idx === outIdx);
                    const indexOfIn = (inIdx) => ordered.findIndex(item => item.type === 'in' && item.idx === inIdx);
                    const distSum = (pair) => {
                        const a = cyclicDistance(indexOfIn(0), indexOfOut(pair[0]));
                        const b = cyclicDistance(indexOfIn(1), indexOfOut(pair[1]));
                        return a + b;
                    };
                    pairing = distSum(pairB) > distSum(pairA) ? pairB : pairA;
                } else if (scoreB === scoreA && this.state.style.type === 'spline') {
                    const rightTurns = (pair) => {
                        const r0 = Math.sign(cross(inOutDirs[0], outDirs[pair[0]]));
                        const r1 = Math.sign(cross(inOutDirs[1], outDirs[pair[1]]));
                        return (r0 < 0 ? 1 : 0) + (r1 < 0 ? 1 : 0);
                    };
                    pairing = rightTurns(pairB) > rightTurns(pairA) ? pairB : pairA;
                } else {
                    pairing = scoreB > scoreA ? pairB : pairA;
                }
                incoming.forEach((from, inIdx) => {
                    const to = outgoing[pairing[inIdx]];
                    pairingMap.set(`${from}->${vIdx}`, to);
                });
            }
        });

        const sources = vertices
            .map((_, idx) => idx)
            .filter(idx => (adjacencyIn.get(idx) || []).length === 0);
        const paths = [];
        const visited = new Set();
        const edgeKey = (a, b) => `${a}->${b}`;
        const isBoundaryEdge = (a, b) => boundaryEdges.has(undirectedKey(a, b));
        const walk = (from, to, path, allowBoundaryTraversal = false) => {
            const key = edgeKey(from, to);
            if (visited.has(key)) {
                paths.push([...path, to]);
                return;
            }
            visited.add(key);
            const currentPath = [...path, to];
            if (!allowBoundaryTraversal && boundaryVertices.has(to) && currentPath.length > 1) {
                paths.push(currentPath);
                return;
            }
            const outgoing = adjacencyOut.get(to) || [];
            const incoming = adjacencyIn.get(to) || [];
            const pairedNext = pairingMap.get(`${from}->${to}`);
            if (pairedNext !== undefined) {
                if (currentPath.includes(pairedNext)) {
                    paths.push(currentPath);
                    return;
                }
                walk(to, pairedNext, currentPath);
                return;
            }
            if (outgoing.length === 0) {
                paths.push(currentPath);
                return;
            }
            if (incoming.length === 2 && outgoing.length > 2) {
                // Clamp at 2->m (m>2): treat junction as an endpoint.
                paths.push(currentPath);
                return;
            }
            if (incoming.length === 1 && outgoing.length > 1) {
                outgoing.forEach(next => {
                    if (!allowBoundaryTraversal && isBoundaryEdge(to, next)) return;
                    walk(to, next, currentPath, allowBoundaryTraversal);
                });
                return;
            }
            if (incoming.length <= 1 && outgoing.length === 1) {
                if (!allowBoundaryTraversal && isBoundaryEdge(to, outgoing[0])) {
                    paths.push(currentPath);
                    return;
                }
                walk(to, outgoing[0], currentPath, allowBoundaryTraversal);
                return;
            }
            // Default: branch on all outgoing.
            outgoing.forEach(next => {
                if (!allowBoundaryTraversal && isBoundaryEdge(to, next)) return;
                walk(to, next, currentPath, allowBoundaryTraversal);
            });
        };

        let boundaryPathRef = null;
        if (boundaryCycle && boundaryCycle.length >= 3) {
            boundaryPathRef = [...boundaryCycle, boundaryCycle[0]];
            paths.push(boundaryPathRef);
            edges.forEach(([from, to]) => {
                if (isBoundaryEdge(from, to)) {
                    visited.add(edgeKey(from, to));
                }
            });
            edges.forEach(([from, to]) => {
                const key = edgeKey(from, to);
                if (visited.has(key)) return;
                walk(from, to, [from], false);
            });
        } else if (sources.length) {
            sources.forEach(start => {
                const outgoing = adjacencyOut.get(start) || [];
                outgoing.forEach(next => walk(start, next, [start]));
            });
        } else {
            const start = edges[0]?.[0];
            if (start !== undefined) {
                const outgoing = adjacencyOut.get(start) || [];
                outgoing.forEach(next => walk(start, next, [start]));
            }
        }

        const pathObjects = paths.map(path => {
            const isClosed = path.length > 2 && path[0] === path[path.length - 1];
            const pathIndices = isClosed ? path.slice(0, -1) : path;
            const points = pathIndices.map(idx => vertices[idx]);
            const startIdx = pathIndices[0];
            const endIdx = pathIndices[pathIndices.length - 1];
            const startDegree = undirectedDegree.get(startIdx) || 0;
            const endDegree = undirectedDegree.get(endIdx) || 0;
            const isBoundary = path === boundaryPathRef;
            return {
                closed: isClosed,
                points,
                isBoundary,
                trueEndpointStart: startDegree === 1,
                trueEndpointEnd: endDegree === 1,
                trimFromPoint: (!isBoundary && this.state.style.type === 'spline' && startDegree > 2) ? vertices[startIdx] : null,
                trimToPoint: (!isBoundary && this.state.style.type === 'spline' && endDegree > 2) ? vertices[endIdx] : null,
                forceTrim: !isBoundary && this.state.style.type === 'spline'
            };
        });

        const boundaryKey = boundaryCycle ? faceKey(boundaryCycle) : null;
        const interiorFaces = uniqueFaces.filter(face => faceKey(face) !== boundaryKey);
        return { paths: pathObjects, vertices, faces: interiorFaces };
    }

    _handlePreviewMouseDown(event, presetId) {
        if (presetId !== this.state.style.preset) return;
        const hit = this._findHitPoint(event, presetId);
        if (!hit) return;
        this.dragState = hit;
        event.preventDefault();
    }

    _handlePreviewMouseMove(event) {
        const { presetId, pathIndex, pointIndex, vertexIndex, ioType, ioIndex } = this.dragState;
        if (presetId === null) return;
        const card = this.previewCards.get(presetId);
        if (!card) return;
        const { x, y } = this._getNormalizedPoint(event, card.canvas);
        const clamped = {
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y))
        };
        const presetData = this.state.previewPoints[presetId];
        if (presetData && presetData.in && presetData.out && ioType && Number.isInteger(ioIndex)) {
            const targetPaths = presetData[ioType];
            const targetPath = targetPaths?.[ioIndex];
            const targetPoint = targetPath?.[pointIndex];
            if (targetPoint) {
                targetPoint.x = clamped.x;
                targetPoint.y = clamped.y;
                this._requestPreviewRender();
            }
            return;
        }
        if (presetData && presetData.vertices && presetData.edges) {
            if (Number.isInteger(vertexIndex) && presetData.vertices[vertexIndex]) {
                presetData.vertices[vertexIndex].x = clamped.x;
                presetData.vertices[vertexIndex].y = clamped.y;
                if (presetData.pathOverrides) {
                    delete presetData.pathOverrides;
                }
                this._requestPreviewRender();
            }
            return;
        }
        const paths = (presetData && presetData.vertices && presetData.edges)
            ? presetData.pathOverrides?.map(path => path.points)
            : this.state.previewPoints[presetId];
        const targetPath = paths?.[pathIndex];
        if (!targetPath) return;

        const targetPoint = targetPath[pointIndex];
        if (targetPoint) {
            targetPoint.x = clamped.x;
            targetPoint.y = clamped.y;
        } else {
            targetPath[pointIndex] = clamped;
        }
        this._requestPreviewRender();
    }

    _handlePreviewMouseUp() {
        this.dragState = { presetId: null, pathIndex: null, pointIndex: null, vertexIndex: null, ioType: null, ioIndex: null };
        this.branching4Pairing = null;
    }

    _findHitPoint(event, presetId) {
        const card = this.previewCards.get(presetId);
        if (!card) return null;
        const canvas = card.canvas;
        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const padding = 16;
        const usableW = rect.width - padding * 2;
        const usableH = rect.height - padding * 2;
        const hitRadius = this.wrapper?.dataset.inputCoarse === 'true' ? 14 : 8;

        const presetData = this.state.previewPoints[presetId];
        if (presetData && presetData.in && presetData.out) {
            const rawPaths = [
                ...presetData.in.map((points, index) => ({ points, ioType: 'in', ioIndex: index })),
                ...presetData.out.map((points, index) => ({ points, ioType: 'out', ioIndex: index }))
            ];
            for (let p = 0; p < rawPaths.length; p++) {
                const { points, ioType, ioIndex } = rawPaths[p];
                for (let i = 0; i < points.length; i++) {
                    const px = padding + points[i].x * usableW;
                    const py = padding + points[i].y * usableH;
                    if (Math.hypot(mouseX - px, mouseY - py) <= hitRadius) {
                        return { presetId, pathIndex: p, pointIndex: i, vertexIndex: null, ioType, ioIndex };
                    }
                }
            }
            return null;
        }
        const paths = (presetData && presetData.vertices && presetData.edges)
            ? this._getPresetPoints(presetId).paths.map(path => path.points)
            : this.state.previewPoints[presetId];
        for (let p = 0; p < paths.length; p++) {
            const points = paths[p];
            for (let i = 0; i < points.length; i++) {
                const px = padding + points[i].x * usableW;
                const py = padding + points[i].y * usableH;
                if (Math.hypot(mouseX - px, mouseY - py) <= hitRadius) {
                    let vertexIndex = null;
                    if (presetData && presetData.vertices && presetData.edges) {
                        vertexIndex = presetData.vertices.indexOf(points[i]);
                        if (vertexIndex < 0) vertexIndex = null;
                    }
                    return { presetId, pathIndex: p, pointIndex: i, vertexIndex, ioType: null, ioIndex: null };
                }
            }
        }
        return null;
    }

    _getNormalizedPoint(event, canvas) {
        const rect = canvas.getBoundingClientRect();
        const padding = 16;
        const usableW = rect.width - padding * 2;
        const usableH = rect.height - padding * 2;
        const x = (event.clientX - rect.left - padding) / usableW;
        const y = (event.clientY - rect.top - padding) / usableH;
        return { x, y };
    }
}
