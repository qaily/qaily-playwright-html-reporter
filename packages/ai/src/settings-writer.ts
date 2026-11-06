import type { SecretsApi, Settings, SettingsLayer } from '@qaily/contracts';
import { GitHubRepo } from './github.ts';

/**
 * Saves team settings on a static host (GitHub Pages) by committing data/settings.json through the GitHub API.
 * Uses the GitHub settings and token as they are at save time.
 */
export class GitHubSettingsWriter {
  private settings: () => Settings;
  private secrets: SecretsApi;

  constructor(settings: () => Settings, secrets: SecretsApi) {
    this.settings = settings;
    this.secrets = secrets;
  }

  get label(): string {
    const gh = this.settings().connections.github;
    return `GitHub ${gh.owner}/${gh.repo}`;
  }

  available(): boolean {
    const gh = this.settings().connections.github;
    return !!(gh.owner && gh.repo && this.secrets.get('githubToken'));
  }

  async save(layer: SettingsLayer): Promise<void> {
    const gh = this.settings().connections.github;
    const token = this.secrets.get('githubToken');
    if (!gh.owner || !gh.repo || !token) throw new Error('Set the GitHub owner and repo (team) and store a GitHub token to save team settings.');
    const path = `${gh.dataPath.replace(/^\/+|\/+$/g, '')}/settings.json`.replace(/^\//, '');
    await new GitHubRepo({ ...gh, token }).commit('Update report team settings', async () => [
      { path, content: JSON.stringify(layer, null, 2) + '\n' },
    ]);
  }
}
