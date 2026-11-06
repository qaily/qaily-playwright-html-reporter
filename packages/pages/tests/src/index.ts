import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';
import { loadTests, type TestsModel } from './model.ts';

export type { TestsModel, TestItem } from './model.ts';

export default definePage<TestsModel>({
  id: 'tests',
  title: 'Tests',
  icon: 'list',
  order: 50,
  contractVersion: PAGE_CONTRACT_VERSION,
  filters: ['rangeDays', 'branch'],
  load: (ctx, params) => loadTests(ctx, params),
  views: {
    classic: () => import('./classic-view.ts').then((m) => m.default),
  },
});
