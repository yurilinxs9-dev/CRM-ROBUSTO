'use client';

import { useRouter } from 'next/navigation';
import { LogOut, User as UserIcon } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';

interface UserMenuProps {
  variant?: 'card' | 'icon';
  className?: string;
}

export function UserMenu({ variant = 'card', className }: UserMenuProps) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const name = user?.nome ?? 'Usuário';
  const role = user?.role ?? '';
  const initial = name.charAt(0).toUpperCase();

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'card' ? (
          <button
            type="button"
            aria-label="Menu do usuário"
            className={cn(
              'flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className,
            )}
          >
            <Avatar className="h-9 w-9">
              {user?.avatar_url && <AvatarImage src={user.avatar_url} alt={name} />}
              <AvatarFallback className="bg-primary text-primary-foreground">{initial}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-tight">{name}</p>
              {role && <p className="truncate text-xs text-muted-foreground">{role}</p>}
            </div>
          </button>
        ) : (
          <button
            type="button"
            aria-label="Menu do usuário"
            className={cn(
              'rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              className,
            )}
          >
            <Avatar className="h-9 w-9">
              {user?.avatar_url && <AvatarImage src={user.avatar_url} alt={name} />}
              <AvatarFallback className="bg-primary text-primary-foreground">{initial}</AvatarFallback>
            </Avatar>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-medium leading-tight">{name}</span>
          {user?.email && <span className="text-xs font-normal text-muted-foreground">{user.email}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <UserIcon className="mr-2 h-4 w-4" />
          Perfil
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive">
          <LogOut className="mr-2 h-4 w-4" />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
