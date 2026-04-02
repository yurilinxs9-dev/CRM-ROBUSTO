'use client';
import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import Link from 'next/link';

const navItems = [
  { href: '/kanban',    label: 'Kanban',        icon: '⬛' },
  { href: '/chat',      label: 'Conversas',     icon: '💬' },
  { href: '/instances', label: 'Instâncias',    icon: '📱' },
  { href: '/dashboard', label: 'Dashboard',     icon: '📊' },
  { href: '/settings',  label: 'Configurações', icon: '⚙️' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, accessToken, isAuthenticated } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isAuthenticated && !accessToken) {
      router.push('/login');
    }
  }, [isAuthenticated, accessToken, router]);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg-base)' }}>
      {/* Sidebar */}
      <aside className="flex flex-col w-60 flex-shrink-0 border-r"
        style={{ background: 'var(--bg-surface-1)', borderColor: 'var(--border-subtle)' }}>
        {/* Logo */}
        <div className="h-14 flex items-center gap-3 px-4 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
            style={{ background: 'var(--primary)' }}>C</div>
          <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>CRM WhatsApp</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}
                className="flex items-center gap-3 h-9 px-3 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: active ? 'var(--primary-subtle)' : 'transparent',
                  color: active ? 'var(--primary)' : 'var(--text-secondary)',
                  border: active ? '1px solid var(--primary-border)' : '1px solid transparent',
                }}>
                <span>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User */}
        <div className="p-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
            style={{ background: 'var(--bg-surface-3)' }}>
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
              style={{ background: 'var(--secondary)' }}>
              {user?.nome?.[0] ?? 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                {user?.nome ?? 'Usuário'}
              </p>
              <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                {user?.role ?? ''}
              </p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="h-14 flex items-center justify-between px-6 border-b flex-shrink-0"
          style={{ background: 'var(--bg-surface-1)', borderColor: 'var(--border-subtle)' }}>
          <h1 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
            {navItems.find((n) => pathname.startsWith(n.href))?.label ?? 'CRM'}
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2 py-1 rounded-full"
              style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}>
              ● Online
            </span>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
