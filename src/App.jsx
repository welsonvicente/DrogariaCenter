import { useEffect, useRef, useState } from 'react'
import CotacaoScreen from './CotacaoScreen.jsx'
import {
  extractPdfLines, findHighDiscountSales, formatMoney, operatorName, parseCieloLines, parseFechamentoLines, parsePagPixLines,
  parsePagPixSpreadsheet, parseTrierLines, parseTrierSpreadsheet, reconcile, STATUS_LABEL,
} from './reconciliation.js'

const EMPTY_FILES = { trier: null, pagpix: null, cielo: null, fechamento: null }
const ANALYST_MARKERS_STORAGE_KEY = 'drogaria-center:trier:analyst-markers:v1'
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

function loadAnalystMarkers() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ANALYST_MARKERS_STORAGE_KEY) || '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch { return {} }
}

function markerSignature(kind, row) {
  if (kind === 'sem_recebimento') {
    return [row.sale.numero, row.sale.data, row.sale.hora, row.sale.forma, row.sale.valor, row.sale.operador, row.sale.raw].join('|')
  }
  return [row.fonte, row.data, row.hora, row.valor, row.operador, row.tipo, row.bandeira, row.raw].join('|')
}

function rowsWithMarkerKeys(rows, kind) {
  if (!kind) return rows
  const occurrences = new Map()
  return rows.map((row) => {
    const signature = markerSignature(kind, row)
    const occurrence = occurrences.get(signature) || 0
    occurrences.set(signature, occurrence + 1)
    return { ...row, __markerKey: `${kind}:${signature}:${occurrence}` }
  })
}

function columnFilter(rows, columns, filters) {
  return rows.filter((row) => columns.every((column) => {
    const filter = filters[column.key]?.trim().toLocaleLowerCase('pt-BR')
    return !filter || column.value(row).toLocaleLowerCase('pt-BR').includes(filter)
  }))
}

function FilterRow({ columns, rows, filters, onChange, tableId }) {
  return <tr className="filter-row no-print">{columns.map((column) => <th key={column.key}>
    {column.filterable !== false && <><input
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
    </datalist></>}
  </th>)}</tr>
}

function useReorderableColumns(columns, storageKey) {
  const [columnOrder, setColumnOrder] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || '[]')
      return Array.isArray(saved) ? saved : []
    } catch { return [] }
  })
  const columnMap = new Map(columns.map((column) => [column.key, column]))
  const visibleKeys = [...columnOrder.filter((key) => columnMap.has(key)), ...columns.map((column) => column.key).filter((key) => !columnOrder.includes(key))]
  const orderedColumns = visibleKeys.map((key) => columnMap.get(key))

  useEffect(() => {
    const missingKeys = columns.map((column) => column.key).filter((key) => !columnOrder.includes(key))
    if (missingKeys.length) setColumnOrder((current) => [...current, ...missingKeys.filter((key) => !current.includes(key))])
  }, [columns.map((column) => column.key).join('|')])

  useEffect(() => { window.localStorage.setItem(storageKey, JSON.stringify(columnOrder)) }, [columnOrder, storageKey])

  function moveColumn(sourceKey, targetKey) {
    if (!sourceKey || sourceKey === targetKey) return
    setColumnOrder((current) => {
      const complete = [...current, ...columns.map((column) => column.key).filter((key) => !current.includes(key))]
      const sourceIndex = complete.indexOf(sourceKey)
      const targetIndex = complete.indexOf(targetKey)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const next = [...complete]
      const [moved] = next.splice(sourceIndex, 1)
      next.splice(targetIndex, 0, moved)
      return next
    })
  }

  function shiftColumn(key, direction) {
    const index = visibleKeys.indexOf(key)
    const target = visibleKeys[index + direction]
    if (target) moveColumn(key, target)
  }

  return { orderedColumns, moveColumn, shiftColumn }
}

function ReorderableColumnHeader({ column, index, total, onMove, onShift }) {
  return <th className="reorderable-column" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onMove(event.dataTransfer.getData('text/plain'), column.key) }}>
    <div className="column-heading" draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', column.key) }} title="Arraste para mudar esta coluna de lugar">
      <span className="column-drag-handle" aria-hidden="true">⠿</span><span>{column.label}</span>
      <span className="column-move-buttons no-print"><button type="button" disabled={index === 0} onClick={(event) => { event.stopPropagation(); onShift(column.key, -1) }} aria-label={`Mover ${column.label} para a esquerda`}>←</button><button type="button" disabled={index === total - 1} onClick={(event) => { event.stopPropagation(); onShift(column.key, 1) }} aria-label={`Mover ${column.label} para a direita`}>→</button></span>
    </div>
  </th>
}

