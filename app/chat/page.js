import HermesChatClient from '@/components/hermes/HermesChatClient';

export const metadata = {
  title: 'Chat - PersonalDash',
};

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <HermesChatClient />
    </div>
  );
}
