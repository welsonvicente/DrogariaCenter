export const COTACAO_STORAGE_KEY = 'drogaria_center_cotacao_v1'

export function normalizeHeader(value) {
  return String(value || '').trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
}

function wordDistance(first, second) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex]
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current[secondIndex] = Math.min(
        current[secondIndex - 1] + 1,
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1),
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[second.length]
}

function similarSearchWord(term, word) {
  if (term.length < 4 || word.length < 4) return false
  if (word.startsWith(term) || term.startsWith(word)) return true
  const smallestLength = Math.min(term.length, word.length)
  const tolerance = smallestLength >= 8 ? 2 : smallestLength >= 5 ? 1 : 0
  return tolerance > 0 && Math.abs(term.length - word.length) <= tolerance && wordDistance(term, word) <= tolerance
}

export function matchesProductSearch(product, query) {
  const normalizedQuery = normalizeHeader(query)
  if (!normalizedQuery) return true
  const normalizedName = normalizeHeader(product?.nome)
  const normalizedSupplier = normalizeHeader(product?.fornecedor)
  const normalizedEan = String(product?.ean || '').replace(/\D/g, '')
  const haystack = `${normalizedName} ${normalizedSupplier} ${normalizedEan}`
  const words = normalizedName.split(/[^A-Z0-9]+/).filter(Boolean)
  return normalizedQuery.split(/\s+/).every((term) => {
    if (haystack.includes(term)) return true
    if (/^\d+$/.test(term)) return normalizedEan.includes(term)
    return words.some((word) => similarSearchWord(term, word))
  })
}

export function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return value
  let source = String(value).trim().toUpperCase()
  if (/^[\d\s.,-]*G[\d\s.,G-]*$/.test(source)) source = source.replace(/G/g, '9')
  let text = source.replace(/[^\d,.-]/g, '')
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
  precoUnit: ['PRECO UNITARIO', 'PRECO UNIT', 'VALOR UNITARIO', 'LIQ S ST', 'LIQ SEM ST', 'LIQUIDO S ST', 'LIQUIDO SEM ST', 'PRECO C DESCONTO SEM ST', 'PRECO COM DESCONTO', 'PRECO', 'VALOR', 'PU'],
  precoCusto: ['P. CUSTO', 'P CUSTO', 'PRECO DE CUSTO', 'PRECO CUSTO', 'CUSTO UNITARIO', 'VALOR ULT ENTRADA', 'ULTIMO CUSTO'],
  dcb: ['DCB', 'DENOMINACAO COMUM BRASILEIRA', 'PRINCIPIO ATIVO DCB'],
  laboratorio: ['LABORATORIO', 'LAB', 'FABRICANTE', 'MARCA'],
  fornecedor: ['FORNECEDOR PREFERIDO', 'FORNECEDOR ESCOLHIDO', 'DISTRIBUIDOR PREFERIDO'],
}

function matchColumn(headers, patterns) {
  const normalizeColumnLabel = (value) => normalizeHeader(value).replace(/[^A-Z0-9]+/g, ' ').trim()
  const normalized = headers.map(normalizeColumnLabel)
  const normalizedPatterns = patterns.map(normalizeColumnLabel)
  for (const pattern of normalizedPatterns) { const index = normalized.findIndex((header) => header === pattern); if (index >= 0) return index }
  for (const pattern of normalizedPatterns) { const index = normalized.findIndex((header) => header && header.includes(pattern)); if (index >= 0) return index }
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
  let source = String(value ?? '').trim().toUpperCase()
  const compact = source.replace(/[^A-Z0-9]/g, '')
  if (compact.includes('G') && /^[0-9G]+$/.test(compact)) source = compact.replace(/G/g, '9')
  return source.replace(/\D/g, '')
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

export function normalizeDcbKey(value) {
  return normalizeHeader(value)
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[^A-Z0-9.+/%]+/g, '')
}

export function parseDcbCatalog(rows, { eanIndex, dcbIndex }) {
  const catalog = {}
  const conflictingEans = new Set()
  let invalid = 0
  let duplicates = 0

  rows.forEach((row) => {
    const ean = normalizeEan(row[eanIndex])
    const label = String(row[dcbIndex] || '').trim()
    const key = normalizeDcbKey(label)
    if (!ean || !key) { invalid += 1; return }
    if (conflictingEans.has(ean)) return
    if (catalog[ean]) {
      duplicates += 1
      if (catalog[ean].key !== key) {
        delete catalog[ean]
        conflictingEans.add(ean)
      }
      return
    }
    catalog[ean] = { key, label }
  })

  return { catalog, invalid, duplicates, conflicts: conflictingEans.size }
}

