import { defineConfig } from 'astro/config';

// Statyczna strona wizytówkowa — build trafia do folderu `dist/`,
// który Cloudflare Pages serwuje bez żadnego dodatkowego adaptera.
export default defineConfig({
  site: 'https://arturgladosz.pl',
});
