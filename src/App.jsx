import { useEffect, useRef, useState } from 'react'
import CotacaoScreen from './CotacaoScreen.jsx'
import {
  extractPdfLines, formatMoney, operatorName, parseCieloLines, parsePagPixLines,
  parsePagPixSpreadsheet, parseTrierLines, parseTrierSpreadsheet, reconcile, STATUS_LABEL,
} from './reconciliation.js'

const EMPTY_FILES = { trier: null, pagpix: null, cielo: null, fechamento: null }
const SYSTEM_PATHS = { home: '/', trier: '/conciliacao-trier', cartazes: '/cartazes-oferta', cotacao: '/cotacao-medicamentos' }
const SOURCES = {
  trier: { title: 'Relação de Vendas (Trier)', hint: 'Base principal — obrigatório', color: 'bg-ink', step: '01', badge: 'Obrigatório' },
  pagpix: { title: 'Relatório Detalhado PaggPix', hint: 'Recebimentos PIX', color: 'bg-teal', step: '02', badge: 'PIX' },
  cielo: { title: 'Relatório Detalhado Cielo', hint: 'Recebimentos cartão', color: 'bg-amber', step: '03', badge: 'Cartão' },
  fechamento: { title: 'Fechamento de Caixa', hint: 'Opcional', color: 'bg-muted', step: '04', badge: 'Opcional' },
}

function systemFromPathname(pathname) {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  return Object.entries(SYSTEM_PATHS).find(([, path]) => path === normalizedPath)?.[0] || 'home'
}

function FileSlot({ source, file, onFile }) {
  const [reviewOpen, setReviewOpen] = useState(false)
  const input = useRef(null)
  const isPagPix = source.color === 'bg-teal'
  const isTrier = source.color === 'bg-ink'
  const acceptedFiles = isPagPix
    ? '.pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : isTrier ? '.pdf,.xls,application/pdf,application/vnd.ms-excel' : '.pdf,application/pdf'
  const uploadLabel = isPagPix ? 'Enviar PDF ou XLSX' : isTrier ? 'Enviar PDF ou XLS' : 'Enviar PDF'
  return <article className="upload-card">
    <div className={`upload-accent ${source.color}`} />
    <div className="upload-card-body">
      <div className="upload-meta"><span className="upload-step">{source.step}</span><span className={file ? 'upload-state loaded' : 'upload-state'}>{file ? 'Carregado' : source.badge}</span></div>
      <h2>{source.title}</h2>
      <p className="hint">{isPagPix ? `${source.hint} — PDF ou XLSX` : isTrier ? `${source.hint} — PDF ou XLS` : source.hint}</p>
      <input ref={input} className="hidden" type="file" accept={acceptedFiles} onChange={(event) => onFile(event.target.files?.[0])} />
      {!file ? <button className="dropzone" onClick={() => input.current?.click()}><span className="dropzone-icon">＋</span><span>{uploadLabel}</span><small>Toque para selecionar o arquivo</small></button> : <>
        <div className="loaded-file">
          <span className="loaded-file-icon">✓</span><b className="truncate">{file.fileName}</b><span className="text-muted whitespace-nowrap">{file.rows.length} linhas</span>
        </div>
        <div className="file-actions"><button className="swap-button" onClick={() => input.current?.click()}>Trocar arquivo</button><button className="review-button" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? 'Ocultar linhas' : 'Revisar extração'}</button></div>
        {reviewOpen && <div className="review-box">{file.lines.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}</div>}
      </>}
    </div>
  </article>
}

function StatusPill({ status }) { return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span> }

function columnFilter(rows, columns, filters) {
  return rows.filter((row) => columns.every((column) => {
    const filter = filters[column.key]?.trim().toLocaleLowerCase('pt-BR')
    return !filter || column.value(row).toLocaleLowerCase('pt-BR').includes(filter)
  }))
}