export function evaluatePriceOpportunity(currentPrice, lastCost) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(lastCost)) return null
  const difference = lastCost - currentPrice
  const percent = lastCost > 0 ? Math.abs(difference) / lastCost * 100 : null
  if (Math.abs(difference) < .005) return { type: 'stable', label: 'Mesmo preço', difference: 0, percent: 0 }
  if (difference > 0) return { type: 'good', label: 'Boa oportunidade', difference, percent }
  return { type: 'high', label: 'Acima do último custo', difference: Math.abs(difference), percent }
}

const PRODUCT_STOPWORDS = new Set([
  'POT', 'POTASSICA', 'REV', 'REVESTIDO', 'REVESTIDOS', 'GENERICO', 'GEN', 'C', 'CX', 'BL', 'BLX', 'FR', 'FRASCO',
  'BR', 'RGD', 'GD', 'CRG', 'EMS', 'GERMED', 'BIOLAB', 'RANBAXY', 'MEDLEY', 'PRATI', 'NEO', 'NEOQUIMICA',
  'TEUTO', 'CIMED', 'ACHE', 'BIOSINTETICA', 'EUROFARMA', 'LEGRAND', 'MULTILAB', 'SANDOZ', 'SANOFI', 'COM',
  'CP', 'CPR', 'COMP', 'COMPR', 'COMPRIMIDO', 'COMPRIMIDOS', 'CAP', 'CAPS', 'CAPSULA', 'CAPSULAS', 'UN', 'AMP', 'SACH',
  'MG', 'MCG', 'G', 'ML', 'UI', 'MUI', 'DOSE', 'DOSES',
])

const FORM_ALIASES = [
  ['tablet', /\b(CP|CPR|COM|COMP|COMPR|COMPRIMIDOS?|DRAGEAS?|DRG)\b/],
  ['capsule', /\b(CAP|CAPS|CAPSULAS?)\b/],
  ['drops', /\b(GTS|GOTAS?)\b/],
  ['syrup', /\b(XPE|XAROPE)\b/],
  ['suspension', /\b(SUSP|SUSPENSAO)\b/],
  ['solution', /\b(SOL|SOLUCAO)\b/],
  ['cream', /\b(CR|CREME)\b/],
  ['ointment', /\b(POM|POMADA)\b/],
  ['gel', /\bGEL\b/],
  ['spray', /\b(SPR|SPRAY)\b/],
  ['injectable', /\b(INJ|INJETAVEL|AMP|AMPOLA)\b/],
  ['sachet', /\b(SACH|SACHE)\b/],
]

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort()
}

function sameValues(first, second) {
  return first.length === second.length && first.every((value, index) => value === second[index])
}

function diceScore(first, second) {
  if (!first.length || !second.length) return 0
  const secondSet = new Set(second)
  const intersection = first.filter((token) => secondSet.has(token)).length
  return (2 * intersection) / (first.length + second.length)
}

