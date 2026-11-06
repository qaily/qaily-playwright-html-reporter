import { defineTheme } from '@qaily/contracts';
import { css } from './skin.ts';

export default defineTheme({
  id: 'chronoscope',
  label: 'Chronoscope',
  css,
  forcedColorScheme: 'dark',
  views: {
    // three.js is loaded only when this view is shown.
    monitoring: { dials: () => import('./chronoscope-view.ts').then((m) => m.default) },
    weekly: { carousel: () => import('./weekly-view.ts').then((m) => m.default) },
    monthly: { carousel: () => import('./monthly-view.ts').then((m) => m.default) },
  },
  preferredViews: { monitoring: 'dials', weekly: 'carousel', monthly: 'carousel' },
});
