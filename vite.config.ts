import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.TURBOPUFFER_API_KEY': JSON.stringify(env.VITE_TURBOPUFFER_API_KEY || ''),
      'process.env.VITE_AI_PROVIDER': JSON.stringify(env.VITE_AI_PROVIDER || 'gemini'),
      'process.env.VITE_OPENROUTER_API_KEY': JSON.stringify(env.VITE_OPENROUTER_API_KEY || ''),
      'process.env.VITE_OPENROUTER_EMBED_MODEL': JSON.stringify(env.VITE_OPENROUTER_EMBED_MODEL || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
