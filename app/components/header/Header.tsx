import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { chatStore } from '~/lib/stores/chat';
import { sidebarOpen } from '~/lib/stores/sidebar';
import { classNames } from '~/utils/classNames';

export function Header() {
  const chat = useStore(chatStore);
  const isSidebarOpen = useStore(sidebarOpen);

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <button
          type="button"
          onClick={() => sidebarOpen.set(!isSidebarOpen)}
          className="flex items-center justify-center bg-transparent border-0 p-0 cursor-pointer"
          aria-label={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          aria-expanded={isSidebarOpen}
        >
          <div className="i-ph:sidebar-simple-duotone text-xl" />
        </button>
        <a href="/" className="text-2xl font-semibold text-accent flex items-center">
          <img src="/logo-light-styled.png" alt="Koadr" className="w-[90px] inline-block dark:hidden" />
          <img src="/logo-dark-styled.png" alt="Koadr" className="w-[90px] inline-block hidden dark:block" />
        </a>
      </div>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="">
                <HeaderActionButtons chatStarted={chat.started} />
              </div>
            )}
          </ClientOnly>
        </>
      )}
    </header>
  );
}
