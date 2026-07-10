import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        brand: {
          DEFAULT: '#00a859',
          hover: '#008f4c',
          subtle: 'rgba(0,168,89,0.12)',
          border: 'rgba(0,168,89,0.30)',
        },
        // Escala unificada (Onda 1 da auditoria UI): espelha as CSS vars que
        // antes só existiam via style inline. Novas telas usam SEMPRE estas
        // classes (bg-surface-*, text-ink-*, border-line-*) — nunca style={{}}.
        surface: {
          0: 'var(--bg-base)',
          1: 'var(--bg-surface-1)',
          2: 'var(--bg-surface-2)',
          3: 'var(--bg-surface-3)',
          4: 'var(--bg-surface-4)',
        },
        ink: {
          1: 'var(--text-primary)',
          2: 'var(--text-secondary)',
          3: 'var(--text-muted)',
        },
        line: {
          1: 'var(--border-subtle)',
          2: 'var(--border-default)',
          3: 'var(--border-strong)',
        },
        temp: {
          cold: '#38bdf8',
          warm: '#fb923c',
          hot: '#f97316',
          fire: '#ef4444',
        },
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
        info: '#0ea5e9',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // Elevação pro dark: sombra não funciona em fundo escuro sem uma luz
      // interna — cada nível combina inset highlight + sombra externa.
      boxShadow: {
        'elev-1': 'inset 0 1px 0 rgba(255,255,255,0.03), 0 1px 2px rgba(0,0,0,0.4)',
        'elev-2': 'inset 0 1px 0 rgba(255,255,255,0.04), 0 4px 12px rgba(0,0,0,0.45)',
        'elev-3': 'inset 0 1px 0 rgba(255,255,255,0.05), 0 12px 32px rgba(0,0,0,0.55)',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'Geist Mono', 'JetBrains Mono', 'monospace'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-in-from-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-in-from-left': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 200ms ease-out',
        'slide-in-from-right': 'slide-in-from-right 250ms ease-out',
        'slide-in-from-left': 'slide-in-from-left 250ms ease-out',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
