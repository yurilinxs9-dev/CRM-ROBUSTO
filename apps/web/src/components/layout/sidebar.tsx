'use client';

import { LayoutDashboard, Kanban, MessageSquare, Smartphone, Settings, CalendarDays, BarChart3 } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
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
  className?: string;
}

export function Sidebar({ collapsed = false, onNavigate, className }: SidebarProps) {
  return (
    <aside
      aria-label="Navegação principal"
      className={cn(
        'flex h-full flex-col border-r border-border bg-card',
        collapsed ? 'w-16' : 'w-[260px]',
        className,
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex h-14 items-center gap-2 border-b border-border px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <span className="text-sm font-bold text-primary-foreground">C</span>
        </div>
        {!collapsed && <span className="font-semibold tracking-tight">CRM Pro</span>}
      </div>

      {/* Nav */}
      <nav className={cn('flex-1 space-y-1 overflow-y-auto p-3', collapsed && 'p-2')}>
        {NAV_ITEMS.map((item) => (
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
      </nav>

      <Separator />

      {/* User card */}
      <div className={cn('p-3', collapsed && 'flex justify-center p-2')}>
        {collapsed ? <UserMenu variant="icon" /> : <UserMenu variant="card" />}
      </div>
    </aside>
  );
}
