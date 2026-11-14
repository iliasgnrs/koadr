import { useEffect } from 'react';
import { type LoaderFunctionArgs, type MetaFunction } from 'react-router';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import { FirstRunOnboarding } from '~/components/onboarding/FirstRunOnboarding';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { requireUser } from '~/lib/auth-guard';
import { loadConnections } from '~/lib/connections-client';
import { beginApplyingRemote, endApplyingRemote, syncSettingsFromServer } from '~/lib/settings-client';
import { applyProviderSettings } from '~/lib/settings-sync';
import { hydrateGitHubConnection } from '~/lib/stores/githubConnection';
import { hydrateGitLabConnection } from '~/lib/stores/gitlabConnection';
import { hydrateProfileFromAccount } from '~/lib/stores/profile';
import { initializeProviders, providersStore } from '~/lib/stores/settings';
import { setTheme } from '~/lib/stores/theme';

export const meta: MetaFunction = () => {
  return [
    { title: 'Koadr — Prompt it. Build it. Ship it.' },
    {
      name: 'description',
      content:
        'Koadr is an open-architecture, agentic AI workspace that turns natural language into production-ready full-stack applications instantly inside your browser.',
    },
  ];
};

/*
 * There is no guest mode (project decision), so the app shell requires a
 * session. The guard runs on the server: an anonymous visitor is redirected to
 * /login before any chat store is mounted, which also keeps the WebContainer
 * from booting for someone who cannot use it.
 */
export const loader = ({ context, request }: LoaderFunctionArgs) => {
  const user = requireUser(context, request);

  return Response.json({ user });
};

/**
 * Landing page component for Bolt
 * Note: Settings functionality should ONLY be accessed through the sidebar menu.
 * Do not add settings button/panel to this landing page as it was intentionally removed
 * to keep the UI clean and consistent with the design system.
 */
export default function Index() {
  /*
   * Reconcile this browser with the account once per authenticated load.
   *
   * Rendering never waits on this: the pre-hydration script paints the account's
   * theme, and a failed request only leaves the defaults in place.
   */
  useEffect(() => {
    /*
     * The sidebar shows the account as soon as this resolves; until then it may
     * briefly show a cached name. Both calls are independent so a slow one does
     * not delay the other.
     */
    void hydrateProfileFromAccount();
    void loadConnections().then((connections) => {
      if (connections.github) {
        void hydrateGitHubConnection();
      }

      if (connections.gitlab) {
        void hydrateGitLabConnection();
      }
    });

    let cancelled = false;

    void syncSettingsFromServer().then((applied) => {
      if (!applied) {
        /*
         * The account could not be read (offline). Auto-enable still runs, but
         * nothing is saved, so it cannot overwrite a stored choice later.
         */
        void initializeProviders();

        return;
      }

      if (cancelled) {
        return;
      }

      /*
       * Applied through setTheme so the store and the html attributes move
       * together. The remote flag stops the resulting setTheme() call from
       * queueing a push back to the server.
       */
      if (applied.theme) {
        beginApplyingRemote();

        try {
          setTheme(applied.theme as never);
        } finally {
          endApplyingRemote();
        }
      }

      /*
       * Providers are not covered by setTheme, so the store is updated here.
       *
       * A written map is authoritative: a provider the account does not list is
       * disabled, otherwise the defaults (OpenRouter/Anthropic/OpenAI/Google)
       * would survive a user who enabled only one provider. An empty map means
       * the account never saved a choice, so the defaults stand until the first
       * toggle is written.
       */
      if (applied.providerSettings) {
        providersStore.set(
          applyProviderSettings(
            providersStore.get(),
            applied.providerSettings as Record<string, { settings?: object }>,
          ),
        );
      }

      /*
       * Providers configured through environment variables are auto-enabled once,
       * after the account copy is in place, so an explicit choice is never undone.
       */
      void initializeProviders();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>{() => <Chat />}</ClientOnly>
      <FirstRunOnboarding />
    </div>
  );
}
