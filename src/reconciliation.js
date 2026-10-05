export const OPERADORES = {
  3: 'Rinaldo Ramos da Silva',
  4: 'José Wesley de Souza Maranhão',
  8: 'Katia Rejane do Nascimento',
  12: 'Joao Victor Dornelas de Araujo',
  13: 'Claudia Rodrigues da Silva Araújo',
  15: 'Willian Cesar Ramos de Souza',
  16: 'Deuzeni Maria da Silva',
  // Mantido para identificar corretamente relatórios históricos. O vendedor
  // não faz mais parte da equipe ativa exibida no cadastro.
  17: 'José Ramos da Silva Junior',
  19: 'Shakira Kessia Santana de Souza',
}

export const STATUS_LABEL = {
  CONCILIADA: 'Conciliada',
  DIVERGENCIA: 'Divergência',
  SEM_RECEBIMENTO: 'Sem recebimento',
  RECEBIMENTO_SEM_VENDA: 'Recebimento sem venda',
  CREDIARIO_CARTAO: 'Crediário recebido no cartão',
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

function normalizeOperatorText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

function operatorAliases(operator) {
  const aliases = Array.isArray(operator.pagpixAliases) ? operator.pagpixAliases : String(operator.pagpixName ?? '').split(/[,;\n]/)
  return [operator.name, ...aliases].map(normalizeOperatorText).filter(Boolean).sort((a, b) => b.length - a.length)
}

function containsOperatorAlias(text, alias) {
  return ` ${text} `.includes(` ${alias} `)
}

function inferTrierOperatorCode(row) {
  if (row.operadorOriginal) return String(row.operadorOriginal).trim()
  const raw = String(row.raw ?? '')
  const firstMoneyIndex = raw.search(/-?\d{1,3}(?:\.\d{3})*,\d{2}/)
  const beforeMoney = firstMoneyIndex >= 0 ? raw.slice(0, firstMoneyIndex) : raw
  return [...beforeMoney.matchAll(/\b\d{1,3}\b/g)].at(-1)?.[0] ?? ''
}

export function resolveOperator(row, source, operators = []) {
  if (!row) return null
  const code = String(row.operador ?? '').trim()
  const direct = operators.find((operator) => String(operator.trierCode ?? '').trim() === code)
  if (/trier/i.test(source)) {
    if (direct) return direct
    const inferredCode = inferTrierOperatorCode(row)
    return operators.find((operator) => String(operator.trierCode ?? '').trim() === inferredCode) ?? null
  }
  if (/pagg?pix/i.test(source)) {
    const searchable = normalizeOperatorText(row.operadorOriginal || row.raw)
    return operators.find((operator) => operatorAliases(operator).some((alias) => containsOperatorAlias(searchable, alias))) ?? direct ?? null
  }
  return direct ?? null
}

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

// Stable identifiers used by the manual review action. They intentionally
// include the source row details instead of only the sale number because the
// same number can appear in a different report/date after a new import.
export function reconciliationSaleKey(sale) {
  if (!sale) return ''
  return ['sale', sale.numero, sale.data, sale.hora, sale.forma, Number(sale.valor ?? 0).toFixed(2), sale.raw ?? ''].join('|')
}

export function reconciliationReceiptKey(receipt) {
  if (!receipt) return ''
  return ['receipt', receipt.fonte ?? '', receipt.data, receipt.hora, Number(receipt.valor ?? 0).toFixed(2), receipt.tipo ?? '', receipt.bandeira ?? '', receipt.raw ?? ''].join('|')
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

function discountDetails(values, fallbackTotal = null) {
  const numbers = values.map((value) => typeof value === 'number' ? value : toNumber(value))
  const [valorBruto, percentualInformado, valorDescontoInformado, valorLiquido] = numbers
  const descontoValor = Number.isFinite(valorDescontoInformado) ? Math.max(0, -valorDescontoInformado) : 0
  const descontoPercentualCalculado = Number.isFinite(valorBruto) && valorBruto > 0 ? (descontoValor / valorBruto) * 100 : 0
  return {
    valorBruto: Number.isFinite(valorBruto) ? valorBruto : fallbackTotal,
    descontoPercentual: Number.isFinite(percentualInformado) && percentualInformado > 0 ? percentualInformado : descontoPercentualCalculado,
    descontoValor,
    valorLiquido: Number.isFinite(valorLiquido) ? valorLiquido : fallbackTotal,
  }
}

function findOperadorCode(text) {
  const upper = text.toUpperCase()
  for (const [name, code] of Object.entries(NOME_TO_CODE)) {
    if (new RegExp(`\\b${name}\\b`).test(upper)) return code
  }
  return OP_CODES.sort((a, b) => b.length - a.length).find((code) => new RegExp(`\\b${code}\\b`).test(text)) ?? null
}

function findTrierOperator(chunk, firstMoney) {
  const beforeAmounts = firstMoney ? chunk.slice(0, chunk.indexOf(firstMoney)) : chunk
  const matches = [...beforeAmounts.matchAll(new RegExp(`\\b(${OP_CODES.sort((a, b) => b.length - a.length).join('|')})\\b`, 'g'))]
  return matches.at(-1)?.[1] ?? findOperadorCode(beforeAmounts)
}

export function parseTrierLines(lines) {
  const formas = 'CARTAO|PIX|DINHEIRO|CREDIARIO|CHEQUE'
  const parseChunk = (chunk) => {
    const head = chunk.match(new RegExp(`^(\\d{4,8})\\s+\\d{0,3}\\s*(${formas})\\b`))
    const date = chunk.match(DATE_RE)
    const time = chunk.match(TIME_RE)
    const monies = findAllMoney(chunk)
    if (!head || !date || !time || !monies.length) return null
    const valor = toNumber(monies.at(-1))
    return {
      numero: head[1],
      forma: head[2],
      operador: findTrierOperator(chunk, monies[0]),
      operadorOriginal: findTrierOperator(chunk, monies[0]),
      tele: /\bSIM\b/i.test(chunk) ? 'Sim' : '',
      isDev: /\bDev\b/i.test(chunk),
      data: date[1],
      hora: time[1],
      valor,
      ...discountDetails(monies.length >= 4 ? monies.slice(0, 4) : [], valor),
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

function findExactSpreadsheetColumn(headerRow, expectedLabel) {
  return headerRow.findIndex((value) => normalizeSpreadsheetLabel(value) === expectedLabel)
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
        gross: findSpreadsheetColumn(headerRow, 'vlr bruto'),
        discountPercent: findExactSpreadsheetColumn(headerRow, 'desc'),
        discountValue: findSpreadsheetColumn(headerRow, 'vlr desc'),
        liquid: findSpreadsheetColumn(headerRow, 'vlr liquido'),
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
        const tele = String(sourceRow[columns.delivery] ?? '').trim()
        const operator = String(sourceRow[columns.operator] ?? '')
        const valorBruto = parseLooseNumber(sourceRow[columns.gross])
        const descontoPercentual = parseLooseNumber(sourceRow[columns.discountPercent])
        const descontoValor = parseLooseNumber(sourceRow[columns.discountValue])
        const valorLiquido = parseLooseNumber(sourceRow[columns.liquid])
        rows.push({
          numero,
          forma,
          operador: OP_CODES.includes(operator.trim()) ? operator.trim() : findOperadorCode(operator),
          operadorOriginal: operator.trim(),
          tele: /^sim$/i.test(tele) ? 'Sim' : '',
          isDev: /\bdev\b/i.test(type),
          data: DATE_RE.exec(data)?.[1] ?? data,
          hora: TIME_RE.exec(hora)?.[1] ?? hora,
          valor,
          ...discountDetails([valorBruto, descontoPercentual, descontoValor, valorLiquido], valor),
          raw: sourceRow.filter((value) => value !== '').join(' '),
        })
      }
      if (rows.length) return rows
    }
  }
  throw new Error('Nao encontrei uma tabela de vendas Trier valida neste XLS.')
}

export function findHighDiscountSales(sales, mode = 'percent', threshold = 0) {
  const safeThreshold = Math.max(0, Number(threshold) || 0)
  const metric = mode === 'value' ? 'descontoValor' : 'descontoPercentual'
  return sales
    .filter((sale) => !sale.isDev && Number(sale.descontoValor) > 0.005 && Number(sale[metric]) >= safeThreshold)
    .sort((first, second) => Number(second[metric]) - Number(first[metric]) || Number(second.descontoValor) - Number(first.descontoValor))
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
    return [{ data: date[1], hora: date[2], operador: findOperadorCode(line), operadorOriginal: '', tipo, status, valor: toNumber(money[1]), raw: line }]
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
      operadorOriginal: operator,
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
    const isPix = /\bPIX\b/i.test(line)
    const bandeira = line.match(/\b(VISA|MASTER(?:CARD)?|ELO|AMEX|HIPERCARD|DINERS)\b/i)
    const parcelas = line.match(/\b(0[1-9]|[1-9])\b(?=\s+(?:VISA|MASTER(?:CARD)?|ELO|AMEX|HIPERCARD|DINERS))/i)
    const tipo = isPix ? 'PIX' : /D[ÉE]BITO/i.test(line) ? 'Débito' : /CR[ÉE]DITO/i.test(line) ? 'Crédito' : ''
    return [{
      data: date[1], hora: time?.[1] ?? '', valor: toNumber(money[1]),
      forma: isPix ? 'PIX' : 'CARTAO',
      tipo, bandeira: isPix ? 'PIX' : bandeira?.[1].toUpperCase() ?? '', parcelas: parcelas?.[1] ?? '1', status, raw: line,
    }]
  })
}

