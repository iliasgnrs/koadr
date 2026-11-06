import { useEffect } from 'react';
import type { LoaderFunctionArgs, MetaFunction } from 'react-router';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { Chat } from '~/components/chat/Chat.client';
import { Header } from '~/components/header/Header';
import { FirstRunOnboarding } from '~/components/onboarding/FirstRunOnboarding';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { requireUser } from '~/lib/auth-guard';
import { beginApplyingRemote, endApplyingRemote, syncSettingsFromServer } from '~/lib/settings-client';
import { hydrateProfileFromAccount } from '~/lib/stores/profile';
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
   * The page has already rendered from localStorage by the time this runs, so a
   * slow or failed request never blocks the UI — it only means this device keeps
   * its local choices for now.
   */
  useEffect(() => {
    /*
     * The sidebar shows the account as soon as this resolves; until then it may
     * briefly show a cached name. Both calls are independent so a slow one does
     * not delay the other.
     */
    void hydrateProfileFromAccount();

    let cancelled = false;

    void syncSettingsFromServer().then((applied) => {
      if (cancelled || !applied) {
        return;
      }

      /*
       * Applied through setTheme so the store, localStorage and the html
       * attributes all move together. The remote flag stops the resulting
       * setTheme() call from queueing a push back to the server.
       */
      beginApplyingRemote();

      try {
        setTheme(applied.theme as never);
      } finally {
        endApplyingRemote();
      }
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
