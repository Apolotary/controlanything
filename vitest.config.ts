import { defineConfig } from 'vitest/config';

// One run over every workspace; each package/app folder is its own project.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
