import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';
import { loadWeekly, type WeeklyModel } from './model.ts';

export type { WeeklyModel, WeekDay, WeekRun } from './model.ts';

export default definePage<WeeklyModel>({
  id: 'weekly',
  title: 'Weekly',
  icon: 'calendar-week',
  order: 20,
  contractVersion: PAGE_CONTRACT_VERSION,
  filters: ['branch'],
  load: (ctx, params) => loadWeekly(ctx, params),
  views: {
    classic: () => import('./classic-view.ts').then((m) => m.default),
  },
});
