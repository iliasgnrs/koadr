import Cookies from 'js-cookie';
import { atom, computed } from 'nanostores';
import { loadConnections, saveConnectionToAccount, deleteConnectionFromAccount } from '~/lib/connections-client';
import { gitHubApiService } from '~/lib/services/githubApiService';
import { logStore } from '~/lib/stores/logs';
import type { GitHubConnection } from '~/types/GitHub';
import { calculateStatsSummary } from '~/utils/githubStats';

// Auto-connect using environment variable
const envToken = import.meta.env?.VITE_GITHUB_ACCESS_TOKEN;
const envTokenType = import.meta.env?.VITE_GITHUB_TOKEN_TYPE;

const githubConnectionAtom = atom<GitHubConnection>({
  user: null,
  token: envToken || '',
  tokenType:
    envTokenType === 'classic' || envTokenType === 'fine-grained'
      ? (envTokenType as 'classic' | 'fine-grained')
      : 'classic',
});

/*
 * The connection (token included) lives encrypted on the account. The token is
 * only held in memory for the session, so a shared machine does not keep a
 * usable credential after sign-out; `hydrateFromAccount` reports whether a
 * connection exists so the UI can ask the user to reconnect.
 */
export const githubConnectionHydrated = atom(false);

export async function hydrateGitHubConnection(): Promise<void> {
  const stored = (await loadConnections()).github;

  githubConnectionHydrated.set(true);

  if (!stored) {
    return;
  }

  const current = githubConnectionAtom.get();

  githubConnectionAtom.set({
    ...current,
    user: (stored.user as GitHubConnection['user']) ?? current.user,
    tokenType: (stored.tokenType as GitHubConnection['tokenType']) ?? 'classic',
  });
}

// Computed store for checking if connected
export const isGitHubConnected = computed(githubConnectionAtom, (connection) => !!connection.user);

// Computed store for GitHub stats summary
export const githubStatsSummary = computed(githubConnectionAtom, (connection) => {
  if (!connection.stats) {
    return null;
  }

  return calculateStatsSummary(connection.stats);
});

// Connection status atoms
export const isGitHubConnecting = atom(false);
export const isGitHubLoadingStats = atom(false);

// GitHub connection store methods
export const githubConnectionStore = {
  // Get current connection
  get: () => githubConnectionAtom.get(),

  // Connect to GitHub
  async connect(token: string, tokenType: 'classic' | 'fine-grained' = 'classic'): Promise<void> {
    if (isGitHubConnecting.get()) {
      throw new Error('Connection already in progress');
    }

    isGitHubConnecting.set(true);

    try {
      // Fetch user data
      const { user, rateLimit } = await gitHubApiService.fetchUser(token, tokenType);

      // Create connection object
      const connection: GitHubConnection = {
        user,
        token,
        tokenType,
        rateLimit,
      };

      // Set cookies for client-side access
      Cookies.set('githubUsername', user.login);
      Cookies.set('githubToken', token);
      Cookies.set('git:github.com', JSON.stringify({ username: token, password: 'x-oauth-basic' }));

      void saveConnectionToAccount('github', {
        user: user as unknown as Record<string, unknown>,
        token,
        tokenType,
      });

      // Update atom
      githubConnectionAtom.set(connection);

      logStore.logInfo('Connected to GitHub', {
        type: 'system',
        message: `Connected to GitHub as ${user.login}`,
      });

      // Fetch stats in background
      this.fetchStats().catch((error) => {
        console.error('Failed to fetch initial GitHub stats:', error);
      });
    } catch (error) {
      console.error('Failed to connect to GitHub:', error);
      logStore.logError(`GitHub authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`, {
        type: 'system',
        message: 'GitHub authentication failed',
      });
      throw error;
    } finally {
      isGitHubConnecting.set(false);
    }
  },

  // Disconnect from GitHub
  disconnect(): void {
    // Clear atoms
    githubConnectionAtom.set({
      user: null,
      token: '',
      tokenType: 'classic',
    });

    void deleteConnectionFromAccount('github');

    // Clear cookies
    Cookies.remove('githubUsername');
    Cookies.remove('githubToken');
    Cookies.remove('git:github.com');

    // Clear API service cache
    gitHubApiService.clearCache();

    logStore.logInfo('Disconnected from GitHub', {
      type: 'system',
      message: 'Disconnected from GitHub',
    });
  },

  // Fetch GitHub stats
  async fetchStats(): Promise<void> {
    const connection = githubConnectionAtom.get();

    if (!connection.user || !connection.token) {
      throw new Error('Not connected to GitHub');
    }

    if (isGitHubLoadingStats.get()) {
      return; // Already loading
    }

    isGitHubLoadingStats.set(true);

    try {
      const stats = await gitHubApiService.fetchStats(connection.token, connection.tokenType);

      // Update connection with stats
      const updatedConnection: GitHubConnection = {
        ...connection,
        stats,
      };

      // Update atom
      githubConnectionAtom.set(updatedConnection);

      logStore.logInfo('GitHub stats refreshed', {
        type: 'system',
        message: 'Successfully refreshed GitHub statistics',
      });
    } catch (error) {
      console.error('Failed to fetch GitHub stats:', error);

      // If the error is due to expired token, disconnect
      if (error instanceof Error && error.message.includes('401')) {
        logStore.logError('GitHub token has expired', {
          type: 'system',
          message: 'GitHub token has expired. Please reconnect your account.',
        });
        this.disconnect();
      }

      throw error;
    } finally {
      isGitHubLoadingStats.set(false);
    }
  },

  // Update token type
  updateTokenType(tokenType: 'classic' | 'fine-grained'): void {
    const connection = githubConnectionAtom.get();

    const updatedConnection = {
      ...connection,
      tokenType,
    };

    githubConnectionAtom.set(updatedConnection);
    void saveConnectionToAccount('github', { tokenType });
  },

  // Clear stats cache
  clearCache(): void {
    const connection = githubConnectionAtom.get();

    if (connection.token) {
      gitHubApiService.clearUserCache(connection.token);
    }
  },

  // Subscribe to connection changes
  subscribe: githubConnectionAtom.subscribe.bind(githubConnectionAtom),
};

// Export the atom for direct access
export { githubConnectionAtom };
