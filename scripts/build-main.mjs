// 메인 프로세스·preload·SQLite 작업 스레드 묶기 → dist/main/*.cjs
import { build } from 'esbuild'
import { mainOptions } from './build-options.mjs'

await build({ ...mainOptions, logLevel: 'warning' })
