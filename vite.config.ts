import { defineConfig } from 'vite';
import { developmentConfig } from './src/dev/config.ts';

export default defineConfig(() => ({
  ...developmentConfig(),
  build: { outDir: 'dist', emptyOutDir: true },
}));