function ReviewToolbar({ rows, markers, reviewFilter, onReviewFilter, onSetAll }) {
  const marked = rows.filter((row) => markers[row.__markerKey]).length
  return <div className="analyst-review-toolbar no-print">
    <div className="analyst-review-copy"><span className="analyst-review-icon">✓</span><div><strong>Revisão do analista</strong><small>{marked} de {rows.length} registro(s) marcados como conciliados manualmente. A marcação não altera o resultado automático.</small></div></div>
    <div className="analyst-review-controls">
      <div className="analyst-review-bulk" role="group" aria-label="Marcar registros em lote">
        <button type="button" disabled={marked === rows.length} onClick={() => onSetAll(rows.map((row) => row.__markerKey), true)}>✓ Marcar todos</button>
        <button type="button" disabled={marked === 0} onClick={() => onSetAll(rows.map((row) => row.__markerKey), false)}>○ Desmarcar todos</button>
      </div>
      <div className="analyst-review-filters" role="group" aria-label="Filtrar revisão manual">
        {[['all', 'Todos'], ['pending', 'Pendentes'], ['marked', 'Marcados']].map(([key, label]) => <button type="button" key={key} className={reviewFilter === key ? 'active' : ''} onClick={() => onReviewFilter(key)}>{label}</button>)}
      </div>
    </div>
  </div>
}

function AnalystMarker({ marker, onToggle }) {
  return <button type="button" className={marker ? 'analyst-marker marked' : 'analyst-marker'} onClick={onToggle} aria-pressed={Boolean(marker)} title={marker ? 'Clique para reabrir este registro' : 'Marcar que o motivo já foi identificado'}>
    <span>{marker ? '✓' : '○'}</span>{marker ? 'Conciliado pelo analista' : 'Marcar conciliado'}
  </button>
}

function SalesTable({ rows, markers = {}, onToggleMarker, onSetMarkers, markerKind }) {
  const [filters, setFilters] = useState({})
  const [reviewFilter, setReviewFilter] = useState('all')
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
    { key: 'status', label: 'Status', value: (row) => STATUS_LABEL[row.status], render: (row) => <StatusPill status={row.status} /> },
    ...(markerKind ? [{ key: 'analysis', label: 'Análise', filterable: false, value: () => '', render: (row) => <AnalystMarker marker={markers[row.__markerKey]} onToggle={() => onToggleMarker(row.__markerKey)} /> }] : []),
  ]
  const { orderedColumns, moveColumn, shiftColumn } = useReorderableColumns(columns, 'drogaria-center:trier:sales-column-order:v1')
  const keyedRows = rowsWithMarkerKeys(rows, markerKind)
  const columnFilteredRows = columnFilter(keyedRows, columns, filters)
  const filteredRows = markerKind ? columnFilteredRows.filter((row) => reviewFilter === 'all' || (reviewFilter === 'marked') === Boolean(markers[row.__markerKey])) : columnFilteredRows
  if (!rows.length) return <EmptyTable />
  return <>{markerKind && <ReviewToolbar rows={keyedRows} markers={markers} reviewFilter={reviewFilter} onReviewFilter={setReviewFilter} onSetAll={onSetMarkers} />}<div className="table-meta"><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} registro(s).</div><div className="column-order-hint no-print">⠿ Arraste uma coluna ou use as setas para reorganizar</div></div><Table><thead><tr>{orderedColumns.map((column, index) => <ReorderableColumnHeader key={column.key} column={column} index={index} total={orderedColumns.length} onMove={moveColumn} onShift={shiftColumn} />)}</tr><FilterRow tableId="sales-filter" columns={orderedColumns} rows={keyedRows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((row) => { const sale = row.sale; const marker = markers[row.__markerKey]; return <tr className={marker ? 'manually-reconciled' : ''} key={row.__markerKey || `${sale.numero}-${row.status}`}>{orderedColumns.map((column) => <td key={column.key}>{column.render ? column.render(row) : column.value(row)}</td>)}</tr> })}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={orderedColumns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table></>
}

function DiscountAuditTable({ rows }) {
  const [filters, setFilters] = useState({})
  const columns = [
    { key: 'sale', label: 'Nº venda', value: (sale) => sale.numero },
    { key: 'date', label: 'Data', value: (sale) => sale.data },
    { key: 'time', label: 'Hora', value: (sale) => sale.hora || '—' },
    { key: 'operator', label: 'Operador', value: (sale) => operatorName(sale.operador) },
    { key: 'method', label: 'Forma', value: (sale) => sale.forma || '—' },
    { key: 'channel', label: 'Delivery/Balcão', value: (sale) => sale.tele === 'Sim' ? 'Delivery' : 'Balcão' },
    { key: 'gross', label: 'Valor bruto', value: (sale) => formatMoney(sale.valorBruto) },
    { key: 'discountPercent', label: 'Desconto %', value: (sale) => `${Number(sale.descontoPercentual || 0).toFixed(2).replace('.', ',')}%`, render: (sale) => <strong className="discount-high-percent">{Number(sale.descontoPercentual || 0).toFixed(2).replace('.', ',')}%</strong> },
    { key: 'discountValue', label: 'Desconto R$', value: (sale) => formatMoney(sale.descontoValor), render: (sale) => <strong className="discount-high-value">{formatMoney(sale.descontoValor)}</strong> },
    { key: 'liquid', label: 'Valor líquido', value: (sale) => formatMoney(sale.valorLiquido) },
    { key: 'total', label: 'Total líquido', value: (sale) => formatMoney(sale.valor) },
  ]
  const { orderedColumns, moveColumn, shiftColumn } = useReorderableColumns(columns, 'drogaria-center:trier:discount-column-order:v1')
  const filteredRows = columnFilter(rows, columns, filters)
  if (!rows.length) return <EmptyTable />
  return <><div className="table-meta"><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} venda(s) com desconto alto.</div><div className="column-order-hint no-print">⠿ Arraste uma coluna ou use as setas para reorganizar</div></div><Table><thead><tr>{orderedColumns.map((column, index) => <ReorderableColumnHeader key={column.key} column={column} index={index} total={orderedColumns.length} onMove={moveColumn} onShift={shiftColumn} />)}</tr><FilterRow tableId="discount-filter" columns={orderedColumns} rows={rows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((sale) => <tr className="discount-high-row" key={`${sale.numero}-${sale.data}-${sale.hora}`}>{orderedColumns.map((column) => <td key={column.key}>{column.render ? column.render(sale) : column.value(sale)}</td>)}</tr>)}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={orderedColumns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table></>
}

