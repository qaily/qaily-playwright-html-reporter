import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';
import { loadMonitoring, type MonitoringModel } from './model.ts';

export type { MonitoringModel, LaneCard, RunCard } from './model.ts';

export default definePage<MonitoringModel>({
  id: 'monitoring',
  title: 'Monitoring',
  icon: 'activity',
  order: 10,
  contractVersion: PAGE_CONTRACT_VERSION,
  filters: ['rangeDays', 'branch'],
  // Monitoring shows the latest run per lane, so it looks back further than the site's default (Today).
  defaultRangeDays: 14,
  load: (ctx) => loadMonitoring(ctx),
  views: {
    classic: () => import('./classic-view.ts').then((m) => m.default),
  },
});
