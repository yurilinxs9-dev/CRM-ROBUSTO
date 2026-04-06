import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import Providers from './providers';
import { cn } from '@/lib/cn';

export const metadata: Metadata = {
  title: 'CRM WhatsApp',
  description: 'CRM com funil Kanban e WhatsApp integrado',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={cn('dark', GeistSans.variable, GeistMono.variable)}>
      <body className={cn('min-h-screen bg-background font-sans antialiased')}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
