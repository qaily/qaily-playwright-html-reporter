import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';
import { loadHeatmap, type HeatmapModel } from './model.ts';

export type { HeatmapModel } from './model.ts';

export default definePage<HeatmapModel>({
  id: 'heatmap',
  title: 'Heat Map',
  icon: 'grid',
  order: 60,
  contractVersion: PAGE_CONTRACT_VERSION,
  filters: ['rangeDays', 'branch'],
  load: (ctx, params) => loadHeatmap(ctx, params),
  views: {
    classic: () => import('./classic-view.ts').then((m) => m.default),
  },
});
