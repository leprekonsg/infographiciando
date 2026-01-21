import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.DASHSCOPE_API_KEY': JSON.stringify(env.DASHSCOPE_API_KEY),
      'process.env.QWEN_API_KEY': JSON.stringify(env.QWEN_API_KEY),
      'process.env.QWEN_VL_PROXY_URL': JSON.stringify(env.QWEN_VL_PROXY_URL)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    // Exclude Node-only modules from browser bundle
    optimizeDeps: {
      exclude: [
        '@resvg/resvg-js', // Native module: Node.js only
      ]
    },
    build: {
      rollupOptions: {
        external: [
          '@resvg/resvg-js' // Prevent bundling native module
        ]
      }
    }
  };
});
