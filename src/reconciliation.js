export const OPERADORES = {
  3: 'Rinaldo Ramos da Silva',
  4: 'José Wesley de Souza Maranhão',
  8: 'Katia Rejane do Nascimento',
  13: 'Claudia Rodrigues da Silva Araújo',
  15: 'Willian Cesar Ramos de Souza',
  16: 'Deuzeni Maria da Silva',
  17: 'José Ramos da Silva Junior',
  19: 'Shakira Kessia Santana de Souza',
}

export const STATUS_LABEL = {
  CONCILIADA: 'Conciliada',
  DIVERGENCIA: 'Divergência',
  SEM_RECEBIMENTO: 'Sem recebimento',
  RECEBIMENTO_SEM_VENDA: 'Recebimento sem venda',
  DUPLICADO: 'Duplicado',
  DEVOLUCAO: 'Devolução',
}

const DATE_RE = /(\d{2}\/\d{2}\/\d{2,4})/
const TIME_RE = /(\d{2}:\d{2})(?::\d{2})?/
const MONEY_RE = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g
const OP_CODES = Object.keys(OPERADORES)
const NOME_TO_CODE = Object.fromEntries(
  Object.entries(OPERADORES).map(([code, name]) => [name.split(' ')[0].toUpperCase(), code]),
)

export async function extractPdfLines(file) {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const allLines = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1 })
    const rows = new Map()

    content.items.forEach((item) => {
      // The source reports can be saved with a 90° page rotation. Converting
      // to viewport coordinates normalizes every orientation before grouping.
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      const rowY = Math.round(y)
      const row = rows.get(rowY) ?? []
      row.push({ x, text: item.str })
      rows.set(rowY, row)
    })

    ;[...rows.entries()]
      .sort(([a], [b]) => a - b)
      .forEach(([, row]) => {
        const line = row
          .sort((a, b) => a.x - b.x)
          .map((item) => item.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (line) allLines.push(line)
      })
  }

  return allLines
}

function timeToMinutes(hhmm = '00:00') {
  const [hours, minutes] = hhmm.split(':').map(Number)
  return hours * 60 + minutes
}

function parseDataHora(dataStr, horaStr) {
  if (!dataStr) return null
  let [day, month, year] = dataStr.split('/').map(Number)
  if (year < 100) year += 2000
  const [hours = 0, minutes = 0] = (horaStr ?? '').split(':').map(Number)
  return new Date(year, month - 1, day, hours, minutes)
}

function toNumber(moneyStr) {
  return moneyStr ? Number.parseFloat(moneyStr.replace(/\./g, '').replace(',', '.')) : null
}

function findAllMoney(line) {
  return [...line.matchAll(MONEY_RE)].map((match) => match[0])
}

function findOperadorCode(text) {
  const upper = text.toUpperCase()
  for (const [name, code] of Object.entries(NOME_TO_CODE)) {
    if (new RegExp(`\\b${name}\\b`).test(upper)) return code
  }
  return OP_CODES.sort((a, b) => b.length - a.length).find((code) => new RegExp(`\\b${code}\\b`).test(text)) ?? null
}

export function parseTrierLines(lines) {
  const formas = 'CARTAO|PIX|DINHEIRO|CREDIARIO|CHEQUE'
  const parseChunk = (chunk) => {
    const head = chunk.match(new RegExp(`^(\\d{4,8})\\s+\\d{0,3}\\s*(${formas})\\b`))
    const date = chunk.match(DATE_RE)
    const time = chunk.match(TIME_RE)
    const monies = findAllMoney(chunk)
    if (!head || !date || !time || !monies.length) return null
    return {
      numero: head[1],
      forma: head[2],
      operador: findOperadorCode(chunk),
      tele: /\bSim\b/.test(chunk) ? 'Sim' : '',
      isDev: /\bDev\b/i.test(chunk),
      data: date[1],
      hora: time[1],
      valor: toNumber(monies.at(-1)),
      raw: chunk.slice(0, 140),
    }
  }

  // A word boundary prevents the blob strategy from splitting inside a six-digit
  // sale number (for example, treating "268648" as "8648").
  const start = new RegExp(`(?=\\b\\d{4,8}\\s+\\d{0,3}\\s*(?:${formas})\\b)`)
  const fromBlob = lines.join(' ').split(start).map((chunk) => parseChunk(chunk.trim())).filter(Boolean)
  const fromLines = lines.map((line) => parseChunk(line.trim())).filter(Boolean)
  // Prefer the reconstructed page rows whenever they cover the same report.
  // The blob includes repeated page headings such as "Vend. Dev.", which can
  // incorrectly mark the first sale on a page as a return.
  return fromLines.length >= fromBlob.length * 0.9 ? fromLines : fromBlob
}

