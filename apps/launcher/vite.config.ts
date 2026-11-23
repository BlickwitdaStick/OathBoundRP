import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

// `electron/main.ts` reads its configuration via `process.env.VITE_*`, but
// nothing put those values into `process.env`: Vite loads `.env` into
// `import.meta.env` (renderer), not into the main Node process, and the
// packaged app doesn't even have a `.env` next to it. Result: CLIENT_ID,
// SERVER_IP, API_PORT and DIST_REPO always fell back to empty/localhost, so
// login, the queue, mod verification and updates could never work outside the
// development machine.
//
// The fix is to replace those accesses at build time (`define`), which is the
// only mechanism that survives packaging.
//
// VITE_DISCORD_CLIENT_SECRET is NOT in this list on purpose: any value
// embedded here travels inside the installer and can be extracted by any
// player. Exchanging the code for a token is now done by the web panel, which
// is what holds the secret — see docs/technical/LAUNCHER_DISTRIBUTION.md.
const INLINED_ENV = [
  'VITE_DISCORD_CLIENT_ID',
  'VITE_DISCORD_REDIRECT_URI',
  'VITE_SERVER_IP',
  'VITE_SERVER_PORT',
  'VITE_API_PORT',
  'VITE_GITHUB_DIST_REPO',
  'VITE_PANEL_URL'
] as const

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_')

  const mainDefine: Record<string, string> = {}
  for (const key of INLINED_ENV) {
    mainDefine[`process.env.${key}`] = JSON.stringify(env[key] ?? '')
  }

  const electronBuild = (entry: string, extra: Record<string, unknown> = {}) => ({
    entry,
    ...extra,
    vite: {
      define: mainDefine,
      build: {
        outDir: 'dist-electron',
        minify: mode === 'production',
        rollupOptions: {
          // `.mjs`, not `.js` — package.json has "type": "module", but
          // electron-builder packages by looking only at the `main` field of
          // its extraMetadata, without trusting the real package.json "type".
          // Without the explicit extension, the packaged installer failed with
          // "entry file not found", looking for the old `.js` inside the
          // ASAR. See electron-builder.json and package.json "main".
          //
          // An attempt to force the preload to CJS (`format: 'cjs'`) was
          // reverted: this version of vite-plugin-electron targets Vite 8
          // (Rolldown) and reads `build.rolldownOptions`, not `rollupOptions` —
          // the `format` here was silently ignored, and the file came out
          // with a `.cjs` extension but real `import`/`export` inside, which
          // would break on load (worse than before). See
          // docs/technical/LAUNCHER_DISTRIBUTION.md §7.
          output: {
            entryFileNames: '[name].mjs',
          },
        },
      },
    },
  })

  return {
    plugins: [
      react(),
      electron([
        electronBuild('electron/main.ts'),
        electronBuild('electron/preload.ts', {
          onstart(options: { reload: () => void }) {
            options.reload()
          },
        }),
      ]),
      renderer(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      emptyOutDir: true,
    },
  }
})
