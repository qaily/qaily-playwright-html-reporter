import { AiService, AiStore, GitHubSettingsWriter } from '@qaily/ai';
import { ArtifactService } from '@qaily/artifacts';
import { DataService, NotesStore, clearCachedRollups, Router, SecretStore, SettingsService, ThemeManager, fetchServerStatus, loadTeamLayer, teamWriterFor } from '@qaily/core';
import { defineComponents } from '@qaily/ui';
import { AiDock } from './ai-dock.ts';
import { QailyShell } from './shell.ts';
import { THEMES } from './themes.ts';

async function boot(): Promise<void> {
  defineComponents();
  customElements.define('qaily-shell', QailyShell);
  customElements.define('qaily-ai-dock', AiDock);

  const base = new URL('./', document.baseURI);
  const dataUrl = new URL('data/', base);
  const [team, server] = await Promise.all([loadTeamLayer(dataUrl), fetchServerStatus(base)]);
  const secrets = new SecretStore();
  // On a static host (GitHub Pages) team settings are saved by committing data/settings.json.
  const settings: SettingsService = new SettingsService(
    team,
    teamWriterFor(server, base) ?? new GitHubSettingsWriter(() => settings.settings, secrets),
  );
  const artifacts = new ArtifactService({
    baseUrl: base,
    dataUrl,
    localServer: !!server?.artifacts,
    secrets,
    s3: () => settings.settings.connections.s3,
    // Reloading is what clears loaded report data from memory, including DuckDB's copies.
    onForget: () => {
      if (readsFromBucket) void clearCachedRollups().finally(() => location.reload());
    },
  });
  // A hosted report can read its data from the bucket. `qaily-report serve` always uses its own data folder.
  const { bucket, dataSource } = settings.settings.connections.s3;
  const readsFromBucket = !server?.artifacts && !!bucket && dataSource === 'bucket';
  const data = new DataService(
    dataUrl,
    readsFromBucket ? { signedUrl: (path) => artifacts.dataFileUrl(path), keepOnDevice: () => artifacts.keepsCredentialsOnDevice() } : null,
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
  };
  document.body.replaceChildren(shell);
}

boot().catch((err) => {
  console.error(err);
  document.body.textContent = `The report could not start: ${err instanceof Error ? err.message : err}`;
});
