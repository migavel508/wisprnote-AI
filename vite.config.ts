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
      // Provider API keys are NO LONGER injected into the client bundle — all
      // provider calls go through the authenticated Lambda proxy, which reads the
      // real keys from Secrets Manager server-side. Only non-secret config below.
      'process.env.VITE_AI_PROVIDER': JSON.stringify(getEnv('VITE_AI_PROVIDER', 'gemini')),
      'process.env.VITE_OPENROUTER_EMBED_MODEL': JSON.stringify(getEnv('VITE_OPENROUTER_EMBED_MODEL')),
      'process.env.VITE_OPENROUTER_IMAGE_MODEL': JSON.stringify(getEnv('VITE_OPENROUTER_IMAGE_MODEL')),
      // Defined as empty so the (dormant) Gemini SDK reference compiles without a
      // runtime error — the real key is NEVER bundled; calls go via the proxy.
      'process.env.GEMINI_API_KEY': JSON.stringify(''),
      'import.meta.env.VITE_AWS_REGION': JSON.stringify(getEnv('VITE_AWS_REGION', 'us-east-1')),
      'import.meta.env.VITE_COGNITO_USER_POOL_ID': JSON.stringify(getEnv('VITE_COGNITO_USER_POOL_ID')),
      'import.meta.env.VITE_COGNITO_CLIENT_ID': JSON.stringify(getEnv('VITE_COGNITO_CLIENT_ID')),
      'import.meta.env.VITE_COGNITO_DOMAIN': JSON.stringify(getEnv('VITE_COGNITO_DOMAIN')),
      'import.meta.env.VITE_COGNITO_AUTH_ORIGIN': JSON.stringify(getEnv('VITE_COGNITO_AUTH_ORIGIN')),
      'import.meta.env.VITE_WEB_OAUTH_REDIRECT_URI': JSON.stringify(getEnv('VITE_WEB_OAUTH_REDIRECT_URI')),
      // Set VITE_DEBUG_LOGS=true to force full debug logging to the console even
      // in release/build mode (release normally suppresses info/debug). Lets you
      // see Turbopuffer / KG / network logs in the packaged app while diagnosing.
      'import.meta.env.VITE_DEBUG_LOGS': JSON.stringify(getEnv('VITE_DEBUG_LOGS')),
      'import.meta.env.VITE_API_GATEWAY_URL': JSON.stringify(getEnv('VITE_API_GATEWAY_URL')),
      'import.meta.env.VITE_S3_BUCKET': JSON.stringify(getEnv('VITE_S3_BUCKET')),
      'import.meta.env.VITE_CLOUDFRONT_URL': JSON.stringify(getEnv('VITE_CLOUDFRONT_URL')),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          // Main app window.
          main: path.resolve(__dirname, 'index.html'),
          // Lightweight bundle for the always-on-top overlay windows (recording
          // indicator + meeting-detection prompt) — see overlay.html / overlay.tsx.
          overlay: path.resolve(__dirname, 'overlay.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