function parseLooseNumber(value) {
  if (typeof value === 'number') return value
  const text = String(value ?? '').trim().replace(/[^\d,.-]/g, '')
  if (!text) return null
  if (text.includes(',') && text.includes('.')) return Number(text.replace(/\./g, '').replace(',', '.'))
  if (text.includes(',')) return Number(text.replace(',', '.'))
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : null
}

function findSpreadsheetColumn(headerRow, expectedLabel) {
  return headerRow.findIndex((value) => normalizeSpreadsheetLabel(value).includes(expectedLabel))
}

function findSellerColumn(headerRow) {
  return headerRow.findIndex((value) => normalizeSpreadsheetLabel(value) === 'vend')
}

export async function parseTrierSpreadsheet(file) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true })
  const headers = { sale: 'num venda', payment: 'cond pagto', date: 'emissao', time: 'hora', total: 'total liquido' }

  for (const sheetName of workbook.SheetNames) {
    const values = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: false })
    for (let headerIndex = 0; headerIndex < values.length; headerIndex += 1) {
      const headerRow = values[headerIndex]
      const headerColumns = Object.fromEntries(Object.entries(headers).map(([key, label]) => [key, findSpreadsheetColumn(headerRow, label)]))
      if (Object.values(headerColumns).some((column) => column < 0)) continue

      // The Trier XLS export has merged headings; these offsets are the real
      // value columns in its sales rows.
      const columns = {
        sale: headerColumns.sale - 1,
        payment: headerColumns.payment + 1,
        date: headerColumns.date - 1,
        time: headerColumns.time,
        total: headerColumns.total,
        type: findSpreadsheetColumn(headerRow, 'tipo') + 1,
        delivery: findSpreadsheetColumn(headerRow, 'tele') + 2,
        operator: findSellerColumn(headerRow),
      }
      const rows = []
      for (const sourceRow of values.slice(headerIndex + 1)) {
        const numero = String(sourceRow[columns.sale] ?? '').trim()
        const forma = normalizeSpreadsheetLabel(sourceRow[columns.payment]).toUpperCase()
        const data = String(sourceRow[columns.date] ?? '').trim()
        const hora = String(sourceRow[columns.time] ?? '').trim()
        const valor = parseLooseNumber(sourceRow[columns.total])
        if (!/^\d{4,8}$/.test(numero) || !['PIX', 'CARTAO'].includes(forma) || !DATE_RE.test(data) || !TIME_RE.test(hora) || valor === null) continue
        const type = String(sourceRow[columns.type] ?? '')
        const tele = String(sourceRow[columns.delivery] ?? '')
        const operator = String(sourceRow[columns.operator] ?? '')
        rows.push({
          numero,
          forma,
          operador: OP_CODES.includes(operator.trim()) ? operator.trim() : findOperadorCode(operator),
          tele: /^sim$/i.test(tele) ? 'Sim' : '',
          isDev: /\bdev\b/i.test(type),
          data: DATE_RE.exec(data)?.[1] ?? data,
          hora: TIME_RE.exec(hora)?.[1] ?? hora,
          valor,
          raw: sourceRow.filter((value) => value !== '').join(' '),
        })
      }
      if (rows.length) return rows
    }
  }
  throw new Error('Nao encontrei uma tabela de vendas Trier valida neste XLS.')
}

export function parsePagPixLines(lines) {
  return lines.flatMap((raw) => {
    const line = raw.trim()
    const date = line.match(/(\d{2}\/\d{2}\/\d{4}),?\s*(\d{2}:\d{2}(?::\d{2})?)/)
    const money = line.match(/R\$\s*(-?[\d.,]+)/i)
    if (!date || !money) return []
    const status = /\bPAGO\b/i.test(line) ? 'PAGO'
      : /EXPIRAD/i.test(line) ? 'EXPIRADA'
        : /PENDENTE/i.test(line) ? 'PENDENTE'
          : /CANCELAD/i.test(line) ? 'CANCELADA' : null
    const tipo = /\bdelivery\b/i.test(line) ? 'Delivery' : /\bbalc[aã]o\b/i.test(line) ? 'Balcao' : null
    return [{ data: date[1], hora: date[2], operador: findOperadorCode(line), tipo, status, valor: toNumber(money[1]), raw: line }]
  })
}

function normalizeSpreadsheetLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function readSpreadsheetCell(cell) {
  if (!cell) return ''
  if (cell.text && cell.text !== '-') return cell.text.trim()
  return cell.value === null || cell.value === undefined || cell.value === '-' ? '' : String(cell.value).trim()
}

function parseSpreadsheetNumber(cell) {
  if (typeof cell?.value === 'number') return cell.value
  const text = readSpreadsheetCell(cell)
  if (!text) return null
  if (text.includes(',')) return toNumber(text)
  const value = Number(text.replace(/[^\d.-]/g, ''))
  return Number.isFinite(value) ? value : null
}

function parseSpreadsheetDateTime(value) {
  const match = String(value ?? '').match(/(\d{2}\/\d{2}\/\d{2,4})\s*,?\s*(\d{2}:\d{2}(?::\d{2})?)/)
  return match ? { data: match[1], hora: match[2] } : null
}

export async function parsePagPixSpreadsheet(file) {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await file.arrayBuffer())

  const headers = {
    createdAt: 'data criacao brasilia gmt 3',
    type: 'tipo',
    operator: 'operador',
    status: 'status',
    value: 'valor transacao',
  }
  let sheet
  let columns
  for (const candidate of workbook.worksheets) {
    const foundColumns = {}
    candidate.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      foundColumns[normalizeSpreadsheetLabel(readSpreadsheetCell(cell))] = columnNumber
    })
    if (Object.values(headers).every((header) => foundColumns[header])) {
      sheet = candidate
      columns = foundColumns
      break
    }
  }
  if (!sheet) throw new Error('Nao encontrei as colunas PaggPix esperadas: data criacao (Brasilia), tipo, operador, status e valor transacao.')

  const rows = []
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    const dateTime = parseSpreadsheetDateTime(readSpreadsheetCell(row.getCell(columns[headers.createdAt])))
    const valor = parseSpreadsheetNumber(row.getCell(columns[headers.value]))
    if (!dateTime || valor === null) continue
    const type = readSpreadsheetCell(row.getCell(columns[headers.type]))
    const operator = readSpreadsheetCell(row.getCell(columns[headers.operator]))
    const status = readSpreadsheetCell(row.getCell(columns[headers.status])).toUpperCase()
    rows.push({
      ...dateTime,
      operador: findOperadorCode(operator),
      tipo: /^delivery$/i.test(type) ? 'Delivery' : /^balc[a-z]+o$/i.test(type) ? 'Balcao' : type,
      status,
      valor,
      raw: `${dateTime.data}, ${dateTime.hora} ${type} ${operator} ${status} R$ ${valor.toFixed(2)}`,
    })
  }
  return rows
}

