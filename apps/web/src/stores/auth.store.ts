import { create } from 'zustand';

interface User {
  id: string;
  nome: string;
  email: string;
  role: string;
  avatar_url?: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  setAuth: (user, accessToken) => {
    localStorage.setItem('accessToken', accessToken);
    set({ user, accessToken, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem('accessToken');
    set({ user: null, accessToken: null, isAuthenticated: false });
  },
}));