function FilterRow({ columns, rows, filters, onChange, tableId }) {
  return <tr className="filter-row no-print">{columns.map((column) => <th key={column.key}>
    <input
      aria-label={`Filtrar ${column.label}`}
      value={filters[column.key] ?? ''}
      list={`${tableId}-${column.key}-options`}
      placeholder="Selecionar ou digitar"
      onChange={(event) => onChange(column.key, event.target.value)}
    />
    <datalist id={`${tableId}-${column.key}-options`}>
      {[...new Set(rows.map(column.value).filter((value) => value && value !== '—'))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
        .map((value) => <option value={value} key={value} />)}
    </datalist>
  </th>)}</tr>
}

function SalesTable({ rows }) {
  const [filters, setFilters] = useState({})
  const columns = [
    { key: 'sale', label: 'Nº venda', value: (row) => row.sale.numero },
    { key: 'date', label: 'Data', value: (row) => row.sale.data },
    { key: 'saleTime', label: 'Hora venda', value: (row) => row.sale.hora || '—' },
    { key: 'operator', label: 'Operador', value: (row) => operatorName(row.sale.operador) },
    { key: 'method', label: 'Forma', value: (row) => row.sale.forma || '—' },
    { key: 'channel', label: 'Delivery/Balcão', value: (row) => row.sale.tele === 'Sim' ? 'Delivery' : 'Balcão' },
    { key: 'saleValue', label: 'Valor venda', value: (row) => formatMoney(row.sale.valor) },
    { key: 'receivedValue', label: 'Valor recebido', value: (row) => row.recebimento ? formatMoney(row.recebimento.valor) : '—' },
    { key: 'source', label: 'Origem', value: (row) => row.fonte || '—' },
    { key: 'receivedTime', label: 'Hora receb.', value: (row) => row.recebimento?.hora || '—' },
    { key: 'difference', label: 'Diferença', value: (row) => row.diff !== undefined ? formatMoney(row.diff) : '—' },
    { key: 'status', label: 'Status', value: (row) => STATUS_LABEL[row.status] },
  ]
  const filteredRows = columnFilter(rows, columns, filters)
  if (!rows.length) return <EmptyTable />
  return <><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} registro(s).</div><Table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr><FilterRow tableId="sales-filter" columns={columns} rows={rows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((row) => { const sale = row.sale; return <tr key={`${sale.numero}-${row.status}`}><td>{sale.numero}</td><td>{sale.data}</td><td>{sale.hora || '—'}</td><td>{operatorName(sale.operador)}</td><td>{sale.forma || '—'}</td><td>{sale.tele === 'Sim' ? 'Delivery' : 'Balcão'}</td><td>{formatMoney(sale.valor)}</td><td>{row.recebimento ? formatMoney(row.recebimento.valor) : '—'}</td><td>{row.fonte || '—'}</td><td>{row.recebimento?.hora || '—'}</td><td>{row.diff !== undefined ? formatMoney(row.diff) : '—'}</td><td><StatusPill status={row.status} /></td></tr> })}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={columns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table></>
}

function NoSaleTable({ rows }) {
  const [filters, setFilters] = useState({})
  const columns = [
    { key: 'source', label: 'Origem', value: (row) => row.fonte },
    { key: 'date', label: 'Data', value: (row) => row.data },
    { key: 'time', label: 'Hora', value: (row) => row.hora || '—' },
    { key: 'operator', label: 'Operador', value: (row) => operatorName(row.operador) },
    { key: 'type', label: 'Tipo/Bandeira', value: (row) => row.tipo || row.bandeira || '—' },
    { key: 'value', label: 'Valor', value: (row) => formatMoney(row.valor) },
    { key: 'status', label: 'Status', value: (row) => STATUS_LABEL[row.status] },
  ]
  const filteredRows = columnFilter(rows, columns, filters)
  if (!rows.length) return <EmptyTable />
  return <><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} registro(s).</div><Table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr><FilterRow tableId="no-sale-filter" columns={columns} rows={rows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((row, index) => <tr key={`${row.fonte}-${row.data}-${row.hora}-${index}`}><td>{row.fonte}</td><td>{row.data}</td><td>{row.hora || '—'}</td><td>{operatorName(row.operador)}</td><td>{row.tipo || row.bandeira || '—'}</td><td>{formatMoney(row.valor)}</td><td><StatusPill status={row.status} /></td></tr>)}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={columns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table></>
}

function Table({ children }) { return <div className="table-frame"><div className="table-scroll"><table>{children}</table></div></div> }
function EmptyTable() { return <div className="table-frame p-7 text-center text-sm text-muted">Nada nessa categoria.</div> }

function exportRows(output) {
  return [
    ...output.results.map((row) => ({
      'Número da venda': row.sale.numero, Data: row.sale.data, 'Hora da venda': row.sale.hora || '', Operador: operatorName(row.sale.operador), 'Forma de pagamento': row.sale.forma || '', 'Delivery/Balcão': row.sale.tele === 'Sim' ? 'Delivery' : 'Balcão', 'Valor da venda': row.sale.valor, 'Valor recebido': row.recebimento?.valor ?? '', Origem: row.fonte || '', 'Hora do recebimento': row.recebimento?.hora || '', 'Diferença de valor': row.diff ?? '', Status: STATUS_LABEL[row.status],
    })),
    ...output.semVenda.map((row) => ({
      'Número da venda': '', Data: row.data, 'Hora da venda': '', Operador: operatorName(row.operador), 'Forma de pagamento': '', 'Delivery/Balcão': row.tipo || row.bandeira || '', 'Valor da venda': '', 'Valor recebido': row.valor, Origem: row.fonte, 'Hora do recebimento': row.hora || '', 'Diferença de valor': '', Status: STATUS_LABEL[row.status],
    })),
  ]
}

function downloadCsv(output) {
  const rows = exportRows(output); if (!rows.length) return
  const headers = Object.keys(rows[0]); const content = [headers.join(';'), ...rows.map((row) => headers.map((key) => String(row[key]).replace(/;/g, ',')).join(';'))].join('\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'concilia_trier.csv' }); link.click(); URL.revokeObjectURL(url)
}

async function downloadExcel(output) {
  const rows = exportRows(output); if (!rows.length) return
  const { default: ExcelJS } = await import('exceljs')
  const headers = Object.keys(rows[0])
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Conciliação')
  sheet.columns = headers.map((header) => ({ header, key: header, width: Math.max(header.length + 2, 18) }))
  rows.forEach((row) => sheet.addRow(row))
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  const data = await workbook.xlsx.writeBuffer()
  const url = URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'concilia_trier.xlsx' })
  link.click()
  URL.revokeObjectURL(url)
}

