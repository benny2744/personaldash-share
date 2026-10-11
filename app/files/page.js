export const dynamic = 'force-dynamic';

import FilesClient from '@/components/files/FilesClient';

export const metadata = {
  title: 'Files - WorkDash',
};

export default function FilesPage() {
  return <FilesClient />;
}