function NoSaleTable({ rows, markers = {}, onToggleMarker, onSetMarkers, markerKind }) {
  const [filters, setFilters] = useState({})
  const [reviewFilter, setReviewFilter] = useState('all')
  const columns = [
    { key: 'source', label: 'Origem', value: (row) => row.fonte },
    { key: 'date', label: 'Data', value: (row) => row.data },
    { key: 'time', label: 'Hora', value: (row) => row.hora || '—' },
    { key: 'operator', label: 'Operador', value: (row) => operatorName(row.operador) },
    { key: 'type', label: 'Tipo/Bandeira', value: (row) => row.tipo || row.bandeira || '—' },
    { key: 'value', label: 'Valor', value: (row) => formatMoney(row.valor) },
    { key: 'status', label: 'Status', value: (row) => STATUS_LABEL[row.status], render: (row) => <StatusPill status={row.status} /> },
    ...(markerKind ? [{ key: 'analysis', label: 'Análise', filterable: false, value: () => '', render: (row) => <AnalystMarker marker={markers[row.__markerKey]} onToggle={() => onToggleMarker(row.__markerKey)} /> }] : []),
  ]
  const { orderedColumns, moveColumn, shiftColumn } = useReorderableColumns(columns, 'drogaria-center:trier:no-sale-column-order:v1')
  const keyedRows = rowsWithMarkerKeys(rows, markerKind)
  const columnFilteredRows = columnFilter(keyedRows, columns, filters)
  const filteredRows = markerKind ? columnFilteredRows.filter((row) => reviewFilter === 'all' || (reviewFilter === 'marked') === Boolean(markers[row.__markerKey])) : columnFilteredRows
  if (!rows.length) return <EmptyTable />
  return <>{markerKind && <ReviewToolbar rows={keyedRows} markers={markers} reviewFilter={reviewFilter} onReviewFilter={setReviewFilter} onSetAll={onSetMarkers} />}<div className="table-meta"><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} registro(s).</div><div className="column-order-hint no-print">⠿ Arraste uma coluna ou use as setas para reorganizar</div></div><Table><thead><tr>{orderedColumns.map((column, index) => <ReorderableColumnHeader key={column.key} column={column} index={index} total={orderedColumns.length} onMove={moveColumn} onShift={shiftColumn} />)}</tr><FilterRow tableId="no-sale-filter" columns={orderedColumns} rows={keyedRows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((row, index) => { const marker = markers[row.__markerKey]; return <tr className={marker ? 'manually-reconciled' : ''} key={row.__markerKey || `${row.fonte}-${row.data}-${row.hora}-${row.valor}-${index}`}>{orderedColumns.map((column) => <td key={column.key}>{column.render ? column.render(row) : column.value(row)}</td>)}</tr> })}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={orderedColumns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table></>
}

function Table({ children }) { return <div className="table-frame"><div className="table-scroll"><table>{children}</table></div></div> }
function EmptyTable() { return <div className="table-frame p-7 text-center text-sm text-muted">Nada nessa categoria.</div> }

function ClosingCreditSummary({ groups }) {
  if (!groups.length) return null
  return <div className="closing-credit-groups">{groups.map((group, index) => <article key={`${group.data}-${group.valor}-${index}`} className={group.conciliado ? 'matched' : 'pending'}><div><span>{group.conciliado ? '✓ Conciliado pelo fechamento' : '! Valor ainda não localizado'}</span><strong>Contas recebidas crediário (Cartão)</strong><small>Fechamento de {group.data}</small></div><dl><div><dt>Informado</dt><dd>{formatMoney(group.valor)}</dd></div><div><dt>Encontrado na Cielo</dt><dd>{formatMoney(group.totalEncontrado)}</dd></div><div><dt>Recebimentos</dt><dd>{group.quantidadeRecebimentos}</dd></div><div><dt>Diferença</dt><dd>{formatMoney(group.diff)}</dd></div></dl></article>)}</div>
}