function HomeScreen({ onSelect }) {
  return <main className="app-shell home-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="home-topbar"><div className="brand-logo-wrap"><img className="brand-logo" src="/drogaria-center-logo.png" alt="Drogaria Center" /></div><div className="local-chip home-chip"><span />Sistemas internos</div></header>
    <section className="home-hero"><p className="brand-kicker">Drogaria Center</p><h1>Olá! O que vamos<br />fazer hoje?</h1><p>Escolha uma ferramenta para começar. Tudo foi pensado para tornar a rotina da farmácia mais simples.</p></section>
    <section className="system-grid" aria-label="Sistemas disponíveis">
      <button className="system-card system-card-reconcile" onClick={() => onSelect('trier')}><span className="system-icon" aria-hidden="true">↔</span><span className="system-label">Financeiro</span><strong>Conciliação Trier</strong><small>Compare vendas, PIX e cartões em um só lugar.</small><span className="system-action">Abrir conciliação <b aria-hidden="true">→</b></span></button>
      <button className="system-card system-card-posters" onClick={() => onSelect('cartazes')}><span className="system-icon" aria-hidden="true">✦</span><span className="system-label">Comunicação visual</span><strong>Cartazes de oferta</strong><small>Crie cartazes prontos para imprimir e expor na farmácia.</small><span className="system-action">Criar cartazes <b aria-hidden="true">→</b></span></button>
      <button className="system-card system-card-quotes" onClick={() => onSelect('cotacao')}><span className="system-icon" aria-hidden="true">⌁</span><span className="system-label">Compras</span><strong>Cotação de medicamentos</strong><small>Compare fornecedores e escolha o melhor preço para cada item do pedido.</small><span className="system-action">Abrir cotação <b aria-hidden="true">→</b></span></button>
    </section>
    <p className="home-support">Mais ferramentas serão adicionadas aqui conforme a operação da Drogaria Center evoluir.</p>
    <footer className="app-footer"><img src="/drogaria-center-logo.png" alt="Drogaria Center" /><span>Ferramentas simples para a rotina da farmácia.</span></footer>
  </div></main>
}

function priceParts(value) {
  const rawValue = String(value ?? '').replace(/[^\d,.-]/g, '')
  const normalizedValue = rawValue.includes(',') && rawValue.includes('.')
    ? rawValue.replace(/\./g, '').replace(',', '.')
    : rawValue.replace(',', '.')
  const numeric = Number(normalizedValue)
  const [whole, cents] = (Number.isFinite(numeric) ? numeric : 0).toFixed(2).split('.')
  return { whole, cents }
}

function titleLines(context, title, maxWidth) {
  const words = (title || 'PRODUTO EM OFERTA').trim().toUpperCase().split(/\s+/)
  return words.reduce((lines, word) => {
    const currentLine = lines.at(-1) || ''
    const candidate = currentLine ? `${currentLine} ${word}` : word
    if (context.measureText(candidate).width <= maxWidth || !currentLine) lines[lines.length - 1] = candidate
    else lines.push(word)
    return lines
  }, [''])
}

