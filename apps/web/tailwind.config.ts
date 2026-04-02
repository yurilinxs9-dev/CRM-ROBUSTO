import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#00a859',
          hover: '#008f4c',
          subtle: 'rgba(0,168,89,0.12)',
          border: 'rgba(0,168,89,0.30)',
        },
        secondary: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
        },
        surface: {
          base: '#0a0d0f',
          1: '#0f1419',
          2: '#151d27',
          3: '#1c2733',
          4: '#253447',
        },
        border: {
          subtle: '#1e2d3d',
          DEFAULT: '#2d4059',
          strong: '#3d5a7a',
        },
        content: {
          primary: '#e8edf2',
          secondary: '#8899aa',
          muted: '#4a5d6e',
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
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
      },
      fontSize: {
        xs: '11px',
        sm: '13px',
        base: '14px',
        md: '15px',
        lg: '17px',
        xl: '20px',
        '2xl': '24px',
        '3xl': '30px',
      },
      animation: {
        'pulse-ring': 'pulse-ring 2s ease-in-out infinite',
        'fade-up': 'fade-up 250ms ease-out',
        shimmer: 'shimmer 1.5s infinite linear',
        'card-bounce': 'card-bounce 600ms ease-in-out',
      },
      keyframes: {
        'pulse-ring': {
          '0%, 100%': { transform: 'scale(1)', opacity: '1' },
          '50%': { transform: 'scale(1.05)', opacity: '0.8' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'card-bounce': {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.02)' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
