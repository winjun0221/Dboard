// 결과·표 내보내기: CSV · 엑셀(xlsx) · JSON · Markdown · SQL(INSERT). 큰 결과도 조금씩 파일에 쓴다.
// 엑셀은 큰 라이브러리 없이 fflate로 zip(xlsx)을 바로 만든다 (글자는 inlineStr, 첫 줄 굵게·고정).
import fs from 'node:fs'
import { Zip, ZipDeflate, strToU8 } from 'fflate'
import { csvLine } from '../shared/csv'
import { literal, quoteIdent } from '../shared/dialect'
import { t } from '../shared/i18n'
import { isBin, type Cell, type CsvWriteOptions } from '../shared/types'

export type RowSource = (onColumns: (names: string[]) => void, onRows: (rows: Cell[][]) => Promise<void>) => Promise<number>

/** 엑셀 한 시트의 최대 행 (머리글 포함) */
const XLSX_MAX_ROWS = 1_048_576
const XLSX_MAX_TEXT = 32_767

export const EXTENSIONS: Record<CsvWriteOptions['format'], string> = { csv: 'csv', xlsx: 'xlsx', json: 'json', md: 'md', sql: 'sql' }

/** 디스크가 따라오게 쓰기 (drain 기다림) */
function fileWriter(file: string) {
  const out = fs.createWriteStream(file)
  let failed: Error | null = null
  out.on('error', (e) => {
    failed = e
  })
  const write = (s: string | Uint8Array) => new Promise<void>((resolve, reject) => {
    if (failed) return reject(failed)
    if (out.write(s)) return resolve()
    const done = (e?: Error) => {
      out.off('drain', done)
      out.off('error', done)
      if (e) reject(e)
      else resolve()
    }
    out.on('drain', done)
    out.on('error', done)
  })
  const end = () => new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  return { write, end, destroy: () => out.destroy() }
}

const binText = (v: Cell) => (v !== null && isBin(v) ? '0x' + v.bin.toUpperCase() : v)

/** 열 이름이 겹치면 _2, _3 (JSON 키) */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1
    seen.set(n, k)
    return k === 1 ? n : `${n}_${k}`
  })
}

const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g
const xmlText = (s: string) => s.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 숫자로 넣어도 값이 안 바뀌는 글자 (앞자리 0 없음, 15자리 이하) */
const SAFE_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/

function xlsxCell(v: Cell, style = ''): string {
  if (v === null) return '<c/>'
  if (typeof v === 'number' && Number.isFinite(v)) return `<c${style}><v>${v}</v></c>`
  if (typeof v === 'boolean') return `<c${style} t="b"><v>${v ? 1 : 0}</v></c>`
  const s = String(binText(v))
  if (!style && SAFE_NUMBER.test(s) && s.replace(/[-.]/g, '').length <= 15) return `<c><v>${s}</v></c>`
  return `<c${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(s.length > XLSX_MAX_TEXT ? s.slice(0, XLSX_MAX_TEXT) : s)}</t></is></c>`
}

const NS = 'http://schemas.openxmlformats.org'
const XLSX_STATIC: Record<string, string> = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
}

async function writeXlsx(file: string, o: CsvWriteOptions, run: RowSource): Promise<number> {
  const out = fileWriter(file)
  let pending: Promise<void> = Promise.resolve()
  let zipError: Error | null = null
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err
      return
    }
    const w = out.write(chunk)
    pending = pending.then(() => w)
    if (final) pending = pending.then(() => out.end())
  })
  const push = async (entry: ZipDeflate, s: string, final = false) => {
    entry.push(strToU8(s), final)
    if (zipError) throw zipError
    await pending
  }
  try {
    for (const [name, xml] of Object.entries(XLSX_STATIC)) {
      const e = new ZipDeflate(name, { level: 6 })
      zip.add(e)
      await push(e, xml, true)
    }
    const sheet = new ZipDeflate('xl/worksheets/sheet1.xml', { level: 6 })
    zip.add(sheet)
    const freeze = o.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ''
    await push(sheet, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}/spreadsheetml/2006/main">${freeze}<sheetData>`)
    let lines = 0
    let header = ''
    let written = 0
    const n = await run(
      (names) => {
        if (o.header) {
          header = '<row>' + names.map((x) => xlsxCell(x, ' s="1"')).join('') + '</row>'
          lines = 1
        }
      },
      async (rows) => {
        let xml = header
        header = ''
        for (const r of rows) {
          if (lines >= XLSX_MAX_ROWS) break
          xml += '<row>' + r.map((v) => xlsxCell(v)).join('') + '</row>'
          lines++
          written++
        }
        if (xml) await push(sheet, xml)
      },
    )
    await push(sheet, header + '</sheetData></worksheet>', true)
    zip.end()
    await pending
    if (written < n) throw new Error(t('엑셀은 한 시트에 {n}행까지라 {written}행만 썼어요. 전부 필요하면 CSV로 내보내 주세요.', { n: XLSX_MAX_ROWS - 1, written }))
    return n
  } catch (e) {
    zip.terminate()
    out.destroy()
    throw e
  }
}

/** 결과를 파일로. 형식은 o.format, 반환은 쓴 행 수 */
export async function writeExport(file: string, o: CsvWriteOptions, run: RowSource): Promise<number> {
  if (o.format === 'xlsx') return writeXlsx(file, o, run)
  const out = fileWriter(file)
  try {
    let names: string[] = []
    let first = true
    let header: Promise<void> = Promise.resolve()
    const start = (cols: string[]) => {
      names = cols
      if (o.format === 'csv') {
        if (o.bom) header = out.write('﻿')
        if (o.header) header = header.then(() => out.write(csvLine(cols, o.delimiter) + '\r\n'))
      } else if (o.format === 'json') {
        names = uniqueNames(cols)
        header = out.write('[\n')
      } else if (o.format === 'md') {
        const esc = (s: string) => s.replace(/\|/g, '\\|')
        header = out.write(`| ${cols.map(esc).join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n`)
      }
    }
    const table = o.table.trim() || 'result'
    const target = table.split('.').map((x) => quoteIdent(o.dialect, x)).join('.')
    const n = await run(start, async (rows) => {
      await header
      let text = ''
      if (o.format === 'csv') text = rows.map((r) => csvLine(r, o.delimiter, o.nullText)).join('\r\n') + '\r\n'
      else if (o.format === 'json') {
        text = rows.map((r) => {
          const obj: Record<string, unknown> = {}
          r.forEach((v, i) => {
            obj[names[i]] = binText(v)
          })
          return (first ? '  ' : ',\n  ') + (first = false, JSON.stringify(obj))
        }).join('')
      } else if (o.format === 'md') {
        const cell = (v: Cell) => (v === null ? o.nullText : String(binText(v))).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
        text = rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n') + '\n'
      } else {
        const cols = names.map((x) => quoteIdent(o.dialect, x)).join(', ')
        text = rows.map((r) => `INSERT INTO ${target} (${cols}) VALUES (${r.map((v) => literal(o.dialect, v)).join(', ')});`).join('\n') + '\n'
      }
      await out.write(text)
    })
    await header
    if (o.format === 'json') await out.write(first ? ']\n' : '\n]\n')
    await out.end()
    return n
  } catch (e) {
    out.destroy()
    throw e
  }
}
