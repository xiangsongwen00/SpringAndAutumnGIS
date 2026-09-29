import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Development-only bridge for the localhost services documented in 测试数据.md.
      // Production deployments should configure CORS or an equivalent same-origin gateway.
      '/test/geoserver': {
        target: 'http://localhost:7777',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/test\/geoserver/, '')
      },
      '/test/mapservice': {
        target: 'http://localhost:8085',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/test\/mapservice/, '')
      },
      '/test/business-map': {
        target: 'https://map.liaoliaofarm.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/test\/business-map/, '')
      }
    }
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'SpringAndAutumnGIS',
      fileName: (format) => `spring-and-autumn-gis.${format}.js`
    },
    rollupOptions: {
      external: ['three'],
      output: {
        globals: {
          three: 'THREE'
        }
      }
    }
  }
});
