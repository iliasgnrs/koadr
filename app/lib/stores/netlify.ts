import { atom } from 'nanostores';
import { toast } from 'react-toastify';
import { logStore } from './logs';
import { saveConnectionToAccount } from '~/lib/connections-client';
import type { NetlifyConnection, NetlifyUser } from '~/types/netlify';

const envToken = import.meta.env.VITE_NETLIFY_ACCESS_TOKEN;
console.log('Netlify store: envToken loaded:', envToken ? '[TOKEN_EXISTS]' : '[NO_TOKEN]');

/*
 * The connection lives encrypted on the account; only the environment token is
 * available to a fresh session without a round-trip.
 */
export const netlifyConnection = atom<NetlifyConnection>({
  user: null,
  token: envToken || '',
  stats: undefined,
});
export const isConnecting = atom<boolean>(false);
export const isFetchingStats = atom<boolean>(false);

// Function to initialize Netlify connection with environment token
export async function initializeNetlifyConnection() {
  const currentState = netlifyConnection.get();

  // If we already have a connection or no token, don't try to connect
  if (currentState.user || !envToken) {
    console.log('Netlify: Skipping auto-connect - user exists or no env token');
    return;
  }

  console.log('Netlify: Attempting auto-connection with env token');

  try {
    isConnecting.set(true);

    const response = await fetch('https://api.netlify.com/api/v1/user', {
      headers: {
        Authorization: `Bearer ${envToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to connect to Netlify: ${response.statusText}`);
    }

    const userData = await response.json();

    // Update the connection state
    const connectionData: Partial<NetlifyConnection> = {
      user: userData as NetlifyUser,
      token: envToken,
    };

    void saveConnectionToAccount('netlify', {
      user: userData as unknown as Record<string, unknown>,
      token: envToken,
    });

    // Update the store
    updateNetlifyConnection(connectionData);

    // Fetch initial stats
    await fetchNetlifyStats(envToken);
  } catch (error) {
    console.error('Error initializing Netlify connection:', error);
    logStore.logError('Failed to initialize Netlify connection', { error });
  } finally {
    isConnecting.set(false);
  }
}

export const updateNetlifyConnection = (updates: Partial<NetlifyConnection>) => {
  const currentState = netlifyConnection.get();
  const newState = { ...currentState, ...updates };
  netlifyConnection.set(newState);

  // A token-less update (stats) must not overwrite the stored credential.
  if (newState.token) {
    void saveConnectionToAccount('netlify', {
      user: newState.user as unknown as Record<string, unknown>,
      token: newState.token,
    });
  }
};

export async function fetchNetlifyStats(token: string) {
  try {
    isFetchingStats.set(true);

    const sitesResponse = await fetch('https://api.netlify.com/api/v1/sites', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!sitesResponse.ok) {
      throw new Error(`Failed to fetch sites: ${sitesResponse.status}`);
    }

    const sites = (await sitesResponse.json()) as any;

    const currentState = netlifyConnection.get();
    updateNetlifyConnection({
      ...currentState,
      stats: {
        sites,
        totalSites: sites.length,
      },
    });
  } catch (error) {
    console.error('Netlify API Error:', error);
    logStore.logError('Failed to fetch Netlify stats', { error });
    toast.error('Failed to fetch Netlify statistics');
  } finally {
    isFetchingStats.set(false);
  }
}