export function parseFechamentoLines(lines) {
  const periodLine = lines.find((line) => /PER[IÍ]ODO/i.test(line) && DATE_RE.test(line))
  const reportDate = periodLine?.match(DATE_RE)?.[1] ?? lines.find((line) => DATE_RE.test(line))?.match(DATE_RE)?.[1] ?? ''
  const pattern = /CONTAS\s+RECEBIDAS\s+CREDI[AÁ]RIO\s*\(\s*CART[AÃ]O\s*\)\s*:\s*(-?[\d.]+,\d{2})/i
  const seen = new Set()
  return lines.flatMap((raw) => {
    const match = raw.match(pattern)
    if (!match) return []
    const valor = toNumber(match[1])
    const signature = `${reportDate}|${valor}`
    if (!Number.isFinite(valor) || valor <= 0 || seen.has(signature)) return []
    seen.add(signature)
    return [{
      data: reportDate,
      hora: '',
      valor,
      tipo: 'Crediário (Cartão)',
      status: 'INFORMADO',
      raw: raw.trim(),
    }]
  })
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function betterClosingSubset(candidate, current, targetCents) {
  if (!current) return true
  const candidateDifference = Math.abs(candidate.sum - targetCents)
  const currentDifference = Math.abs(current.sum - targetCents)
  if (candidateDifference !== currentDifference) return candidateDifference < currentDifference
  if (candidate.usedValue !== current.usedValue) return candidate.usedValue < current.usedValue
  if (candidate.usedCount !== current.usedCount) return candidate.usedCount < current.usedCount
  return candidate.items.length < current.items.length
}

function findClosingReceiptSubset(receipts, target, toleranceValue) {
  const targetCents = Math.round(Number(target) * 100)
  const toleranceCents = Math.max(0, Math.round(Number(toleranceValue || 0) * 100))
  if (!targetCents) return []
  const maximum = targetCents + toleranceCents
  const states = new Map([[0, { sum: 0, items: [], usedValue: 0, usedCount: 0 }]])
  receipts.forEach((receipt) => {
    const cents = Math.round(Number(receipt.valor) * 100)
    if (cents <= 0 || cents > maximum) return
    const previousStates = [...states.values()].sort((first, second) => second.sum - first.sum)
    previousStates.forEach((state) => {
      const sum = state.sum + cents
      if (sum > maximum) return
      const candidate = {
        sum,
        items: [...state.items, receipt],
        usedValue: state.usedValue + (receipt.used ? cents : 0),
        usedCount: state.usedCount + (receipt.used ? 1 : 0),
      }
      if (betterClosingSubset(candidate, states.get(sum), targetCents)) states.set(sum, candidate)
    })
  })
  let best = null
  states.forEach((state) => {
    if (state.items.length && Math.abs(state.sum - targetCents) <= toleranceCents && betterClosingSubset(state, best, targetCents)) best = state
  })
  return best?.items ?? []
}

export function reconcile(files, toleranceValue, toleranceHours, manualUnmatches = {}, manualMatches = {}, manualReceipts = {}, splitSuggestionMinutes = 15) {
  const trier = files.trier.rows
    .filter((row) => row.valor !== null && row.data)
    .map((row) => ({ ...row, dt: parseDataHora(row.data, row.hora), min: timeToMinutes(row.hora) }))
  if (!trier.length) throw new Error('Não encontrei vendas válidas no PDF da Trier. Confira as linhas extraídas e o formato do relatório.')

  const makePool = (key, acceptedStatus, fonte) => (files[key]?.rows ?? [])
    .filter((row) => row.status === acceptedStatus && row.valor !== null && row.data)
    .map((row) => {
      const cieloPix = key === 'cielo' && (row.forma === 'PIX' || row.tipo === 'PIX' || /\bPIX\b/i.test(row.raw || ''))
      return {
        ...row,
        ...(key === 'cielo' ? { forma: cieloPix ? 'PIX' : 'CARTAO', tipo: cieloPix ? 'PIX' : row.tipo, bandeira: cieloPix ? 'PIX' : row.bandeira } : {}),
        dt: parseDataHora(row.data, row.hora), min: timeToMinutes(row.hora), used: false, fonte,
      }
    })
  const pagpixPool = makePool('pagpix', 'PAGO', 'PaggPix')
  const cieloPool = makePool('cielo', 'APROVADA', 'Cielo')
  const manualReceiptPool = Object.values(manualReceipts ?? {})
    .filter((row) => row && row.valor !== null && row.valor !== undefined && row.data)
    .map((row) => ({
      ...row,
      fonte: 'Manual',
      status: row.status || 'MANUAL',
      dt: parseDataHora(row.data, row.hora),
      min: timeToMinutes(row.hora),
      used: false,
    }))
  const allReceipts = [...pagpixPool, ...cieloPool, ...manualReceiptPool]
  const fechamentoCrediario = (files.fechamento?.rows ?? [])
    .filter((row) => row.valor > 0 && row.data)
    .map((row) => ({ ...row, dt: parseDataHora(row.data, row.hora) }))
  const results = []
  const pending = []

  const pairReceiptKeys = (pair) => [...new Set((Array.isArray(pair?.receiptKeys) ? pair.receiptKeys : [pair?.receiptKey]).filter(Boolean))]
  const pairSaleKeys = (pair) => [...new Set((Array.isArray(pair?.saleKeys) ? pair.saleKeys : [pair?.saleKey]).filter(Boolean))]
  const confirmedPairs = Object.values(manualMatches ?? {}).filter((pair) => pairSaleKeys(pair).length && pairReceiptKeys(pair).length)
  const confirmedSaleKeys = new Set(confirmedPairs.flatMap(pairSaleKeys))
  const confirmedReceiptKeys = new Set(confirmedPairs.flatMap(pairReceiptKeys))
  const manualPairs = Object.values(manualUnmatches ?? {}).filter((pair) => pair?.saleKey && !confirmedSaleKeys.has(pair.saleKey) && pairReceiptKeys(pair).every((key) => !confirmedReceiptKeys.has(key)))
  const manualBySale = new Map(manualPairs.map((pair) => [pair.saleKey, pair]))
  const manualByReceipt = new Map(manualPairs.flatMap((pair) => pairReceiptKeys(pair).map((key) => [key, pair])))
  const blockedReceipts = new Set(manualByReceipt.keys())

  trier.forEach((sale) => {
    if (sale.isDev) results.push({ sale, status: 'DEVOLUCAO', fonte: null, motivo: 'Linha de devolução — não é recebimento a conciliar' })
    else if (['DINHEIRO', 'CREDIARIO', 'CHEQUE'].includes(sale.forma)) results.push({ sale, status: 'CONCILIADA', fonte: null, motivo: 'Meio de pagamento não eletrônico' })
    else pending.push(sale)
  })
  pending.sort((a, b) => a.min - b.min)

  const getPool = (sale) => {
    if (sale.forma === 'PIX') {
      const expectedType = sale.tele === 'Sim' ? 'Delivery' : 'Balcao'
      const available = pagpixPool.filter((item) => !item.used && !blockedReceipts.has(reconciliationReceiptKey(item)) && sameDay(item.dt, sale.dt))
      const sameChannel = available.filter((item) => item.tipo === expectedType)
      // Algumas vendas são marcadas como Tele/Delivery na Trier, mas o QR Code
      // fica registrado como Balcão no PaggPix (ou o inverso). Nesse caso,
      // somente permita atravessar o canal quando o vendedor também coincidir.
      const sameSellerOtherChannel = sale.operador
        ? available.filter((item) => item.tipo !== expectedType && item.operador && String(item.operador) === String(sale.operador))
        : []
      const cieloPix = cieloPool.filter((item) => item.forma === 'PIX' && !item.used && !item.reservedClosing && !blockedReceipts.has(reconciliationReceiptKey(item)) && sameDay(item.dt, sale.dt))
      return { pool: [...sameChannel, ...sameSellerOtherChannel, ...cieloPix], fonte: 'PaggPix ou Cielo', expectedType }
    }
    if (sale.forma === 'CARTAO') return { pool: cieloPool.filter((item) => item.forma !== 'PIX' && !item.used && !item.reservedClosing && !blockedReceipts.has(reconciliationReceiptKey(item)) && sameDay(item.dt, sale.dt)), fonte: 'Cielo' }
    return { pool: [], fonte: null }
  }

  const buildMatchedResult = (sale, recebimento, fonte, expectedType) => {
    recebimento.used = true
    const diff = +(sale.valor - recebimento.valor).toFixed(2)
    const channelMismatch = fonte === 'PaggPix' && recebimento.tipo !== expectedType
    return {
      sale,
      status: Math.abs(diff) < 0.005 ? 'CONCILIADA' : 'DIVERGENCIA',
      fonte,
      recebimento,
      recebimentos: [recebimento],
      diff,
      canalTrier: fonte === 'PaggPix' ? expectedType : null,
      canalRecebimento: fonte === 'PaggPix' ? (recebimento.tipo || null) : null,
      canalDivergente: channelMismatch,
      motivo: channelMismatch ? `Canal divergente: Trier ${expectedType}, PaggPix ${recebimento.tipo || 'não informado'}; vendedor correspondente` : null,
    }
  }

  const applyConfirmedMatches = (resolved) => {
    confirmedPairs.forEach((pair, pairIndex) => {
      const saleKeys = pairSaleKeys(pair)
      const sales = saleKeys.map((key) => pending.find((item) => reconciliationSaleKey(item) === key)).filter(Boolean)
      const receiptKeys = pairReceiptKeys(pair)
      const receipts = receiptKeys.map((key) => allReceipts.find((item) => reconciliationReceiptKey(item) === key)).filter(Boolean)
      if (sales.length !== saleKeys.length || receipts.length !== receiptKeys.length || receipts.some((item) => item.used || item.reservedClosing)) return
      receipts.forEach((item) => { item.used = true })
      const receivedValue = +receipts.reduce((sum, item) => sum + Number(item.valor || 0), 0).toFixed(2)
      const salesValue = +sales.reduce((sum, item) => sum + Number(item.valor || 0), 0).toFixed(2)
      const sources = [...new Set(receipts.map((item) => item.fonte || 'Manual'))]
      const types = [...new Set(receipts.map((item) => item.tipo || item.bandeira).filter(Boolean))]
      const receipt = receipts.length === 1 ? receipts[0] : {
        data: receipts[0]?.data || sales[0]?.data,
        hora: receipts.map((item) => item.hora).filter(Boolean).join(' + '),
        valor: receivedValue,
        tipo: types.join(' + ') || 'Pagamento dividido',
        fonte: 'Múltiplos',
        raw: receipts.map((item) => item.raw || `${item.fonte} ${item.tipo || ''} ${item.valor}`).join(' | '),
      }
      const diff = +(salesValue - receivedValue).toFixed(2)
      const fonte = sources.length === 1 ? sources[0] : 'Múltiplos'
      const groupId = pair.groupId || `manual-group-${pairIndex}-${saleKeys.join(':')}`
      sales.forEach((sale) => {
        resolved.set(sale.numero, {
          sale,
          status: Math.abs(diff) < 0.005 ? 'CONCILIADA' : 'DIVERGENCIA',
          fonte,
          recebimento: receipt,
          recebimentos: receipts,
          diff,
          manualMatch: true,
          manualMatchGroupId: groupId,
          manualMatchSaleKey: saleKeys[0],
          manualMatchSaleKeys: saleKeys,
          manualMatchReceiptKey: receiptKeys[0],
          manualMatchReceiptKeys: receiptKeys,
          groupSales: sales,
          groupSalesValue: salesValue,
          groupReceivedValue: receivedValue,
          motivo: sales.length > 1
            ? `Conciliação manual em grupo: ${sales.length} vendas somando ${salesValue.toFixed(2)} com ${receipts.length} recebimento(s) somando ${receivedValue.toFixed(2)}`
            : receipts.length > 1
              ? `Conciliação manual com ${receipts.length} recebimentos (${types.join(' + ') || 'pagamento dividido'})`
              : `Conciliação confirmada manualmente pelo analista${fonte === 'Manual' ? ' com forma de pagamento informada' : ''}`,
        })
      })
    })
  }

  // Resolve todas as disputas entre vendas e recebimentos em conjunto. O fluxo
  // maximo evita perder conciliacoes e o menor custo reserva primeiro os pares
  // de valor exato, canal/vendedor compativel e horario mais proximo.
  const assignGlobally = (sales, requireTime) => {
    const candidates = []
    const receipts = []
    const receiptIndexes = new Map()
    sales.forEach((sale, saleIndex) => {
      const { pool, fonte, expectedType } = getPool(sale)
      if (!fonte) return
      pool.forEach((receipt) => {
        const valueDifference = Math.abs(receipt.valor - sale.valor)
        const timeDifferenceMinutes = Math.abs(receipt.min - sale.min)
        if (valueDifference > toleranceValue) return
        if (requireTime && timeDifferenceMinutes > toleranceHours * 60) return
        if (!receiptIndexes.has(receipt)) {
          receiptIndexes.set(receipt, receipts.length)
          receipts.push(receipt)
        }
        let channelPriority = 0
        const receiptSource = receipt.fonte || fonte
        if (receiptSource === 'PaggPix') {
          const sameSeller = sale.operador && receipt.operador && String(receipt.operador) === String(sale.operador)
          const sameChannel = receipt.tipo === expectedType
          channelPriority = sameSeller && sameChannel ? 0 : sameSeller ? 1 : sameChannel ? 2 : 3
        }
        candidates.push({
          sale,
          saleIndex,
          receipt,
          receiptIndex: receiptIndexes.get(receipt),
          fonte: receiptSource,
          expectedType,
          // Um centavo vale mais que qualquer diferenca de canal/horario.
          cost: Math.round(valueDifference * 100) * 1_000_000_000
            + channelPriority * 100_000_000
            + Math.round(Math.abs(receipt.dt - sale.dt) / 1000) * 100
            + saleIndex,
        })
      })
    })
    if (!candidates.length) return []

    const source = 0
    const saleOffset = 1
    const receiptOffset = saleOffset + sales.length
    const sink = receiptOffset + receipts.length
    const graph = Array.from({ length: sink + 1 }, () => [])
    const addEdge = (from, to, capacity, cost, candidate = null) => {
      const forward = { to, reverse: graph[to].length, capacity, cost, candidate }
      const backward = { to: from, reverse: graph[from].length, capacity: 0, cost: -cost, candidate: null }
      graph[from].push(forward)
      graph[to].push(backward)
    }
    sales.forEach((sale, index) => addEdge(source, saleOffset + index, 1, 0))
    receipts.forEach((receipt, index) => addEdge(receiptOffset + index, sink, 1, 0))
    candidates.forEach((candidate) => addEdge(saleOffset + candidate.saleIndex, receiptOffset + candidate.receiptIndex, 1, candidate.cost, candidate))

    while (true) {
      const distances = Array(graph.length).fill(Infinity)
      const previousNode = Array(graph.length).fill(-1)
      const previousEdge = Array(graph.length).fill(-1)
      const queued = Array(graph.length).fill(false)
      const queue = [source]
      distances[source] = 0
      queued[source] = true
      while (queue.length) {
        const node = queue.shift()
        queued[node] = false
        graph[node].forEach((edge, edgeIndex) => {
          if (!edge.capacity || distances[edge.to] <= distances[node] + edge.cost) return
          distances[edge.to] = distances[node] + edge.cost
          previousNode[edge.to] = node
          previousEdge[edge.to] = edgeIndex
          if (!queued[edge.to]) { queue.push(edge.to); queued[edge.to] = true }
        })
      }
      if (!Number.isFinite(distances[sink])) break
      for (let node = sink; node !== source; node = previousNode[node]) {
        const edge = graph[previousNode[node]][previousEdge[node]]
        edge.capacity -= 1
        graph[node][edge.reverse].capacity += 1
      }
    }

    return graph.slice(saleOffset, receiptOffset).flatMap((edges) => edges
      .filter((edge) => edge.candidate && edge.capacity === 0)
      .map((edge) => edge.candidate))
  }

  const resolvePending = (resolved) => {
    applyConfirmedMatches(resolved)
    const eligiblePending = pending.filter((sale) => !resolved.has(sale.numero) && !manualBySale.has(reconciliationSaleKey(sale)))
    const timedMatches = assignGlobally(eligiblePending, true)
    timedMatches.forEach(({ sale, receipt, fonte, expectedType }) => resolved.set(sale.numero, buildMatchedResult(sale, receipt, receipt.fonte || fonte, expectedType)))
    const fallbackMatches = assignGlobally(eligiblePending.filter((sale) => !resolved.has(sale.numero)), false)
    fallbackMatches.forEach(({ sale, receipt, fonte, expectedType }) => resolved.set(sale.numero, buildMatchedResult(sale, receipt, receipt.fonte || fonte, expectedType)))
    pending.forEach((sale) => {
      if (resolved.has(sale.numero)) return
      const manualPair = manualBySale.get(reconciliationSaleKey(sale))
      if (manualPair) {
        resolved.set(sale.numero, {
          sale,
          status: 'SEM_RECEBIMENTO',
          fonte: getPool(sale).fonte,
          motivo: 'Desconciliado manualmente pelo analista',
          manualUnmatch: true,
          manualUnmatchSaleKey: manualPair.saleKey,
          manualUnmatchReceiptKey: pairReceiptKeys(manualPair)[0] || '',
          manualUnmatchReceiptKeys: pairReceiptKeys(manualPair),
        })
      } else resolved.set(sale.numero, { sale, status: 'SEM_RECEBIMENTO', fonte: getPool(sale).fonte, motivo: 'Nenhum recebimento correspondente encontrado' })
    })
  }

  const resolved = new Map()
  resolvePending(resolved)

  let requiresRematch = false
  const closingGroups = fechamentoCrediario.map((closing, index) => {
    const candidates = cieloPool.filter((item) => item.forma !== 'PIX' && !item.reservedClosing && !blockedReceipts.has(reconciliationReceiptKey(item)) && !confirmedReceiptKeys.has(reconciliationReceiptKey(item)) && sameDay(item.dt, closing.dt))
    const receipts = findClosingReceiptSubset(candidates, closing.valor, toleranceValue)
    if (receipts.some((receipt) => receipt.used)) requiresRematch = true
    receipts.forEach((receipt) => { receipt.reservedClosing = true; receipt.closingGroup = index })
    const totalEncontrado = receipts.reduce((sum, receipt) => sum + receipt.valor, 0)
    return {
      ...closing,
      receipts,
      totalEncontrado: +totalEncontrado.toFixed(2),
      diff: +(closing.valor - totalEncontrado).toFixed(2),
      conciliado: receipts.length > 0 && Math.abs(closing.valor - totalEncontrado) <= toleranceValue,
    }
  })

  if (requiresRematch) {
    pagpixPool.forEach((item) => { item.used = false })
    cieloPool.forEach((item) => { item.used = false })
    manualReceiptPool.forEach((item) => { item.used = false })
    resolved.clear()
    resolvePending(resolved)
  }
  pending.forEach((sale) => results.push(resolved.get(sale.numero)))

  const crediarioCartao = closingGroups.flatMap((group) => group.receipts.map((item) => ({
    ...item,
    status: 'CREDIARIO_CARTAO',
    fechamentoValor: group.valor,
    fechamentoData: group.data,
  })))
  const semVendaPool = [...pagpixPool, ...cieloPool, ...manualReceiptPool.filter((item) => blockedReceipts.has(reconciliationReceiptKey(item)))]
  const semVenda = semVendaPool.filter((item) => !item.used && !item.reservedClosing).map((item) => {
    const manualPair = manualByReceipt.get(reconciliationReceiptKey(item))
    return {
      ...item,
      status: 'RECEBIMENTO_SEM_VENDA',
      ...(manualPair ? {
        manualUnmatch: true,
        manualUnmatchSaleKey: manualPair.saleKey,
        manualUnmatchReceiptKey: pairReceiptKeys(manualPair)[0] || '',
        manualUnmatchReceiptKeys: pairReceiptKeys(manualPair),
        motivo: 'Desconciliado manualmente pelo analista',
      } : {}),
    }
  })
  semVenda.forEach((item, index) => {
    semVenda.slice(index + 1).forEach((other) => {
      if (other.status !== 'DUPLICADO' && item.fonte === other.fonte && Math.abs(item.valor - other.valor) < 0.005 && Math.abs(item.dt - other.dt) <= 60000) {
        item.status = 'DUPLICADO'
        other.status = 'DUPLICADO'
      }
    })
  })

  // Sugere, sem confirmar automaticamente, quando dois recebimentos de meios
  // diferentes fecham uma venda pendente e aconteceram muito perto dela.
  // Quinze minutos mantém a sugestão conservadora mesmo quando a tolerância
  // geral de horário foi configurada para várias horas.
  const splitSuggestionWindowMinutes = Math.min(720, Math.max(1, Number(splitSuggestionMinutes) || 15))
  const paymentMethodKey = (receipt) => [receipt.fonte, receipt.tipo, receipt.bandeira].filter(Boolean).join('|').toUpperCase()
  results.forEach((row) => {
    if (row.status !== 'SEM_RECEBIMENTO' || !row.sale) return
    const sale = row.sale
    const expectedType = sale.tele === 'Sim' ? 'Delivery' : 'Balcao'
    const candidates = semVenda.filter((receipt) => {
      if (!sameDay(receipt.dt, sale.dt) || Math.abs(receipt.min - sale.min) > splitSuggestionWindowMinutes) return false
      if (sale.forma === 'CARTAO') return receipt.fonte === 'Cielo' && receipt.forma !== 'PIX'
      if (sale.forma !== 'PIX') return false
      if (receipt.fonte === 'Cielo') return receipt.forma === 'PIX'
      if (receipt.fonte !== 'PaggPix') return false
      const sameChannel = receipt.tipo === expectedType
      const sameSeller = sale.operador && receipt.operador && String(sale.operador) === String(receipt.operador)
      return sameChannel || sameSeller
    })
    let best = null
    candidates.forEach((first, firstIndex) => {
      candidates.slice(firstIndex + 1).forEach((second) => {
        if (paymentMethodKey(first) === paymentMethodKey(second)) return
        const total = +(Number(first.valor || 0) + Number(second.valor || 0)).toFixed(2)
        const diff = +(Number(sale.valor || 0) - total).toFixed(2)
        if (Math.abs(diff) > Number(toleranceValue || 0)) return
        const maxTimeDifferenceMinutes = Math.max(Math.abs(first.min - sale.min), Math.abs(second.min - sale.min))
        const score = Math.round(Math.abs(diff) * 100) * 1_000_000 + maxTimeDifferenceMinutes * 1_000 + Math.abs(first.min - second.min)
        if (!best || score < best.score) best = { receipts: [first, second], total, diff, maxTimeDifferenceMinutes, score }
      })
    })
    if (best) row.splitPaymentSuggestion = {
      receipts: best.receipts,
      total: best.total,
      diff: best.diff,
      maxTimeDifferenceMinutes: best.maxTimeDifferenceMinutes,
      windowMinutes: splitSuggestionWindowMinutes,
    }
  })

  semVenda.forEach((receipt) => {
    const sales = results.filter((row) => {
      if (row.status !== 'SEM_RECEBIMENTO' || !row.sale || !sameDay(row.sale.dt, receipt.dt) || Math.abs(row.sale.min - receipt.min) > splitSuggestionWindowMinutes) return false
      if (receipt.fonte === 'PaggPix') {
        if (row.sale.forma !== 'PIX') return false
        const expectedType = row.sale.tele === 'Sim' ? 'Delivery' : 'Balcao'
        const sameChannel = receipt.tipo === expectedType
        const sameSeller = row.sale.operador && receipt.operador && String(row.sale.operador) === String(receipt.operador)
        return sameChannel || sameSeller
      }
      if (receipt.fonte !== 'Cielo') return false
      return receipt.forma === 'PIX' ? row.sale.forma === 'PIX' : row.sale.forma === 'CARTAO'
    })
    let best = null
    sales.forEach((first, firstIndex) => {
      sales.slice(firstIndex + 1).forEach((second) => {
        const salesDistanceMinutes = Math.abs(first.sale.min - second.sale.min)
        if (salesDistanceMinutes > splitSuggestionWindowMinutes) return
        const total = +(Number(first.sale.valor || 0) + Number(second.sale.valor || 0)).toFixed(2)
        const diff = +(total - Number(receipt.valor || 0)).toFixed(2)
        // Em uma sugestão (que ainda exige confirmação), aceite também pequenas
        // diferenças proporcionais. Isso cobre o caso real de R$ 348,49 x
        // R$ 350,00 sem ampliar a conciliação automática normal.
        const allowedDifference = Math.max(Number(toleranceValue || 0), Math.min(5, Number(receipt.valor || 0) * 0.01))
        if (Math.abs(diff) > allowedDifference) return
        const maxTimeDifferenceMinutes = Math.max(Math.abs(first.sale.min - receipt.min), Math.abs(second.sale.min - receipt.min))
        const score = Math.round(Math.abs(diff) * 100) * 1_000_000 + maxTimeDifferenceMinutes * 1_000 + salesDistanceMinutes
        if (!best || score < best.score) best = { rows: [first, second], total, diff, maxTimeDifferenceMinutes, salesDistanceMinutes, allowedDifference, score }
      })
    })
    if (best) receipt.splitSalesSuggestion = {
      sales: best.rows.map((row) => row.sale),
      total: best.total,
      diff: best.diff,
      maxTimeDifferenceMinutes: best.maxTimeDifferenceMinutes,
      salesDistanceMinutes: best.salesDistanceMinutes,
      allowedDifference: best.allowedDifference,
      windowMinutes: splitSuggestionWindowMinutes,
    }
  })
  return { results, semVenda, crediarioCartao, fechamentoCrediario: closingGroups.map(({ receipts, ...group }) => ({ ...group, quantidadeRecebimentos: receipts.length })) }
}

export function operatorName(code) {
  return code ? OPERADORES[code] ?? code : '—'
}

export function formatMoney(value) {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
