import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://makuma1005.com',
  integrations: [sitemap()]
});