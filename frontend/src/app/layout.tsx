import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  metadataBase: new URL('https://itsverso.xyz'),
  title: 'Verso — open-source agent orchestrator for knowledge work',
  description:
    'Verso connects to your apps, remembers your context, and orchestrates local Hermes agents on your Mac.',
  openGraph: {
    title: 'Verso — open-source agent orchestrator for knowledge work',
    description:
      'Verso connects to your apps, remembers your context, and orchestrates local Hermes agents on your Mac.',
    url: 'https://itsverso.xyz',
    siteName: 'Verso',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
