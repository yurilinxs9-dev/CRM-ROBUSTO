'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { PageHeader } from '@/components/layout/page-header';
import { visibleAdminTabs, canSeeAdminPath, firstAllowedAdminHref } from '@/lib/admin-tabs';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const isAdmin = useAuthStore((s) => s.user?.is_platform_admin);
  const scopes = useAuthStore((s) => s.user?.platform_scopes);
  const hydrated = useAuthStore((s) => s.hydrated);
  const router = useRouter();
  const pathname = usePathname();

  const tabs = visibleAdminTabs(scopes);
  const allowed = canSeeAdminPath(pathname, scopes);

  useEffect(() => {
    if (!hydrated) return;
    if (isAdmin === false) {
      router.replace('/dashboard');
      return;
    }
    // Escopos só chegam depois do /auth/me; enquanto undefined não redireciona,
    // senão o admin master seria chutado do painel no primeiro render.
    if (isAdmin && scopes && !allowed) {
      router.replace(firstAllowedAdminHref(scopes) ?? '/dashboard');
    }
  }, [hydrated, isAdmin, scopes, allowed, router]);

  if (isAdmin === false) return null;
  if (scopes && !allowed) return null;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader title="Painel Admin" subtitle="Administração da plataforma" />
      <nav className="flex gap-1 border-b" style={{ borderColor: 'var(--border-default)' }}>
        {tabs.map((t) => {
          const active = t.href === '/admin' ? pathname === '/admin' : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className="px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
              style={{
                borderColor: active ? 'var(--primary)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