function exportRows(output, markers = {}) {
  const sales = rowsWithMarkerKeys(output.results, 'sem_recebimento')
  const receipts = rowsWithMarkerKeys(output.semVenda, 'sem_venda')
  const closingReceipts = output.crediarioCartao ?? []
  return [
    ...sales.map((row) => ({
      'Número da venda': row.sale.numero, Data: row.sale.data, 'Hora da venda': row.sale.hora || '', Operador: operatorName(row.sale.operador), 'Forma de pagamento': row.sale.forma || '', 'Delivery/Balcão': row.sale.tele === 'Sim' ? 'Delivery' : 'Balcão', 'Valor da venda': row.sale.valor, 'Valor recebido': row.recebimento?.valor ?? '', Origem: row.fonte || '', 'Hora do recebimento': row.recebimento?.hora || '', 'Diferença de valor': row.diff ?? '', Status: STATUS_LABEL[row.status], 'Revisão do analista': row.status === 'SEM_RECEBIMENTO' ? (markers[row.__markerKey] ? 'Conciliado pelo analista' : 'Pendente') : '', 'Data da revisão': markers[row.__markerKey]?.markedAt ? new Date(markers[row.__markerKey].markedAt).toLocaleString('pt-BR') : '',
    })),
    ...receipts.map((row) => ({
      'Número da venda': '', Data: row.data, 'Hora da venda': '', Operador: operatorName(row.operador), 'Forma de pagamento': '', 'Delivery/Balcão': row.tipo || row.bandeira || '', 'Valor da venda': '', 'Valor recebido': row.valor, Origem: row.fonte, 'Hora do recebimento': row.hora || '', 'Diferença de valor': '', Status: STATUS_LABEL[row.status], 'Revisão do analista': markers[row.__markerKey] ? 'Conciliado pelo analista' : 'Pendente', 'Data da revisão': markers[row.__markerKey]?.markedAt ? new Date(markers[row.__markerKey].markedAt).toLocaleString('pt-BR') : '',
    })),
    ...closingReceipts.map((row) => ({
      'Número da venda': '', Data: row.data, 'Hora da venda': '', Operador: operatorName(row.operador), 'Forma de pagamento': '', 'Delivery/Balcão': row.tipo || row.bandeira || '', 'Valor da venda': '', 'Valor recebido': row.valor, Origem: 'Cielo / Fechamento de Caixa', 'Hora do recebimento': row.hora || '', 'Diferença de valor': '', Status: STATUS_LABEL[row.status], 'Revisão do analista': '', 'Data da revisão': '',
    })),
  ]
}

