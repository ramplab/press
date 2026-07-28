import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    cssCodeSplit: false,
    lib: {
      // `theme` and `roman` are hooks-free entries (theme preference + init
      // script; roman-numeral book furniture) so React Server Components can
      // import them without pulling in the widgets.
      entry: {
        index: 'src/index.ts',
        theme: 'src/themeControl.ts',
        roman: 'src/roman.ts',
        // The brand mark is a pure SVG (no hooks) so any surface — including
        // Server Components — can print it without the widget barrel.
        brand: 'src/BrandMark.tsx',
        // The Codebase → Journey loader animates in pure CSS (no hooks), so
        // it too stays out of the widget barrel; its styles land in style.css.
        loader: 'src/JourneyLoader.tsx',
        // The pure layout engine — no React, no CSS — so Server Components and
        // the catalog's hero-content derivation can share the one layout source
        // of truth without importing the widget barrel.
        systemMapLayout: 'src/systemMapLayout.ts',
      },
      formats: ['es'],
      cssFileName: 'style',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@ramplab/spec'],
    },
  },
});