export function normalizeProductName(value) {
  return normalizeHeader(value)
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\b(HIDROCLOROTIAZIDA|HCTZ|HCT)\b/g, ' HCTZ ')
    .replace(/\bPOTASSICA\b|\bPOT\b/g, ' ')
    .replace(/\bREVESTIDOS?\b|\bREV\b/g, ' ')
    .replace(/([A-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z])/g, '$1 $2')
    .replace(/[^A-Z0-9.%/+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildProductSignature(name, supplier = '') {
  let text = normalizeProductName(name)
  text = text.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(MCG|MG|G|UI)\b/g, '$1$3 + $2$3')
  const packPatterns = [
    /\bC\s*\/\s*(\d+)\b/,
    /\bBL(?:ISTER)?\s*X?\s*(\d+)\b/,
    /\b(\d+)\s*(?:CP|CPR|COM|COMP|COMPR|COMPRIMIDOS?|CAP|CAPS|CAPSULAS?|DRG|SACH|AMP|UN)\b/,
  ]
  const packMatch = packPatterns.map((pattern) => text.match(pattern)).find(Boolean)
  const pack = packMatch ? Number(packMatch[1]) : null
  const form = FORM_ALIASES.find(([, pattern]) => pattern.test(text))?.[0] || null
  const release = /\b(LP|XR|ER|RETARD|PROLONGAD[AO]S?)\b|\bLIBERACAO\s+PROLONGADA\b/.test(text) ? 'extended' : 'immediate'
  const doseTokens = uniqueSorted([...text.matchAll(/(\d+(?:\.\d+)?)\s*(MCG|MG|G|UI|MUI|%)(?:\s*\/\s*(ML|G|DOSE))?/g)].map((match) => `${Number(match[1])}${match[2]}${match[3] ? `/${match[3]}` : ''}`))
  const sizeTokens = uniqueSorted([...text.matchAll(/(\d+(?:\.\d+)?)\s*(ML|G)\b/g)].map((match) => `${Number(match[1])}${match[2]}`).filter((token) => !doseTokens.includes(token)))
  const supplierTokens = new Set(normalizeProductName(supplier).split(' ').filter(Boolean))
  const ingredientText = text
    .replace(/\bC\s*\/\s*\d+\b/g, ' ')
    .replace(/\bBL(?:ISTER)?\s*X?\s*\d+\b/g, ' ')
    .replace(/\b\d+\s*(?:CP|CPR|COM|COMP|COMPR|COMPRIMIDOS?|CAP|CAPS|CAPSULAS?|DRG|SACH|AMP|UN)\b/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:MCG|MG|G|UI|MUI|%)(?:\s*\/\s*(?:ML|G|DOSE))?/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*(?:ML|G)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
  const ingredientTokens = uniqueSorted(ingredientText.split(/\s+/).filter((token) => token && !/^\d/.test(token) && !PRODUCT_STOPWORDS.has(token) && !supplierTokens.has(token)))
  const associations = uniqueSorted(ingredientTokens.filter((token) => token === 'HCTZ'))
  const presentation = pack !== null ? `PACK:${pack}` : sizeTokens.length ? `SIZE:${sizeTokens.join('+')}` : ''
  const key = [ingredientTokens.join('+'), doseTokens.join('+'), form || '', presentation].join('|')
  return { normalized: text, ingredientTokens, associations, doseTokens, sizeTokens, form, release, pack, presentation, key }
}

export function compareProductNames(orderName, candidateName, candidateSupplier = '') {
  const order = buildProductSignature(orderName)
  const candidate = buildProductSignature(candidateName, candidateSupplier)
  const conflicts = []
  const solidOralForms = new Set(['tablet', 'capsule'])
  const reviewableSolidOralDifference = Boolean(order.form && candidate.form && order.form !== candidate.form && solidOralForms.has(order.form) && solidOralForms.has(candidate.form))
  if (order.doseTokens.length && candidate.doseTokens.length && !sameValues(order.doseTokens, candidate.doseTokens)) conflicts.push('dosagem')
  if (order.form && candidate.form && order.form !== candidate.form && !reviewableSolidOralDifference) conflicts.push('forma')
  if (order.pack !== null && candidate.pack !== null && order.pack !== candidate.pack) conflicts.push('embalagem')
  if (order.sizeTokens.length && candidate.sizeTokens.length && !sameValues(order.sizeTokens, candidate.sizeTokens)) conflicts.push('volume')
  if (!sameValues(order.associations, candidate.associations)) conflicts.push('associação')
  if (order.release !== candidate.release) conflicts.push('liberação')
  const ingredientSimilarity = diceScore(order.ingredientTokens, candidate.ingredientTokens)
  const doseMatch = order.doseTokens.length > 0 && candidate.doseTokens.length > 0 && sameValues(order.doseTokens, candidate.doseTokens)
  const formMatch = Boolean(order.form && candidate.form && order.form === candidate.form)
  const presentationMatch = Boolean(order.presentation && candidate.presentation && order.presentation === candidate.presentation)
  const score = Math.round((ingredientSimilarity * .6 + (doseMatch ? .2 : 0) + (formMatch ? .1 : 0) + (presentationMatch ? .1 : 0)) * 100)
  const automatic = !conflicts.length && ingredientSimilarity >= .85 && doseMatch && formMatch && presentationMatch
  const suggestion = !conflicts.length && !automatic && ingredientSimilarity >= .55 && (doseMatch || formMatch || presentationMatch)
  const safeToAutoAccept = !conflicts.length && ingredientSimilarity >= .85 && doseMatch && presentationMatch && (formMatch || reviewableSolidOralDifference)
  return {
    status: conflicts.length ? 'conflict' : automatic ? 'automatic' : suggestion ? 'suggestion' : 'possible',
    score,
    conflicts,
    reviewReasons: reviewableSolidOralDifference ? ['cápsula versus comprimido'] : [],
    safeToAutoAccept,
    order,
    candidate,
  }
}

export function productLinkId(item, candidateEan) {
  const orderIdentity = normalizeEan(item.ean) || `NAME:${buildProductSignature(item.nome).key}`
  return `${orderIdentity}=>${normalizeEan(candidateEan)}`
}

export function createOfferKey(supplier, sourceEan) {
  return `${normalizeHeader(supplier)}|${normalizeEan(sourceEan)}`
}

export function findProductMatches(cotacoes, item, productLinks = {}, matchingOptions = {}, dcbCatalog = {}) {
  const matchedProducts = []
  const suggestions = []
  const orderDcb = dcbCatalog[normalizeEan(item.ean)] || null
  Object.values(cotacoes).forEach((candidate) => {
    const exact = Boolean(item.ean && candidate.ean === item.ean)
    const linkState = productLinks[productLinkId(item, candidate.ean)]
    const candidateDcb = dcbCatalog[normalizeEan(candidate.ean)] || null
    const sameDcb = Boolean(orderDcb?.key && candidateDcb?.key && orderDcb.key === candidateDcb.key)
    const comparison = exact ? null : compareProductNames(item.nome, candidate.nome, candidate.ofertas[0]?.fornecedor || '')
    let method = null
    if (exact) method = 'ean'
    else if (linkState !== 'rejected' && sameDcb) method = 'dcb'
    else if (linkState === 'approved') method = 'confirmed-name'
    else if (linkState !== 'rejected' && comparison.status === 'automatic') method = 'automatic-name'
    else if (linkState !== 'rejected' && matchingOptions.autoAcceptSafe && comparison.status === 'suggestion' && comparison.safeToAutoAccept) method = 'auto-reviewed-name'
    if (method) {
      matchedProducts.push({ ...candidate, method, score: exact || sameDcb ? 100 : comparison?.score || 100, comparison, dcb: candidateDcb?.label || '' })
    } else if (linkState !== 'rejected' && comparison?.status === 'suggestion') {
      suggestions.push({ ...candidate, method: 'suggestion', score: comparison.score, comparison })
    }
  })

  const offersByKey = new Map()
  matchedProducts.forEach((product) => product.ofertas.forEach((offer) => {
    if (!Number.isFinite(offer.precoUnitario) || offer.precoUnitario <= 0) return
    const enriched = { ...offer, offerKey: createOfferKey(offer.fornecedor, product.ean), eanOferta: product.ean, nomeOferta: product.nome, dcbOferta: product.dcb || '', matchMethod: product.method, matchScore: product.score }
    const existing = offersByKey.get(enriched.offerKey)
    if (!existing || enriched.precoUnitario < existing.precoUnitario) offersByKey.set(enriched.offerKey, enriched)
  }))
  const offers = [...offersByKey.values()].sort((first, second) => first.precoUnitario - second.precoUnitario)
  suggestions.sort((first, second) => second.score - first.score)
  return { offers, matchedProducts, suggestions, orderDcb }
}

export function calculateOrder(cotacoes, pedido, ajustesManuais = {}, productLinks = {}, matchingOptions = {}, dcbCatalog = {}) {
  return pedido.map((item) => {
    const { offers, matchedProducts, suggestions, orderDcb } = findProductMatches(cotacoes, item, productLinks, matchingOptions, dcbCatalog)
    const ajuste = ajustesManuais[item.id]
    const quantidadeOriginal = item.quantidadePedida
    const adjustedQuantity = Number(ajuste?.quantidade)
    const quantidadeFinal = ajuste && Number.isInteger(adjustedQuantity) && adjustedQuantity >= 0 ? adjustedQuantity : quantidadeOriginal
    const melhorOfertaEanExato = offers.find((offer) => offer.matchMethod === 'ean') || null
    const ofertasNomeMaisBaratas = melhorOfertaEanExato
      ? offers.filter((offer) => offer.matchMethod !== 'ean' && offer.eanOferta !== item.ean && offer.precoUnitario < melhorOfertaEanExato.precoUnitario - 0.005)
      : []
    const melhorOfertaNome = ofertasNomeMaisBaratas[0] || null
    const economiaNomeUnitario = melhorOfertaNome && melhorOfertaEanExato ? melhorOfertaEanExato.precoUnitario - melhorOfertaNome.precoUnitario : 0
    const base = { ...item, dcb: orderDcb?.label || '', quantidadeOriginal, quantidadeFinal, ajusteManual: Boolean(ajuste), motivoAjuste: ajuste?.motivo || '', ofertasDisponiveis: offers, produtosCorrespondentes: matchedProducts, sugestoesCorrespondencia: suggestions, melhorOfertaEanExato, melhorOfertaNome, ofertasNomeMaisBaratas, temOfertaNomeMaisBarata: ofertasNomeMaisBaratas.length > 0, economiaNomeUnitario, economiaNomeTotal: economiaNomeUnitario * quantidadeFinal }
    if (!offers.length) return { ...base, fornecedorSelecionado: null, fornecedorAutomatico: null, eanOferta: null, nomeOferta: null, matchMethod: null, matchScore: null, precoUnitario: null, precoAutomatico: null, precoTotal: null, precoTotalAutomatico: null, impactoAjuste: 0, status: suggestions.length ? 'revisarCorrespondencia' : 'naoEncontrado' }
    const best = offers[0]
    const hasActivePreference = Boolean(item.preferenciaFornecedorAtiva && item.fornecedorPreferido)
    const preferredOffers = hasActivePreference ? offers.filter((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(item.fornecedorPreferido)) : []
    const preferred = preferredOffers[0]
    const automatic = preferred || best
    const supplierMatches = ajuste?.fornecedor ? offers.filter((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(ajuste.fornecedor)) : []
    const manual = ajuste?.eanOferta ? supplierMatches.find((offer) => offer.eanOferta === ajuste.eanOferta) : supplierMatches[0]
    if (ajuste && !manual) return { ...base, fornecedorSelecionado: ajuste.fornecedor, fornecedorAutomatico: automatic?.fornecedor || null, eanOferta: ajuste.eanOferta || null, nomeOferta: null, matchMethod: null, matchScore: null, precoUnitario: null, precoAutomatico: automatic?.precoUnitario ?? null, precoTotal: null, precoTotalAutomatico: automatic ? automatic.precoUnitario * quantidadeOriginal : null, impactoAjuste: 0, status: 'ajusteInvalido' }
    if (!automatic && !manual) return { ...base, fornecedorSelecionado: null, fornecedorAutomatico: null, eanOferta: null, nomeOferta: null, matchMethod: null, matchScore: null, precoUnitario: null, precoAutomatico: null, precoTotal: null, precoTotalAutomatico: null, impactoAjuste: 0, status: suggestions.length ? 'revisarCorrespondencia' : 'naoEncontrado' }
    const selected = manual || automatic
    const precoTotal = selected.precoUnitario * quantidadeFinal
    const precoTotalAutomatico = automatic ? automatic.precoUnitario * quantidadeOriginal : null
    const status = ajuste ? (quantidadeFinal === 0 ? 'removidoManual' : 'ajusteManual') : selected.offerKey === best.offerKey ? 'selecionado' : 'alternativaPreferida'
    return { ...base, fornecedorSelecionado: selected.fornecedor, fornecedorAutomatico: automatic?.fornecedor || null, eanOferta: selected.eanOferta, nomeOferta: selected.nomeOferta, dcbOferta: selected.dcbOferta || '', eanOfertaAutomatico: automatic?.eanOferta || null, matchMethod: selected.matchMethod, matchScore: selected.matchScore, offerKey: selected.offerKey, precoUnitario: selected.precoUnitario, precoAutomatico: automatic?.precoUnitario ?? null, menorPreco: best.precoUnitario, precoTotal, precoTotalAutomatico, impactoAjuste: ajuste && precoTotalAutomatico !== null ? precoTotal - precoTotalAutomatico : 0, status }
  })
}

export async function readSpreadsheet(file) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const matrices = workbook.SheetNames.map((name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', blankrows: false }))
  return matrices.sort((first, second) => second.length - first.length)[0] || []
}
