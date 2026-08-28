import InterpolationEditor from './interpolation-selector.js';
import { createInterpolation3dEditor } from './interpolation-editor-3d.js';

const previewTopology = {
    points: [
        [-1.5, -1, -0.7],
        [1.4, -1.1, -0.4],
        [1.6, 1.1, 0.8],
        [-1.2, 1.2, 0.5],
        [0, 0, 2.1]
    ],
    add_simplices: {
        edges: [
            { vertices: [0, 1], path: [[-1.5, -1, -0.7], [0, -1.35, -0.5], [1.4, -1.1, -0.4]] },
            [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]
        ],
        faces: [
            { id: 'front', vertices: [0, 1, 4] },
            { id: 'right', vertices: [1, 2, 4] },
            { id: 'back', vertices: [2, 3, 4] },
            { id: 'left', vertices: [3, 0, 4] },
            { id: 'base', vertices: [0, 3, 2, 1] }
        ]
    }
};

document.addEventListener('DOMContentLoaded', () => {
    const openEditorButton = document.getElementById('open-editor-button');
    const open3dEditorButton = document.getElementById('open-3d-editor-button');
    const outputDisplayWrapper = document.getElementById('output-display-wrapper');
    const outputDisplay = document.getElementById('output-display');
    
    let currentInterpolationStyle = null;

    async function ensureWasmBridge() {
        if (globalThis.vektorWasm && typeof globalThis.vektorWasm.compute_interpolation === 'function') {
            return;
        }

        const candidates = ['./vektor_wasm/vektor.js'];

        let lastError = null;
        for (const modulePath of candidates) {
            try {
                const wasmModule = await import(modulePath);
                if (typeof wasmModule.default !== 'function' || typeof wasmModule.compute_interpolation !== 'function') {
                    throw new Error(`Module does not expose expected wasm API: ${modulePath}`);
                }
                await wasmModule.default();
                globalThis.vektorWasm = {
                    compute_interpolation(payload) {
                        return wasmModule.compute_interpolation(payload);
                    }
                };
                console.info(`Loaded real vektor WASM bridge from ${modulePath}`);
                return;
            } catch (error) {
                lastError = error;
            }
        }

        throw new Error(`Failed to load real vektor WASM bridge. Last error: ${lastError?.message || lastError}`);
    }

    async function setup() {
        await ensureWasmBridge();
        const editor = new InterpolationEditor({
            container: document.body,
            engineWasmApi: globalThis.vektorWasm,
            onSelect: (style) => {
                console.log('Style saved:', style);
                currentInterpolationStyle = style;
                displayStyleObject(currentInterpolationStyle);
            }
        });
        editor.initialize();

        const editor3d = createInterpolation3dEditor({
            getTopology: () => previewTopology
        });
        editor3d.mount(document.body);
        open3dEditorButton.addEventListener('click', () => editor3d.open());

        openEditorButton.addEventListener('click', () => {
            editor.show();
        });

        outputDisplayWrapper.addEventListener('dblclick', () => {
            editor.show(currentInterpolationStyle);
        });
    }

    setup().catch((error) => {
        console.error('Failed to initialize interpolation editor wasm dependency', error);
        outputDisplay.textContent = `WASM init failed: ${error?.message || error}`;
        openEditorButton.disabled = true;
    });

    /**
     * Displays the style object as a formatted JSON string.
     * @param {object} style - The interpolation style object from the editor.
     */
    function displayStyleObject(style) {
        if (style) {
            outputDisplay.textContent = JSON.stringify(style, null, 2);
        } else {
            outputDisplay.textContent = 'No style saved yet.';
        }
    }
});
