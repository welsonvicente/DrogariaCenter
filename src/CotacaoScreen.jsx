import { useEffect, useMemo, useState } from 'react'
import { COTACAO_STORAGE_KEY, autoMapColumns, calculateOrder, createOrderLineId, detectHeaderRow, ensureOrderLineIds, evaluatePriceOpportunity, formatBRL, normalizeEan, normalizeHeader, parsePriceHistory, readSpreadsheet, supplierFromFilename, toNumber } from './cotacao.js'

function storedData() {
  try { return JSON.parse(localStorage.getItem(COTACAO_STORAGE_KEY)) || {} } catch { return {} }
}

function DownloadCsv({ data, name, children }) {
  function download() {
    if (!data.length) return
    const headers = Object.keys(data[0])
    const rows = [headers.join(';'), ...data.map((row) => headers.map((header) => `"${String(row[header] ?? '').replace(/"/g, '""')}"`).join(';'))]
    const url = URL.createObjectURL(new Blob(['\uFEFF', rows.join('\n')], { type: 'text/csv;charset=utf-8' }))
    Object.assign(document.createElement('a'), { href: url, download: name }).click()
    URL.revokeObjectURL(url)
  }
  return <button className="quote-secondary-button" disabled={!data.length} onClick={download}>{children}</button>
}

function Status({ type, children }) { return <span className={`quote-status ${type}`}>{children}</span> }

function PurchaseStatus({ item }) {
  if (item.status === 'naoEncontrado') return <Status type="danger">Não encontrado</Status>
  if (item.status === 'ajusteInvalido') return <Status type="danger">Revisar ajuste</Status>
  if (item.status === 'removidoManual') return <Status type="neutral">Removido</Status>
  if (item.status === 'ajusteManual') return <Status type="warning">Ajuste manual</Status>
  if (item.status === 'alternativaPreferida') return <Status type="warning">Preferido</Status>
  return <Status type="success">Melhor preço</Status>
}

function historyCategory(item, history) {
  const reference = history[item.ean]
  if (!reference) return 'missing'
  return evaluatePriceOpportunity(item.precoUnitario, reference.precoCusto)?.type || 'missing'
}

function historyOpportunityScore(item, history) {
  const reference = history[item.ean]
  if (!reference || !Number.isFinite(item.precoUnitario) || !Number.isFinite(reference.precoCusto)) return null
  if (reference.precoCusto > 0) return (reference.precoCusto - item.precoUnitario) / reference.precoCusto * 100
  return reference.precoCusto - item.precoUnitario
}

function mergeBytes(chunks) {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.length })
  return bytes
}

function canvasBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Não foi possível gerar o arquivo.')), type, quality))
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

function wrapText(context, text, width) {
  return String(text).split(/\s+/).reduce((lines, word) => {
    const current = lines.at(-1) || ''
    const candidate = current ? `${current} ${word}` : word
    if (context.measureText(candidate).width <= width || !current) lines[lines.length - 1] = candidate
    else lines.push(word)
    return lines
  }, [''])
}

function purchasePage(rows, supplier, pageNumber, totalPages) {
  const canvas = document.createElement('canvas')
  canvas.width = 1600; canvas.height = 1080
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#ec0016'; context.fillRect(0, 0, canvas.width, 160)
  context.fillStyle = '#fff'; context.font = '900 58px Arial, sans-serif'; context.fillText('DROGARIA CENTER', 70, 78)
  context.font = '700 28px Arial, sans-serif'; context.fillText('PEDIDO - MELHOR COMPRA', 70, 124)
  context.font = '700 24px Arial, sans-serif'; context.textAlign = 'right'; context.fillText(`Página ${pageNumber} de ${totalPages}`, 1530, 82)
  context.fillStyle = '#5b484d'; context.textAlign = 'left'; context.font = '700 25px Arial, sans-serif'; context.fillText(`Filtro de laboratório: ${supplier}`, 70, 205)
  const columns = [70, 245, 735, 855, 1120, 1345]
  const widths = [160, 470, 100, 250, 205, 185]
  const headers = ['CÓDIGO', 'PRODUTO', 'QTD.', 'FORNECEDOR', 'UNITÁRIO', 'TOTAL']
  context.fillStyle = '#fff3f5'; context.fillRect(55, 235, 1490, 54)
  context.fillStyle = '#7b5c64'; context.font = '800 18px Arial, sans-serif'
  headers.forEach((header, index) => context.fillText(header, columns[index], 269))
  let y = 323
  rows.forEach((item, index) => {
    const lines = wrapText(context, item.nome, widths[1] - 15).slice(0, 2)
    const height = Math.max(44, lines.length * 25 + 20)
    if (index % 2 === 0) { context.fillStyle = '#fffafb'; context.fillRect(55, y - 27, 1490, height) }
    context.fillStyle = '#4c393e'; context.font = '600 18px Arial, sans-serif'; context.fillText(item.ean, columns[0], y)
    context.font = '700 18px Arial, sans-serif'; lines.forEach((line, lineIndex) => context.fillText(`${lineIndex === 0 && item.ajusteManual ? '* ' : ''}${line}`, columns[1], y - 12 + lineIndex * 25))
    context.textAlign = 'right'; context.font = '700 18px Arial, sans-serif'; context.fillText(String(item.quantidadeFinal), columns[2] + widths[2] - 10, y)
    context.textAlign = 'left'; context.font = '600 17px Arial, sans-serif'; context.fillText(`${item.fornecedorSelecionado}${item.ajusteManual ? ' *' : ''}`, columns[3], y)
    context.textAlign = 'right'; context.font = '700 18px Arial, sans-serif'; context.fillText(formatBRL(item.precoUnitario), columns[4] + widths[4] - 8, y); context.fillText(formatBRL(item.precoTotal), columns[5] + widths[5] - 8, y)
    context.textAlign = 'left'; y += height
  })
  const total = rows.reduce((sum, item) => sum + item.precoTotal, 0)
  context.fillStyle = '#f4ffe0'; context.fillRect(55, 980, 1490, 54)
  context.fillStyle = '#527900'; context.font = '900 23px Arial, sans-serif'; context.fillText(`TOTAL DESTA PÁGINA: ${formatBRL(total)}`, 75, 1015)
  if (rows.some((item) => item.ajusteManual)) { context.fillStyle = '#806c71'; context.font = '600 15px Arial, sans-serif'; context.fillText('* Escolha ou quantidade ajustada manualmente.', 75, 1060) }
  return canvas
}

