import { defineConfig } from 'vite';
// `vite build --mode profile` (npm run build:profile) makes a React profiling build in
// .cache/dist-profile for tests/desktop-performance.spec.ts: the <Profiler> in main.tsx then
// reports commit times. Released and test builds use the normal production React.
export default defineConfig(({ mode }) => ({
  base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true },
  resolve: mode === 'profile' ? { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } : {},
  build: mode === 'profile' ? { outDir: '.cache/dist-profile', emptyOutDir: true } : { outDir: 'dist', emptyOutDir: true },
}));
