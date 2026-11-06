// Theme registry. Skins are small and bundled; heavy theme views load lazily through ThemeModule.views.

import type { ThemeModule } from '@qaily/contracts';
import classic from '@qaily/theme-classic';
import darkOps from '@qaily/theme-dark-ops';
import chronoscope from '@qaily/theme-chronoscope';

// Skins are small and load with the app; heavy theme views (three.js) load only when shown.
export const THEMES: ThemeModule[] = [chronoscope, classic, darkOps];