function drawPoster(canvas, background, values) {
  canvas.width = background.naturalWidth || 1334
  canvas.height = background.naturalHeight || 2000
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(background, 0, 0, canvas.width, canvas.height)

  const scale = canvas.width / 1334
  const x = (value) => value * scale
  const y = (value) => value * scale
  const titleWidth = x(1110)
  let fontSize = x(106)
  let lines = []
  while (fontSize >= x(55)) {
    context.font = `900 ${fontSize}px Arial, sans-serif`
    lines = titleLines(context, values.product, titleWidth)
    if (lines.length <= 3) break
    fontSize -= x(5)
  }
  const lineHeight = fontSize * .95
  const titleCenter = y(500)
  context.fillStyle = '#4a4210'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  lines.slice(0, 3).forEach((line, index) => context.fillText(line, canvas.width / 2, titleCenter + (index - (Math.min(lines.length, 3) - 1) / 2) * lineHeight))

  const oldPrice = priceParts(values.oldPrice)
  const currentPrice = priceParts(values.price)
  context.fillStyle = '#e6001a'
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  context.font = `900 ${x(66)}px Arial, sans-serif`
  context.fillText(`DE: R$${oldPrice.whole},${oldPrice.cents}`, x(270), y(850))
  context.font = `900 ${x(72)}px Arial Narrow, Arial, sans-serif`
  context.fillText('POR:', x(285), y(1025))
  context.font = `900 ${x(152)}px Arial Narrow, Arial, sans-serif`
  const priceSizes = currentPrice.whole.length === 1 ? { main: 600, currency: 152, cents: 220 } : currentPrice.whole.length === 2 ? { main: 440, currency: 130, cents: 176 } : { main: 330, currency: 110, cents: 145 }
  const gap = x(22)
  const maxPriceWidth = canvas.width * .88
  const priceWidth = (multiplier = 1) => {
    context.font = `900 ${x(priceSizes.currency * multiplier)}px Arial Narrow, Arial, sans-serif`
    const currencyWidth = context.measureText('R$').width
    context.font = `900 ${x(priceSizes.main * multiplier)}px Arial Narrow, Arial, sans-serif`
    const wholeWidth = context.measureText(currentPrice.whole).width
    context.font = `900 ${x(priceSizes.cents * multiplier)}px Arial Narrow, Arial, sans-serif`
    const centsWidth = context.measureText(`,${currentPrice.cents}`).width
    return { currencyWidth, wholeWidth, centsWidth, total: currencyWidth + wholeWidth + centsWidth + gap * 2 }
  }
  let textMetrics = priceWidth()
  const shrink = Math.min(1, maxPriceWidth / textMetrics.total)
  if (shrink < 1) textMetrics = priceWidth(shrink)
  const startPrice = (canvas.width - textMetrics.total) / 2
  context.textAlign = 'left'
  context.font = `900 ${x(priceSizes.currency * shrink)}px Arial Narrow, Arial, sans-serif`
  context.fillText('R$', startPrice, y(1265))
  context.font = `900 ${x(priceSizes.main * shrink)}px Arial Narrow, Arial, sans-serif`
  context.fillText(currentPrice.whole, startPrice + textMetrics.currencyWidth + gap, y(1460))
  context.textAlign = 'left'
  context.font = `900 ${x(priceSizes.cents * shrink)}px Arial Narrow, Arial, sans-serif`
  context.fillText(`,${currentPrice.cents}`, startPrice + textMetrics.currencyWidth + gap + textMetrics.wholeWidth + gap, y(1390))
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Não foi possível gerar o arquivo.')), type, quality))
}

function mergeBytes(chunks) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  chunks.forEach((chunk) => { merged.set(chunk, offset); offset += chunk.length })
  return merged
}

