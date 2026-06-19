import { defineConfig } from 'tsdown';

/**
 * tsdown(rolldown 기반) 번들 설정 — esbuild를 쓰지 않는다.
 * src/index.ts → dist/index.js (ESM). 의존성(discord.js 등)은 external로 두고
 * 런타임 node_modules에서 해석한다. hook-emit.mjs는 별도(번들 제외, 훅이 직접 실행).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
});
