import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';
import { loadIssues, type IssuesModel } from './model.ts';

export type { IssuesModel, IssueGroup } from './model.ts';

export default definePage<IssuesModel>({
  id: 'issues',
  title: 'Issues',
  icon: 'alert',
  order: 40,
  contractVersion: PAGE_CONTRACT_VERSION,
  filters: ['rangeDays', 'branch'],
  load: (ctx, params, signal) => loadIssues(ctx, params, signal),
  views: {
    classic: () => import('./classic-view.ts').then((m) => m.default),
  },
});
