import type { LoaderFunctionArgs } from 'react-router';
import type { MetaFunction } from 'react-router';
import { ClientOnly } from 'remix-utils/client-only';
import { BaseChat } from '~/components/chat/BaseChat';
import { GitUrlImport } from '~/components/git/GitUrlImport.client';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';

export const meta: MetaFunction = () => {
  return [
    { title: 'Koadr — Prompt it. Build it. Ship it.' },
    {
      name: 'description',
      content: 'Koadr is an open-architecture, agentic AI workspace that builds full-stack apps in the browser.',
    },
  ];
};

export async function loader(args: LoaderFunctionArgs) {
  return Response.json({ url: args.params.url });
}

export default function Index() {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <ClientOnly fallback={<BaseChat />}>{() => <GitUrlImport />}</ClientOnly>
    </div>
  );
}
