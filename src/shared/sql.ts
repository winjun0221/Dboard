// SQL 글 나누기: 문장 경계(;, SQL Server의 GO, MySQL의 DELIMITER, 빈 줄), 커서 아래 문장, 위험한 문장 알아보기
// 글자 그대로인 부분(문자열·주석·따옴표 이름·PostgreSQL $$ 본문)은 먼저 공백으로 가린 뒤(mask) 나머지만 본다.
import type { Dialect } from './types'

export interface Stmt {
  /** 원래 글에서 문장 처음 (앞 공백 뺌) */
  from: number
  /** 문장 끝 (구분자 앞, 뒤 공백 뺌) */
  to: number
  /** 구분자까지 포함한 끝 (커서가 ; 바로 뒤에 있어도 이 문장) */
  end: number
  text: string
}

export interface SplitOptions {
  /** 빈 줄도 문장 구분 (커서 아래 문장 찾을 때). 괄호·BEGIN 블록 안에서는 무시 */
  blankLines?: boolean
  /** ;로 나누기. 기본: SQL Server만 끔(GO로만 나눔 — DECLARE한 변수가 다음 문장까지 이어지게) */
  semicolon?: boolean
}

const isIdent = (c: string | undefined) => !!c && /[\p{L}\p{N}_$@#]/u.test(c)
const isIdentStart = (c: string | undefined) => !!c && /[\p{L}_]/u.test(c)

/** 같은 길이의 글: 문자열·주석·따옴표 이름은 공백(줄바꿈도 공백으로 — 안의 빈 줄·GO 줄에 속지 않게) */
export function mask(src: string, d: Dialect): string {
  const out = src.split('')
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) out[k] = ' '
  }
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    // 줄 주석
    if ((c === '-' && c2 === '-') || (d === 'mysql' && c === '#')) {
      let j = i
      while (j < n && src[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    // 블록 주석 (PostgreSQL은 겹쳐 쓸 수 있음)
    if (c === '/' && c2 === '*') {
      let j = i + 2
      let depth = 1
      while (j < n && depth > 0) {
        if (src[j] === '*' && src[j + 1] === '/') {
          depth--
          j += 2
        } else if (d === 'postgres' && src[j] === '/' && src[j + 1] === '*') {
          depth++
          j += 2
        } else j++
      }
      blank(i, j)
      i = j
      continue
    }
    // PostgreSQL $태그$ … $태그$
    if (d === 'postgres' && c === '$' && !isIdent(src[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))
      if (m) {
        const tag = m[0]
        const close = src.indexOf(tag, i + tag.length)
        const j = close < 0 ? n : close + tag.length
        blank(i, j)
        i = j
        continue
      }
    }
    // 문자열·따옴표 이름
    const closeOf: Record<string, string> = { "'": "'", '"': '"' }
    if (d === 'mysql') closeOf['`'] = '`'
    if (d === 'mssql') closeOf['['] = ']'
    if (c in closeOf) {
      const close = closeOf[c]
      // 백슬래시 이스케이프: MySQL 문자열, PostgreSQL E'…'
      const backslash = (d === 'mysql' && c !== '`') || (d === 'postgres' && c === "'" && /[eE]/.test(src[i - 1] ?? '') && !isIdent(src[i - 2]))
      let j = i + 1
      while (j < n) {
        if (backslash && src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === close) {
          if (src[j + 1] === close) {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      blank(i, Math.min(j, n))
      i = j
      continue
    }
    i++
  }
  return out.join('')
}

const TX_WORDS = new Set(['TRANSACTION', 'TRAN', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'ISOLATION', 'READ', 'DISTRIBUTED', 'FROM', 'AS', 'IS', 'AND', 'OR'])
const END_IGNORE = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT'])

/** 다음 낱말(또는 기호 하나). 없으면 '' */
function nextToken(m: string, i: number): string {
  const r = /^\s*([\p{L}_][\p{L}\p{N}_]*|[^\s])?/u.exec(m.slice(i, i + 200))
  return (r?.[1] ?? '').toUpperCase()
}

/** 문장들로 나누기. 주석만 있는 조각은 뺀다 */
export function splitSql(src: string, d: Dialect, opts: SplitOptions = {}): Stmt[] {
  const m = mask(src, d)
  const semicolon = opts.semicolon ?? d !== 'mssql'
  const out: Stmt[] = []
  let start = 0
  let depth = 0
  let block = 0
  let delim = ';'

  const push = (a: number, b: number, end: number) => {
    let x = a
    let y = b
    while (x < y && /\s/.test(src[x])) x++
    while (y > x && /\s/.test(src[y - 1])) y--
    if (m.slice(x, y).trim()) out.push({ from: x, to: y, end: Math.max(end, y), text: src.slice(x, y) })
  }
  const reset = () => {
    depth = 0
    block = 0
  }

  let i = 0
  const n = src.length
  while (i < n) {
    // 줄 처음: DELIMITER · GO · 빈 줄
    if (i === 0 || m[i - 1] === '\n') {
      let eol = m.indexOf('\n', i)
      if (eol < 0) eol = n
      const line = m.slice(i, eol)
      const rawLine = src.slice(i, eol)
      if (d === 'mysql' && /^\s*DELIMITER\s+\S+\s*$/i.test(line)) {
        push(start, i, i)
        delim = rawLine.trim().split(/\s+/)[1]
        start = eol + 1
        i = eol + 1
        reset()
        continue
      }
      if (d === 'mssql' && /^\s*GO(\s+\d+)?\s*$/i.test(line)) {
        push(start, i, eol)
        start = eol + 1
        i = eol + 1
        reset()
        continue
      }
      if (opts.blankLines && line.trim() === '' && depth === 0 && block === 0 && m.slice(start, i).trim()) {
        push(start, i, i)
        start = i
      }
    }
    const c = m[i]
    if (semicolon && depth === 0 && block === 0 && m.startsWith(delim, i)) {
      push(start, i, i + delim.length)
      i += delim.length
      start = i
      continue
    }
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (isIdentStart(c) && !isIdent(m[i - 1])) {
      let j = i
      // 낱말은 구분자(DELIMITER $$ 등) 앞에서 끊는다: END$$
      while (j < n && isIdent(m[j]) && !(delim !== ';' && m.startsWith(delim, j))) j++
      const w = m.slice(i, j).toUpperCase()
      if (w === 'CASE') block++
      else if (w === 'BEGIN') {
        const next = nextToken(m, j)
        const isBlock = d === 'postgres' ? next === 'ATOMIC' : !(next === '' || TX_WORDS.has(next) || /^[;,)=.]$/.test(next) || (delim !== ';' && delim.startsWith(next)))
        if (isBlock) block++
      } else if (w === 'END') {
        if (!END_IGNORE.has(nextToken(m, j)) && block > 0) block--
      }
      i = j
      continue
    }
    i++
  }
  push(start, n, n)
  return out
}

/** 커서 아래 문장. 문장 사이 빈칸이면 같은 줄·바로 윗줄에서 끝난 문장, 아니면 바로 다음 줄에서 시작하는 문장 */
export function statementAt(src: string, offset: number, d: Dialect): Stmt | null {
  const list = splitSql(src, d, { blankLines: true, semicolon: true })
  const inside = list.find((s) => offset >= s.from && offset <= s.end)
  if (inside) return inside
  const prev = [...list].reverse().find((s) => s.end <= offset)
  if (prev && /^[ \t]*\r?\n?[ \t]*$/.test(src.slice(prev.end, offset))) return prev
  const next = list.find((s) => s.from >= offset)
  if (next && /^[ \t]*\r?\n?[ \t]*$/.test(src.slice(offset, next.from))) return next
  return null
}

/** 주석 뒤 첫 낱말 (대문자) */
export function firstKeyword(sql: string, d: Dialect): string {
  const r = /^\s*([\p{L}_]+)/u.exec(mask(sql, d))
  return (r?.[1] ?? '').toUpperCase()
}

/** WHERE 없는 UPDATE·DELETE (괄호 밖 기준) */
export function isDangerous(sql: string, d: Dialect): boolean {
  const kw = firstKeyword(sql, d)
  if (kw !== 'UPDATE' && kw !== 'DELETE') return false
  const m = mask(sql, d)
  let depth = 0
  let flat = ''
  for (const c of m) {
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) flat += c
  }
  return !/\bWHERE\b/i.test(flat)
}

const ROW_WORDS = new Set(['SELECT', 'WITH', 'SHOW', 'VALUES', 'TABLE', 'PRAGMA', 'EXPLAIN', 'DESCRIBE', 'DESC'])

/** 다시 실행해도 안전한(행만 읽는) 문장인지 — 'CSV로 전부 내보내기'에서 다시 실행할 때만 쓴다 */
export function isReadOnlyQuery(sql: string, d: Dialect): boolean {
  if (!ROW_WORDS.has(firstKeyword(sql, d))) return false
  // WITH … DELETE, SELECT … INTO 같은 쓰기 문장은 제외
  return !/\b(INSERT|UPDATE|DELETE|MERGE|INTO|CREATE|DROP|ALTER|TRUNCATE|CALL|EXEC|EXECUTE)\b/i.test(mask(sql, d))
}

// ───────── 자동 완성: 문장에 나오는 표 ─────────

const CLAUSE_END = /^(WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|FETCH|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|NATURAL|ON|USING|UNION|INTERSECT|EXCEPT|WINDOW|FOR|SET|VALUES|RETURNING|SELECT|WITH)$/i
const OPEN_CLOSE: Record<string, string> = { '"': '"', '`': '`', '[': ']' }

/** pos부터 (공백 건너뛰고) 점으로 이은 이름 하나. 따옴표는 벗기고 마지막 부분(표 이름)만 */
function readName(src: string, masked: string, pos: number): { name: string; end: number } | null {
  let i = pos
  // 주석은 mask에서 공백이 됐다. 따옴표 이름도 공백이 되므로 원래 글의 여는 따옴표에서 멈춘다
  while (i < src.length && /\s/.test(masked[i]) && !(src[i] in OPEN_CLOSE)) i++
  let name = ''
  for (;;) {
    const c = src[i]
    if (c !== undefined && c in OPEN_CLOSE) {
      const close = src.indexOf(OPEN_CLOSE[c], i + 1)
      if (close < 0) return null
      name = src.slice(i + 1, close)
      i = close + 1
    } else {
      const m = /^[\p{L}\p{N}_$#@]+/u.exec(src.slice(i, i + 256))
      if (!m) return null
      name = m[0]
      i += m[0].length
    }
    if (src[i] !== '.') break
    i++
  }
  return name ? { name, end: i } : null
}

/** 문장에서 FROM·JOIN·UPDATE·INTO·TABLE 뒤에 나오는 표 이름 (FROM a x, b y 목록 포함, 스키마는 뗌). 자동 완성에서 열 이름을 고를 때 쓴다 */
export function referencedTables(sql: string, d: Dialect): string[] {
  const masked = mask(sql, d)
  const out: string[] = []
  const seen = new Set<string>()
  const add = (n: string) => {
    if (CLAUSE_END.test(n) || seen.has(n.toLowerCase())) return
    seen.add(n.toLowerCase())
    out.push(n)
  }
  for (const k of masked.matchAll(/\b(FROM|JOIN|UPDATE|INTO|TABLE)\b/gi)) {
    let i = k.index + k[0].length
    for (;;) {
      const r = readName(sql, masked, i)
      if (!r) break
      add(r.name)
      if (k[1].toUpperCase() !== 'FROM') break
      // FROM a [AS] x, b … — 별칭을 건너뛰고 쉼표가 있으면 다음 표
      const rest = masked.slice(r.end, r.end + 200)
      const m = /^\s*(?:(?:AS\s+)?([\p{L}\p{N}_$]+))?\s*,/iu.exec(rest)
      if (!m || (m[1] && CLAUSE_END.test(m[1]))) break
      i = r.end + m[0].length
    }
  }
  return out
}

/** DDL의 REFERENCES 뒤 표 이름들 (덤프에서 부모 표를 먼저 만들려고) */
export function ddlReferences(ddl: string, d: Dialect): string[] {
  const masked = mask(ddl, d)
  const out = new Set<string>()
  for (const k of masked.matchAll(/\bREFERENCES\b/gi)) {
    const r = readName(ddl, masked, k.index + k[0].length)
    if (r) out.add(r.name)
  }
  return [...out]
}

/** 쿼리 변수 하나: SQL 안의 :이름 또는 ${이름} 자리 */
export interface QueryParam {
  name: string
  from: number
  to: number
}

/** 쿼리 변수 찾기. 문자열·주석 안은 빼고, PostgreSQL ::타입 변환과 := 대입도 변수가 아니다 */
export function findParams(src: string, d: Dialect): QueryParam[] {
  const m = mask(src, d)
  const out: QueryParam[] = []
  const re = /\$\{([A-Za-z_][\w.]*)\}|(?<![:\w$@]):([A-Za-z_]\w*)/g
  for (let x = re.exec(m); x; x = re.exec(m)) out.push({ name: x[1] ?? x[2], from: x.index, to: x.index + x[0].length })
  return out
}

/** 쿼리 변수 자리에 값을 그대로 넣는다 (값은 SQL 조각: 글자는 따옴표까지 사용자가 쓴다) */
export function bindParams(src: string, d: Dialect, values: Record<string, string>): string {
  const list = findParams(src, d)
  let s = src
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]
    if (Object.prototype.hasOwnProperty.call(values, p.name)) s = s.slice(0, p.from) + values[p.name] + s.slice(p.to)
  }
  return s
}
