import type { Metadata } from 'next';
import '@/styles/globals.css';
import Providers from './providers';

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
    <html lang="pt-BR" className="dark">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