export function parseCieloLines(lines) {
  return lines.flatMap((raw) => {
    const line = raw.trim()
    const date = line.match(DATE_RE)
    const time = line.match(TIME_RE)
    const money = line.match(/R\$\s*(-?[\d.,]+)/i)
    if (!date || !money) return []
    const status = /N[ÃA]O\s*APROVADA/i.test(line) ? 'NAO_APROVADA'
      : /APROVADA/i.test(line) ? 'APROVADA'
        : /CANCELADA/i.test(line) ? 'CANCELADA' : null
    const bandeira = line.match(/\b(VISA|MASTER(?:CARD)?|ELO|AMEX|HIPERCARD|DINERS)\b/i)
    const parcelas = line.match(/\b(0[1-9]|[1-9])\b(?=\s+(?:VISA|MASTER(?:CARD)?|ELO|AMEX|HIPERCARD|DINERS))/i)
    return [{
      data: date[1], hora: time?.[1] ?? '', valor: toNumber(money[1]),
      bandeira: bandeira?.[1].toUpperCase() ?? '', parcelas: parcelas?.[1] ?? '1', status, raw: line,
    }]
  })
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function reconcile(files, toleranceValue, toleranceHours) {
  const trier = files.trier.rows
    .filter((row) => row.valor !== null && row.data)
    .map((row) => ({ ...row, dt: parseDataHora(row.data, row.hora), min: timeToMinutes(row.hora) }))
  if (!trier.length) throw new Error('Não encontrei vendas válidas no PDF da Trier. Confira as linhas extraídas e o formato do relatório.')

  const makePool = (key, acceptedStatus, fonte) => (files[key]?.rows ?? [])
    .filter((row) => row.status === acceptedStatus && row.valor !== null && row.data)
    .map((row) => ({ ...row, dt: parseDataHora(row.data, row.hora), min: timeToMinutes(row.hora), used: false, fonte }))
  const pagpixPool = makePool('pagpix', 'PAGO', 'PaggPix')
  const cieloPool = makePool('cielo', 'APROVADA', 'Cielo')
  const results = []
  const pending = []

  trier.forEach((sale) => {
    if (sale.isDev) results.push({ sale, status: 'DEVOLUCAO', fonte: null, motivo: 'Linha de devolução — não é recebimento a conciliar' })
    else if (['DINHEIRO', 'CREDIARIO', 'CHEQUE'].includes(sale.forma)) results.push({ sale, status: 'CONCILIADA', fonte: null, motivo: 'Meio de pagamento não eletrônico' })
    else pending.push(sale)
  })
  pending.sort((a, b) => a.min - b.min)

  const getPool = (sale) => {
    if (sale.forma === 'PIX') return {
      pool: pagpixPool.filter((item) => !item.used && sameDay(item.dt, sale.dt)
        && ((sale.tele === 'Sim' && item.tipo === 'Delivery') || (sale.tele !== 'Sim' && item.tipo === 'Balcao'))),
      fonte: 'PaggPix',
    }
    if (sale.forma === 'CARTAO') return { pool: cieloPool.filter((item) => !item.used && sameDay(item.dt, sale.dt)), fonte: 'Cielo' }
    return { pool: [], fonte: null }
  }

  const tryMatch = (sale, requireTime) => {
    const { pool, fonte } = getPool(sale)
    if (!fonte) return null
    let candidates = pool.filter((item) => Math.abs(item.valor - sale.valor) <= toleranceValue)
    if (requireTime) candidates = candidates.filter((item) => Math.abs(item.min - sale.min) <= toleranceHours * 60)
    if (!candidates.length) return null
    candidates.sort((a, b) => Math.abs(a.valor - sale.valor) - Math.abs(b.valor - sale.valor) || Math.abs(a.min - sale.min) - Math.abs(b.min - sale.min))
    const recebimento = candidates[0]
    recebimento.used = true
    const diff = +(sale.valor - recebimento.valor).toFixed(2)
    return { sale, status: Math.abs(diff) < 0.005 ? 'CONCILIADA' : 'DIVERGENCIA', fonte, recebimento, diff, motivo: null }
  }

  const resolved = new Map()
  pending.forEach((sale) => {
    const match = tryMatch(sale, true)
    if (match) resolved.set(sale.numero, match)
  })
  pending.forEach((sale) => {
    if (resolved.has(sale.numero)) return
    resolved.set(sale.numero, tryMatch(sale, false) ?? { sale, status: 'SEM_RECEBIMENTO', fonte: getPool(sale).fonte, motivo: 'Nenhum recebimento correspondente encontrado' })
  })
  pending.forEach((sale) => results.push(resolved.get(sale.numero)))

  const semVenda = [...pagpixPool, ...cieloPool].filter((item) => !item.used).map((item) => ({ ...item, status: 'RECEBIMENTO_SEM_VENDA' }))
  semVenda.forEach((item, index) => {
    semVenda.slice(index + 1).forEach((other) => {
      if (other.status !== 'DUPLICADO' && item.fonte === other.fonte && Math.abs(item.valor - other.valor) < 0.005 && Math.abs(item.dt - other.dt) <= 60000) {
        item.status = 'DUPLICADO'
        other.status = 'DUPLICADO'
      }
    })
  })
  return { results, semVenda }
}

export function operatorName(code) {
  return code ? OPERADORES[code] ?? code : '—'
}

export function formatMoney(value) {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
