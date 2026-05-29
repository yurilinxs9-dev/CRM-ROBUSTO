import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface User {
  id: string;
  nome: string;
  email: string;
  role: string;
  tenantId: string;
  avatar_url?: string;
  is_platform_admin?: boolean;
}

export interface Tenant {
  id: string;
  nome: string;
  pool_enabled: boolean;
  prefix_enabled?: boolean;
}

interface AuthState {
  user: User | null;
  tenant: Tenant | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  hydrated: boolean;
  // Impersonação: guarda a sessão do admin de plataforma enquanto ele navega
  // como um usuário-cliente. impersonating=true mostra o banner "voltar".
  impersonating: boolean;
  adminBackup: { user: User; token: string; tenant: Tenant | null } | null;
  setAuth: (user: User, token: string) => void;
  setTenant: (tenant: Tenant) => void;
  updateToken: (token: string) => void;
  updateUser: (partial: Partial<User>) => void;
  startImpersonation: (user: User, token: string) => void;
  stopImpersonation: () => void;
  logout: () => void;
  setHydrated: () => void;
}

// Persist both user and token to localStorage so a hard refresh keeps the
// session. The JWT itself dictates expiry — when it expires, the next API
// call 401s and the axios interceptor / login redirect takes over.
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tenant: null,
      accessToken: null,
      isAuthenticated: false,
      hydrated: false,
      impersonating: false,
      adminBackup: null,
      setAuth: (user, accessToken) => {
        // Keep legacy key in sync for any code still reading it directly.
        localStorage.setItem('accessToken', accessToken);
        set({ user, accessToken, isAuthenticated: true });
      },
      setTenant: (tenant) => set({ tenant }),
      updateUser: (partial) => set((state) => ({
        user: state.user ? { ...state.user, ...partial } : null,
      })),
      startImpersonation: (targetUser, token) => set((state) => {
        // Salva a sessão atual do admin (só na primeira vez, pra não perder
        // o admin ao impersonar em cadeia) e troca pro usuário-alvo.
        const backup = state.adminBackup ?? (state.user && state.accessToken
          ? { user: state.user, token: state.accessToken, tenant: state.tenant }
          : null);
        localStorage.setItem('accessToken', token);
        return { adminBackup: backup, impersonating: true, user: targetUser, accessToken: token, tenant: null };
      }),
      stopImpersonation: () => set((state) => {
        const b = state.adminBackup;
        if (!b) return { impersonating: false };
        localStorage.setItem('accessToken', b.token);
        return { impersonating: false, adminBackup: null, user: b.user, accessToken: b.token, tenant: b.tenant };
      }),
      updateToken: (accessToken) => {
        localStorage.setItem('accessToken', accessToken);
        set({ accessToken });
      },
      logout: () => {
        localStorage.removeItem('accessToken');
        set({ user: null, tenant: null, accessToken: null, isAuthenticated: false, impersonating: false, adminBackup: null });
      },
      setHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'crm-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        tenant: state.tenant,
        accessToken: state.accessToken,
        isAuthenticated: state.isAuthenticated,
        impersonating: state.impersonating,
        adminBackup: state.adminBackup,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);

export const useIsPoolEnabled = () => useAuthStore((s) => s.tenant?.pool_enabled ?? false);
