'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface NavItemProps {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  collapsed?: boolean;
  onNavigate?: () => void;
}

export function NavItem({ href, label, icon: Icon, exact, collapsed, onNavigate }: NavItemProps) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-lg px-3 h-10 text-sm font-medium outline-none transition-colors duration-200',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        active
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary"
        />
      )}
      <Icon className={cn('h-[18px] w-[18px] shrink-0', active && 'text-primary')} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
