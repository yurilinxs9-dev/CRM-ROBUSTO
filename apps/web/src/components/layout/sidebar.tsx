'use client';

import { LayoutDashboard, Kanban, MessageSquare, Smartphone, Settings, CalendarDays, BarChart3, PanelLeftClose, PanelLeftOpen, Shield } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import { useAuthStore } from '@/stores/auth.store';
import { NavItem } from './nav-item';
import { UserMenu } from './user-menu';

import type { LucideIcon } from 'lucide-react';

export interface NavEntry {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

export const NAV_ITEMS: NavEntry[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, exact: true },
  { href: '/kanban', label: 'Kanban', icon: Kanban },
  { href: '/chat', label: 'Conversas', icon: MessageSquare },
  { href: '/agenda', label: 'Agenda', icon: CalendarDays },
  { href: '/instances', label: 'Instâncias', icon: Smartphone },
  { href: '/settings', label: 'Configurações', icon: Settings },
];

interface SidebarProps {
  collapsed?: boolean;
  onNavigate?: () => void;
  onToggleCollapse?: () => void;
  className?: string;
}

export function Sidebar({ collapsed = false, onNavigate, onToggleCollapse, className }: SidebarProps) {
  const role = useAuthStore((s) => s.user?.role);
  const isPlatformAdmin = useAuthStore((s) => s.user?.is_platform_admin);
  // VISUALIZADOR nao tem acesso a Conversas — escondemos do menu.
  const visibleNav = NAV_ITEMS.filter(
    (item) => !(item.href === '/chat' && role === 'VISUALIZADOR'),
  );

  return (
    <aside
      aria-label="Navegação principal"
      className={cn(
        'relative flex h-full flex-col border-r border-border bg-card transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-[260px]',
        className,
      )}
    >
      {/* Logo + Toggle */}
      <div
        className={cn(
          'flex h-14 items-center gap-2 border-b border-border px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <span className="text-sm font-bold text-primary-foreground">C</span>
        </div>
        {!collapsed && <span className="flex-1 font-semibold tracking-tight">CRM Pro</span>}
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              collapsed && 'absolute right-1 top-3',
            )}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className={cn('flex-1 space-y-1 overflow-y-auto p-3', collapsed && 'p-2')}>
        {visibleNav.map((item) => (
          <NavItem
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            exact={item.exact}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
        {isPlatformAdmin && (
          <NavItem
            href="/admin"
            label="Admin"
            icon={Shield}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        )}
      </nav>

      <Separator />

      {/* User card */}
      <div className={cn('p-3', collapsed && 'flex justify-center p-2')}>
        {collapsed ? <UserMenu variant="icon" /> : <UserMenu variant="card" />}
      </div>
    </aside>
  );
}
