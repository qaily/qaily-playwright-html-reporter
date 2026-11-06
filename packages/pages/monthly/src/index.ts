import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';
import { loadMonthly, type MonthlyModel } from './model.ts';

export type { MonthlyModel } from './model.ts';

export default definePage<MonthlyModel>({
  id: 'monthly',
  title: 'Monthly',
  icon: 'calendar-month',
  order: 30,
  contractVersion: PAGE_CONTRACT_VERSION,
  filters: ['branch'],
  load: (ctx, params) => loadMonthly(ctx, params),
  views: {
    classic: () => import('./classic-view.ts').then((m) => m.default),
  },
});
