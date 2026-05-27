import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './features/**/*.{js,ts,jsx,tsx,mdx}',
    './data/**/*.{js,ts,jsx,tsx,mdx}'
  ],
  safelist: [
    'from-slate-400',
    'to-slate-600',
    'from-zinc-400',
    'to-zinc-600',
    'from-stone-400',
    'to-stone-600',
    'from-gray-400',
    'to-gray-600'
  ],
  theme: {
    extend: {}
  },
  plugins: []
};

export default config;
