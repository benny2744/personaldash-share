import SettingsClient from '@/components/settings/SettingsClient';

export const metadata = {
  title: 'Settings - WorkDash',
};

export default function SettingsPage() {
  return (
    <div className="space-y-10">
      <div className="page-header">
        <h1>Settings</h1>
        <p className="subtitle">Local storage and offline behavior</p>
      </div>
      <SettingsClient />
    </div>
  );
}
