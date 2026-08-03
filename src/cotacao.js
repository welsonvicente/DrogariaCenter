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
  ean: ['EAN', 'GTIN', 'CODIGO BARRAS', 'COD BARRAS', 'CODIGO DE BARRAS', 'EAN PRINCIPAL'],
  codigo: ['CODIGO', 'COD', 'COD REDUZIDO', 'REFERENCIA', 'REF', 'ITEM', 'COD FAT'],
  nome: ['NOME', 'DESCRICAO', 'PRODUTO', 'MEDICAMENTO', 'NOME DO PRODUTO', 'DESC'],
  quantidade: ['QUANTIDADE', 'QTD', 'QTDE', 'QTD PEDIDA', 'QUANT'],
  precoUnit: ['PRECO UNITARIO', 'PRECO UNIT', 'VALOR UNITARIO', 'PRECO C DESCONTO SEM ST', 'PRECO COM DESCONTO', 'PRECO', 'VALOR', 'PU'],
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

export function calculateOrder(cotacoes, pedido) {
  return pedido.map((item) => {
    const offers = cotacoes[item.ean]?.ofertas || []
    if (!offers.length) return { ...item, fornecedorSelecionado: null, precoUnitario: null, precoTotal: null, status: 'naoEncontrado' }
    const best = [...offers].sort((first, second) => first.precoUnitario - second.precoUnitario)[0]
    const preferred = item.fornecedorPreferido && offers.find((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(item.fornecedorPreferido))
    if (item.fornecedorPreferido && !preferred) return { ...item, fornecedorSelecionado: null, precoUnitario: null, precoTotal: null, status: 'naoEncontrado' }
    const selected = preferred || best
    return { ...item, fornecedorSelecionado: selected.fornecedor, precoUnitario: selected.precoUnitario, precoTotal: selected.precoUnitario * item.quantidadePedida, status: selected.fornecedor === best.fornecedor ? 'selecionado' : 'alternativaPreferida' }
  })
}

export async function readSpreadsheet(file) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const matrices = workbook.SheetNames.map((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', blankrows: false }))
  return matrices.sort((first, second) => second.length - first.length)[0] || []
}
