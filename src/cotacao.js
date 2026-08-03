export const COTACAO_STORAGE_KEY = 'drogaria_center_cotacao_v1'

export function normalizeHeader(value) {
  return String(value || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
}

export function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return value
  let text = String(value).trim().replace(/[^\d,.-]/g, '')
  if (!text) return null
  if (text.includes(',') && text.includes('.')) text = text.replace(/\./g, '').replace(',', '.')
  else if (text.includes(',')) text = text.replace(',', '.')
  const result = Number.parseFloat(text)
  return Number.isNaN(result) ? null : result
}

export function formatBRL(value) {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function detectHeaderRow(matrix) {
  const maxCheck = Math.min(20, matrix.length)
  let best = { index: 0, score: -Infinity }
  for (let index = 0; index < maxCheck; index += 1) {
    const row = matrix[index] || []
    const values = row.filter((cell) => String(cell || '').trim())
    if (values.length < 2) continue
    const textCells = values.filter((cell) => !/^-?\d+([.,]\d+)?$/.test(String(cell).trim()) && String(cell).trim().length < 60).length
    let dataRows = 0
    for (let next = index + 1; next < Math.min(index + 4, matrix.length); next += 1) {
      if ((matrix[next] || []).filter((cell) => String(cell || '').trim()).length >= Math.max(2, Math.floor(values.length / 2))) dataRows += 1
    }
    const score = textCells * 2 + dataRows * 3 + values.length
    if (score > best.score) best = { index, score }
  }
  return best.index
}

const columnPatterns = {
  ean: ['EAN', 'GTIN', 'CODIGO BARRAS', 'COD BARRAS', 'COD. BARRAS', 'CODIGO DE BARRAS', 'EAN PRINCIPAL'],
  codigo: ['CODIGO', 'COD', 'COD REDUZIDO', 'REFERENCIA', 'REF', 'ITEM', 'COD FAT'],
  nome: ['NOME', 'DESCRICAO', 'PRODUTO', 'MEDICAMENTO', 'NOME DO PRODUTO', 'DESC'],
  quantidade: ['QUANTIDADE', 'QTD', 'QTDE', 'QTD PEDIDA', 'QUANT'],
  precoUnit: ['PRECO UNITARIO', 'PRECO UNIT', 'VALOR UNITARIO', 'PRECO C DESCONTO SEM ST', 'PRECO COM DESCONTO', 'PRECO', 'VALOR', 'PU'],
  precoCusto: ['P. CUSTO', 'P CUSTO', 'PRECO DE CUSTO', 'PRECO CUSTO', 'CUSTO UNITARIO', 'VALOR ULT ENTRADA', 'ULTIMO CUSTO'],
  fornecedor: ['FORNECEDOR', 'FABRICANTE', 'LABORATORIO', 'LAB', 'MARCA', 'FORNECEDOR PREFERIDO'],
}

function matchColumn(headers, patterns) {
  const normalized = headers.map(normalizeHeader)
  for (const pattern of patterns) { const index = normalized.findIndex((header) => header === pattern); if (index >= 0) return index }
  for (const pattern of patterns) { const index = normalized.findIndex((header) => header && (header.includes(pattern) || pattern.includes(header))); if (index >= 0) return index }
  return -1
}

function columnStats(rows, index) {
  const values = rows.map((row) => row[index]).filter((value) => value !== undefined && value !== null && String(value).trim())
  if (!values.length) return { empty: true }
  const numbers = values.filter((value) => toNumber(value) !== null)
  const longText = values.filter((value) => toNumber(value) === null && String(value).trim().length > 15)
  const eans = values.filter((value) => { const digits = String(value).replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 14 })
  return { empty: false, numericRatio: numbers.length / values.length, longTextRatio: longText.length / values.length, eanRatio: eans.length / values.length }
}

export function autoMapColumns(headers, rows) {
  const mapping = {}; const used = new Set()
  Object.entries(columnPatterns).forEach(([key, patterns]) => { const index = matchColumn(headers, patterns); if (index >= 0 && !used.has(index)) { mapping[key] = index; used.add(index) } })
  if (mapping.ean === undefined) for (let index = 0; index < headers.length; index += 1) { if (!used.has(index) && columnStats(rows, index).eanRatio > .7) { mapping.ean = index; used.add(index); break } }
  if (mapping.nome === undefined) {
    let best = -1; let score = 0
    for (let index = 0; index < headers.length; index += 1) { if (!used.has(index) && columnStats(rows, index).longTextRatio > score) { score = columnStats(rows, index).longTextRatio; best = index } }
    if (best >= 0 && score > .5) { mapping.nome = best; used.add(best) }
  }
  if (mapping.quantidade === undefined) for (let index = 0; index < headers.length; index += 1) { if (!used.has(index) && columnStats(rows, index).numericRatio > .8) { mapping.quantidade = index; used.add(index); break } }
  return mapping
}

export function supplierFromFilename(filename) {
  const known = ['EMS', 'MEDLEY', 'GERMED', 'EUROFARMA', 'ACHE', 'ACHÉ', 'NEOQUIMICA', 'NEO QUIMICA', 'PRATI', 'DONADUZZI', 'TEUTO', 'CIMED', 'CIFARMA', 'LEGRAND', 'MULTILAB', 'SANDOZ', 'MEDQUIMICA', 'SANOFI', 'MARTINS']
  const stem = filename.replace(/\.[^.]+$/, '').toUpperCase()
  const found = known.find((name) => stem.includes(name))
  if (found) return found.charAt(0) + found.slice(1).toLowerCase()
  const word = stem.replace(/[_\-\d]+/g, ' ').trim().split(/\s+/).find((value) => value.length >= 3)
  return word ? word.charAt(0) + word.slice(1).toLowerCase() : 'Fornecedor'
}

export function createOrderLineId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `pedido-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function ensureOrderLineIds(pedido) {
  return pedido.map((item) => item.id ? item : { ...item, id: createOrderLineId() })
}

export function normalizeEan(value) {
  return String(value ?? '').replace(/\D/g, '')
}

export function parsePriceHistory(rows, { eanIndex, nameIndex = null, costIndex, laboratoryIndex = null }) {
  const history = {}
  let invalid = 0
  let duplicates = 0

  rows.forEach((row) => {
    const ean = normalizeEan(row[eanIndex])
    const lastCost = toNumber(row[costIndex])
    if (!ean || lastCost === null || lastCost < 0) { invalid += 1; return }
    if (history[ean]) duplicates += 1
    history[ean] = {
      ean,
      nome: nameIndex === null ? '' : String(row[nameIndex] || '').trim(),
      laboratorio: laboratoryIndex === null ? '' : String(row[laboratoryIndex] || '').trim(),
      precoCusto: lastCost,
    }
  })

  return { history, invalid, duplicates }
}

export function evaluatePriceOpportunity(currentPrice, lastCost) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(lastCost)) return null
  const difference = lastCost - currentPrice
  const percent = lastCost > 0 ? Math.abs(difference) / lastCost * 100 : null
  if (Math.abs(difference) < .005) return { type: 'stable', label: 'Mesmo preço', difference: 0, percent: 0 }
  if (difference > 0) return { type: 'good', label: 'Boa oportunidade', difference, percent }
  return { type: 'high', label: 'Acima do último custo', difference: Math.abs(difference), percent }
}

export function calculateOrder(cotacoes, pedido, ajustesManuais = {}) {
  return pedido.map((item) => {
    const offers = cotacoes[item.ean]?.ofertas || []
    const ajuste = ajustesManuais[item.id]
    const quantidadeOriginal = item.quantidadePedida
    const adjustedQuantity = Number(ajuste?.quantidade)
    const quantidadeFinal = ajuste && Number.isInteger(adjustedQuantity) && adjustedQuantity >= 0 ? adjustedQuantity : quantidadeOriginal
    const base = { ...item, quantidadeOriginal, quantidadeFinal, ajusteManual: Boolean(ajuste), motivoAjuste: ajuste?.motivo || '' }
    if (!offers.length) return { ...base, fornecedorSelecionado: null, fornecedorAutomatico: null, precoUnitario: null, precoAutomatico: null, precoTotal: null, precoTotalAutomatico: null, impactoAjuste: 0, status: 'naoEncontrado' }
    const best = [...offers].sort((first, second) => first.precoUnitario - second.precoUnitario)[0]
    const preferred = item.fornecedorPreferido && offers.find((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(item.fornecedorPreferido))
    const automatic = item.fornecedorPreferido ? preferred : best
    const manual = ajuste?.fornecedor && offers.find((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(ajuste.fornecedor))
    if (ajuste && !manual) return { ...base, fornecedorSelecionado: ajuste.fornecedor, fornecedorAutomatico: automatic?.fornecedor || null, precoUnitario: null, precoAutomatico: automatic?.precoUnitario ?? null, precoTotal: null, precoTotalAutomatico: automatic ? automatic.precoUnitario * quantidadeOriginal : null, impactoAjuste: 0, status: 'ajusteInvalido' }
    if (!automatic && !manual) return { ...base, fornecedorSelecionado: null, fornecedorAutomatico: null, precoUnitario: null, precoAutomatico: null, precoTotal: null, precoTotalAutomatico: null, impactoAjuste: 0, status: 'naoEncontrado' }
    const selected = manual || automatic
    const precoTotal = selected.precoUnitario * quantidadeFinal
    const precoTotalAutomatico = automatic ? automatic.precoUnitario * quantidadeOriginal : null
    const status = ajuste ? (quantidadeFinal === 0 ? 'removidoManual' : 'ajusteManual') : selected.fornecedor === best.fornecedor ? 'selecionado' : 'alternativaPreferida'
    return { ...base, fornecedorSelecionado: selected.fornecedor, fornecedorAutomatico: automatic?.fornecedor || null, precoUnitario: selected.precoUnitario, precoAutomatico: automatic?.precoUnitario ?? null, menorPreco: best.precoUnitario, precoTotal, precoTotalAutomatico, impactoAjuste: ajuste && precoTotalAutomatico !== null ? precoTotal - precoTotalAutomatico : 0, status }
  })
}

export async function readSpreadsheet(file) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const matrices = workbook.SheetNames.map((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', blankrows: false }))
  return matrices.sort((first, second) => second.length - first.length)[0] || []
}
