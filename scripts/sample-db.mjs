// 시험·스크린샷용 SQLite DB: 고객·주문(1200행)·메모(기본 키 없음)·뷰
// 사용: node scripts/sample-db.mjs <파일>
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export function makeSampleDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      city TEXT,
      joined TEXT DEFAULT CURRENT_DATE
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      total NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      ordered_at TEXT NOT NULL
    );
    CREATE INDEX ix_orders_customer ON orders (customer_id);
    CREATE INDEX ix_orders_status ON orders (status, ordered_at);
    CREATE TABLE notes (author TEXT, body TEXT);
    CREATE VIEW v_big_orders AS SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total >= 500;
  `)
  const names = ['김민준', '이서연', '박지호', '최수아', '정도윤', '강하은', '조시우', '윤지유', 'Alice Kim', 'Brian Lee', 'Chloe Park', 'Daniel Choi']
  const cities = ['서울', '부산', '대구', '인천', '광주', '대전', null]
  const ins = db.prepare('INSERT INTO customers (name, email, city, joined) VALUES (?, ?, ?, ?)')
  names.forEach((n, i) => ins.run(n, `user${i + 1}@example.com`, cities[i % cities.length], `2025-${String((i % 12) + 1).padStart(2, '0')}-1${i % 9}`))
  const statuses = ['new', 'paid', 'shipped', 'cancelled']
  const ord = db.prepare('INSERT INTO orders (customer_id, total, status, ordered_at) VALUES (?, ?, ?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < 1200; i++) {
    ord.run((i % names.length) + 1, Math.round(((i * 37) % 997) * 1.07 * 100) / 100, statuses[i % 4], `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')} 1${i % 10}:00:00`)
  }
  db.exec('COMMIT')
  db.exec(`INSERT INTO notes VALUES ('김민준', '첫 메모'), ('김민준', '첫 메모'), ('Alice Kim', 'hello')`)
  db.close()
  return file
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(makeSampleDb(path.resolve(process.argv[2] || 'sample.db')))
}
