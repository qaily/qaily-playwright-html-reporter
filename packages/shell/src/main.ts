import { AiService, AiStore, GitHubSettingsWriter } from '@qaily/ai';
import { ArtifactService, BucketTeamSettings } from '@qaily/artifacts';
import {
  DataService,
  NotesStore,
  clearCachedRollups,
  Router,
  SecretStore,
  SettingsService,
  ThemeManager,
  fetchServerStatus,
  loadTeamLayer,
  personalSettingsKey,
  teamWriterFor,
} from '@qaily/core';
import { DEFAULT_SETTINGS } from '@qaily/contracts';
import { defineComponents } from '@qaily/ui';
import { AiDock } from './ai-dock.ts';
import { QailyShell, personalFolder, type DataLocation } from './shell.ts';
import { THEMES } from './themes.ts';

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');

async function boot(): Promise<void> {
  defineComponents();
  customElements.define('qaily-shell', QailyShell);
  customElements.define('qaily-ai-dock', AiDock);

  const base = new URL('./', document.baseURI);
  const dataUrl = new URL('data/', base);
  const [team, server] = await Promise.all([loadTeamLayer(dataUrl), fetchServerStatus(base)]);
  const secrets = new SecretStore();
  // Each report on a host keeps its own personal settings, such as the bucket location it looks at.
  const settings = new SettingsService(team, null, DEFAULT_SETTINGS, personalSettingsKey(base.pathname));

  // Where the data comes from is fixed for the page's life: changing it (personally or for the team) asks for a
  // reload, so the catalog, rollups and attachment links never mix two locations.
  const s3AtStart = settings.settings.connections.s3;
  const location: DataLocation = {
    dataSource: s3AtStart.dataSource,
    prefix: s3AtStart.prefix,
    dataPrefix: s3AtStart.dataPrefix,
    personal: server?.artifacts ? null : personalFolder(s3AtStart, settings.resolved.sources),
  };
  const readsFromBucket = !server?.artifacts && !!s3AtStart.bucket && location.dataSource === 'bucket';

  const artifacts = new ArtifactService({
    baseUrl: base,
    dataUrl,
    localServer: !!server?.artifacts,
    secrets,
    s3: () => ({ ...settings.settings.connections.s3, dataSource: location.dataSource, prefix: location.prefix, dataPrefix: location.dataPrefix }),
    // Reloading is what clears loaded report data from memory, including DuckDB's copies.
    onForget: () => {
      if (readsFromBucket) void clearCachedRollups().finally(() => window.location.reload());
    },
  });

  // A report reading from a bucket also takes its team settings from there (team-settings.json in the data folder),
  // so another data folder brings its own lanes and rules, and Save for team writes them back there.
  const where = `${s3AtStart.bucket}/${trimSlashes(location.dataPrefix)}`;
  const bucketTeam = readsFromBucket ? new BucketTeamSettings(artifacts, () => where) : null;
  settings.setWriter(teamWriterFor(server, base) ?? bucketTeam ?? new GitHubSettingsWriter(() => settings.settings, secrets));
  const loadBucketTeam = async () => {
    if (bucketTeam) settings.setDataLayer(await bucketTeam.load());
  };
  await loadBucketTeam();
  artifacts.subscribe(() => void loadBucketTeam());

  const data = new DataService(
    dataUrl,
    readsFromBucket
      ? { scope: where, signedUrl: (path) => artifacts.dataFileUrl(path), keepOnDevice: () => artifacts.keepsCredentialsOnDevice() }
      : null,
  );
  // Tab-only credentials end with the tab, without any event: rollups on the device must not outlive them.
  if (!readsFromBucket || !artifacts.keepsCredentialsOnDevice()) void clearCachedRollups();

  const shell = document.createElement('qaily-shell') as QailyShell;
  shell.services = {
    data,
    settings,
    secrets,
    artifacts,
    ai: new AiService({
      baseUrl: base,
      data,
      artifacts,
      secrets,
      settings: () => settings.settings,
      store: new AiStore(dataUrl),
      localWrites: !!server?.writes,
    }),
    notes: new NotesStore(),
    themes: new ThemeManager(THEMES),
    router: new Router(),
    location,
  };
  document.body.replaceChildren(shell);
}

boot().catch((err) => {
  console.error(err);
  document.body.textContent = `The report could not start: ${err instanceof Error ? err.message : err}`;
});