function downloadCsv(output, markers) {
  const rows = exportRows(output, markers); if (!rows.length) return
  const headers = Object.keys(rows[0]); const content = [headers.join(';'), ...rows.map((row) => headers.map((key) => String(row[key]).replace(/;/g, ',')).join(';'))].join('\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'concilia_trier.csv' }); link.click(); URL.revokeObjectURL(url)
}

async function downloadExcel(output, markers) {
  const rows = exportRows(output, markers); if (!rows.length) return
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

function PwaInstallButton() {
  const [installPrompt, setInstallPrompt] = useState(null)
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean(window.navigator.standalone))

  useEffect(() => {
    const handlePrompt = (event) => { event.preventDefault(); setInstallPrompt(event) }
    const handleInstalled = () => { setInstalled(true); setInstallPrompt(null) }
    window.addEventListener('beforeinstallprompt', handlePrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', handlePrompt); window.removeEventListener('appinstalled', handleInstalled) }
  }, [])

  if (installed) return <span className="pwa-installed-badge">✓ Instalado</span>
  if (!installPrompt) return null

  async function install() {
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') setInstallPrompt(null)
  }

  return <button type="button" className="pwa-install-button" onClick={install}><img src="/pwa/favicon-32.png" alt="" />Instalar aplicativo</button>
}

function HomeScreen({ onSelect }) {
  return <main className="app-shell home-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="home-topbar"><div className="brand-logo-wrap"><img className="brand-logo" src="/drogaria-center-logo.png" alt="Drogaria Center" /></div><div className="home-topbar-actions"><PwaInstallButton /><div className="local-chip home-chip"><span />Sistemas internos</div></div></header>
    <section className="home-hero"><p className="brand-kicker">Utilitários - Drogaria Center</p><h1>Olá! O que vamos<br />fazer hoje?</h1><p>Escolha uma ferramenta para começar. Tudo foi pensado para tornar a rotina da farmácia mais simples.</p></section>
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
  const layouts = {
    1: [1, 1, 'portrait'],
    2: [2, 1, 'landscape'],
    4: [2, 2, 'portrait'],
    6: [3, 2, 'portrait'],
    8: [4, 2, 'landscape'],
    9: [3, 3, 'portrait'],
    10: [5, 2, 'landscape'],
    12: [4, 3, 'portrait'],
  }
  const [columns, rows, orientation] = layouts[itemsPerPage] || layouts[8]
  return { columns, rows, orientation }
}

function drawOfferPage(canvas, background, offers, itemsPerPage) {
  const { columns, rows, orientation } = offerLayout(itemsPerPage)
  const pageWidth = 1800
  const pageHeight = Math.round(pageWidth * (orientation === 'landscape' ? 210 / 297 : 297 / 210))
  const pagePadding = 12
  const cellWidth = (pageWidth - pagePadding * 2) / columns
  const cellHeight = (pageHeight - pagePadding * 2) / rows
  const gap = Math.max(6, Math.round(Math.min(cellWidth, cellHeight) * .012))
  canvas.width = pageWidth
  canvas.height = pageHeight
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  offers.forEach((offer, index) => {
    const poster = document.createElement('canvas')
    drawPoster(poster, background, offer)
    const column = index % columns
    const row = Math.floor(index / columns)
    const destinationWidth = cellWidth - gap
    const destinationHeight = cellHeight - gap
    const destinationX = pagePadding + column * cellWidth + gap / 2
    const destinationY = pagePadding + row * cellHeight + gap / 2
    context.drawImage(poster, destinationX, destinationY, destinationWidth, destinationHeight)
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
  const [individualQuantity, setIndividualQuantity] = useState(2)
  const [individualItemsPerPage, setIndividualItemsPerPage] = useState(2)
  const [individualPage, setIndividualPage] = useState(0)
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

  const normalizedIndividualQuantity = Math.max(1, Math.min(999, Math.round(Number(individualQuantity) || 1)))
  const totalIndividualPages = Math.max(1, Math.ceil(normalizedIndividualQuantity / individualItemsPerPage))
  const visibleIndividualCount = Math.max(0, Math.min(individualItemsPerPage, normalizedIndividualQuantity - individualPage * individualItemsPerPage))
  const individualOrientation = offerLayout(individualItemsPerPage).orientation === 'landscape' ? 'horizontal' : 'vertical'

  useEffect(() => {
    if (individualPage >= totalIndividualPages) setIndividualPage(Math.max(0, totalIndividualPages - 1))
  }, [individualPage, totalIndividualPages])

  useEffect(() => {
    if (background && canvasRef.current) drawOfferPage(canvasRef.current, background, Array.from({ length: visibleIndividualCount }, () => values), individualItemsPerPage)
  }, [background, individualItemsPerPage, individualPage, values, visibleIndividualCount])

  const totalBatchPages = Math.max(1, Math.ceil(batchOffers.length / itemsPerPage))
  const visibleBatchOffers = batchOffers.slice(batchPage * itemsPerPage, (batchPage + 1) * itemsPerPage)

  useEffect(() => {
    if (batchPage >= totalBatchPages) setBatchPage(Math.max(0, totalBatchPages - 1))
  }, [batchPage, totalBatchPages])

  useEffect(() => {
    if (background && visibleBatchOffers.length && batchCanvasRef.current) drawOfferPage(batchCanvasRef.current, background, visibleBatchOffers, itemsPerPage)
  }, [background, visibleBatchOffers, itemsPerPage])

  function createIndividualPages() {
    return Array.from({ length: totalIndividualPages }, (_, index) => {
      const page = document.createElement('canvas')
      const copiesOnPage = Math.min(individualItemsPerPage, normalizedIndividualQuantity - index * individualItemsPerPage)
      drawOfferPage(page, background, Array.from({ length: copiesOnPage }, () => values), individualItemsPerPage)
      return page
    })
  }

  async function downloadPoster(format) {
    try {
      const canvas = canvasRef.current
      if (!canvas || !background) return
      const productSlug = values.product.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'oferta'
      const fileBase = `cartaz-${productSlug}-${normalizedIndividualQuantity}-copias`
      if (format === 'pdf') saveBlob(await postersPdfBlob(createIndividualPages()), `${fileBase}.pdf`)
      else saveBlob(await canvasBlob(canvas, format === 'png' ? 'image/png' : 'image/jpeg', .96), `${fileBase}-pagina-${individualPage + 1}.${format === 'png' ? 'png' : 'jpg'}`)
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
    {mode === 'individual' ? <section className="poster-studio"><form className="poster-form" onSubmit={(event) => event.preventDefault()}><div className="poster-form-title"><span className="future-icon" aria-hidden="true">✦</span><div><span className="section-kicker">Dados da oferta</span><h2>Monte seu cartaz</h2></div></div><label>Nome do produto<textarea value={values.product} maxLength="70" onChange={(event) => setValues((current) => ({ ...current, product: event.target.value }))} placeholder="Ex.: SONRIDOR RAPID+FORTE 4CP REV" /></label><div className="price-fields"><label>Preço anterior<input inputMode="decimal" value={values.oldPrice} onChange={(event) => setValues((current) => ({ ...current, oldPrice: event.target.value }))} placeholder="7,99" /></label><label>Preço da oferta<input inputMode="decimal" value={values.price} onChange={(event) => setValues((current) => ({ ...current, price: event.target.value }))} placeholder="1,99" /></label></div><div className="individual-print-settings"><label>Quantidade de cartazes<input type="number" min="1" max="999" step="1" value={individualQuantity} onChange={(event) => { setIndividualQuantity(event.target.value); setIndividualPage(0) }} onBlur={() => setIndividualQuantity(normalizedIndividualQuantity)} /></label><label className="items-per-page">Tamanho na folha A4<select value={individualItemsPerPage} onChange={(event) => { setIndividualItemsPerPage(Number(event.target.value)); setIndividualPage(0) }}><option value="2">2 por página · maior</option><option value="4">4 por página · grande</option><option value="6">6 por página · médio</option><option value="8">8 por página · pequeno</option><option value="10">10 por página · menor</option><option value="12">12 por página · compacto</option></select></label></div><p className="poster-tip">O PDF inclui todas as cópias em folhas A4. PNG e JPG baixam a página exibida na prévia.</p><div className="download-actions"><button type="button" disabled={!background} onClick={() => downloadPoster('pdf')}>⇩ PDF completo</button><button type="button" disabled={!background} onClick={() => downloadPoster('png')}>⇩ PNG da página</button><button type="button" disabled={!background} onClick={() => downloadPoster('jpg')}>⇩ JPG da página</button></div>{renderError && <p className="poster-error" role="alert">{renderError}</p>}</form><section className="poster-preview-panel"><div className="poster-preview-label"><span>Prévia da folha A4</span><small>A4 {individualOrientation} · {individualItemsPerPage} por página · Página {individualPage + 1} de {totalIndividualPages}</small></div><div className="poster-canvas-wrap individual-a4-canvas-wrap"><canvas ref={canvasRef} aria-label="Prévia da folha A4 com cartazes de oferta" /></div><div className="batch-pagination"><button type="button" disabled={individualPage === 0} onClick={() => setIndividualPage((page) => page - 1)}>← Anterior</button><span>{visibleIndividualCount} cartazes nesta página</span><button type="button" disabled={individualPage + 1 >= totalIndividualPages} onClick={() => setIndividualPage((page) => page + 1)}>Próxima →</button></div></section></section> : <section className="poster-studio batch-studio"><form className="poster-form" onSubmit={(event) => event.preventDefault()}><div className="poster-form-title"><span className="future-icon" aria-hidden="true">▦</span><div><span className="section-kicker">Lote de ofertas</span><h2>Importe sua planilha</h2></div></div><label className="batch-upload">{batchLoading ? 'Lendo a planilha...' : 'Selecionar arquivo XLS ou XLSX'}<input type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => importOffers(event.target.files?.[0])} /></label>{batchFileName && <div className="batch-file-status"><b>{batchFileName}</b><span>{batchOffers.length} ofertas identificadas</span></div>}<label className="items-per-page">Cartazes por página<select value={itemsPerPage} onChange={(event) => { setItemsPerPage(Number(event.target.value)); setBatchPage(0) }}><option value="1">1 por página</option><option value="2">2 por página</option><option value="4">4 por página</option><option value="6">6 por página</option><option value="8">8 por página (referência)</option><option value="9">9 por página</option><option value="10">10 por página</option><option value="12">12 por página</option></select></label><p className="poster-tip">O XLS enviado foi reconhecido pelas colunas Produto, Vlr.Promoção e Preço Normal.</p><div className="download-actions"><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('pdf')}>{batchExporting ? 'Gerando arquivo...' : '⇩ Baixar PDF completo'}</button><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('png')}>⇩ Baixar PNG da página</button></div>{renderError && <p className="poster-error" role="alert">{renderError}</p>}</form><section className="poster-preview-panel"><div className="poster-preview-label"><span>Prévia do lote</span><small>{batchOffers.length ? `Página ${batchPage + 1} de ${totalBatchPages}` : 'Aguardando planilha'}</small></div>{batchOffers.length ? <><div className="poster-canvas-wrap batch-canvas-wrap"><canvas ref={batchCanvasRef} aria-label="Prévia da página de cartazes" /></div><div className="batch-pagination"><button type="button" disabled={batchPage === 0} onClick={() => setBatchPage((page) => page - 1)}>← Anterior</button><span>{visibleBatchOffers.length} cartazes nesta página</span><button type="button" disabled={batchPage + 1 >= totalBatchPages} onClick={() => setBatchPage((page) => page + 1)}>Próxima →</button></div></> : <div className="batch-empty"><span>▦</span><b>Envie uma planilha para visualizar o lote.</b><small>Você poderá escolher quantos cartazes saem em cada página.</small></div>}</section></section>}
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
  const [analystMarkers, setAnalystMarkers] = useState(loadAnalystMarkers)
  const [discountMode, setDiscountMode] = useState('percent')
  const [discountPercentThreshold, setDiscountPercentThreshold] = useState(30)
  const [discountValueThreshold, setDiscountValueThreshold] = useState(20)
  const [discountAudit, setDiscountAudit] = useState(null)
  const canRun = files.trier && (files.pagpix || files.cielo)

  useEffect(() => {
    window.localStorage.setItem(ANALYST_MARKERS_STORAGE_KEY, JSON.stringify(analystMarkers))
  }, [analystMarkers])

  function toggleAnalystMarker(markerKey) {
    setAnalystMarkers((current) => {
      if (current[markerKey]) {
        const next = { ...current }
        delete next[markerKey]
        return next
      }
      return { ...current, [markerKey]: { markedAt: new Date().toISOString() } }
    })
  }

  function setAnalystMarkerGroup(markerKeys, shouldMark) {
    setAnalystMarkers((current) => {
      const next = { ...current }
      if (shouldMark) {
        const markedAt = new Date().toISOString()
        markerKeys.forEach((markerKey) => { next[markerKey] = next[markerKey] || { markedAt } })
      } else markerKeys.forEach((markerKey) => { delete next[markerKey] })
      return next
    })
  }

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
      const rows = spreadsheetRows ?? (key === 'trier' ? parseTrierLines(lines) : key === 'pagpix' ? parsePagPixLines(lines) : key === 'cielo' ? parseCieloLines(lines) : key === 'fechamento' ? parseFechamentoLines(lines) : [])
      setFiles((previous) => ({ ...previous, [key]: { fileName: file.name, lines, rows } }))
      setOutput(null)
      if (key === 'trier') setDiscountAudit(null)
      if (!lines.length) setError(`Não consegui extrair nenhum texto de “${file.name}”. Se for um PDF escaneado (imagem), será necessário OCR.`)
      else if (key !== 'fechamento' && !rows.length) setError(`Li ${lines.length} linhas de “${file.name}”, mas não reconheci registros no formato esperado. Abra “Ver linhas extraídas” para revisar o conteúdo.`)
    } catch (exception) { setError(`Não consegui ler “${file.name}”. Confira se é um PDF válido e contém texto. Detalhe: ${exception.message || exception}`) }
  }

  function runReconciliation() {
    setError('')
    try { setOutput(reconcile(files, Number(toleranceValue) || 0, Number(toleranceHours) || 0)); setTab('resumo') }
    catch (exception) { setOutput(null); setError(exception.message) }
  }

  function runDiscountAudit() {
    const threshold = discountMode === 'value' ? Number(discountValueThreshold) : Number(discountPercentThreshold)
    if (!files.trier?.rows?.length) { setError('Importe a Relação de Vendas Trier antes de verificar os descontos.'); return }
    if (!Number.isFinite(threshold) || threshold < 0) { setError('Informe um limite de desconto válido, igual ou maior que zero.'); return }
    setError('')
    setDiscountAudit({ mode: discountMode, threshold })
  }

  const results = output?.results ?? []; const noSale = output?.semVenda ?? []; const crediarioCartao = output?.crediarioCartao ?? []; const fechamentoCrediario = output?.fechamentoCrediario ?? []
  const accounting = results.filter((row) => row.status !== 'DEVOLUCAO')
  const counts = {
    total: accounting.length, pix: accounting.filter((row) => row.sale.forma === 'PIX').length, card: accounting.filter((row) => row.sale.forma === 'CARTAO').length, reconciled: accounting.filter((row) => row.status === 'CONCILIADA').length, missing: accounting.filter((row) => row.status === 'SEM_RECEBIMENTO').length, divergent: accounting.filter((row) => row.status === 'DIVERGENCIA').length, pixNoSale: noSale.filter((row) => row.fonte === 'PaggPix').length, cardNoSale: noSale.filter((row) => row.fonte === 'Cielo').length, duplicates: noSale.filter((row) => row.status === 'DUPLICADO').length, returns: results.filter((row) => row.status === 'DEVOLUCAO').length,
  }
  const totalValue = accounting.reduce((sum, row) => sum + row.sale.valor, 0)
  const matchedValue = accounting.filter((row) => ['CONCILIADA', 'DIVERGENCIA'].includes(row.status)).reduce((sum, row) => sum + row.sale.valor, 0)
  const divergentValue = accounting.filter((row) => row.status === 'DIVERGENCIA').reduce((sum, row) => sum + Math.abs(row.diff), 0)
  const highDiscountRows = discountAudit ? findHighDiscountSales(files.trier?.rows ?? [], discountAudit.mode, discountAudit.threshold) : []
  const highDiscountTotal = highDiscountRows.reduce((sum, sale) => sum + Number(sale.descontoValor || 0), 0)
  const highDiscountMaxPercent = highDiscountRows.reduce((highest, sale) => Math.max(highest, Number(sale.descontoPercentual || 0)), 0)
  const kpis = [['Total de vendas', counts.total], ['Vendas PIX', counts.pix], ['Vendas cartão', counts.card], ['Conciliadas', counts.reconciled], ['Não conciliadas', counts.missing], ['PIX sem venda', counts.pixNoSale], ['Cartão sem venda', counts.cardNoSale], ...(fechamentoCrediario.length ? [['Crediário recebido no cartão', formatMoney(crediarioCartao.reduce((sum, row) => sum + row.valor, 0))]] : []), ['Recebimentos duplicados', counts.duplicates], ['Valor conciliado', formatMoney(matchedValue)], ['Valor divergente', formatMoney(divergentValue)], ['% conciliação', `${totalValue ? ((matchedValue / totalValue) * 100).toFixed(1) : '0.0'}%`]]
  const tabs = [['resumo', 'Resumo'], ['conciliada', `Conciliadas (${counts.reconciled})`], ['divergencia', `Divergências (${counts.divergent})`], ['sem_recebimento', `Sem recebimento (${counts.missing})`], ['sem_venda', `Sem venda (${noSale.length})`], ...(fechamentoCrediario.length ? [['crediario_cartao', `Crediário cartão (${crediarioCartao.length})`]] : []), ...(counts.returns ? [['devolucao', `Devoluções (${counts.returns})`]] : [])]

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
    <section className="discount-audit-controls no-print"><div className="discount-audit-heading"><span className="discount-audit-icon">%</span><div><span className="section-kicker">Auditoria da Trier</span><strong>Verificar vendas com desconto alto</strong><small>Escolha um limite por percentual ou por valor. Devoluções não entram nessa análise.</small></div></div><div className="discount-audit-form"><div className="discount-mode-toggle" role="group" aria-label="Tipo do limite de desconto"><button type="button" className={discountMode === 'percent' ? 'active' : ''} aria-pressed={discountMode === 'percent'} onClick={() => setDiscountMode('percent')}>% Percentual</button><button type="button" className={discountMode === 'value' ? 'active' : ''} aria-pressed={discountMode === 'value'} onClick={() => setDiscountMode('value')}>R$ Valor</button></div><label>{discountMode === 'percent' ? 'Desconto mínimo (%)' : 'Desconto mínimo (R$)'}<input type="number" min="0" step={discountMode === 'percent' ? '0.1' : '0.01'} value={discountMode === 'percent' ? discountPercentThreshold : discountValueThreshold} onChange={(event) => discountMode === 'percent' ? setDiscountPercentThreshold(event.target.value) : setDiscountValueThreshold(event.target.value)} /></label><button type="button" className="discount-audit-button" disabled={!files.trier} onClick={runDiscountAudit}>Verificar descontos altos <b aria-hidden="true">→</b></button></div></section>
    {discountAudit && <section className="discount-audit-results"><div className="discount-results-heading"><div><span className="section-kicker">Resultado da auditoria</span><h2>Descontos altos</h2><p>Limite aplicado: <b>{discountAudit.mode === 'percent' ? `${discountAudit.threshold.toFixed(2).replace('.', ',')}%` : formatMoney(discountAudit.threshold)}</b>. A lista está ordenada do maior desconto para o menor.</p></div><button type="button" className="discount-close no-print" onClick={() => setDiscountAudit(null)}>Fechar análise</button></div><div className="discount-kpis"><article><small>Vendas encontradas</small><strong>{highDiscountRows.length}</strong></article><article><small>Total concedido</small><strong>{formatMoney(highDiscountTotal)}</strong></article><article><small>Maior percentual</small><strong>{highDiscountMaxPercent.toFixed(2).replace('.', ',')}%</strong></article></div>{highDiscountRows.length ? <DiscountAuditTable rows={highDiscountRows} /> : <div className="discount-empty"><span>✓</span><div><b>Nenhuma venda ultrapassou esse limite.</b><small>Você pode reduzir o percentual ou o valor e verificar novamente.</small></div></div>}</section>}
    {output && <section className="results-section"><div className="results-heading"><span className="section-kicker">Etapa 3</span><h2>Resultado da conciliação</h2><p>Revise os indicadores e filtre cada coluna para investigar os registros.</p></div><div className="kpi-grid">{kpis.map(([label, value]) => <div className="kpi" key={label}><div>{label}</div><strong>{value}</strong></div>)}</div>
      <div className="no-print tabs"><div className="tab-list">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>{label}</button>)}</div><div className="export-list"><button onClick={() => downloadCsv(output, analystMarkers)}>⇩ CSV</button><button onClick={() => downloadExcel(output, analystMarkers)}>⇩ Excel</button><button onClick={() => window.print()}>⇩ PDF</button></div></div>
      {tab === 'resumo' && <div className="summary-card">Das <b>{counts.total}</b> vendas eletrônicas da Relação de Vendas, <b className="text-green">{counts.reconciled}</b> foram conciliadas, <b className="text-amber">{counts.divergent}</b> tiveram divergência de valor dentro da tolerância e <b className="text-rust">{counts.missing}</b> não encontraram recebimento correspondente.{noSale.length > 0 && <><br /><br />Também foram encontrados <b className="text-rust">{noSale.length}</b> recebimentos sem venda correspondente, sendo <b>{counts.duplicates}</b> identificados como possível duplicidade.</>}{crediarioCartao.length > 0 && <><br /><br /><b className="text-green">{crediarioCartao.length}</b> recebimento(s) da Cielo, somando <b>{formatMoney(crediarioCartao.reduce((sum, row) => sum + row.valor, 0))}</b>, foram identificados como <b>Contas Recebidas Crediário (Cartão)</b> pelo Fechamento de Caixa.</>}{counts.returns > 0 && <><br /><br /><b>{counts.returns}</b> linha(s) de devolução não entraram na conciliação, pois não representam recebimento a buscar.</>}<br /><br />Use as abas para revisar cada grupo ou exporte a tabela final em Excel, CSV ou PDF.</div>}
      {tab === 'conciliada' && <SalesTable rows={results.filter((row) => row.status === 'CONCILIADA')} />}{tab === 'divergencia' && <SalesTable rows={results.filter((row) => row.status === 'DIVERGENCIA')} />}{tab === 'sem_recebimento' && <SalesTable rows={results.filter((row) => row.status === 'SEM_RECEBIMENTO')} markers={analystMarkers} onToggleMarker={toggleAnalystMarker} onSetMarkers={setAnalystMarkerGroup} markerKind="sem_recebimento" />}{tab === 'devolucao' && <SalesTable rows={results.filter((row) => row.status === 'DEVOLUCAO')} />}{tab === 'sem_venda' && <NoSaleTable rows={noSale} markers={analystMarkers} onToggleMarker={toggleAnalystMarker} onSetMarkers={setAnalystMarkerGroup} markerKind="sem_venda" />}{tab === 'crediario_cartao' && <><ClosingCreditSummary groups={fechamentoCrediario} /><NoSaleTable rows={crediarioCartao} /></>}
    </section>}
    <footer className="app-footer"><img src="/drogaria-center-logo.png" alt="Drogaria Center" /><span>Conciliação segura, simples e local.</span></footer>
  </div></main>
}
