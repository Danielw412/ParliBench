import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react-router-dom', ...['ArrowRight','ArrowUpRight','ArrowLeft','ArrowClockwise','Scales','Sun','Moon','Check','CircleNotch','Info','EyeSlash','LockSimple','PencilSimple','UploadSimple','Plus','Play'].map(icon => `@phosphor-icons/react/dist/csr/${icon}`)] },
    base: env.VITE_BASE_PATH || '/',
    server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
    build: { sourcemap: false },
  };
});
