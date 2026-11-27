// 시험용 DB 서버(Docker)를 올리고 실제 서버 테스트까지 돌린다
// 사용: npm run test:db [-- --down]   (--down: 끝나면 서버를 내림)
import { execFileSync, spawnSync } from 'node:child_process'

const compose = ['compose', '-f', 'test/docker-compose.yml']
console.log('시험용 DB 서버 올리는 중… (처음에는 이미지를 받느라 오래 걸려요)')
execFileSync('docker', [...compose, 'up', '-d', '--build', '--wait'], { stdio: 'inherit' })
const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/servers.test.ts', 'test/dump-servers.test.ts', 'test/stage1-servers.test.ts', 'test/stage2-servers.test.ts', 'test/stage3-servers.test.ts', 'test/stage32-servers.test.ts', 'test/stage33-servers.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, DBOARD_TEST_DBS: '1' },
})
if (process.argv.includes('--down')) execFileSync('docker', [...compose, 'down', '-v'], { stdio: 'inherit' })
process.exit(r.status ?? 1)