async function postersPdfBlob(canvases) {
  const encode = (text) => new TextEncoder().encode(text)
  const images = await Promise.all(canvases.map(async (canvas) => ({ canvas, jpeg: new Uint8Array(await (await canvasBlob(canvas, 'image/jpeg', .96)).arrayBuffer()) })))
  let nextObject = 3
  const pages = images.map((image) => ({ ...image, pageObject: nextObject++, contentObject: nextObject++, imageObject: nextObject++ }))
  const objects = [
    { id: 1, value: encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n') },
    { id: 2, value: encode(`2 0 obj\n<< /Type /Pages /Kids [${pages.map((page) => `${page.pageObject} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`) },
  ]
  pages.forEach((page) => {
    const pageWidth = 720
    const pageHeight = Math.round(pageWidth * page.canvas.height / page.canvas.width)
    const content = encode(`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Poster${page.imageObject} Do\nQ\n`)
    objects.push(
      { id: page.pageObject, value: encode(`${page.pageObject} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Poster${page.imageObject} ${page.imageObject} 0 R >> >> /Contents ${page.contentObject} 0 R >>\nendobj\n`) },
      { id: page.contentObject, value: mergeBytes([encode(`${page.contentObject} 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, encode('endstream\nendobj\n')]) },
      { id: page.imageObject, value: mergeBytes([encode(`${page.imageObject} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.canvas.width} /Height ${page.canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, encode('\nendstream\nendobj\n')]) },
    )
  })
  objects.sort((first, second) => first.id - second.id)
  const header = encode('%PDF-1.4\n')
  const offsets = []
  let position = header.length
  objects.forEach((object) => { offsets.push(position); position += object.value.length })
  const xrefPosition = position
  const xref = encode(`xref\n0 ${nextObject}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${nextObject} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`)
  return new Blob([header, ...objects.map((object) => object.value), xref], { type: 'application/pdf' })
}

function offerLayout(itemsPerPage) {
  const layouts = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2], 9: [3, 3], 12: [4, 3] }
  const [columns, rows] = layouts[itemsPerPage] || layouts[8]
  return { columns, rows }
}

function drawOfferPage(canvas, background, offers, itemsPerPage) {
  const { columns, rows } = offerLayout(itemsPerPage)
  const pageWidth = 1800
  const cellWidth = pageWidth / columns
  const cellHeight = cellWidth * 1.5
  const gap = Math.max(10, Math.round(cellWidth * .018))
  canvas.width = pageWidth
  canvas.height = Math.round(cellHeight * rows)
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  offers.forEach((offer, index) => {
    const poster = document.createElement('canvas')
    drawPoster(poster, background, offer)
    const column = index % columns
    const row = Math.floor(index / columns)
    const destinationX = column * cellWidth + gap / 2
    const destinationY = row * cellHeight + gap / 2
    context.drawImage(poster, destinationX, destinationY, cellWidth - gap, cellHeight - gap)
  })
}

function normalizeSpreadsheetText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
}

function offersFromSpreadsheet(XLSX, workbook) {
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' })
    const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeSpreadsheetText(cell).includes('produto')) && row.some((cell) => normalizeSpreadsheetText(cell).includes('promocao')))
    if (headerIndex < 0) continue
    const headers = rows[headerIndex].map(normalizeSpreadsheetText)
    const productColumn = headers.findIndex((header) => header.includes('produto'))
    const promotionColumn = headers.findIndex((header) => header.includes('promocao'))
    const normalPriceColumn = headers.findIndex((header) => header.includes('preco normal') || header.includes('valor normal'))
    if (productColumn < 0 || promotionColumn < 0 || normalPriceColumn < 0) continue
    const offers = rows.slice(headerIndex + 1).map((row) => ({ product: String(row[productColumn] ?? '').trim(), price: row[promotionColumn], oldPrice: row[normalPriceColumn] })).filter((offer) => offer.product && offer.price !== '')
    if (offers.length) return offers
  }
  throw new Error('Não encontrei as colunas Produto, Vlr.Promoção e Preço Normal no XLS.')
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click()
  URL.revokeObjectURL(url)
}

function CartazesScreen({ onBack }) {
  const canvasRef = useRef(null)
  const batchCanvasRef = useRef(null)
  const [background, setBackground] = useState(null)
  const [renderError, setRenderError] = useState('')
  const [mode, setMode] = useState('individual')
  const [values, setValues] = useState({ product: 'SONRIDOR RAPID+FORTE 4CP REV', oldPrice: '7,99', price: '1,99' })
  const [batchOffers, setBatchOffers] = useState([])
  const [batchFileName, setBatchFileName] = useState('')
  const [itemsPerPage, setItemsPerPage] = useState(8)
  const [batchPage, setBatchPage] = useState(0)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchExporting, setBatchExporting] = useState(false)

  useEffect(() => {
    const image = new Image()
    image.onload = () => setBackground(image)
    image.onerror = () => setRenderError('Não foi possível carregar o modelo oficial do cartaz.')
    image.src = '/oferta-background.png'
  }, [])

  useEffect(() => {
    if (background && canvasRef.current) drawPoster(canvasRef.current, background, values)
  }, [background, values])

  const totalBatchPages = Math.max(1, Math.ceil(batchOffers.length / itemsPerPage))
  const visibleBatchOffers = batchOffers.slice(batchPage * itemsPerPage, (batchPage + 1) * itemsPerPage)

  useEffect(() => {
    if (batchPage >= totalBatchPages) setBatchPage(Math.max(0, totalBatchPages - 1))
  }, [batchPage, totalBatchPages])

  useEffect(() => {
    if (background && visibleBatchOffers.length && batchCanvasRef.current) drawOfferPage(batchCanvasRef.current, background, visibleBatchOffers, itemsPerPage)
  }, [background, visibleBatchOffers, itemsPerPage])

  async function downloadPoster(format) {
    try {
      const canvas = canvasRef.current
      if (!canvas || !background) return
      const productSlug = values.product.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'oferta'
      if (format === 'pdf') saveBlob(await postersPdfBlob([canvas]), `cartaz-${productSlug}.pdf`)
      else saveBlob(await canvasBlob(canvas, format === 'png' ? 'image/png' : 'image/jpeg', .96), `cartaz-${productSlug}.${format === 'png' ? 'png' : 'jpg'}`)
    } catch (exception) { setRenderError(exception.message || 'Não foi possível baixar o cartaz.') }
  }

  async function importOffers(file) {
    if (!file) return
    setRenderError('')
    setBatchLoading(true)
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const offers = offersFromSpreadsheet(XLSX, workbook)
      setBatchOffers(offers)
      setBatchFileName(file.name)
      setBatchPage(0)
      setMode('batch')
    } catch (exception) { setRenderError(exception.message || 'Não foi possível ler o XLS enviado.') }
    finally { setBatchLoading(false) }
  }

  function createBatchPages() {
    return Array.from({ length: totalBatchPages }, (_, index) => {
      const page = document.createElement('canvas')
      drawOfferPage(page, background, batchOffers.slice(index * itemsPerPage, (index + 1) * itemsPerPage), itemsPerPage)
      return page
    })
  }

  async function downloadBatch(format) {
    try {
      if (!background || !visibleBatchOffers.length) return
      setBatchExporting(true)
      if (format === 'pdf') saveBlob(await postersPdfBlob(createBatchPages()), `cartazes-oferta-${batchOffers.length}-itens.pdf`)
      else saveBlob(await canvasBlob(batchCanvasRef.current, 'image/png'), `cartazes-oferta-pagina-${batchPage + 1}.png`)
    } catch (exception) { setRenderError(exception.message || 'Não foi possível gerar o arquivo do lote.') }
    finally { setBatchExporting(false) }
  }

  return <main className="app-shell home-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="home-topbar"><button className="back-button" onClick={onBack}>← Todos os sistemas</button><div className="brand-logo-wrap"><img className="brand-logo" src="/drogaria-center-logo.png" alt="Drogaria Center" /></div></header>
    <section className="poster-heading"><div><p className="brand-kicker">Comunicação visual</p><h1>Gerador de cartazes de oferta</h1><p>Crie um cartaz individual ou importe uma planilha para montar várias ofertas de uma vez.</p></div><span className="poster-live"><i />Prévia ao vivo</span></section>
    <div className="poster-mode-toggle" role="tablist" aria-label="Modo de criação"><button role="tab" aria-selected={mode === 'individual'} className={mode === 'individual' ? 'active' : ''} onClick={() => setMode('individual')}>Cartaz individual</button><button role="tab" aria-selected={mode === 'batch'} className={mode === 'batch' ? 'active' : ''} onClick={() => setMode('batch')}>Lote por XLS</button></div>
    {mode === 'individual' ? <section className="poster-studio"><form className="poster-form" onSubmit={(event) => event.preventDefault()}><div className="poster-form-title"><span className="future-icon" aria-hidden="true">✦</span><div><span className="section-kicker">Dados da oferta</span><h2>Monte seu cartaz</h2></div></div><label>Nome do produto<textarea value={values.product} maxLength="70" onChange={(event) => setValues((current) => ({ ...current, product: event.target.value }))} placeholder="Ex.: SONRIDOR RAPID+FORTE 4CP REV" /></label><div className="price-fields"><label>Preço anterior<input inputMode="decimal" value={values.oldPrice} onChange={(event) => setValues((current) => ({ ...current, oldPrice: event.target.value }))} placeholder="7,99" /></label><label>Preço da oferta<input inputMode="decimal" value={values.price} onChange={(event) => setValues((current) => ({ ...current, price: event.target.value }))} placeholder="1,99" /></label></div><p className="poster-tip">Use vírgula para os centavos. O cartaz segue o modelo oficial enviado.</p><div className="download-actions"><button type="button" disabled={!background} onClick={() => downloadPoster('pdf')}>⇩ Baixar PDF</button><button type="button" disabled={!background} onClick={() => downloadPoster('png')}>⇩ Baixar PNG</button><button type="button" disabled={!background} onClick={() => downloadPoster('jpg')}>⇩ Baixar JPG</button></div>{renderError && <p className="poster-error" role="alert">{renderError}</p>}</form><section className="poster-preview-panel"><div className="poster-preview-label"><span>Prévia para impressão</span><small>Formato vertical</small></div><div className="poster-canvas-wrap"><canvas ref={canvasRef} aria-label="Prévia do cartaz de oferta" /></div></section></section> : <section className="poster-studio batch-studio"><form className="poster-form" onSubmit={(event) => event.preventDefault()}><div className="poster-form-title"><span className="future-icon" aria-hidden="true">▦</span><div><span className="section-kicker">Lote de ofertas</span><h2>Importe sua planilha</h2></div></div><label className="batch-upload">{batchLoading ? 'Lendo a planilha...' : 'Selecionar arquivo XLS ou XLSX'}<input type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => importOffers(event.target.files?.[0])} /></label>{batchFileName && <div className="batch-file-status"><b>{batchFileName}</b><span>{batchOffers.length} ofertas identificadas</span></div>}<label className="items-per-page">Cartazes por página<select value={itemsPerPage} onChange={(event) => { setItemsPerPage(Number(event.target.value)); setBatchPage(0) }}><option value="1">1 por página</option><option value="2">2 por página</option><option value="4">4 por página</option><option value="6">6 por página</option><option value="8">8 por página (referência)</option><option value="9">9 por página</option><option value="12">12 por página</option></select></label><p className="poster-tip">O XLS enviado foi reconhecido pelas colunas Produto, Vlr.Promoção e Preço Normal.</p><div className="download-actions"><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('pdf')}>{batchExporting ? 'Gerando arquivo...' : '⇩ Baixar PDF completo'}</button><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('png')}>⇩ Baixar PNG da página</button></div>{renderError && <p className="poster-error" role="alert">{renderError}</p>}</form><section className="poster-preview-panel"><div className="poster-preview-label"><span>Prévia do lote</span><small>{batchOffers.length ? `Página ${batchPage + 1} de ${totalBatchPages}` : 'Aguardando planilha'}</small></div>{batchOffers.length ? <><div className="poster-canvas-wrap batch-canvas-wrap"><canvas ref={batchCanvasRef} aria-label="Prévia da página de cartazes" /></div><div className="batch-pagination"><button type="button" disabled={batchPage === 0} onClick={() => setBatchPage((page) => page - 1)}>← Anterior</button><span>{visibleBatchOffers.length} cartazes nesta página</span><button type="button" disabled={batchPage + 1 >= totalBatchPages} onClick={() => setBatchPage((page) => page + 1)}>Próxima →</button></div></> : <div className="batch-empty"><span>▦</span><b>Envie uma planilha para visualizar o lote.</b><small>Você poderá escolher quantos cartazes saem em cada página.</small></div>}</section></section>}
    <footer className="app-footer"><img src="/drogaria-center-logo.png" alt="Drogaria Center" /><span>Cartazes de oferta prontos para imprimir.</span></footer>
  </div></main>
}

export default function App() {
  const [activeSystem, setActiveSystem] = useState(() => systemFromPathname(window.location.pathname))
  const [files, setFiles] = useState(EMPTY_FILES)
  const [toleranceValue, setToleranceValue] = useState(0.5)
  const [toleranceHours, setToleranceHours] = useState(2)
  const [output, setOutput] = useState(null)
  const [tab, setTab] = useState('resumo')
  const [error, setError] = useState('')
  const canRun = files.trier && (files.pagpix || files.cielo)

  async function handleFile(key, file) {
    if (!file) return
    setError('')
    try {
      const isPagPixSpreadsheet = key === 'pagpix' && /\.xlsx$/i.test(file.name)
      const isTrierSpreadsheet = key === 'trier' && /\.xls$/i.test(file.name)
      const spreadsheetRows = isPagPixSpreadsheet
        ? await parsePagPixSpreadsheet(file)
        : isTrierSpreadsheet ? await parseTrierSpreadsheet(file) : null
      const lines = spreadsheetRows ? spreadsheetRows.map((row) => row.raw) : await extractPdfLines(file)
      const rows = spreadsheetRows ?? (key === 'trier' ? parseTrierLines(lines) : key === 'pagpix' ? parsePagPixLines(lines) : key === 'cielo' ? parseCieloLines(lines) : [])
      setFiles((previous) => ({ ...previous, [key]: { fileName: file.name, lines, rows } }))
      setOutput(null)
      if (!lines.length) setError(`Não consegui extrair nenhum texto de “${file.name}”. Se for um PDF escaneado (imagem), será necessário OCR.`)
      else if (key !== 'fechamento' && !rows.length) setError(`Li ${lines.length} linhas de “${file.name}”, mas não reconheci registros no formato esperado. Abra “Ver linhas extraídas” para revisar o conteúdo.`)
    } catch (exception) { setError(`Não consegui ler “${file.name}”. Confira se é um PDF válido e contém texto. Detalhe: ${exception.message || exception}`) }
  }

  function runReconciliation() {
    setError('')
    try { setOutput(reconcile(files, Number(toleranceValue) || 0, Number(toleranceHours) || 0)); setTab('resumo') }
    catch (exception) { setOutput(null); setError(exception.message) }
  }

  const results = output?.results ?? []; const noSale = output?.semVenda ?? []
  const accounting = results.filter((row) => row.status !== 'DEVOLUCAO')
  const counts = {
    total: accounting.length, pix: accounting.filter((row) => row.sale.forma === 'PIX').length, card: accounting.filter((row) => row.sale.forma === 'CARTAO').length, reconciled: accounting.filter((row) => row.status === 'CONCILIADA').length, missing: accounting.filter((row) => row.status === 'SEM_RECEBIMENTO').length, divergent: accounting.filter((row) => row.status === 'DIVERGENCIA').length, pixNoSale: noSale.filter((row) => row.fonte === 'PaggPix').length, cardNoSale: noSale.filter((row) => row.fonte === 'Cielo').length, duplicates: noSale.filter((row) => row.status === 'DUPLICADO').length, returns: results.filter((row) => row.status === 'DEVOLUCAO').length,
  }
  const totalValue = accounting.reduce((sum, row) => sum + row.sale.valor, 0)
  const matchedValue = accounting.filter((row) => ['CONCILIADA', 'DIVERGENCIA'].includes(row.status)).reduce((sum, row) => sum + row.sale.valor, 0)
  const divergentValue = accounting.filter((row) => row.status === 'DIVERGENCIA').reduce((sum, row) => sum + Math.abs(row.diff), 0)
  const kpis = [['Total de vendas', counts.total], ['Vendas PIX', counts.pix], ['Vendas cartão', counts.card], ['Conciliadas', counts.reconciled], ['Não conciliadas', counts.missing], ['PIX sem venda', counts.pixNoSale], ['Cartão sem venda', counts.cardNoSale], ['Recebimentos duplicados', counts.duplicates], ['Valor conciliado', formatMoney(matchedValue)], ['Valor divergente', formatMoney(divergentValue)], ['% conciliação', `${totalValue ? ((matchedValue / totalValue) * 100).toFixed(1) : '0.0'}%`]]
  const tabs = [['resumo', 'Resumo'], ['conciliada', `Conciliadas (${counts.reconciled})`], ['divergencia', `Divergências (${counts.divergent})`], ['sem_recebimento', `Sem recebimento (${counts.missing})`], ['sem_venda', `Sem venda (${noSale.length})`], ...(counts.returns ? [['devolucao', `Devoluções (${counts.returns})`]] : [])]

  useEffect(() => {
    const syncWithBrowserNavigation = () => setActiveSystem(systemFromPathname(window.location.pathname))
    window.addEventListener('popstate', syncWithBrowserNavigation)
    return () => window.removeEventListener('popstate', syncWithBrowserNavigation)
  }, [])

  function navigateTo(system) {
    const path = SYSTEM_PATHS[system]
    if (window.location.pathname !== path) window.history.pushState({ system }, '', path)
    setActiveSystem(system)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (activeSystem === 'home') return <HomeScreen onSelect={navigateTo} />
  if (activeSystem === 'cartazes') return <CartazesScreen onBack={() => navigateTo('home')} />
  if (activeSystem === 'cotacao') return <CotacaoScreen onBack={() => navigateTo('home')} />

  return <main className="app-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="brand-header">
      <div className="brand-topline"><div className="brand-logo-wrap"><img className="brand-logo" src="/drogaria-center-logo.png" alt="Drogaria Center" /></div><div className="local-chip"><span />Processamento local</div></div>
      <div className="brand-content"><button className="back-button no-print" onClick={() => navigateTo('home')}>← Todos os sistemas</button><p className="brand-kicker">Conciliação financeira</p><h1>Vendas e recebimentos,<br />lado a lado.</h1><p className="sub">Cruze os relatórios Trier, PaggPix e Cielo com rapidez e encontre diferenças antes do fechamento.</p></div>
      <div className="hero-mark" aria-hidden="true">+</div>
    </header>
    <section className="section-heading no-print"><div><span className="section-kicker">Etapa 1</span><h2>Importe os relatórios</h2><p>Comece pela Relação de Vendas e adicione pelo menos uma fonte de recebimentos.</p></div><div className="privacy-note"><span>✓</span> Seus arquivos não saem deste dispositivo</div></section>
    <section className="no-print upload-grid">{Object.entries(SOURCES).map(([key, source]) => <FileSlot key={key} source={source} file={files[key]} onFile={(file) => handleFile(key, file)} />)}</section>
    {error && <div role="alert" className="error-box">{error}</div>}
    <section className="no-print controls"><div className="controls-title"><span className="section-kicker">Etapa 2</span><strong>Defina as tolerâncias</strong></div><label>Tolerância de valor (R$)<input type="number" min="0" step="0.1" value={toleranceValue} onChange={(event) => setToleranceValue(event.target.value)} /></label><label>Tolerância de horário (h)<input type="number" min="0" step="0.5" value={toleranceHours} onChange={(event) => setToleranceHours(event.target.value)} /></label><button className="primary-button" disabled={!canRun} onClick={runReconciliation}><span>Executar conciliação</span><b aria-hidden="true">→</b></button></section>
    {output && <section className="results-section"><div className="results-heading"><span className="section-kicker">Etapa 3</span><h2>Resultado da conciliação</h2><p>Revise os indicadores e filtre cada coluna para investigar os registros.</p></div><div className="kpi-grid">{kpis.map(([label, value]) => <div className="kpi" key={label}><div>{label}</div><strong>{value}</strong></div>)}</div>
      <div className="no-print tabs"><div className="tab-list">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>{label}</button>)}</div><div className="export-list"><button onClick={() => downloadCsv(output)}>⇩ CSV</button><button onClick={() => downloadExcel(output)}>⇩ Excel</button><button onClick={() => window.print()}>⇩ PDF</button></div></div>
      {tab === 'resumo' && <div className="summary-card">Das <b>{counts.total}</b> vendas eletrônicas da Relação de Vendas, <b className="text-green">{counts.reconciled}</b> foram conciliadas, <b className="text-amber">{counts.divergent}</b> tiveram divergência de valor dentro da tolerância e <b className="text-rust">{counts.missing}</b> não encontraram recebimento correspondente.{noSale.length > 0 && <><br /><br />Também foram encontrados <b className="text-rust">{noSale.length}</b> recebimentos sem venda correspondente, sendo <b>{counts.duplicates}</b> identificados como possível duplicidade.</>}{counts.returns > 0 && <><br /><br /><b>{counts.returns}</b> linha(s) de devolução não entraram na conciliação, pois não representam recebimento a buscar.</>}<br /><br />Use as abas para revisar cada grupo ou exporte a tabela final em Excel, CSV ou PDF.</div>}
      {tab === 'conciliada' && <SalesTable rows={results.filter((row) => row.status === 'CONCILIADA')} />}{tab === 'divergencia' && <SalesTable rows={results.filter((row) => row.status === 'DIVERGENCIA')} />}{tab === 'sem_recebimento' && <SalesTable rows={results.filter((row) => row.status === 'SEM_RECEBIMENTO')} />}{tab === 'devolucao' && <SalesTable rows={results.filter((row) => row.status === 'DEVOLUCAO')} />}{tab === 'sem_venda' && <NoSaleTable rows={noSale} />}
    </section>}
    <footer className="app-footer"><img src="/drogaria-center-logo.png" alt="Drogaria Center" /><span>Conciliação segura, simples e local.</span></footer>
  </div></main>
}
