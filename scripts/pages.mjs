import { copyFileSync, writeFileSync } from 'node:fs';
// GitHub Pages serves this shell for deep links. Vite emits absolute base-prefixed assets.
copyFileSync('dist/index.html', 'dist/404.html');
writeFileSync('dist/.nojekyll', '');
