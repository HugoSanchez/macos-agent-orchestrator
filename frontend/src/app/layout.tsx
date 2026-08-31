import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Verso — open-source agent orchestrator for knowledge work',
  description:
    'Verso connects to your apps, remembers your context, and orchestrates local Hermes agents on your Mac.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
