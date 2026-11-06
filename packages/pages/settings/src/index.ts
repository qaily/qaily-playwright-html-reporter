import { PAGE_CONTRACT_VERSION, definePage } from '@qaily/contracts';

// The model is empty: the view reads and writes settings through ctx.settingsApi.
export default definePage<null>({
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  order: 1000,
  contractVersion: PAGE_CONTRACT_VERSION,
  load: async () => null,
  views: {
    classic: () => import('./settings-view.ts').then((m) => m.default),
  },
});
