import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        chrome: {
          50: '#f6f6f7',
          100: '#ebedf0',
          200: '#d6dae0',
          300: '#b2bac7',
          400: '#7d889b',
          500: '#576174',
          600: '#3f4756',
          700: '#2c3340',
          800: '#1d232c',
          900: '#11161d',
        },
        accent: {
          400: '#4fa3ff',
          500: '#2388ff',
          600: '#0d6fe8',
        },
      },
      fontFamily: {
        sans: ['"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 16px 40px rgba(0, 0, 0, 0.18)',
      },
    },
  },
  plugins: [],
} satisfies Config