async function canvasesPdfBlob(canvases) {
  const encode = (text) => new TextEncoder().encode(text)
  const images = await Promise.all(canvases.map(async (canvas) => ({ canvas, jpeg: new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', .95)).arrayBuffer()) })))
  let nextId = 3
  const pages = images.map((image) => ({ ...image, pageId: nextId++, contentId: nextId++, imageId: nextId++ }))
  const objects = [{ id: 1, value: encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n') }, { id: 2, value: encode(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((page) => `${page.pageId} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`) }]
  pages.forEach((page) => {
    const width = 720; const height = Math.round(width * page.canvas.height / page.canvas.width)
    const content = encode(`q\n${width} 0 0 ${height} 0 0 cm\n/Im${page.imageId} Do\nQ\n`)
    objects.push({ id: page.pageId, value: encode(`${page.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im${page.imageId} ${page.imageId} 0 R >> >> /Contents ${page.contentId} 0 R >>\nendobj\n`) }, { id: page.contentId, value: mergeBytes([encode(`${page.contentId} 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, encode('endstream\nendobj\n')]) }, { id: page.imageId, value: mergeBytes([encode(`${page.imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.canvas.width} /Height ${page.canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, encode('\nendstream\nendobj\n')]) })
  })
  objects.sort((first, second) => first.id - second.id)
  const header = encode('%PDF-1.4\n'); let position = header.length; const offsets = []
  objects.forEach((object) => { offsets.push(position); position += object.value.length })
  const xref = encode(`xref\n0 ${nextId}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`)
  return new Blob([header, ...objects.map((object) => object.value), xref], { type: 'application/pdf' })
}

export default function CotacaoScreen({ onBack }) {
  const saved = storedData()
  const [cotacoes, setCotacoes] = useState(saved.cotacoes || {})
  const [fornecedores, setFornecedores] = useState(saved.fornecedores || [])
  const [pedido, setPedido] = useState(() => ensureOrderLineIds(saved.pedido || []))
  const [ajustesManuais, setAjustesManuais] = useState(saved.ajustesManuais || {})
  const [historicoPrecos, setHistoricoPrecos] = useState(saved.historicoPrecos || {})
  const [historicoInfo, setHistoricoInfo] = useState(saved.historicoInfo || null)
  const [activeTab, setActiveTab] = useState('')
  const [warnings, setWarnings] = useState([])
  const [notice, setNotice] = useState('')
  const [mapping, setMapping] = useState(null)
  const [loading, setLoading] = useState('')
  const [exporting, setExporting] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [supplierToRemove, setSupplierToRemove] = useState('')
  const [supplierToRename, setSupplierToRename] = useState('')
  const [supplierNameDraft, setSupplierNameDraft] = useState('')
  const [supplierRenameError, setSupplierRenameError] = useState('')
  const [editingLineId, setEditingLineId] = useState('')
  const [purchaseDraft, setPurchaseDraft] = useState({ fornecedor: '', quantidade: 1, motivo: '' })
  const [purchaseEditError, setPurchaseEditError] = useState('')
  const [resetAdjustmentsOpen, setResetAdjustmentsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [supplierFilter, setSupplierFilter] = useState('todos')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [onlyAdjusted, setOnlyAdjusted] = useState(false)
  const [historyFilter, setHistoryFilter] = useState('all')
  const [historySort, setHistorySort] = useState('default')
  const resultado = useMemo(() => calculateOrder(cotacoes, pedido, ajustesManuais), [ajustesManuais, cotacoes, pedido])
  const supplierList = useMemo(() => [...new Set(Object.values(cotacoes).flatMap((item) => item.ofertas.map((offer) => offer.fornecedor)))].sort((first, second) => first.localeCompare(second, 'pt-BR')), [cotacoes])
  const purchaseTabs = useMemo(() => pedido.length ? [
    { id: 'pedido', label: 'Pedido', description: 'Itens solicitados', count: pedido.length },
    { id: 'resultado', label: 'Melhor compra', description: 'Resultado calculado', count: resultado.filter((item) => item.quantidadeFinal > 0 && item.status !== 'naoEncontrado' && item.status !== 'ajusteInvalido').length },
  ] : [], [pedido.length, resultado])
  const supplierTabs = useMemo(() => supplierList.map((supplier) => ({
    id: `forn:${supplier}`,
    label: supplier,
    count: Object.values(cotacoes).filter((item) => item.ofertas.some((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(supplier))).length,
  })), [cotacoes, supplierList])
  const tabs = useMemo(() => [...purchaseTabs, ...supplierTabs], [purchaseTabs, supplierTabs])

  useEffect(() => { localStorage.setItem(COTACAO_STORAGE_KEY, JSON.stringify({ cotacoes, fornecedores: supplierList, pedido, ajustesManuais, historicoPrecos, historicoInfo })) }, [ajustesManuais, cotacoes, historicoInfo, historicoPrecos, pedido, supplierList])
  useEffect(() => { if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0]?.id || '') }, [activeTab, tabs])

  async function startImport(kind, file) {
    if (!file) return
    setNotice(''); setWarnings([]); setLoading(kind)
    try {
      const matrix = await readSpreadsheet(file)
      if (!matrix.length) throw new Error('A planilha está vazia.')
      const headerIndex = detectHeaderRow(matrix)
      const headers = (matrix[headerIndex] || []).map((header) => String(header || '').trim())
      const rows = matrix.slice(headerIndex + 1).filter((row) => row.some((cell) => String(cell || '').trim()))
      if (!rows.length) throw new Error('Não encontrei linhas de dados após o cabeçalho.')
      const auto = autoMapColumns(headers, rows)
      const fields = kind === 'cotacao'
        ? [{ key: 'ean', label: 'EAN / código de barras', required: true }, { key: 'nome', label: 'Descrição do produto', required: true }, { key: 'precoUnit', label: 'Preço unitário', required: true }, { key: 'nomeFornecedor', label: 'Nome do fornecedor', type: 'text', required: true }]
        : kind === 'historico'
          ? [{ key: 'ean', label: 'EAN / código de barras', required: true }, { key: 'nome', label: 'Descrição do produto (opcional)' }, { key: 'precoCusto', label: 'Último preço de custo', required: true }, { key: 'fornecedor', label: 'Laboratório (opcional)' }]
          : [{ key: 'ean', label: 'EAN (opcional)' }, { key: 'codigo', label: 'Código interno (opcional)' }, { key: 'nome', label: 'Descrição do produto', required: true }, { key: 'quantidade', label: 'Quantidade', required: true }, { key: 'fornecedor', label: 'Fornecedor preferido (opcional)' }]
      setMapping({ kind, headers, rows, fields, values: { ...auto, nomeFornecedor: supplierFromFilename(file.name) }, fileName: file.name })
    } catch (error) { setNotice(error.message || 'Não foi possível ler a planilha.') }
    finally { setLoading('') }
  }

  function mappedIndex(value) { return value === '' || value === undefined ? null : Number(value) }

  function confirmMapping() {
    if (!mapping) return
    const get = (key) => mappedIndex(mapping.values[key])
    if (mapping.kind === 'cotacao') {
      const eanIndex = get('ean'); const nameIndex = get('nome'); const priceIndex = get('precoUnit'); const supplier = String(mapping.values.nomeFornecedor || '').trim()
      if (eanIndex === null || nameIndex === null || priceIndex === null || !supplier) { setNotice('Selecione EAN, descrição, preço e informe o fornecedor.'); return }
      let added = 0; let duplicates = 0; let invalid = 0
      const next = Object.fromEntries(Object.entries(cotacoes).map(([key, value]) => [key, { ...value, ofertas: [...value.ofertas] }]))
      mapping.rows.forEach((row) => {
        const ean = normalizeEan(row[eanIndex])
        const nome = String(row[nameIndex] || '').trim(); const precoUnitario = toNumber(row[priceIndex])
        if (!ean || !nome || precoUnitario === null) { invalid += 1; return }
        if (!next[ean]) next[ean] = { ean, nome, ofertas: [] }
        if (next[ean].ofertas.some((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(supplier))) { duplicates += 1; return }
        next[ean].ofertas.push({ fornecedor: supplier, precoUnitario }); added += 1
      })
      setCotacoes(next); setFornecedores((current) => [...new Set([...current, supplier])].sort((first, second) => first.localeCompare(second, 'pt-BR')))
      setWarnings([...(duplicates ? [`${duplicates} duplicata(s) foram ignoradas.`] : []), ...(invalid ? [`${invalid} linha(s) sem dados completos foram ignoradas.`] : [])])
      setNotice(`${added} oferta(s) de ${supplier} importada(s).`)
    } else if (mapping.kind === 'pedido') {
      const eanIndex = get('ean'); const codeIndex = get('codigo'); const nameIndex = get('nome'); const quantityIndex = get('quantidade'); const supplierIndex = get('fornecedor')
      if (nameIndex === null || quantityIndex === null || (eanIndex === null && codeIndex === null)) { setNotice('Selecione nome, quantidade e ao menos um identificador (EAN ou código).'); return }
      const seen = new Set(); let duplicates = 0; let invalid = 0
      const next = mapping.rows.reduce((items, row) => {
        const ean = (eanIndex === null ? '' : normalizeEan(row[eanIndex])) || (codeIndex === null ? '' : String(row[codeIndex] || '').trim())
        const nome = String(row[nameIndex] || '').trim(); const quantidadePedida = toNumber(row[quantityIndex]); const fornecedorPreferido = supplierIndex === null ? null : String(row[supplierIndex] || '').trim() || null
        const key = `${ean}|${fornecedorPreferido || ''}`
        if (!ean || !nome || !quantidadePedida) { invalid += 1; return items }
        if (seen.has(key)) { duplicates += 1; return items }
        seen.add(key); items.push({ id: createOrderLineId(), ean, nome, quantidadePedida: Math.max(0, Math.round(quantidadePedida)), fornecedorPreferido }); return items
      }, [])
      setPedido(next); setAjustesManuais({}); setOnlyAdjusted(false); setWarnings([...(duplicates ? [`${duplicates} duplicata(s) no pedido foram ignoradas.`] : []), ...(invalid ? [`${invalid} linha(s) sem dados completos foram ignoradas.`] : [])]); setNotice(`${next.length} item(ns) de pedido importado(s). Os ajustes manuais anteriores foram limpos.`)
    } else {
      const eanIndex = get('ean'); const nameIndex = get('nome'); const costIndex = get('precoCusto'); const laboratoryIndex = get('fornecedor')
      if (eanIndex === null || costIndex === null) { setNotice('Selecione o EAN e o último preço de custo.'); return }
      const { history, invalid, duplicates } = parsePriceHistory(mapping.rows, { eanIndex, nameIndex, costIndex, laboratoryIndex })
      const total = Object.keys(history).length
      if (!total) { setNotice('Não encontrei produtos com EAN e preço de custo válidos.'); return }
      const matched = resultado.filter((item) => history[item.ean]).length
      setHistoricoPrecos(history)
      setHistoricoInfo({ fileName: mapping.fileName, importedAt: new Date().toISOString(), total, matched })
      setWarnings([...(duplicates ? [`${duplicates} EAN(s) repetido(s); foi mantido o último custo encontrado.`] : []), ...(invalid ? [`${invalid} linha(s) sem EAN ou custo válido foram ignoradas.`] : [])])
      setNotice(`${total} custo(s) histórico(s) importado(s). ${matched} produto(s) do pedido foram encontrados pelo EAN.`)
    }
    setMapping(null)
  }

  function removeSupplier(supplier) {
    const supplierKey = normalizeHeader(supplier)
    let removedOffers = 0
    const nextCotacoes = Object.fromEntries(Object.entries(cotacoes).flatMap(([ean, item]) => {
      const offers = item.ofertas.filter((offer) => {
        const shouldRemove = normalizeHeader(offer.fornecedor) === supplierKey
        if (shouldRemove) removedOffers += 1
        return !shouldRemove
      })
      return offers.length ? [[ean, { ...item, ofertas: offers }]] : []
    }))
    if (!removedOffers) { setNotice(`Não encontrei ofertas cadastradas para ${supplier}.`); setSupplierToRemove(''); return }
    const nextSuppliers = [...new Set(Object.values(nextCotacoes).flatMap((item) => item.ofertas.map((offer) => offer.fornecedor)))].sort((first, second) => first.localeCompare(second, 'pt-BR'))
    let revertedAdjustments = 0
    const nextAdjustments = Object.fromEntries(Object.entries(ajustesManuais).filter(([, adjustment]) => {
      const keep = normalizeHeader(adjustment.fornecedor) !== supplierKey
      if (!keep) revertedAdjustments += 1
      return keep
    }))
    localStorage.setItem(COTACAO_STORAGE_KEY, JSON.stringify({ cotacoes: nextCotacoes, fornecedores: nextSuppliers, pedido, ajustesManuais: nextAdjustments, historicoPrecos, historicoInfo }))
    setCotacoes(nextCotacoes)
    setFornecedores(nextSuppliers)
    setAjustesManuais(nextAdjustments)
    setActiveTab(pedido.length ? 'resultado' : '')
    setSupplierFilter('todos')
    setSearch('')
    setWarnings([])
    setNotice(`Tabela de ${supplier} removida: ${removedOffers} oferta(s) excluída(s).${revertedAdjustments ? ` ${revertedAdjustments} ajuste(s) voltaram ao cálculo automático.` : ''}`)
    setSupplierToRemove('')
  }

  function openSupplierRename(supplier) {
    setSupplierToRename(supplier)
    setSupplierNameDraft(supplier)
    setSupplierRenameError('')
  }

  function renameSupplier() {
    const previousName = supplierToRename
    const nextName = supplierNameDraft.trim()
    const previousKey = normalizeHeader(previousName)
    const nextKey = normalizeHeader(nextName)
    if (!nextName) { setSupplierRenameError('Informe o novo nome do fornecedor.'); return }
    if (nextKey !== previousKey && supplierList.some((supplier) => normalizeHeader(supplier) === nextKey)) {
      setSupplierRenameError('Já existe um fornecedor com esse nome.')
      return
    }
    if (nextName === previousName) { setSupplierToRename(''); return }

    let renamedOffers = 0
    const nextCotacoes = Object.fromEntries(Object.entries(cotacoes).map(([ean, item]) => [ean, {
      ...item,
      ofertas: item.ofertas.map((offer) => {
        if (normalizeHeader(offer.fornecedor) !== previousKey) return offer
        renamedOffers += 1
        return { ...offer, fornecedor: nextName }
      }),
    }]))
    const nextOrder = pedido.map((item) => normalizeHeader(item.fornecedorPreferido || '') === previousKey ? { ...item, fornecedorPreferido: nextName } : item)
    const nextAdjustments = Object.fromEntries(Object.entries(ajustesManuais).map(([lineId, adjustment]) => [lineId, normalizeHeader(adjustment.fornecedor) === previousKey ? { ...adjustment, fornecedor: nextName } : adjustment]))
    const nextSuppliers = supplierList.map((supplier) => normalizeHeader(supplier) === previousKey ? nextName : supplier).sort((first, second) => first.localeCompare(second, 'pt-BR'))

    localStorage.setItem(COTACAO_STORAGE_KEY, JSON.stringify({ cotacoes: nextCotacoes, fornecedores: nextSuppliers, pedido: nextOrder, ajustesManuais: nextAdjustments, historicoPrecos, historicoInfo }))
    setCotacoes(nextCotacoes)
    setFornecedores(nextSuppliers)
    setPedido(nextOrder)
    setAjustesManuais(nextAdjustments)
    setActiveTab(`forn:${nextName}`)
    setSupplierFilter((current) => normalizeHeader(current) === previousKey ? nextName : current)
    setSupplierToRename('')
    setSupplierRenameError('')
    setNotice(`${previousName} agora se chama ${nextName}. ${renamedOffers} oferta(s) atualizada(s).`)
  }

  function openPurchaseEdit(item) {
    setEditingLineId(item.id)
    setPurchaseDraft({ fornecedor: item.fornecedorSelecionado || item.fornecedorAutomatico || '', quantidade: item.quantidadeFinal, motivo: item.motivoAjuste || '' })
    setPurchaseEditError('')
  }

  function savePurchaseEdit() {
    const item = resultado.find((row) => row.id === editingLineId)
    if (!item) { setPurchaseEditError('Não encontrei este item no pedido.'); return }
    const quantidade = Number(purchaseDraft.quantidade)
    if (!Number.isInteger(quantidade) || quantidade < 0) { setPurchaseEditError('Informe uma quantidade inteira igual ou maior que zero.'); return }
    const offers = cotacoes[item.ean]?.ofertas || []
    const selected = offers.find((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(purchaseDraft.fornecedor))
    if (!selected) { setPurchaseEditError('Selecione um fornecedor disponível para este produto.'); return }
    const motivo = purchaseDraft.motivo.trim()
    const isAutomatic = normalizeHeader(selected.fornecedor) === normalizeHeader(item.fornecedorAutomatico) && quantidade === item.quantidadeOriginal && !motivo
    setAjustesManuais((current) => {
      const next = { ...current }
      if (isAutomatic) delete next[item.id]
      else next[item.id] = { fornecedor: selected.fornecedor, quantidade, motivo }
      return next
    })
    setEditingLineId('')
    setPurchaseEditError('')
    setNotice(isAutomatic ? `${item.nome} voltou ao cálculo automático.` : `${item.nome} foi ajustado manualmente.`)
  }

  function restorePurchaseItem(lineId) {
    const item = resultado.find((row) => row.id === lineId)
    setAjustesManuais((current) => { const next = { ...current }; delete next[lineId]; return next })
    setEditingLineId('')
    setPurchaseEditError('')
    if (item) setNotice(`${item.nome} voltou ao cálculo automático.`)
  }

  function restoreAllAdjustments() {
    const count = Object.keys(ajustesManuais).length
    setAjustesManuais({})
    setOnlyAdjusted(false)
    setResetAdjustmentsOpen(false)
    setNotice(`${count} ajuste(s) manual(is) foram restaurados para o cálculo automático.`)
  }

  function clearPriceHistory() {
    setHistoricoPrecos({})
    setHistoricoInfo(null)
    setHistoryFilter('all')
    setHistorySort('default')
    setNotice('A referência de custo histórico foi removida. As cotações e o pedido foram mantidos.')
  }

  function clearData() { setCotacoes({}); setFornecedores([]); setPedido([]); setAjustesManuais({}); setHistoricoPrecos({}); setHistoricoInfo(null); setWarnings([]); setOnlyAdjusted(false); setHistoryFilter('all'); setHistorySort('default'); setNotice('Dados removidos deste dispositivo.'); setClearOpen(false); localStorage.removeItem(COTACAO_STORAGE_KEY) }

  const searchText = search.toLocaleLowerCase('pt-BR')
  const pedidoRows = resultado.filter((item) => (!searchText || item.nome.toLocaleLowerCase('pt-BR').includes(searchText) || item.ean.includes(searchText)) && (!onlyMissing || item.status === 'naoEncontrado'))
  const baseResultRows = resultado.filter((item) => item.status !== 'naoEncontrado' && (!searchText || item.nome.toLocaleLowerCase('pt-BR').includes(searchText) || item.ean.includes(searchText)) && (supplierFilter === 'todos' || item.fornecedorSelecionado === supplierFilter) && (!onlyAdjusted || item.ajusteManual))
  const resultRows = baseResultRows
    .filter((item) => historyFilter === 'all' || historyCategory(item, historicoPrecos) === historyFilter)
    .sort((first, second) => {
      if (historySort === 'default') return 0
      const firstScore = historyOpportunityScore(first, historicoPrecos)
      const secondScore = historyOpportunityScore(second, historicoPrecos)
      if (firstScore === null && secondScore === null) return 0
      if (firstScore === null) return 1
      if (secondScore === null) return -1
      return historySort === 'worst' ? firstScore - secondScore : secondScore - firstScore
    })
  const purchaseRows = baseResultRows.filter((item) => item.quantidadeFinal > 0 && item.status !== 'ajusteInvalido' && item.precoTotal !== null)
  const activeSupplier = activeTab.startsWith('forn:') ? activeTab.slice(5) : ''
  const supplierRows = activeSupplier ? Object.values(cotacoes).filter((item) => item.ofertas.some((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(activeSupplier))).map((item) => ({ ...item, offer: item.ofertas.find((offer) => normalizeHeader(offer.fornecedor) === normalizeHeader(activeSupplier)) })).filter((item) => !searchText || item.nome.toLocaleLowerCase('pt-BR').includes(searchText) || item.ean.includes(searchText)) : []
  const exportRows = activeTab === 'pedido' ? pedidoRows.map((item) => ({ CODIGO: item.ean, NOME: item.nome, QUANTIDADE_ORIGINAL: item.quantidadeOriginal, QUANTIDADE_FINAL: item.quantidadeFinal, PREFERIDO: item.fornecedorPreferido || '', AJUSTE_MANUAL: item.ajusteManual ? 'Sim' : 'Não', MOTIVO: item.motivoAjuste, STATUS: item.status })) : activeTab === 'resultado' ? purchaseRows.map((item) => ({ CODIGO: item.ean, NOME: item.nome, QUANTIDADE_ORIGINAL: item.quantidadeOriginal, QUANTIDADE_FINAL: item.quantidadeFinal, FORNECEDOR: item.fornecedorSelecionado, PRECO_UNITARIO: item.precoUnitario, PRECO_TOTAL: item.precoTotal, AJUSTE_MANUAL: item.ajusteManual ? 'Sim' : 'Não', MOTIVO: item.motivoAjuste })) : supplierRows.map((item) => ({ EAN: item.ean, DESCRICAO: item.nome, PRECO_UNITARIO: item.offer.precoUnitario }))
  const total = purchaseRows.reduce((sum, item) => sum + item.precoTotal, 0)
  const automaticTotal = baseResultRows.reduce((sum, item) => sum + (item.precoTotalAutomatico || 0), 0)
  const adjustmentImpact = total - automaticTotal
  const adjustedCount = resultado.filter((item) => item.ajusteManual).length
  const breakdown = purchaseRows.reduce((items, item) => ({ ...items, [item.fornecedorSelecionado]: (items[item.fornecedorSelecionado] || 0) + item.precoTotal }), {})
  const filterLabel = supplierFilter === 'todos' ? 'Todos os fornecedores' : supplierFilter
  const editingItem = resultado.find((item) => item.id === editingLineId)
  const historyCount = Object.keys(historicoPrecos).length
  const historyStats = baseResultRows.reduce((stats, item) => ({ ...stats, [historyCategory(item, historicoPrecos)]: stats[historyCategory(item, historicoPrecos)] + 1 }), { good: 0, stable: 0, high: 0, missing: 0 })
  const historyMatchedCount = historyStats.good + historyStats.stable + historyStats.high

  function purchaseCanvases() {
    const pageSize = 14
    const totalPages = Math.ceil(purchaseRows.length / pageSize)
    return Array.from({ length: totalPages }, (_, index) => purchasePage(purchaseRows.slice(index * pageSize, (index + 1) * pageSize), filterLabel, index + 1, totalPages))
  }

  async function exportPurchase(format) {
    if (!purchaseRows.length) return
    setExporting(format)
    const filename = `pedido-melhor-compra-${filterLabel.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'completo'}`
    try {
      if (format === 'excel') {
        const { default: ExcelJS } = await import('exceljs')
        const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Melhor compra')
        sheet.columns = [{ header: 'Código', key: 'codigo', width: 18 }, { header: 'Produto', key: 'produto', width: 42 }, { header: 'Qtd. original', key: 'quantidadeOriginal', width: 15 }, { header: 'Qtd. final', key: 'quantidadeFinal', width: 13 }, { header: 'Fornecedor', key: 'fornecedor', width: 22 }, { header: 'Preço unitário', key: 'unitario', width: 18 }, { header: 'Preço total', key: 'total', width: 18 }, { header: 'Ajuste manual', key: 'ajuste', width: 15 }, { header: 'Motivo', key: 'motivo', width: 28 }]
        purchaseRows.forEach((item) => sheet.addRow({ codigo: item.ean, produto: item.nome, quantidadeOriginal: item.quantidadeOriginal, quantidadeFinal: item.quantidadeFinal, fornecedor: item.fornecedorSelecionado, unitario: item.precoUnitario, total: item.precoTotal, ajuste: item.ajusteManual ? 'Sim' : 'Não', motivo: item.motivoAjuste }))
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEC0016' } }; sheet.views = [{ state: 'frozen', ySplit: 1 }]
        sheet.getColumn('unitario').numFmt = 'R$ #,##0.00'; sheet.getColumn('total').numFmt = 'R$ #,##0.00'
        const totalRow = sheet.addRow({ produto: `TOTAL - ${filterLabel}`, total }); totalRow.font = { bold: true }; totalRow.getCell('total').numFmt = 'R$ #,##0.00'
        saveBlob(new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filename}.xlsx`)
      } else {
        const pages = purchaseCanvases()
        if (format === 'pdf') saveBlob(await canvasesPdfBlob(pages), `${filename}.pdf`)
        else {
          const spacing = 28; const image = document.createElement('canvas'); image.width = pages[0].width; image.height = pages.reduce((height, page) => height + page.height, spacing * Math.max(0, pages.length - 1))
          const context = image.getContext('2d'); context.fillStyle = '#f7f2f3'; context.fillRect(0, 0, image.width, image.height)
          let y = 0; pages.forEach((page) => { context.drawImage(page, 0, y); y += page.height + spacing })
          saveBlob(await canvasBlob(image), `${filename}.png`)
        }
      }
    } catch (error) { setNotice(error.message || 'Não foi possível gerar a exportação.') }
    finally { setExporting('') }
  }

  return <main className="app-shell quote-shell"><div className="brand-glow brand-glow-one" /><div className="app-container">
    <header className="home-topbar"><button className="back-button" onClick={onBack}>← Todos os sistemas</button><div className="brand-logo-wrap"><img className="brand-logo" src="/drogaria-center-logo.png" alt="Drogaria Center" /></div></header>
    <section className="quote-heading"><div><p className="brand-kicker">Compras inteligentes</p><h1>Cotação de medicamentos</h1><p>Compare fornecedores, encontre o menor preço por item e monte um pedido de compra mais econômico.</p></div><span className="poster-live"><i />Dados salvos neste dispositivo</span></section>
    <section className="quote-actions no-print"><label className="quote-primary-button">{loading === 'cotacao' ? 'Lendo planilha...' : '↑ Importar fornecedor'}<input type="file" accept=".xls,.xlsx" onChange={(event) => startImport('cotacao', event.target.files?.[0])} /></label><label className="quote-secondary-button">{loading === 'pedido' ? 'Lendo planilha...' : '↑ Importar pedido'}<input type="file" accept=".xls,.xlsx" onChange={(event) => startImport('pedido', event.target.files?.[0])} /></label><DownloadCsv data={exportRows} name="cotacao_drogaria_center.csv">⇩ Exportar aba</DownloadCsv><button className="quote-danger-button" onClick={() => setClearOpen(true)}>Limpar dados</button></section>
    {notice && <div className="quote-notice" role="status">{notice}<button onClick={() => setNotice('')}>×</button></div>}
    {warnings.map((warning) => <div className="quote-warning" key={warning}>⚠ {warning}</div>)}
    {!tabs.length ? <section className="quote-empty"><span>⌁</span><h2>Comece por uma planilha</h2><p>Importe uma tabela de fornecedor e depois o seu pedido. O sistema permitirá conferir o mapeamento das colunas antes de salvar.</p></section> : <>
      <section className="quote-navigation no-print">
        {!!purchaseTabs.length && <div className="quote-purchase-nav"><div className="quote-nav-heading"><span className="section-kicker">Etapas da compra</span><small>Revise o pedido e confira a melhor combinação de preços.</small></div><nav>{purchaseTabs.map((tab) => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => { setActiveTab(tab.id); setSearch(''); setOnlyMissing(false); setOnlyAdjusted(false); setSupplierFilter('todos') }}><span className="quote-nav-icon">{tab.id === 'pedido' ? '▤' : '✓'}</span><span><b>{tab.label}</b><small>{tab.description}</small></span><em>{tab.count}</em></button>)}</nav></div>}
        {!!supplierTabs.length && <div className="quote-supplier-nav"><div className="quote-nav-heading"><span className="section-kicker">Fornecedores importados</span><small>Abra uma tabela para revisar, renomear ou excluir.</small></div><nav className="quote-tabs">{supplierTabs.map((tab) => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => { setActiveTab(tab.id); setSearch(''); setOnlyMissing(false); setOnlyAdjusted(false); setSupplierFilter('todos') }}>{tab.label}<span>{tab.count}</span></button>)}</nav></div>}
      </section>
      <section className="quote-content"><div className="quote-controls"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nome ou código..." />{activeTab === 'pedido' && <label className="quote-check"><input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} /> Apenas não encontrados</label>}{activeTab === 'resultado' && <><select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="todos">Todos os fornecedores</option>{supplierList.map((supplier) => <option key={supplier}>{supplier}</option>)}</select><label className="quote-check"><input type="checkbox" checked={onlyAdjusted} onChange={(event) => setOnlyAdjusted(event.target.checked)} /> Apenas ajustados</label>{historyCount > 0 && <><select className="quote-history-select" value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)} aria-label="Filtrar oportunidade de preço"><option value="all">Todos os itens ({baseResultRows.length})</option><option value="good">Comprando mais barato ({historyStats.good})</option><option value="stable">Mesmo preço ({historyStats.stable})</option><option value="high">Comprando mais caro ({historyStats.high})</option><option value="missing">Sem histórico ({historyStats.missing})</option></select><select className="quote-history-select" value={historySort} onChange={(event) => setHistorySort(event.target.value)} aria-label="Ordenar oportunidade de preço"><option value="default">Ordem do pedido</option><option value="worst">Pior → melhor oportunidade</option><option value="best">Melhor → pior oportunidade</option></select></>}{adjustedCount > 0 && <button type="button" className="quote-reset-button" onClick={() => setResetAdjustmentsOpen(true)}>↺ Restaurar cálculo</button>}</>}{activeSupplier && <div className="quote-supplier-actions"><button type="button" className="quote-secondary-button" onClick={() => openSupplierRename(activeSupplier)}>✎ Renomear</button><button type="button" className="quote-danger-button" onClick={() => setSupplierToRemove(activeSupplier)}>Excluir</button></div>}</div>
        {activeTab === 'pedido' && <><div className="quote-kpis"><div><small>Itens no pedido</small><b>{pedido.length}</b></div><div><small>Encontrados</small><b className="success">{resultado.filter((item) => item.status !== 'naoEncontrado').length}</b></div><div><small>Não encontrados</small><b className="danger">{resultado.filter((item) => item.status === 'naoEncontrado').length}</b></div></div><QuoteTable headers={['Código', 'Medicamento', 'Qtd. original', 'Qtd. final', 'Preferido', 'Status']} rows={pedidoRows.map((item) => [item.ean, item.nome, item.quantidadeOriginal, item.quantidadeFinal, item.fornecedorPreferido || 'Qualquer fornecedor', <PurchaseStatus item={item} />])} /></>}
        {activeTab === 'resultado' && <><div className="quote-kpis quote-purchase-kpis"><div className="highlight"><small>Total final</small><b>{formatBRL(total)}</b></div><div><small>Impacto dos ajustes</small><b className={adjustmentImpact > 0 ? 'danger' : adjustmentImpact < 0 ? 'success' : ''}>{adjustmentImpact > 0 ? '+' : ''}{formatBRL(adjustmentImpact)}</b></div><div><small>Ajustes manuais</small><b>{adjustedCount}</b></div><div><small>Itens para comprar</small><b>{purchaseRows.length}</b></div></div><div className="quote-history-panel no-print"><div><span className="section-kicker">Histórico de preço · opcional</span><b>{historyCount ? `${historyMatchedCount} comparados · ${historyStats.good} mais baratos · ${historyStats.high} mais caros${historyFilter !== 'all' ? ` · ${resultRows.length} exibidos` : ''}` : 'Compare a cotação com o último custo pago'}</b><small>{historyCount ? `${historicoInfo?.fileName || 'Planilha de estoque'} · ${historyCount} referências por EAN · os filtros de oportunidade não alteram totais ou exportações` : 'Envie o relatório de estoque depois de calcular a Melhor compra. Esta informação não entra nas exportações.'}</small></div><div><label className="quote-history-upload">{loading === 'historico' ? 'Lendo custos...' : historyCount ? '↥ Atualizar histórico' : '↥ Importar custo anterior'}<input type="file" accept=".xls,.xlsx" onChange={(event) => { startImport('historico', event.target.files?.[0]); event.target.value = '' }} /></label>{historyCount > 0 && <button type="button" className="quote-history-clear" onClick={clearPriceHistory}>Remover referência</button>}</div></div><div className="purchase-export no-print"><div><span className="section-kicker">Exportar melhor compra</span><b>Filtro atual: {filterLabel}{onlyAdjusted ? ' · apenas ajustados' : ''}</b></div><div><button type="button" disabled={!purchaseRows.length || exporting} onClick={() => exportPurchase('png')}>{exporting === 'png' ? 'Gerando...' : '⇩ Imagem PNG'}</button><button type="button" disabled={!purchaseRows.length || exporting} onClick={() => exportPurchase('pdf')}>{exporting === 'pdf' ? 'Gerando...' : '⇩ PDF'}</button><button type="button" disabled={!purchaseRows.length || exporting} onClick={() => exportPurchase('excel')}>{exporting === 'excel' ? 'Gerando...' : '⇩ Excel'}</button></div></div><QuoteTable headers={['Código', 'Medicamento', 'Quantidade', 'Fornecedor', 'Preço unit.', 'Histórico de preço', 'Preço total', 'Status', 'Ação']} rows={resultRows.map((item) => [item.ean, <div className="quote-product-cell"><b>{item.nome}</b>{item.motivoAjuste && <small>{item.motivoAjuste}</small>}</div>, item.ajusteManual && item.quantidadeOriginal !== item.quantidadeFinal ? <span className="quote-quantity-change"><s>{item.quantidadeOriginal}</s><b>{item.quantidadeFinal}</b></span> : item.quantidadeFinal, item.fornecedorSelecionado || '—', formatBRL(item.precoUnitario), <PriceHistoryCell item={item} reference={historicoPrecos[item.ean]} />, formatBRL(item.precoTotal), <PurchaseStatus item={item} />, <button type="button" className="quote-edit-row no-print" onClick={() => openPurchaseEdit(item)}>Editar</button>])} /><div className="quote-total"><b>Total: {formatBRL(total)}</b>{Object.entries(breakdown).map(([supplier, value]) => <span key={supplier}>{supplier}: {formatBRL(value)}</span>)}</div></>}
        {activeSupplier && <><div className="quote-kpis"><div><small>Produtos cotados</small><b>{supplierRows.length}</b></div><div><small>Usados no pedido</small><b className="success">{supplierRows.filter((item) => resultado.some((order) => order.ean === item.ean && normalizeHeader(order.fornecedorSelecionado) === normalizeHeader(activeSupplier))).length}</b></div></div><QuoteTable headers={['EAN', 'Descrição', 'Preço', 'Status']} rows={supplierRows.map((item) => [item.ean, item.nome, formatBRL(item.offer.precoUnitario), resultado.some((order) => order.ean === item.ean && normalizeHeader(order.fornecedorSelecionado) === normalizeHeader(activeSupplier)) ? <Status type="success">No pedido</Status> : <Status type="neutral">Não usado</Status>])} /></>}
      </section>
    </>}
    {mapping && <MappingDialog mapping={mapping} onChange={(key, value) => setMapping((current) => ({ ...current, values: { ...current.values, [key]: value } }))} onCancel={() => setMapping(null)} onConfirm={confirmMapping} />}
    {editingItem && <PurchaseEditDialog item={editingItem} offers={cotacoes[editingItem.ean]?.ofertas || []} draft={purchaseDraft} error={purchaseEditError} onChange={(key, value) => { setPurchaseDraft((current) => ({ ...current, [key]: value })); setPurchaseEditError('') }} onCancel={() => { setEditingLineId(''); setPurchaseEditError('') }} onSave={savePurchaseEdit} onRestore={() => restorePurchaseItem(editingItem.id)} />}
    {resetAdjustmentsOpen && <div className="quote-modal-backdrop"><section className="quote-modal"><span className="section-kicker">Restaurar cálculo</span><h2>Remover todos os ajustes manuais?</h2><p>Os fornecedores e as quantidades voltarão aos valores calculados automaticamente. O pedido e as tabelas importadas continuarão salvos.</p><div><button type="button" className="quote-secondary-button" onClick={() => setResetAdjustmentsOpen(false)}>Cancelar</button><button type="button" className="quote-danger-solid" onClick={restoreAllAdjustments}>Restaurar todos</button></div></section></div>}
    {supplierToRename && <div className="quote-modal-backdrop"><section className="quote-modal"><span className="section-kicker">Editar fornecedor</span><h2>Renomear {supplierToRename}</h2><p>O novo nome será aplicado às ofertas e às preferências existentes no pedido.</p><label className="quote-modal-field">Nome do fornecedor<input autoFocus value={supplierNameDraft} onChange={(event) => { setSupplierNameDraft(event.target.value); setSupplierRenameError('') }} onKeyDown={(event) => { if (event.key === 'Enter') renameSupplier() }} /></label>{supplierRenameError && <div className="quote-field-error" role="alert">{supplierRenameError}</div>}<div><button type="button" className="quote-secondary-button" onClick={() => { setSupplierToRename(''); setSupplierRenameError('') }}>Cancelar</button><button type="button" className="quote-primary-button" onClick={renameSupplier}>Salvar novo nome</button></div></section></div>}
    {supplierToRemove && <div className="quote-modal-backdrop"><section className="quote-modal"><h2>Excluir tabela de {supplierToRemove}?</h2><p>As ofertas desse fornecedor serão removidas da comparação. Seu pedido continuará salvo.</p><div><button type="button" className="quote-secondary-button" onClick={() => setSupplierToRemove('')}>Cancelar</button><button type="button" className="quote-danger-solid" onClick={() => removeSupplier(supplierToRemove)}>Excluir fornecedor</button></div></section></div>}
    {clearOpen && <div className="quote-modal-backdrop"><section className="quote-modal"><h2>Limpar dados?</h2><p>As cotações e o pedido salvos neste dispositivo serão apagados.</p><div><button className="quote-secondary-button" onClick={() => setClearOpen(false)}>Cancelar</button><button className="quote-danger-button" onClick={clearData}>Sim, limpar</button></div></section></div>}
    <footer className="app-footer"><img src="/drogaria-center-logo.png" alt="Drogaria Center" /><span>Cotações organizadas para uma compra mais eficiente.</span></footer>
  </div></main>
}

function PurchaseEditDialog({ item, offers, draft, error, onChange, onCancel, onSave, onRestore }) {
  const sortedOffers = [...offers].sort((first, second) => first.precoUnitario - second.precoUnitario)
  const bestPrice = sortedOffers[0]?.precoUnitario || 0
  const quantity = Number.isFinite(Number(draft.quantidade)) ? Math.max(0, Number(draft.quantidade)) : 0
  return <div className="quote-modal-backdrop"><section className="quote-modal quote-purchase-editor"><span className="section-kicker">Ajustar melhor compra</span><h2>{item.nome}</h2><p>Código {item.ean} · quantidade original {item.quantidadeOriginal}</p><label className="quote-modal-field">Quantidade final<input type="number" min="0" step="1" value={draft.quantidade} onChange={(event) => onChange('quantidade', event.target.value)} /></label><div className="quote-offer-heading"><b>Escolha o fornecedor</b><small>Ordenados pelo menor preço unitário.</small></div><div className="quote-offer-options">{sortedOffers.map((offer, index) => { const active = normalizeHeader(offer.fornecedor) === normalizeHeader(draft.fornecedor); const unitDifference = offer.precoUnitario - bestPrice; return <button type="button" key={offer.fornecedor} className={active ? 'active' : ''} onClick={() => onChange('fornecedor', offer.fornecedor)}><span><b>{offer.fornecedor}</b>{index === 0 && <em>Menor preço</em>}</span><span><strong>{formatBRL(offer.precoUnitario)}</strong><small>Total: {formatBRL(offer.precoUnitario * quantity)}</small></span><small className={unitDifference > 0 ? 'more-expensive' : ''}>{unitDifference > 0 ? `+${formatBRL(unitDifference)} por unidade · +${formatBRL(unitDifference * quantity)} no total` : 'Melhor valor disponível'}</small></button> })}</div><label className="quote-modal-field">Motivo do ajuste (opcional)<textarea value={draft.motivo} maxLength="160" placeholder="Ex.: fechar fatura deste fornecedor" onChange={(event) => onChange('motivo', event.target.value)} /></label><button type="button" className="quote-reason-suggestion" onClick={() => onChange('motivo', 'Fechar fatura')}>+ Fechar fatura</button>{error && <div className="quote-field-error" role="alert">{error}</div>}<div className="quote-editor-actions">{item.ajusteManual && <button type="button" className="quote-reset-item" onClick={onRestore}>↺ Restaurar automático</button>}<button type="button" className="quote-secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="quote-primary-button" onClick={onSave}>Salvar ajuste</button></div></section></div>
}

function PriceHistoryCell({ item, reference }) {
  if (!reference) return <span className="quote-history-missing">Sem referência por EAN</span>
  const comparison = evaluatePriceOpportunity(item.precoUnitario, reference.precoCusto)
  const percent = comparison?.percent === null || comparison?.percent === undefined ? '' : `${comparison.percent.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
  const detail = comparison?.type === 'good'
    ? `${formatBRL(comparison.difference)} abaixo · ${percent}`
    : comparison?.type === 'high'
      ? `${formatBRL(comparison.difference)} acima · ${percent}`
      : comparison ? 'Sem diferença' : 'Preço atual indisponível'
  return <div className="quote-history-cell" title={[reference.nome, reference.laboratorio].filter(Boolean).join(' · ')}><small>Último custo</small><b>{formatBRL(reference.precoCusto)}</b><span className={comparison?.type || 'missing'}><strong>{comparison?.label || 'Sem comparação'}</strong><em>{detail}</em></span></div>
}

function QuoteTable({ headers, rows }) { return <div className="quote-table-frame"><div><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length}>Nenhum registro corresponde ao filtro.</td></tr>}</tbody></table></div></div> }

function MappingDialog({ mapping, onChange, onCancel, onConfirm }) {
  const title = mapping.kind === 'cotacao' ? 'Tabela do fornecedor' : mapping.kind === 'historico' ? 'Histórico de preço de custo' : 'Tabela de pedido'
  const description = mapping.kind === 'historico' ? 'Confirme as colunas que identificam o EAN e o último valor pago.' : 'Confirme o mapeamento antes de importar.'
  return <div className="quote-modal-backdrop"><section className="quote-modal quote-mapping"><span className="section-kicker">Revisar importação</span><h2>{title}</h2><p>Encontramos {mapping.rows.length} linhas em <b>{mapping.fileName}</b>. {description}</p><div className="mapping-preview"><table><thead><tr>{mapping.headers.map((header, index) => <th key={index}>{header || `Col. ${index + 1}`}</th>)}</tr></thead><tbody>{mapping.rows.slice(0, 4).map((row, index) => <tr key={index}>{mapping.headers.map((_, column) => <td key={column}>{row[column]}</td>)}</tr>)}</tbody></table></div><div className="mapping-fields">{mapping.fields.map((field) => <label key={field.key}>{field.label}{field.required && ' *'}{field.type === 'text' ? <input value={mapping.values[field.key] ?? ''} onChange={(event) => onChange(field.key, event.target.value)} /> : <select value={mapping.values[field.key] ?? ''} onChange={(event) => onChange(field.key, event.target.value)}><option value="">Não usar</option>{mapping.headers.map((header, index) => <option value={index} key={index}>{header || `Coluna ${index + 1}`}</option>)}</select>}</label>)}</div><div className="quote-modal-actions"><button className="quote-secondary-button" onClick={onCancel}>Cancelar</button><button className="quote-primary-button" onClick={onConfirm}>Importar</button></div></section></div>
}
