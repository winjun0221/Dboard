// 앱 묶음에서 @duckdb/node-bindings 대신 들어간다 (scripts/build-options.mjs의 alias).
// 네이티브 파일은 설치 파일에 없고, 처음 쓸 때 앱 데이터 폴더로 받은 것(engines.ts가 경로를 알려 줌)을 연다.
const file = globalThis.__dboardDuckdbBinding
if (!file) throw new Error('DuckDB engine is not installed')
const m = { exports: {} }
process.dlopen(m, file)
module.exports = m.exports
