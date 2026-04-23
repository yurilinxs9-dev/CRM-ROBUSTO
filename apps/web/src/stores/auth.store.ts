import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface User {
  id: string;
  nome: string;
  email: string;
  role: string;
  tenantId: string;
  avatar_url?: string;
}

export interface Tenant {
  id: string;
  nome: string;
  pool_enabled: boolean;
}

interface AuthState {
  user: User | null;
  tenant: Tenant | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  hydrated: boolean;
  setAuth: (user: User, token: string) => void;
  setTenant: (tenant: Tenant) => void;
  updateToken: (token: string) => void;
  updateUser: (partial: Partial<User>) => void;
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
      setAuth: (user, accessToken) => {
        // Keep legacy key in sync for any code still reading it directly.
        localStorage.setItem('accessToken', accessToken);
        set({ user, accessToken, isAuthenticated: true });
      },
      setTenant: (tenant) => set({ tenant }),
      updateUser: (partial) => set((state) => ({
        user: state.user ? { ...state.user, ...partial } : null,
      })),
      updateToken: (accessToken) => {
        localStorage.setItem('accessToken', accessToken);
        set({ accessToken });
      },
      logout: () => {
        localStorage.removeItem('accessToken');
        set({ user: null, tenant: null, accessToken: null, isAuthenticated: false });
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
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);

export const useIsPoolEnabled = () => useAuthStore((s) => s.tenant?.pool_enabled ?? false);
