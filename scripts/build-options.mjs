// 메인 프로세스 묶기 설정 (build-main.mjs·dev.mjs·notices.mjs가 같이 씀)
// - 모든 npm 패키지를 dist/main 안에 묶는다 (설치 파일엔 dist/만 들어감)
// - pg-native·cpu-features·pg-cloudflare는 없어도 되는 선택 기능이라 묶지 않는다 (불러오다 실패하면 각 패키지가 알아서 건너뜀)
// - DuckDB 네이티브 파일(@duckdb/node-bindings)은 설치 파일에 넣지 않고 처음 쓸 때 받는다 → 받은 파일을 여는 duckdb-binding.cjs로 바꿔 묶는다
export const mainOptions = {
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts', 'src/main/sqlite-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'pg-native', 'cpu-features', 'pg-cloudflare', 'cloudflare:sockets'],
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  alias: { '@duckdb/node-bindings': './src/main/drivers/duckdb-binding.cjs' },
  logOverride: { 'require-resolve-not-external': 'silent' },
}
