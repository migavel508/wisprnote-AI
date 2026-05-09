import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const fileEnv = loadEnv(mode, '.', '');

  // .env files first, fall back to system env vars (Vercel/CI where .env files are gitignored)
  const getEnv = (key: string, fallback = '') =>
    fileEnv[key] || process.env[key] || fallback;

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(getEnv('GEMINI_API_KEY')),
      'process.env.TURBOPUFFER_API_KEY': JSON.stringify(getEnv('VITE_TURBOPUFFER_API_KEY')),
      'process.env.VITE_AI_PROVIDER': JSON.stringify(getEnv('VITE_AI_PROVIDER', 'gemini')),
      'process.env.VITE_OPENROUTER_API_KEY': JSON.stringify(getEnv('VITE_OPENROUTER_API_KEY')),
      'process.env.VITE_OPENROUTER_EMBED_MODEL': JSON.stringify(getEnv('VITE_OPENROUTER_EMBED_MODEL')),
      'import.meta.env.VITE_AWS_REGION': JSON.stringify(getEnv('VITE_AWS_REGION', 'us-east-1')),
      'import.meta.env.VITE_COGNITO_USER_POOL_ID': JSON.stringify(getEnv('VITE_COGNITO_USER_POOL_ID')),
      'import.meta.env.VITE_COGNITO_CLIENT_ID': JSON.stringify(getEnv('VITE_COGNITO_CLIENT_ID')),
      'import.meta.env.VITE_COGNITO_DOMAIN': JSON.stringify(getEnv('VITE_COGNITO_DOMAIN')),
      'import.meta.env.VITE_COGNITO_AUTH_ORIGIN': JSON.stringify(getEnv('VITE_COGNITO_AUTH_ORIGIN')),
      'import.meta.env.VITE_COGNITO_IDENTITY_PROVIDER': JSON.stringify(getEnv('VITE_COGNITO_IDENTITY_PROVIDER')),
      'import.meta.env.VITE_API_GATEWAY_URL': JSON.stringify(getEnv('VITE_API_GATEWAY_URL')),
      'import.meta.env.VITE_S3_BUCKET': JSON.stringify(getEnv('VITE_S3_BUCKET')),
      'import.meta.env.VITE_CLOUDFRONT_URL': JSON.stringify(getEnv('VITE_CLOUDFRONT_URL')),
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
