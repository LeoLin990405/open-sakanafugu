import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/main.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: { entry: ['src/index.ts'] }, // declarations for the library surface only (not the CLI/tests)
  banner: { js: '' },
});
