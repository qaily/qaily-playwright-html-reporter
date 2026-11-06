// Page registry. Adding a page = one folder under packages/pages + one entry here.
// Each loader is a dynamic import, so every page is its own chunk and can fail on its own.

import type { PageModule } from '@qaily/contracts';

export interface PageEntry {
  id: string;
  title: string;
  icon: string;
  load: () => Promise<{ default: PageModule<any> }>;
}

export const PAGES: PageEntry[] = [
  { id: 'monitoring', title: 'Monitoring', icon: 'activity', load: () => import('@qaily/page-monitoring') },
  { id: 'weekly', title: 'Weekly', icon: 'calendar-week', load: () => import('@qaily/page-weekly') },
  { id: 'monthly', title: 'Monthly', icon: 'calendar-month', load: () => import('@qaily/page-monthly') },
  { id: 'issues', title: 'Issues', icon: 'alert', load: () => import('@qaily/page-issues') },
  { id: 'tests', title: 'Tests', icon: 'list', load: () => import('@qaily/page-tests') },
  { id: 'heatmap', title: 'Heat Map', icon: 'grid', load: () => import('@qaily/page-heatmap') },
  { id: 'settings', title: 'Settings', icon: 'settings', load: () => import('@qaily/page-settings') },
];
