# interpolation-selector

Responsive 2D interpolation style selector and isolated 3D surface interpolation preview.

```js
import InterpolationSelector from 'interpolation-selector';
import 'selector/style.css';
import 'interpolation-selector/style.css';
```

The package is direct-browser ESM. Its shared shell, theme, focus lifecycle, and input-capability behavior come from the sibling `selector` package. Interpolation and geometry behavior stays local.

Compatibility is preserved for existing consumers through `interpolation-editor.js`, the `./interpolation-editor` export, and the `InterpolationEditor` named alias. Rename external imports when convenient; no immediate migration is required.

Run `npm test` for the 3D model tests. Open `test.html` through a local HTTP server for the responsive 2D/3D browser harness.
