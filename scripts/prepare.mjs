// npm runs `prepare` after `npm install` in this repo and when the package is installed straight from GitHub
// (`npm install github:qaily/qaily-playwright-html-reporter`). Builds dist/ and app/ once, if they are missing.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('dist/index.cjs') || !existsSync('app/index.html')) {
  execSync('npm run pkg:build', { stdio: 'inherit' });
}
