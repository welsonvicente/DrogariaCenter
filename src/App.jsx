import { useEffect, useRef, useState } from 'react'
import CotacaoScreen from './CotacaoScreen.jsx'
import { clearReconciliationSession, loadReconciliationSession, saveReconciliationSession } from './browserStorage.js'
import {
  extractPdfLines, findHighDiscountSales, formatMoney, OPERADORES, operatorName, parseCieloLines, parseFechamentoLines, parsePagPixLines,
  parsePagPixSpreadsheet, parseTrierLines, parseTrierSpreadsheet, reconcile, reconciliationReceiptKey, reconciliationSaleKey, resolveOperator, STATUS_LABEL,
} from './reconciliation.js'

const EMPTY_FILES = { trier: null, pagpix: null, cielo: null, fechamento: null }
const ANALYST_MARKERS_STORAGE_KEY = 'drogaria-center:trier:analyst-markers:v1'
const STAFF_STORAGE_KEY = 'drogaria-center:trier:staff-directory:v1'
const STAFF_MIGRATION_KEY = 'drogaria-center:trier:staff-directory:migration:v2'
const RESULT_TAB_STORAGE_KEY = 'drogaria-center:trier:result-tab:v1'
const TABLE_UI_STORAGE_PREFIX = 'drogaria-center:trier:table-ui:v1:'
const APP_BASE_PATH = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
const SYSTEM_ROUTES = { home: '', trier: 'conciliacao-trier', cartazes: 'cartazes-oferta', cotacao: 'cotacao-medicamentos' }
const assetPath = (path) => `${APP_BASE_PATH}${String(path).replace(/^\/+/, '')}`
const systemPath = (system) => `${APP_BASE_PATH}${SYSTEM_ROUTES[system]}`
const SOURCES = {
  trier: { title: 'Relação de Vendas (Trier)', hint: 'Base principal — obrigatório', color: 'bg-ink', step: '01', badge: 'Obrigatório' },
  pagpix: { title: 'Relatório Detalhado PaggPix', hint: 'Recebimentos PIX', color: 'bg-teal', step: '02', badge: 'PIX' },
  cielo: { title: 'Relatório Detalhado Cielo', hint: 'Recebimentos cartão', color: 'bg-amber', step: '03', badge: 'Cartão' },
  fechamento: { title: 'Fechamento de Caixa', hint: 'Opcional', color: 'bg-muted', step: '04', badge: 'Opcional' },
}

const DEFAULT_STAFF = Object.entries(OPERADORES).filter(([trierCode]) => trierCode !== '17').map(([trierCode, name]) => ({
  id: `trier-${trierCode}`,
  name,
  trierCode,
  pagpixAliases: [name],
  active: true,
}))

function loadStaffDirectory() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STAFF_STORAGE_KEY) || 'null')
    let directory = Array.isArray(saved) && saved.length ? saved : DEFAULT_STAFF
    if (window.localStorage.getItem(STAFF_MIGRATION_KEY) !== 'done') {
      directory = directory.filter((person) => String(person.trierCode) !== '17' && !/^jos[eé]\s+ramos\s+da\s+silva\s+junior$/i.test(person.name || ''))
      const joao = { id: 'trier-12', name: 'Joao Victor Dornelas de Araujo', trierCode: '12', pagpixAliases: ['JOAO VICTOR DORNELAS DE ARAUJO'], active: true }
      directory = [...directory.filter((person) => String(person.trierCode) !== '12'), joao]
      window.localStorage.setItem(STAFF_STORAGE_KEY, JSON.stringify(directory))
      window.localStorage.setItem(STAFF_MIGRATION_KEY, 'done')
    }
    return directory.map((person) => ({ ...person, pagpixAliases: Array.isArray(person.pagpixAliases) ? person.pagpixAliases : [], active: person.active !== false }))
  } catch { /* usa a equipe inicial */ }
  return DEFAULT_STAFF
}

function loadResultTab() {
  try { return window.localStorage.getItem(RESULT_TAB_STORAGE_KEY) || 'resumo' }
  catch { return 'resumo' }
}

function loadTableUiState(viewKey) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`${TABLE_UI_STORAGE_PREFIX}${viewKey}`) || '{}')
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  } catch { return {} }
}

function usePersistentTableUi(viewKey) {
  const initial = useRef(loadTableUiState(viewKey))
  const [filters, setFilters] = useState(initial.current.filters ?? {})
  const [reviewFilter, setReviewFilter] = useState(initial.current.reviewFilter || 'all')
  const [selectedStaff, setSelectedStaff] = useState(initial.current.selectedStaff ?? [])
  const [timeStart, setTimeStart] = useState(initial.current.timeStart || '')
  const [timeEnd, setTimeEnd] = useState(initial.current.timeEnd || '')
  const scrollRef = useRef(null)
  const storageKey = `${TABLE_UI_STORAGE_PREFIX}${viewKey}`

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = Number(initial.current.scrollTop) || 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [storageKey])

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        filters, reviewFilter, selectedStaff, timeStart, timeEnd,
        scrollTop: (scrollRef.current?.scrollTop ?? Number(initial.current.scrollTop)) || 0,
      }))
    } catch { /* o navegador pode bloquear o armazenamento local */ }
  }, [filters, reviewFilter, selectedStaff, timeStart, timeEnd, storageKey])

  function saveScroll(event) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({
        filters, reviewFilter, selectedStaff, timeStart, timeEnd, scrollTop: event.currentTarget.scrollTop,
      }))
    } catch { /* mantém a navegação funcionando mesmo sem armazenamento */ }
  }

  const activeFilterCount = Object.values(filters).filter((value) => String(value ?? '').trim()).length
    + (reviewFilter !== 'all' ? 1 : 0)
    + (selectedStaff.length ? 1 : 0)
    + (timeStart ? 1 : 0)
    + (timeEnd ? 1 : 0)

  function clearTableFilters() {
    setFilters({})
    setReviewFilter('all')
    setSelectedStaff([])
    setTimeStart('')
    setTimeEnd('')
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }

  return { filters, setFilters, reviewFilter, setReviewFilter, selectedStaff, setSelectedStaff, timeStart, setTimeStart, timeEnd, setTimeEnd, scrollRef, saveScroll, activeFilterCount, clearTableFilters }
}

function staffForRow(row, source, staff) {
  return resolveOperator(row, source, staff)
}

function staffNameForRow(row, source, staff) {
  const person = staffForRow(row, source, staff)
  if (person) return `${person.name}${person.trierCode ? ` · nº ${person.trierCode}` : ''}${person.active === false ? ' · inativo' : ''}`
  return row?.operador ? operatorName(row.operador) : 'Não identificado'
}

function minutesFromTime(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function secondsFromTime(value) {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0) : null
}

function receiptTimeDifference(row) {
  const saleSeconds = secondsFromTime(row.sale?.hora)
  const receiptSeconds = secondsFromTime(row.recebimento?.hora)
  if (saleSeconds === null || receiptSeconds === null) return null
  const difference = Math.abs(saleSeconds - receiptSeconds)
  if (difference === 0) return { seconds: 0, label: 'mesmo horário' }
  const hours = Math.floor(difference / 3600)
  const minutes = Math.floor((difference % 3600) / 60)
  const seconds = difference % 60
  const parts = []
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}min`)
  if (seconds && !hours) parts.push(`${seconds}s`)
  const direction = receiptSeconds < saleSeconds ? 'antes da venda' : 'depois da venda'
  return { seconds: difference, label: `${parts.join(' ')} ${direction}` }
}

function timeIsInRange(value, start, end) {
  const current = minutesFromTime(value)
  const startMinutes = minutesFromTime(start)
  const endMinutes = minutesFromTime(end)
  if (current === null) return !start && !end
  if (startMinutes === null && endMinutes === null) return true
  if (startMinutes !== null && endMinutes !== null && startMinutes > endMinutes) return current >= startMinutes || current <= endMinutes
  return (startMinutes === null || current >= startMinutes) && (endMinutes === null || current <= endMinutes)
}

function systemFromPathname(pathname) {
  const baseWithoutTrailingSlash = APP_BASE_PATH.replace(/\/$/, '')
  const isInsideBase = !baseWithoutTrailingSlash || pathname === baseWithoutTrailingSlash || pathname.startsWith(`${baseWithoutTrailingSlash}/`)
  const relativePath = isInsideBase ? pathname.slice(baseWithoutTrailingSlash.length) : pathname
  const normalizedRoute = relativePath.replace(/^\/+|\/+$/g, '')
  return Object.entries(SYSTEM_ROUTES).find(([, route]) => route === normalizedRoute)?.[0] || 'home'
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

function trierChannel(row) {
  if (row.sale?.forma !== 'PIX') return '—'
  return row.canalTrier || (row.sale.tele === 'Sim' ? 'Delivery' : 'Balcão')
}

function receiptChannel(row) {
  if (row.fonte !== 'PaggPix' || !row.recebimento) return '—'
  return row.canalRecebimento || row.recebimento.tipo || 'Não informado'
}

function channelComparison(row) {
  if (!row.recebimento) return '—'
  const timing = receiptTimeDifference(row)
  const timingText = timing ? ` · Diferença: ${timing.label}` : ''
  if (row.fonte !== 'PaggPix') return `${row.fonte || 'Recebimento'}${timingText}`
  const trier = trierChannel(row)
  const receipt = receiptChannel(row)
  return row.canalDivergente || trier !== receipt
    ? `Divergente · Trier ${trier} → PaggPix ${receipt}${timingText}`
    : `Compatível · ${trier}${timingText}`
}

function ChannelComparison({ row }) {
  if (!row.recebimento) return <span>—</span>
  const timing = receiptTimeDifference(row)
  const divergent = row.fonte === 'PaggPix' && (row.canalDivergente || trierChannel(row) !== receiptChannel(row))
  const status = row.status === 'DIVERGENCIA' ? 'Valor divergente' : divergent ? 'Canal divergente' : 'Recebimento conciliado'
  const channel = row.fonte === 'PaggPix'
    ? (divergent ? `Trier: ${trierChannel(row)} → PaggPix: ${receiptChannel(row)}` : `Canal: ${trierChannel(row)}`)
    : `${row.fonte || 'Recebimento'} · ${formatMoney(row.recebimento.valor)}`
  return <span className={`channel-check ${divergent || row.status === 'DIVERGENCIA' ? 'divergent' : 'compatible'}`}>
    <b>{divergent || row.status === 'DIVERGENCIA' ? '⚠' : '✓'} {status}{row.manualMatch ? ' · manual' : ''}</b>
    <small>{channel}</small>
    <small>Venda: {row.sale.hora || '—'} · Receb.: {row.recebimento.hora || '—'}</small>
    {timing && <em className={timing.seconds ? 'time-difference' : 'time-difference exact'}>⏱ Diferença de horário: {timing.label}</em>}
  </span>
}

function normalizedDateKey(value) {
  const match = String(value ?? '').match(/(\d{2})\/(\d{2})\/(\d{2,4})/)
  if (!match) return String(value ?? '')
  return `${match[1]}/${match[2]}/${match[3].slice(-2)}`
}

function timeDistanceSeconds(first, second) {
  const firstSeconds = secondsFromTime(first)
  const secondSeconds = secondsFromTime(second)
  return firstSeconds === null || secondSeconds === null ? Number.POSITIVE_INFINITY : Math.abs(firstSeconds - secondSeconds)
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'horário não informado'
  if (seconds === 0) return 'mesmo horário'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return [hours ? `${hours}h` : '', minutes ? `${minutes}min` : '', remainder && !hours ? `${remainder}s` : ''].filter(Boolean).join(' ')
}

function buildPendingCases(results, noSale, toleranceHours, history = []) {
  const receiptsByKey = new Map(noSale.map((receipt) => [reconciliationReceiptKey(receipt), receipt]))
  const cases = []
  results.forEach((row) => {
    if (!row.sale || row.status === 'DEVOLUCAO') return
    const timing = receiptTimeDifference(row)
    const issues = []
    if (row.manualUnmatch) issues.push('manual')
    if (row.status === 'SEM_RECEBIMENTO') issues.push('missing-receipt')
    if (row.status === 'DIVERGENCIA') issues.push('value')
    if (row.canalDivergente) issues.push('channel')
    if (row.recebimento && timing?.seconds > Number(toleranceHours || 0) * 3600) issues.push('time')
    if (!issues.length) return
    const manualReceipt = row.manualUnmatchReceiptKey ? receiptsByKey.get(row.manualUnmatchReceiptKey) : null
    const priority = issues.includes('manual') || issues.includes('missing-receipt') ? 1 : issues.includes('value') ? 2 : 3
    cases.push({
      id: `sale:${reconciliationSaleKey(row.sale)}`,
      kind: 'sale',
      priority,
      issues,
      sale: row.sale,
      receipt: row.recebimento || manualReceipt || null,
      row,
      value: Number(row.sale.valor || 0),
      title: row.manualUnmatch ? 'Desconciliado manualmente' : row.status === 'SEM_RECEBIMENTO' ? 'Venda sem recebimento' : row.status === 'DIVERGENCIA' ? 'Diferença de valor' : row.canalDivergente ? 'Canal divergente' : 'Horário fora da tolerância',
    })
  })
  noSale.filter((receipt) => !receipt.manualUnmatch).forEach((receipt, index) => {
    cases.push({
      id: `receipt:${reconciliationReceiptKey(receipt)}:${index}`,
      kind: 'receipt',
      priority: receipt.status === 'DUPLICADO' ? 2 : 1,
      issues: [receipt.status === 'DUPLICADO' ? 'duplicate' : 'missing-sale'],
      sale: null,
      receipt,
      row: receipt,
      value: Number(receipt.valor || 0),
      title: receipt.status === 'DUPLICADO' ? 'Possível recebimento duplicado' : 'Recebimento sem venda',
    })
  })
  cases.forEach((item) => {
    const saleKey = item.sale ? reconciliationSaleKey(item.sale) : ''
    const receiptKey = item.receipt ? reconciliationReceiptKey(item.receipt) : ''
    const related = history.filter((event) => (saleKey && event.saleKey === saleKey) || (receiptKey && event.receiptKey === receiptKey))
    const lastReview = related.find((event) => ['note', 'manual_match', 'unmatch', 'restore'].includes(event.type))
    item.reviewed = Boolean(lastReview)
    item.reviewNote = related.find((event) => event.type === 'note')?.description || lastReview?.description || ''
  })
  return cases.sort((first, second) => Number(first.reviewed) - Number(second.reviewed) || first.priority - second.priority || second.value - first.value)
}

function historyTypeLabel(type) {
  return ({ manual_match: 'Conciliação manual', unmatch: 'Conciliação desfeita', restore: 'Conciliação restaurada', note: 'Observação adicionada' })[type] || 'Alteração'
}

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

function StaffDirectory({ staff, onSave, onToggleActive, onDelete }) {
  const emptyForm = { id: '', name: '', trierCode: '', pagpixAliases: '' }
  const [form, setForm] = useState(emptyForm)
  const [message, setMessage] = useState('')
  const activeCount = staff.filter((person) => person.active !== false).length

  function submit(event) {
    event.preventDefault()
    const name = form.name.trim()
    const trierCode = form.trierCode.trim()
    const aliases = form.pagpixAliases.split(/[,;\n]/).map((alias) => alias.trim()).filter(Boolean)
    if (!name || !trierCode) { setMessage('Informe o nome e o número usado na Trier.'); return }
    if (!/^\d{1,4}$/.test(trierCode)) { setMessage('O número da Trier deve conter apenas dígitos.'); return }
    if (staff.some((person) => person.id !== form.id && String(person.trierCode) === trierCode)) { setMessage('Esse número da Trier já pertence a outro vendedor.'); return }
    onSave({ id: form.id || `staff-${Date.now()}`, name, trierCode, pagpixAliases: aliases.length ? aliases : [name], active: true })
    setForm(emptyForm)
    setMessage('Cadastro salvo. A identificação foi atualizada nos relatórios já importados.')
  }

  function edit(person) {
    setForm({ id: person.id, name: person.name, trierCode: String(person.trierCode ?? ''), pagpixAliases: (person.pagpixAliases ?? []).join(', ') })
    setMessage('')
  }

  function remove(person) {
    if (!onDelete(person)) return
    if (form.id === person.id) setForm(emptyForm)
    setMessage(`${person.name} foi apagado da equipe. Relatórios históricos continuam preservados.`)
  }

  return <details className="staff-directory no-print">
    <summary><span className="staff-directory-icon">♟</span><span><b>Equipe e identificação dos vendedores</b><small>{activeCount} ativo(s) · relacione o número da Trier ao nome exibido no PaggPix</small></span><strong>Gerenciar equipe</strong></summary>
    <div className="staff-directory-body">
      <form className="staff-form" onSubmit={submit}>
        <div className="staff-form-heading"><div><span className="section-kicker">Cadastro local</span><b>{form.id ? 'Editar vendedor' : 'Adicionar vendedor'}</b></div>{form.id && <button type="button" onClick={() => { setForm(emptyForm); setMessage('') }}>Cancelar edição</button>}</div>
        <label>Nome do vendedor<input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ex.: João Victor" /></label>
        <label>Número na Trier<input inputMode="numeric" value={form.trierCode} onChange={(event) => setForm((current) => ({ ...current, trierCode: event.target.value.replace(/\D/g, '') }))} placeholder="Ex.: 20" /></label>
        <label>Nome(s) no PaggPix<input value={form.pagpixAliases} onChange={(event) => setForm((current) => ({ ...current, pagpixAliases: event.target.value }))} placeholder="Ex.: João Victor, Joao V." /><small>Separe por vírgula quando o nome aparecer escrito de mais de uma forma.</small></label>
        <button className="staff-save" type="submit">{form.id ? 'Salvar alterações' : 'Adicionar à equipe'}</button>
        {message && <p className="staff-message">{message}</p>}
      </form>
      <div className="staff-list">{[...staff].sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || a.name.localeCompare(b.name, 'pt-BR')).map((person) => <article className={person.active === false ? 'inactive' : ''} key={person.id}><div><b>{person.name}</b><small>Trier nº {person.trierCode} · PaggPix: {(person.pagpixAliases ?? []).join(', ') || person.name}</small></div><span>{person.active === false ? 'Inativo' : 'Ativo'}</span><button type="button" onClick={() => edit(person)}>Editar</button><button type="button" onClick={() => onToggleActive(person.id)}>{person.active === false ? 'Reativar' : 'Desativar'}</button><button type="button" className="staff-delete" onClick={() => remove(person)}>Apagar</button></article>)}</div>
    </div>
  </details>
}

function SavedReportsPanel({ files, savedAt, restoring, message, onClear }) {
  const loadedReports = Object.entries(SOURCES).filter(([key]) => files[key])
  const savedDate = savedAt ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(savedAt)) : ''

  return <section className="saved-reports-panel no-print" aria-live="polite">
    <div className="saved-reports-heading">
      <span className="saved-reports-icon" aria-hidden="true">↻</span>
      <div><span className="section-kicker">Histórico no navegador</span><strong>{restoring ? 'Restaurando seus relatórios...' : loadedReports.length ? 'Relatórios salvos automaticamente' : 'Importe uma vez e continue depois'}</strong><small>{loadedReports.length ? `${loadedReports.length} relatório(s) disponível(is) neste navegador${savedDate ? ` · salvo em ${savedDate}` : ''}.` : 'Os próximos relatórios importados ficarão guardados somente neste dispositivo.'}</small></div>
      {loadedReports.length > 0 && <button type="button" onClick={onClear}>Limpar histórico</button>}
    </div>
    {loadedReports.length > 0 && <div className="saved-reports-list">{loadedReports.map(([key, report]) => <article key={key}><span>✓</span><div><b>{SOURCES[key].title}</b><small title={report.fileName}>{report.fileName} · {report.rows?.length ?? 0} linhas</small></div></article>)}</div>}
    {message && <p className="saved-reports-message">{message}</p>}
  </section>
}

function ReviewToolbar({ rows, markers, reviewFilter, onReviewFilter, onSetAll, staff, selectedStaff, onSelectedStaff, timeStart, timeEnd, onTimeStart, onTimeEnd }) {
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
      <details className="review-advanced-filters"><summary>Filtrar colaboradores e horário{selectedStaff.length || timeStart || timeEnd ? ` · ${selectedStaff.length} colaborador(es)` : ''}</summary><div className="review-advanced-body"><fieldset><legend>Colaboradores — selecione um ou mais</legend><div className="review-staff-options">{staff.map((person) => <label key={person.id} className={selectedStaff.includes(person.id) ? 'selected' : ''}><input type="checkbox" checked={selectedStaff.includes(person.id)} onChange={() => onSelectedStaff(selectedStaff.includes(person.id) ? selectedStaff.filter((id) => id !== person.id) : [...selectedStaff, person.id])} /><span>{person.name}</span><small>nº {person.trierCode}</small></label>)}</div></fieldset><div className="review-time-range"><label>De<input type="time" value={timeStart} onChange={(event) => onTimeStart(event.target.value)} /></label><label>Até<input type="time" value={timeEnd} onChange={(event) => onTimeEnd(event.target.value)} /></label><button type="button" onClick={() => { onSelectedStaff([]); onTimeStart(''); onTimeEnd('') }}>Limpar filtros</button></div></div></details>
    </div>
  </div>
}

function AnalystMarker({ marker, onOpen, staff }) {
  const collaborators = (marker?.staffIds ?? []).map((id) => staff.find((person) => person.id === id)?.name).filter(Boolean)
  const details = [collaborators.join(', '), marker?.resolvedTime, marker?.note].filter(Boolean).join(' · ')
  return <button type="button" className={marker ? 'analyst-marker marked' : 'analyst-marker'} onClick={onOpen} aria-pressed={Boolean(marker)} title={details || (marker ? 'Editar revisão deste registro' : 'Registrar motivo identificado')}>
    <span>{marker ? '✓' : '○'}</span><span>{marker ? 'Revisado' : 'Revisar'}{marker && details && <small>{details}</small>}</span>
  </button>
}

function ReconciliationAction({ row, onUnconcile, onRestore }) {
  if (row.manualUnmatch && onRestore) return <button type="button" className="reconciliation-action restore" onClick={() => onRestore(row)} title="Voltar a considerar este par na conciliação">↶ Restaurar</button>
  if (row.recebimento && onUnconcile) return <button type="button" className="reconciliation-action" onClick={() => onUnconcile(row)} title="Desfazer esta conciliação e devolver aos pendentes">↶ Desconciliar</button>
  return null
}

function ReviewEditor({ entry, staff, onSave, onRemove, onClose }) {
  const marker = entry.marker ?? {}
  const [staffIds, setStaffIds] = useState(marker.staffIds ?? [])
  const [resolvedTime, setResolvedTime] = useState(marker.resolvedTime || entry.defaultTime || '')
  const [note, setNote] = useState(marker.note ?? '')
  const selectableStaff = staff.filter((person) => person.active !== false || staffIds.includes(person.id))
  return <div className="review-modal-backdrop no-print" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-modal-title"><div className="review-modal-heading"><div><span className="section-kicker">Revisão manual</span><h3 id="review-modal-title">Registrar motivo localizado</h3><p>Essa informação fica salva neste navegador e acompanha as exportações.</p></div><button type="button" onClick={onClose} aria-label="Fechar">×</button></div><form onSubmit={(event) => { event.preventDefault(); onSave(entry.key, { ...marker, markedAt: marker.markedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), staffIds, resolvedTime, note: note.trim() }); onClose() }}><fieldset><legend>Colaboradores envolvidos</legend><div className="review-modal-staff">{selectableStaff.map((person) => <label key={person.id} className={staffIds.includes(person.id) ? 'selected' : ''}><input type="checkbox" checked={staffIds.includes(person.id)} onChange={() => setStaffIds((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id])} /><span>{person.name}</span><small>Trier nº {person.trierCode}</small></label>)}</div></fieldset><label>Horário em que o lançamento foi localizado<input type="time" value={resolvedTime} onChange={(event) => setResolvedTime(event.target.value)} /></label><label>Observação<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ex.: recebimento localizado no fechamento do caixa seguinte; horário informado incorretamente." /></label><div className="review-modal-actions">{entry.marker && <button className="review-reopen" type="button" onClick={() => { onRemove(entry.key); onClose() }}>Reabrir como pendente</button>}<button type="button" onClick={onClose}>Cancelar</button><button className="review-confirm" type="submit">Salvar como revisado</button></div></form></section></div>
}

function SalesTable({ rows, markers = {}, onSaveMarker, onRemoveMarker, onSetMarkers, markerKind, staff = DEFAULT_STAFF, viewKey = 'vendas', onUnconcile, onRestore }) {
  const { filters, setFilters, reviewFilter, setReviewFilter, selectedStaff, setSelectedStaff, timeStart, setTimeStart, timeEnd, setTimeEnd, scrollRef, saveScroll, activeFilterCount, clearTableFilters } = usePersistentTableUi(viewKey)
  const [editingReview, setEditingReview] = useState(null)
  const columns = [
    { key: 'sale', label: 'Nº venda', value: (row) => row.sale.numero },
    { key: 'date', label: 'Data', value: (row) => row.sale.data },
    { key: 'saleTime', label: 'Hora venda', value: (row) => row.sale.hora || '—' },
    { key: 'operator', label: 'Vendedor Trier', value: (row) => staffNameForRow(row.sale, 'Trier', staff) },
    { key: 'receiptOperator', label: 'Operador PaggPix', value: (row) => row.recebimento && row.fonte === 'PaggPix' ? staffNameForRow(row.recebimento, 'PaggPix', staff) : '—' },
    { key: 'method', label: 'Forma', value: (row) => row.sale.forma || '—' },
    { key: 'channel', label: 'Canal Trier', value: trierChannel },
    { key: 'channelComparison', label: 'Conferência do canal', value: channelComparison, render: (row) => <ChannelComparison row={row} /> },
    { key: 'saleValue', label: 'Valor venda', value: (row) => formatMoney(row.sale.valor) },
    { key: 'receivedValue', label: 'Valor recebido', value: (row) => row.recebimento ? formatMoney(row.recebimento.valor) : '—' },
    { key: 'source', label: 'Origem', value: (row) => row.fonte || '—' },
    { key: 'receivedTime', label: 'Hora receb.', value: (row) => row.recebimento?.hora || '—' },
    { key: 'difference', label: 'Diferença', value: (row) => row.diff !== undefined ? formatMoney(row.diff) : '—' },
    { key: 'status', label: 'Status', value: (row) => STATUS_LABEL[row.status], render: (row) => <StatusPill status={row.status} /> },
    ...((onUnconcile || onRestore) ? [{ key: 'reconciliationAction', label: 'Ação', filterable: false, value: () => '', render: (row) => <ReconciliationAction row={row} onUnconcile={onUnconcile} onRestore={onRestore} /> }] : []),
    ...(markerKind ? [{ key: 'analysis', label: 'Análise', filterable: false, value: () => '', render: (row) => <AnalystMarker marker={markers[row.__markerKey]} staff={staff} onOpen={() => setEditingReview({ key: row.__markerKey, marker: markers[row.__markerKey], defaultTime: row.sale.hora })} /> }] : []),
  ]
  const { orderedColumns, moveColumn, shiftColumn } = useReorderableColumns(columns, 'drogaria-center:trier:sales-column-order:v1')
  const keyedRows = rowsWithMarkerKeys(rows, markerKind)
  const columnFilteredRows = columnFilter(keyedRows, columns, filters)
  const filteredRows = columnFilteredRows.filter((row) => {
    if (markerKind && reviewFilter !== 'all' && (reviewFilter === 'marked') !== Boolean(markers[row.__markerKey])) return false
    const seller = staffForRow(row.sale, 'Trier', staff)
    if (selectedStaff.length && (!seller || !selectedStaff.includes(seller.id))) return false
    return timeIsInRange(row.sale.hora, timeStart, timeEnd)
  })
  if (!rows.length) return <EmptyTable />
  return <>{markerKind && <ReviewToolbar rows={keyedRows} markers={markers} reviewFilter={reviewFilter} onReviewFilter={setReviewFilter} onSetAll={onSetMarkers} staff={staff} selectedStaff={selectedStaff} onSelectedStaff={setSelectedStaff} timeStart={timeStart} timeEnd={timeEnd} onTimeStart={setTimeStart} onTimeEnd={setTimeEnd} />}<div className="table-meta"><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} registro(s).{activeFilterCount > 0 && <span className="active-filter-count">{activeFilterCount} filtro(s) ativo(s)</span>}</div><div className="table-meta-actions no-print">{activeFilterCount > 0 && <button type="button" className="clear-table-filters" onClick={clearTableFilters}>Limpar filtros</button>}<div className="column-order-hint">⠿ Arraste uma coluna ou use as setas para reorganizar</div></div></div><Table scrollRef={scrollRef} onScroll={saveScroll}><thead><tr>{orderedColumns.map((column, index) => <ReorderableColumnHeader key={column.key} column={column} index={index} total={orderedColumns.length} onMove={moveColumn} onShift={shiftColumn} />)}</tr><FilterRow tableId={`sales-filter-${viewKey}`} columns={orderedColumns} rows={keyedRows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((row) => { const sale = row.sale; const marker = markers[row.__markerKey]; return <tr className={marker ? 'manually-reconciled' : ''} key={row.__markerKey || `${sale.numero}-${row.status}`}>{orderedColumns.map((column) => <td key={column.key}>{column.render ? column.render(row) : column.value(row)}</td>)}</tr> })}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={orderedColumns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table>{editingReview && <ReviewEditor key={editingReview.key} entry={editingReview} staff={staff} onSave={onSaveMarker} onRemove={onRemoveMarker} onClose={() => setEditingReview(null)} />}</>
}

function DiscountAuditTable({ rows, staff = DEFAULT_STAFF }) {
  const [filters, setFilters] = useState({})
  const columns = [
    { key: 'sale', label: 'Nº venda', value: (sale) => sale.numero },
    { key: 'date', label: 'Data', value: (sale) => sale.data },
    { key: 'time', label: 'Hora', value: (sale) => sale.hora || '—' },
    { key: 'operator', label: 'Vendedor Trier', value: (sale) => staffNameForRow(sale, 'Trier', staff) },
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

function NoSaleTable({ rows, markers = {}, onSaveMarker, onRemoveMarker, onSetMarkers, markerKind, staff = DEFAULT_STAFF, viewKey = 'recebimentos', onRestore }) {
  const { filters, setFilters, reviewFilter, setReviewFilter, selectedStaff, setSelectedStaff, timeStart, setTimeStart, timeEnd, setTimeEnd, scrollRef, saveScroll, activeFilterCount, clearTableFilters } = usePersistentTableUi(viewKey)
  const [editingReview, setEditingReview] = useState(null)
  const columns = [
    { key: 'source', label: 'Origem', value: (row) => row.fonte },
    { key: 'date', label: 'Data', value: (row) => row.data },
    { key: 'time', label: 'Hora', value: (row) => row.hora || '—' },
    { key: 'operator', label: 'Operador PaggPix', value: (row) => row.fonte === 'PaggPix' ? staffNameForRow(row, 'PaggPix', staff) : '—' },
    { key: 'type', label: 'Tipo/Bandeira', value: (row) => row.tipo || row.bandeira || '—' },
    { key: 'value', label: 'Valor', value: (row) => formatMoney(row.valor) },
    { key: 'status', label: 'Status', value: (row) => STATUS_LABEL[row.status], render: (row) => <StatusPill status={row.status} /> },
    ...(onRestore ? [{ key: 'reconciliationAction', label: 'Ação', filterable: false, value: () => '', render: (row) => <ReconciliationAction row={row} onRestore={onRestore} /> }] : []),
    ...(markerKind ? [{ key: 'analysis', label: 'Análise', filterable: false, value: () => '', render: (row) => <AnalystMarker marker={markers[row.__markerKey]} staff={staff} onOpen={() => setEditingReview({ key: row.__markerKey, marker: markers[row.__markerKey], defaultTime: row.hora })} /> }] : []),
  ]
  const { orderedColumns, moveColumn, shiftColumn } = useReorderableColumns(columns, 'drogaria-center:trier:no-sale-column-order:v1')
  const keyedRows = rowsWithMarkerKeys(rows, markerKind)
  const columnFilteredRows = columnFilter(keyedRows, columns, filters)
  const filteredRows = columnFilteredRows.filter((row) => {
    if (markerKind && reviewFilter !== 'all' && (reviewFilter === 'marked') !== Boolean(markers[row.__markerKey])) return false
    const seller = row.fonte === 'PaggPix' ? staffForRow(row, 'PaggPix', staff) : null
    if (selectedStaff.length && (!seller || !selectedStaff.includes(seller.id))) return false
    return timeIsInRange(row.hora, timeStart, timeEnd)
  })
  if (!rows.length) return <EmptyTable />
  return <>{markerKind && <ReviewToolbar rows={keyedRows} markers={markers} reviewFilter={reviewFilter} onReviewFilter={setReviewFilter} onSetAll={onSetMarkers} staff={staff} selectedStaff={selectedStaff} onSelectedStaff={setSelectedStaff} timeStart={timeStart} timeEnd={timeEnd} onTimeStart={setTimeStart} onTimeEnd={setTimeEnd} />}<div className="table-meta"><div className="filter-result">Exibindo {filteredRows.length} de {rows.length} registro(s).{activeFilterCount > 0 && <span className="active-filter-count">{activeFilterCount} filtro(s) ativo(s)</span>}</div><div className="table-meta-actions no-print">{activeFilterCount > 0 && <button type="button" className="clear-table-filters" onClick={clearTableFilters}>Limpar filtros</button>}<div className="column-order-hint">⠿ Arraste uma coluna ou use as setas para reorganizar</div></div></div><Table scrollRef={scrollRef} onScroll={saveScroll}><thead><tr>{orderedColumns.map((column, index) => <ReorderableColumnHeader key={column.key} column={column} index={index} total={orderedColumns.length} onMove={moveColumn} onShift={shiftColumn} />)}</tr><FilterRow tableId={`no-sale-filter-${viewKey}`} columns={orderedColumns} rows={keyedRows} filters={filters} onChange={(key, value) => setFilters((current) => ({ ...current, [key]: value }))} /></thead><tbody>
    {filteredRows.map((row, index) => { const marker = markers[row.__markerKey]; return <tr className={marker ? 'manually-reconciled' : ''} key={row.__markerKey || `${row.fonte}-${row.data}-${row.hora}-${row.valor}-${index}`}>{orderedColumns.map((column) => <td key={column.key}>{column.render ? column.render(row) : column.value(row)}</td>)}</tr> })}
    {!filteredRows.length && <tr className="empty-row"><td colSpan={orderedColumns.length}>Nenhum registro corresponde aos filtros.</td></tr>}
  </tbody></Table>{editingReview && <ReviewEditor key={editingReview.key} entry={editingReview} staff={staff} onSave={onSaveMarker} onRemove={onRemoveMarker} onClose={() => setEditingReview(null)} />}</>
}

const ISSUE_LABELS = {
  manual: 'Desfeito manualmente',
  'missing-receipt': 'Sem recebimento',
  'missing-sale': 'Sem venda',
  value: 'Valor divergente',
  channel: 'Canal divergente',
  time: 'Horário distante',
  duplicate: 'Possível duplicidade',
}

function PendingCenter({ cases, history, staff, onOpen }) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLocaleLowerCase('pt-BR')
  const visibleCases = cases.filter((item) => {
    if (filter === 'critical' && item.priority !== 1) return false
    if (filter === 'reviewed' && !item.reviewed) return false
    if (filter === 'unreviewed' && item.reviewed) return false
    if (!['all', 'critical', 'reviewed', 'unreviewed'].includes(filter) && !item.issues.includes(filter)) return false
    if (!normalizedSearch) return true
    const searchable = [item.title, item.sale?.numero, item.sale?.data, item.sale?.hora, item.sale?.valor, item.sale?.operador, item.receipt?.data, item.receipt?.hora, item.receipt?.valor, item.receipt?.fonte, item.receipt?.tipo, item.receipt?.bandeira].join(' ').toLocaleLowerCase('pt-BR')
    return searchable.includes(normalizedSearch)
  })
  const criticalCount = cases.filter((item) => item.priority === 1).length
  const affectedValue = cases.filter((item) => item.priority === 1).reduce((sum, item) => sum + item.value, 0)

  return <section className="pending-center">
    <div className="pending-center-hero"><div><span className="section-kicker">Fila de trabalho</span><h3>Central de pendências</h3><p>Comece pelos casos prioritários. Clique em uma ocorrência para comparar os dados lado a lado e registrar a decisão.</p></div><div className="pending-center-kpis"><article><small>Pendências</small><strong>{cases.length}</strong></article><article className="critical"><small>Prioridade alta</small><strong>{criticalCount}</strong></article><article><small>Valor em análise</small><strong>{formatMoney(affectedValue)}</strong></article></div></div>
    <div className="pending-center-tools no-print"><label className="pending-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar venda, valor, horário, vendedor ou origem" /></label><div className="pending-filter-list">{[['all', 'Todos'], ['unreviewed', 'Ainda não vistos'], ['reviewed', 'Já analisados'], ['critical', 'Prioridade alta'], ['missing-receipt', 'Sem recebimento'], ['missing-sale', 'Sem venda'], ['value', 'Valor'], ['channel', 'Canal'], ['time', 'Horário']].map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div></div>
    <div className="pending-center-layout"><div className="pending-case-list">{visibleCases.map((item) => <button type="button" className={`pending-case priority-${item.priority}${item.reviewed ? ' reviewed' : ''}`} key={item.id} onClick={() => onOpen(item)}><span className="pending-priority">{item.reviewed ? '✓ Visto' : item.priority === 1 ? 'Alta' : item.priority === 2 ? 'Média' : 'Revisar'}</span><div className="pending-case-main"><strong>{item.title}</strong><b>{item.sale ? `Venda ${item.sale.numero}` : `${item.receipt.fonte} · recebimento`}</b><small>{item.sale ? `${item.sale.data} · ${item.sale.hora || 'sem horário'} · ${staffNameForRow(item.sale, 'Trier', staff)}` : `${item.receipt.data} · ${item.receipt.hora || 'sem horário'} · ${item.receipt.tipo || item.receipt.bandeira || 'tipo não informado'}`}</small>{item.reviewNote && <small className="pending-review-note">✓ {item.reviewNote}</small>}<span className="pending-tags">{item.issues.map((issue) => <i key={issue}>{ISSUE_LABELS[issue]}</i>)}</span></div><div className="pending-case-value"><strong>{formatMoney(item.value)}</strong>{item.receipt && item.sale && <small>Receb.: {formatMoney(item.receipt.valor)}</small>}<span>Investigar →</span></div></button>)}{!visibleCases.length && <div className="pending-empty"><span>✓</span><b>Nenhuma ocorrência corresponde a esse filtro.</b></div>}</div>
      <aside className="change-history"><div><span className="section-kicker">Rastreabilidade</span><h4>Histórico de alterações</h4><p>As decisões ficam salvas neste navegador.</p></div><div className="history-list">{history.slice(0, 12).map((entry) => <article key={entry.id}><span className={`history-dot ${entry.type}`} /><div><b>{historyTypeLabel(entry.type)}</b><small>{entry.saleNumber ? `Venda ${entry.saleNumber} · ` : ''}{entry.description}</small><time>{new Date(entry.timestamp).toLocaleString('pt-BR')}</time></div></article>)}{!history.length && <div className="history-empty">As próximas conciliações, desfazimentos e observações aparecerão aqui.</div>}</div></aside>
    </div>
  </section>
}

function InvestigationModal({ entry, files, results, noSale, manualReceipts, toleranceHours, history, staff, onClose, onMatch, onUnconcile, onRestore, onAddNote }) {
  const [note, setNote] = useState('')
  const [selectedReceiptKeys, setSelectedReceiptKeys] = useState([])
  const [manualDrafts, setManualDrafts] = useState([])
  const sale = entry.sale
  const receipt = entry.receipt
  const [manualPayment, setManualPayment] = useState(() => ({ tipo: 'Dinheiro', valor: '', data: sale?.data || '', hora: sale?.hora || '', descricao: '' }))

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' || event.key === 'Esc') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const source = sale?.forma === 'PIX' ? 'PaggPix' : sale?.forma === 'CARTAO' ? 'Cielo' : receipt?.fonte
  const acceptedStatus = source === 'PaggPix' ? 'PAGO' : 'APROVADA'
  const availableReceiptKeys = new Set(noSale.map(reconciliationReceiptKey))
  const currentReceiptKey = receipt ? reconciliationReceiptKey(receipt) : ''
  const rawReceipts = source === 'PaggPix' ? (files.pagpix?.rows ?? []) : source === 'Cielo' ? (files.cielo?.rows ?? []) : []
  const storedManualReceipts = sale ? Object.values(manualReceipts ?? {}).filter((item) => item.saleKey === reconciliationSaleKey(sale)) : []
  const receiptCandidates = sale ? [...rawReceipts
    .filter((item) => item.status === acceptedStatus && normalizedDateKey(item.data) === normalizedDateKey(sale.data))
    .map((item) => {
      const candidate = { ...item, fonte: source }
      const valueDifference = Math.abs(Number(candidate.valor || 0) - Number(sale.valor || 0))
      const timeDifference = timeDistanceSeconds(candidate.hora, sale.hora)
      const key = reconciliationReceiptKey(candidate)
      return { receipt: candidate, key, valueDifference, timeDifference, available: availableReceiptKeys.has(key) || key === currentReceiptKey, current: key === currentReceiptKey }
    })
    .sort((first, second) => Number(second.current) - Number(first.current) || first.valueDifference - second.valueDifference || first.timeDifference - second.timeDifference)
    .slice(0, 20), ...[...storedManualReceipts, ...manualDrafts].map((candidate) => ({
      receipt: candidate,
      key: reconciliationReceiptKey(candidate),
      valueDifference: Math.abs(Number(candidate.valor || 0) - Number(sale.valor || 0)),
      timeDifference: timeDistanceSeconds(candidate.hora, sale.hora),
      available: true,
      current: false,
      manual: true,
    }))] : []
  const saleCandidates = receipt ? results
    .filter((item) => item.status === 'SEM_RECEBIMENTO' && item.sale && ((receipt.fonte === 'PaggPix' && item.sale.forma === 'PIX') || (receipt.fonte === 'Cielo' && item.sale.forma === 'CARTAO')) && normalizedDateKey(item.sale.data) === normalizedDateKey(receipt.data))
    .map((item) => ({ row: item, valueDifference: Math.abs(Number(item.sale.valor || 0) - Number(receipt.valor || 0)), timeDifference: timeDistanceSeconds(item.sale.hora, receipt.hora) }))
    .sort((first, second) => first.valueDifference - second.valueDifference || first.timeDifference - second.timeDifference)
    .slice(0, 8) : []
  const saleKey = sale ? reconciliationSaleKey(sale) : entry.row?.manualUnmatchSaleKey || ''
  const receiptKey = receipt ? reconciliationReceiptKey(receipt) : ''
  const relatedHistory = history.filter((item) => (saleKey && item.saleKey === saleKey) || (receiptKey && item.receiptKey === receiptKey)).slice(0, 8)
  const selectedReceipts = receiptCandidates.filter((candidate) => selectedReceiptKeys.includes(candidate.key)).map((candidate) => candidate.receipt)
  const selectedTotal = selectedReceipts.reduce((sum, item) => sum + Number(item.valor || 0), 0)
  const selectedDifference = sale ? +(Number(sale.valor || 0) - selectedTotal).toFixed(2) : 0

  function toggleReceipt(candidate) {
    if (candidate.current) return
    setSelectedReceiptKeys((current) => current.includes(candidate.key) ? current.filter((key) => key !== candidate.key) : [...current, candidate.key])
  }

  function receiptMethod(item) {
    if (item.tipo) return item.bandeira ? `${item.tipo} · ${item.bandeira}` : item.tipo
    if (/D[ÉE]BITO/i.test(item.raw || '')) return `Débito${item.bandeira ? ` · ${item.bandeira}` : ''}`
    if (/CR[ÉE]DITO/i.test(item.raw || '')) return `Crédito${item.bandeira ? ` · ${item.bandeira}` : ''}`
    return item.bandeira || 'Recebimento'
  }

  function addManualPayment() {
    const value = Number(String(manualPayment.valor).replace(/\./g, '').replace(',', '.'))
    if (!sale || !Number.isFinite(value) || value <= 0 || !manualPayment.data) return
    const createdAt = new Date().toISOString()
    const draft = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      saleKey,
      fonte: 'Manual',
      status: 'MANUAL',
      tipo: manualPayment.tipo,
      valor: +value.toFixed(2),
      data: manualPayment.data,
      hora: manualPayment.hora,
      raw: `Pagamento informado manualmente | ${manualPayment.tipo} | ${manualPayment.descricao || 'sem observação'} | ${createdAt}`,
      createdAt,
    }
    const key = reconciliationReceiptKey(draft)
    setManualDrafts((current) => [...current, draft])
    setSelectedReceiptKeys((current) => [...current, key])
    setManualPayment((current) => ({ ...current, valor: '', descricao: '' }))
  }

  return <div className="investigation-backdrop no-print" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="investigation-modal" role="dialog" aria-modal="true" aria-labelledby="investigation-title"><header><div><span className="section-kicker">Investigação lado a lado</span><h3 id="investigation-title">{entry.title}</h3><p>Compare valor, horário, canal e operador. Você pode somar vários recebimentos para uma única venda.</p></div><div className="investigation-close"><small>Esc para sair</small><button type="button" onClick={onClose} aria-label="Fechar investigação">×</button></div></header>
    <div className="investigation-columns"><article className="investigation-primary"><span>{sale ? 'Venda Trier' : 'Recebimento sem venda'}</span>{sale ? <><h4>Venda {sale.numero}</h4><dl><div><dt>Valor</dt><dd>{formatMoney(sale.valor)}</dd></div><div><dt>Data e hora</dt><dd>{sale.data} · {sale.hora || '—'}</dd></div><div><dt>Forma</dt><dd>{sale.forma}</dd></div><div><dt>Canal</dt><dd>{sale.forma === 'PIX' ? (sale.tele === 'Sim' ? 'Delivery' : 'Balcão') : '—'}</dd></div><div><dt>Vendedor</dt><dd>{staffNameForRow(sale, 'Trier', staff)}</dd></div></dl></> : <><h4>{receipt.fonte}</h4><dl><div><dt>Valor</dt><dd>{formatMoney(receipt.valor)}</dd></div><div><dt>Data e hora</dt><dd>{receipt.data} · {receipt.hora || '—'}</dd></div><div><dt>Tipo</dt><dd>{receipt.tipo || receipt.bandeira || '—'}</dd></div></dl></>}{entry.issues.length > 0 && <div className="investigation-alerts">{entry.issues.map((issue) => <span key={issue}>{ISSUE_LABELS[issue]}</span>)}</div>}{entry.row?.manualUnmatch && <button type="button" className="investigation-restore" onClick={() => onRestore(entry.row)}>↶ Restaurar conciliação automática</button>}{sale && entry.row?.recebimento && !entry.row?.manualUnmatch && <button type="button" className="investigation-unmatch" onClick={() => onUnconcile(entry.row)}>↶ Desconciliar este par</button>}</article>
      <div className="candidate-panel"><div className="candidate-heading"><div><span>{sale ? 'Possíveis recebimentos' : 'Possíveis vendas'}</span><b>{sale ? receiptCandidates.length : saleCandidates.length} opção(ões) mais próximas</b></div><small>{sale ? 'Marque uma ou mais opções' : 'Ordenadas por valor e horário'}</small></div><div className="candidate-list">{sale && receiptCandidates.map((candidate) => <article className={`${candidate.current ? 'current' : !candidate.available ? 'unavailable' : ''}${selectedReceiptKeys.includes(candidate.key) ? ' selected' : ''}`} key={candidate.key}><div><b>{candidate.receipt.fonte} · {receiptMethod(candidate.receipt)}</b><small>{candidate.receipt.data} · {candidate.receipt.hora || '—'}</small><span>Diferença de horário: {formatDuration(candidate.timeDifference)}</span>{!candidate.available && !candidate.current && <span className="candidate-reassign-warning">Usado em outra venda — pode ser reatribuído manualmente</span>}</div><div className="candidate-price"><strong>{formatMoney(candidate.receipt.valor)}</strong><small>Dif. individual: {formatMoney(candidate.valueDifference)}</small>{candidate.current ? <em>Vínculo atual</em> : <button type="button" className={selectedReceiptKeys.includes(candidate.key) ? 'selected' : ''} onClick={() => toggleReceipt(candidate)}>{selectedReceiptKeys.includes(candidate.key) ? '✓ Selecionado' : candidate.available ? '+ Selecionar' : '↔ Reatribuir'}</button>}</div></article>)}{!sale && saleCandidates.map((candidate) => <article key={reconciliationSaleKey(candidate.row.sale)}><div><b>Venda {candidate.row.sale.numero}</b><small>{candidate.row.sale.data} · {candidate.row.sale.hora || '—'} · {staffNameForRow(candidate.row.sale, 'Trier', staff)}</small><span>Diferença de horário: {formatDuration(candidate.timeDifference)}</span></div><div className="candidate-price"><strong>{formatMoney(candidate.row.sale.valor)}</strong><small>Dif.: {formatMoney(candidate.valueDifference)}</small><button type="button" onClick={() => onMatch(candidate.row.sale, [receipt])}>Conciliar com esta venda</button></div></article>)}{!(sale ? receiptCandidates.length : saleCandidates.length) && <div className="candidate-empty">Nenhuma opção compatível foi encontrada para a mesma data e forma de pagamento.</div>}</div>{sale && <><div className="selected-receipts-summary"><div><small>Selecionados</small><strong>{selectedReceipts.length} recebimento(s) · {formatMoney(selectedTotal)}</strong><span className={Math.abs(selectedDifference) < .005 ? 'exact' : ''}>Diferença para a venda: {formatMoney(selectedDifference)}</span></div><button type="button" disabled={!selectedReceipts.length} onClick={() => onMatch(sale, selectedReceipts)}>Conciliar selecionados</button></div><details className="manual-payment"><summary>+ Acrescentar outra forma de pagamento</summary><div className="manual-payment-grid"><label>Forma<select value={manualPayment.tipo} onChange={(event) => setManualPayment((current) => ({ ...current, tipo: event.target.value }))}><option>Dinheiro</option><option>PIX</option><option>Cartão de crédito</option><option>Cartão de débito</option><option>Outro pagamento</option></select></label><label>Valor<input inputMode="decimal" value={manualPayment.valor} onChange={(event) => setManualPayment((current) => ({ ...current, valor: event.target.value }))} placeholder="0,00" /></label><label>Data<input value={manualPayment.data} onChange={(event) => setManualPayment((current) => ({ ...current, data: event.target.value }))} placeholder="dd/mm/aaaa" /></label><label>Hora<input type="time" value={manualPayment.hora} onChange={(event) => setManualPayment((current) => ({ ...current, hora: event.target.value }))} /></label><label className="manual-payment-description">Descrição opcional<input value={manualPayment.descricao} onChange={(event) => setManualPayment((current) => ({ ...current, descricao: event.target.value }))} placeholder="Ex.: cliente completou em dinheiro" /></label><button type="button" disabled={!manualPayment.valor || !manualPayment.data} onClick={addManualPayment}>Adicionar à seleção</button></div></details></>}<p className="candidate-tolerance">Tolerância configurada: {toleranceHours}h. Opções fora da tolerância continuam visíveis para revisão, mas só são usadas após confirmação manual.</p></div></div>
    <div className="investigation-footer"><div className="investigation-note"><label>Observação da análise<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Ex.: pagamento localizado em horário diferente; confirmado com o operador." /></label><button type="button" disabled={!note.trim()} onClick={() => { onAddNote(entry, note.trim()); setNote('') }}>Salvar observação</button></div><aside><b>Histórico deste registro</b>{relatedHistory.map((item) => <p key={item.id}><span>{historyTypeLabel(item.type)}</span><small>{item.description} · {new Date(item.timestamp).toLocaleString('pt-BR')}</small></p>)}{!relatedHistory.length && <small>Nenhuma alteração registrada ainda.</small>}</aside></div>
  </section></div>
}

function Table({ children, scrollRef, onScroll }) { return <div className="table-frame"><div className="table-scroll" ref={scrollRef} onScroll={onScroll}><table>{children}</table></div></div> }
function EmptyTable() { return <div className="table-frame p-7 text-center text-sm text-muted">Nada nessa categoria.</div> }

function ClosingCreditSummary({ groups }) {
  if (!groups.length) return null
  return <div className="closing-credit-groups">{groups.map((group, index) => <article key={`${group.data}-${group.valor}-${index}`} className={group.conciliado ? 'matched' : 'pending'}><div><span>{group.conciliado ? '✓ Conciliado pelo fechamento' : '! Valor ainda não localizado'}</span><strong>Contas recebidas crediário (Cartão)</strong><small>Fechamento de {group.data}</small></div><dl><div><dt>Informado</dt><dd>{formatMoney(group.valor)}</dd></div><div><dt>Encontrado na Cielo</dt><dd>{formatMoney(group.totalEncontrado)}</dd></div><div><dt>Recebimentos</dt><dd>{group.quantidadeRecebimentos}</dd></div><div><dt>Diferença</dt><dd>{formatMoney(group.diff)}</dd></div></dl></article>)}</div>
}

function markerExportFields(marker, staff, applicable = true) {
  return {
    'Revisão do analista': applicable ? (marker ? 'Revisado' : 'Pendente') : '',
    'Data da revisão': marker?.markedAt ? new Date(marker.markedAt).toLocaleString('pt-BR') : '',
    'Colaboradores envolvidos': (marker?.staffIds ?? []).map((id) => staff.find((person) => person.id === id)?.name).filter(Boolean).join(', '),
    'Horário localizado': marker?.resolvedTime || '',
    'Observação da revisão': marker?.note || '',
  }
}

function exportRows(output, markers = {}, staff = DEFAULT_STAFF) {
  const sales = rowsWithMarkerKeys(output.results, 'sem_recebimento')
  const receipts = rowsWithMarkerKeys(output.semVenda, 'sem_venda')
  const closingReceipts = output.crediarioCartao ?? []
  return [
    ...sales.map((row) => ({
      'Número da venda': row.sale.numero, Data: row.sale.data, 'Hora da venda': row.sale.hora || '', 'Vendedor Trier': staffNameForRow(row.sale, 'Trier', staff), 'Operador PaggPix': row.recebimento && row.fonte === 'PaggPix' ? staffNameForRow(row.recebimento, 'PaggPix', staff) : '', 'Forma de pagamento': row.sale.forma || '', 'Canal Trier': trierChannel(row) === '—' ? '' : trierChannel(row), 'Canal do recebimento': receiptChannel(row) === '—' ? '' : receiptChannel(row), 'Conferência de canal': channelComparison(row) === '—' ? '' : channelComparison(row), 'Valor da venda': row.sale.valor, 'Valor recebido': row.recebimento?.valor ?? '', Origem: row.fonte || '', 'Hora do recebimento': row.recebimento?.hora || '', 'Diferença de valor': row.diff ?? '', Status: STATUS_LABEL[row.status], 'Motivo da conciliação': row.motivo || '', 'Ação manual': row.manualMatch ? 'Conciliado manualmente' : row.manualUnmatch ? 'Desconciliado manualmente' : '', ...markerExportFields(markers[row.__markerKey], staff, row.status === 'SEM_RECEBIMENTO'),
    })),
    ...receipts.map((row) => ({
      'Número da venda': '', Data: row.data, 'Hora da venda': '', 'Vendedor Trier': '', 'Operador PaggPix': row.fonte === 'PaggPix' ? staffNameForRow(row, 'PaggPix', staff) : '', 'Forma de pagamento': '', 'Canal Trier': '', 'Canal do recebimento': row.tipo || row.bandeira || '', 'Conferência de canal': '', 'Valor da venda': '', 'Valor recebido': row.valor, Origem: row.fonte, 'Hora do recebimento': row.hora || '', 'Diferença de valor': '', Status: STATUS_LABEL[row.status], 'Motivo da conciliação': row.motivo || '', 'Ação manual': row.manualUnmatch ? 'Desconciliado manualmente' : '', ...markerExportFields(markers[row.__markerKey], staff),
    })),
    ...closingReceipts.map((row) => ({
      'Número da venda': '', Data: row.data, 'Hora da venda': '', 'Vendedor Trier': '', 'Operador PaggPix': '', 'Forma de pagamento': '', 'Canal Trier': '', 'Canal do recebimento': row.tipo || row.bandeira || '', 'Conferência de canal': '', 'Valor da venda': '', 'Valor recebido': row.valor, Origem: 'Cielo / Fechamento de Caixa', 'Hora do recebimento': row.hora || '', 'Diferença de valor': '', Status: STATUS_LABEL[row.status], ...markerExportFields(null, staff, false),
    })),
  ]
}

function downloadCsv(output, markers, staff) {
  const rows = exportRows(output, markers, staff); if (!rows.length) return
  const headers = Object.keys(rows[0]); const content = [headers.join(';'), ...rows.map((row) => headers.map((key) => String(row[key]).replace(/[;\r\n]+/g, ' ')).join(';'))].join('\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: 'concilia_trier.csv' }); link.click(); URL.revokeObjectURL(url)
}

async function downloadExcel(output, markers, staff) {
  const rows = exportRows(output, markers, staff); if (!rows.length) return
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

  return <button type="button" className="pwa-install-button" onClick={install}><img src={assetPath('pwa/favicon-32.png')} alt="" />Instalar aplicativo</button>
}

function HomeScreen({ onSelect }) {
  return <main className="app-shell home-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="home-topbar"><div className="brand-logo-wrap"><img className="brand-logo" src={assetPath('drogaria-center-logo.png')} alt="Drogaria Center" /></div><div className="home-topbar-actions"><PwaInstallButton /><div className="local-chip home-chip"><span />Sistemas internos</div></div></header>
    <section className="home-hero"><p className="brand-kicker">Utilitários - Drogaria Center</p><h1>Olá! O que vamos<br />fazer hoje?</h1><p>Escolha uma ferramenta para começar. Tudo foi pensado para tornar a rotina da farmácia mais simples.</p></section>
    <section className="system-grid" aria-label="Sistemas disponíveis">
      <button className="system-card system-card-reconcile" onClick={() => onSelect('trier')}><span className="system-icon" aria-hidden="true">↔</span><span className="system-label">Financeiro</span><strong>Conciliação Trier</strong><small>Compare vendas, PIX e cartões em um só lugar.</small><span className="system-action">Abrir conciliação <b aria-hidden="true">→</b></span></button>
      <button className="system-card system-card-posters" onClick={() => onSelect('cartazes')}><span className="system-icon" aria-hidden="true">✦</span><span className="system-label">Comunicação visual</span><strong>Cartazes de oferta</strong><small>Crie cartazes prontos para imprimir e expor na farmácia.</small><span className="system-action">Criar cartazes <b aria-hidden="true">→</b></span></button>
      <button className="system-card system-card-quotes" onClick={() => onSelect('cotacao')}><span className="system-icon" aria-hidden="true">⌁</span><span className="system-label">Compras</span><strong>Cotação de medicamentos</strong><small>Compare fornecedores e escolha o melhor preço para cada item do pedido.</small><span className="system-action">Abrir cotação <b aria-hidden="true">→</b></span></button>
    </section>
    <p className="home-support">Mais ferramentas serão adicionadas aqui conforme a operação da Drogaria Center evoluir.</p>
    <footer className="app-footer"><img src={assetPath('drogaria-center-logo.png')} alt="Drogaria Center" /><span>Ferramentas simples para a rotina da farmácia.</span></footer>
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
  canvas.width = 1334
  canvas.height = 2000
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const backgroundWidth = background.naturalWidth || background.width || canvas.width
  const backgroundHeight = background.naturalHeight || background.height || canvas.height
  const backgroundScale = Math.min(canvas.width / backgroundWidth, canvas.height / backgroundHeight)
  const renderedBackgroundWidth = backgroundWidth * backgroundScale
  const renderedBackgroundHeight = backgroundHeight * backgroundScale
  context.drawImage(background, (canvas.width - renderedBackgroundWidth) / 2, (canvas.height - renderedBackgroundHeight) / 2, renderedBackgroundWidth, renderedBackgroundHeight)

  const scale = canvas.width / 1334
  const x = (value) => value * scale
  const y = (value) => value * scale
  const titleWidth = x(1110)
  const titleAreaTop = y(390)
  const titleAreaBottom = y(750)
  let fontSize = x(106)
  let lines = []
  while (fontSize >= x(55)) {
    context.font = `900 ${fontSize}px Arial, sans-serif`
    lines = titleLines(context, values.product, titleWidth)
    const titleBlockHeight = Math.min(lines.length, 3) * fontSize * .92
    if (lines.length <= 3 && titleBlockHeight <= titleAreaBottom - titleAreaTop) break
    fontSize -= x(5)
  }
  const lineHeight = fontSize * .92
  const titleCenter = (titleAreaTop + titleAreaBottom) / 2
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
    const portrait = page.canvas.height >= page.canvas.width
    const pageWidth = portrait ? 595.28 : 841.89
    const pageHeight = portrait ? 841.89 : 595.28
    const printMargin = 28.35
    const printableWidth = pageWidth - printMargin * 2
    const printableHeight = pageHeight - printMargin * 2
    const imageScale = Math.min(printableWidth / page.canvas.width, printableHeight / page.canvas.height)
    const imageWidth = page.canvas.width * imageScale
    const imageHeight = page.canvas.height * imageScale
    const imageX = (pageWidth - imageWidth) / 2
    const imageY = (pageHeight - imageHeight) / 2
    const content = encode(`q\n${imageWidth.toFixed(3)} 0 0 ${imageHeight.toFixed(3)} ${imageX.toFixed(3)} ${imageY.toFixed(3)} cm\n/Poster${page.imageObject} Do\nQ\n`)
    objects.push(
      { id: page.pageObject, value: encode(`${page.pageObject} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /CropBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Poster${page.imageObject} ${page.imageObject} 0 R >> >> /Contents ${page.contentObject} 0 R >>\nendobj\n`) },
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
  const [backgroundInfo, setBackgroundInfo] = useState({ name: 'Modelo oficial', custom: false, width: 1334, height: 2000 })
  const [backgroundLoading, setBackgroundLoading] = useState(false)
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
  const [batchExporting, setBatchExporting] = useState('')

  function loadPosterBackground(source, info, objectUrl = false) {
    setBackgroundLoading(true)
    const image = new Image()
    image.onload = () => {
      setBackground(image)
      setBackgroundInfo({ ...info, width: image.naturalWidth, height: image.naturalHeight })
      setRenderError('')
      setBackgroundLoading(false)
      if (objectUrl) URL.revokeObjectURL(source)
    }
    image.onerror = () => {
      setRenderError(info.custom ? 'Não foi possível abrir essa imagem. Use um arquivo PNG, JPG ou WEBP válido.' : 'Não foi possível carregar o modelo oficial do cartaz.')
      setBackgroundLoading(false)
      if (objectUrl) URL.revokeObjectURL(source)
    }
    image.src = source
  }

  function restoreOfficialBackground() {
    loadPosterBackground(assetPath('oferta-background.png'), { name: 'Modelo oficial', custom: false })
  }

  function importPosterBackground(file) {
    if (!file) return
    const validImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name)
    if (!validImage) { setRenderError('Escolha uma imagem PNG, JPG ou WEBP.'); return }
    if (file.size > 20 * 1024 * 1024) { setRenderError('A imagem deve ter no máximo 20 MB.'); return }
    loadPosterBackground(URL.createObjectURL(file), { name: file.name, custom: true }, true)
  }

  useEffect(() => {
    restoreOfficialBackground()
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
      setBatchExporting(format)
      if (format === 'pdf') saveBlob(await postersPdfBlob(createBatchPages()), `cartazes-oferta-${batchOffers.length}-itens.pdf`)
      else if (format === 'zip') {
        const { default: JSZip } = await import('jszip')
        const pages = createBatchPages()
        const zip = new JSZip()
        const digits = String(pages.length).length
        const blobs = await Promise.all(pages.map((page) => canvasBlob(page, 'image/png')))
        blobs.forEach((blob, index) => zip.file(`cartazes-oferta-pagina-${String(index + 1).padStart(digits, '0')}-de-${pages.length}.png`, blob))
        const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
        saveBlob(archive, `cartazes-oferta-${batchOffers.length}-itens-${pages.length}-paginas.zip`)
      } else saveBlob(await canvasBlob(batchCanvasRef.current, 'image/png'), `cartazes-oferta-pagina-${batchPage + 1}.png`)
    } catch (exception) { setRenderError(exception.message || 'Não foi possível gerar o arquivo do lote.') }
    finally { setBatchExporting('') }
  }

  return <main className="app-shell home-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="home-topbar"><button className="back-button" onClick={onBack}>← Todos os sistemas</button><div className="brand-logo-wrap"><img className="brand-logo" src={assetPath('drogaria-center-logo.png')} alt="Drogaria Center" /></div></header>
    <section className="poster-heading"><div><p className="brand-kicker">Comunicação visual</p><h1>Gerador de cartazes de oferta</h1><p>Crie um cartaz individual ou importe uma planilha para montar várias ofertas de uma vez.</p></div><span className="poster-live"><i />Prévia ao vivo</span></section>
    <div className="poster-mode-toggle" role="tablist" aria-label="Modo de criação"><button role="tab" aria-selected={mode === 'individual'} className={mode === 'individual' ? 'active' : ''} onClick={() => setMode('individual')}>Cartaz individual</button><button role="tab" aria-selected={mode === 'batch'} className={mode === 'batch' ? 'active' : ''} onClick={() => setMode('batch')}>Lote por XLS</button></div>
    <section className="poster-background-tool no-print"><div className="poster-background-status"><span className="section-kicker">Imagem de fundo</span><b title={backgroundInfo.name}>{backgroundInfo.name}</b><small>{backgroundInfo.width} × {backgroundInfo.height}px · formato recomendado: 1334 × 2000px</small></div><div className="poster-background-actions"><label className="poster-background-upload">{backgroundLoading ? 'Carregando...' : '↥ Substituir imagem'}<input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={(event) => { importPosterBackground(event.target.files?.[0]); event.target.value = '' }} /></label>{backgroundInfo.custom && <button type="button" onClick={restoreOfficialBackground}>Restaurar modelo oficial</button>}</div></section>
    {mode === 'individual' ? <section className="poster-studio"><form className="poster-form" onSubmit={(event) => event.preventDefault()}><div className="poster-form-title"><span className="future-icon" aria-hidden="true">✦</span><div><span className="section-kicker">Dados da oferta</span><h2>Monte seu cartaz</h2></div></div><label>Nome do produto<textarea value={values.product} maxLength="70" onChange={(event) => setValues((current) => ({ ...current, product: event.target.value }))} placeholder="Ex.: SONRIDOR RAPID+FORTE 4CP REV" /></label><div className="price-fields"><label>Preço anterior<input inputMode="decimal" value={values.oldPrice} onChange={(event) => setValues((current) => ({ ...current, oldPrice: event.target.value }))} placeholder="7,99" /></label><label>Preço da oferta<input inputMode="decimal" value={values.price} onChange={(event) => setValues((current) => ({ ...current, price: event.target.value }))} placeholder="1,99" /></label></div><div className="individual-print-settings"><label>Quantidade de cartazes<input type="number" min="1" max="999" step="1" value={individualQuantity} onChange={(event) => { setIndividualQuantity(event.target.value); setIndividualPage(0) }} onBlur={() => setIndividualQuantity(normalizedIndividualQuantity)} /></label><label className="items-per-page">Tamanho na folha A4<select value={individualItemsPerPage} onChange={(event) => { setIndividualItemsPerPage(Number(event.target.value)); setIndividualPage(0) }}><option value="2">2 por página · maior</option><option value="4">4 por página · grande</option><option value="6">6 por página · médio</option><option value="8">8 por página · pequeno</option><option value="10">10 por página · menor</option><option value="12">12 por página · compacto</option></select></label></div><p className="poster-tip">O PDF inclui todas as cópias em folhas A4. PNG e JPG baixam a página exibida na prévia.</p><div className="download-actions"><button type="button" disabled={!background} onClick={() => downloadPoster('pdf')}>⇩ PDF completo</button><button type="button" disabled={!background} onClick={() => downloadPoster('png')}>⇩ PNG da página</button><button type="button" disabled={!background} onClick={() => downloadPoster('jpg')}>⇩ JPG da página</button></div>{renderError && <p className="poster-error" role="alert">{renderError}</p>}</form><section className="poster-preview-panel"><div className="poster-preview-label"><span>Prévia da folha A4</span><small>A4 {individualOrientation} · {individualItemsPerPage} por página · Página {individualPage + 1} de {totalIndividualPages}</small></div><div className="poster-canvas-wrap individual-a4-canvas-wrap"><canvas ref={canvasRef} aria-label="Prévia da folha A4 com cartazes de oferta" /></div><div className="batch-pagination"><button type="button" disabled={individualPage === 0} onClick={() => setIndividualPage((page) => page - 1)}>← Anterior</button><span>{visibleIndividualCount} cartazes nesta página</span><button type="button" disabled={individualPage + 1 >= totalIndividualPages} onClick={() => setIndividualPage((page) => page + 1)}>Próxima →</button></div></section></section> : <section className="poster-studio batch-studio"><form className="poster-form" onSubmit={(event) => event.preventDefault()}><div className="poster-form-title"><span className="future-icon" aria-hidden="true">▦</span><div><span className="section-kicker">Lote de ofertas</span><h2>Importe sua planilha</h2></div></div><label className="batch-upload">{batchLoading ? 'Lendo a planilha...' : 'Selecionar arquivo XLS ou XLSX'}<input type="file" accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => importOffers(event.target.files?.[0])} /></label>{batchFileName && <div className="batch-file-status"><b>{batchFileName}</b><span>{batchOffers.length} ofertas identificadas</span></div>}<label className="items-per-page">Cartazes por página<select value={itemsPerPage} onChange={(event) => { setItemsPerPage(Number(event.target.value)); setBatchPage(0) }}><option value="1">1 por página</option><option value="2">2 por página</option><option value="4">4 por página</option><option value="6">6 por página</option><option value="8">8 por página (referência)</option><option value="9">9 por página</option><option value="10">10 por página</option><option value="12">12 por página</option></select></label><p className="poster-tip">O PDF inclui todas as páginas. Para imagens, baixe a página exibida ou um ZIP único com todos os PNGs em alta resolução.</p><div className="download-actions"><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('pdf')}>{batchExporting === 'pdf' ? 'Gerando PDF...' : '⇩ PDF completo'}</button><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('zip')}>{batchExporting === 'zip' ? `Gerando ${totalBatchPages} páginas...` : '⇩ Todas as páginas (ZIP)'}</button><button type="button" disabled={!background || !batchOffers.length || batchExporting} onClick={() => downloadBatch('png')}>{batchExporting === 'png' ? 'Gerando PNG...' : '⇩ PNG da página atual'}</button></div>{renderError && <p className="poster-error" role="alert">{renderError}</p>}</form><section className="poster-preview-panel"><div className="poster-preview-label"><span>Prévia do lote</span><small>{batchOffers.length ? `Página ${batchPage + 1} de ${totalBatchPages}` : 'Aguardando planilha'}</small></div>{batchOffers.length ? <><div className="poster-canvas-wrap batch-canvas-wrap"><canvas ref={batchCanvasRef} aria-label="Prévia da página de cartazes" /></div><div className="batch-pagination"><button type="button" disabled={batchPage === 0} onClick={() => setBatchPage((page) => page - 1)}>← Anterior</button><span>{visibleBatchOffers.length} cartazes nesta página</span><button type="button" disabled={batchPage + 1 >= totalBatchPages} onClick={() => setBatchPage((page) => page + 1)}>Próxima →</button></div></> : <div className="batch-empty"><span>▦</span><b>Envie uma planilha para visualizar o lote.</b><small>Você poderá escolher quantos cartazes saem em cada página.</small></div>}</section></section>}
    <footer className="app-footer"><img src={assetPath('drogaria-center-logo.png')} alt="Drogaria Center" /><span>Cartazes de oferta prontos para imprimir.</span></footer>
  </div></main>
}

export default function App() {
  const [activeSystem, setActiveSystem] = useState(() => systemFromPathname(window.location.pathname))
  const [files, setFiles] = useState(EMPTY_FILES)
  const [toleranceValue, setToleranceValue] = useState(0.5)
  const [toleranceHours, setToleranceHours] = useState(2)
  const [output, setOutput] = useState(null)
  const [tab, setTab] = useState(loadResultTab)
  const [error, setError] = useState('')
  const [analystMarkers, setAnalystMarkers] = useState(loadAnalystMarkers)
  const [manualUnmatches, setManualUnmatches] = useState({})
  const [manualMatches, setManualMatches] = useState({})
  const [manualReceipts, setManualReceipts] = useState({})
  const [reconciliationHistory, setReconciliationHistory] = useState([])
  const [investigatingCase, setInvestigatingCase] = useState(null)
  const [staff, setStaff] = useState(loadStaffDirectory)
  const [discountMode, setDiscountMode] = useState('percent')
  const [discountPercentThreshold, setDiscountPercentThreshold] = useState(30)
  const [discountValueThreshold, setDiscountValueThreshold] = useState(20)
  const [discountAudit, setDiscountAudit] = useState(null)
  const [historyReady, setHistoryReady] = useState(false)
  const [historySavedAt, setHistorySavedAt] = useState('')
  const [historyMessage, setHistoryMessage] = useState('')
  const canRun = files.trier && (files.pagpix || files.cielo)

  useEffect(() => {
    window.localStorage.setItem(ANALYST_MARKERS_STORAGE_KEY, JSON.stringify(analystMarkers))
  }, [analystMarkers])

  useEffect(() => { window.localStorage.setItem(STAFF_STORAGE_KEY, JSON.stringify(staff)) }, [staff])

  useEffect(() => {
    try { window.localStorage.setItem(RESULT_TAB_STORAGE_KEY, tab) }
    catch { /* mantém a troca de abas funcionando mesmo sem armazenamento */ }
  }, [tab])

  useEffect(() => {
    let active = true
    loadReconciliationSession().then((saved) => {
      if (!active || !saved?.files) return
      const restoredFiles = Object.fromEntries(Object.keys(EMPTY_FILES).map((key) => [key, saved.files[key] || null]))
      const restoredValueTolerance = saved.toleranceValue ?? 0.5
      const restoredHourTolerance = saved.toleranceHours ?? 2
      const restoredManualUnmatches = saved.manualUnmatches && typeof saved.manualUnmatches === 'object' ? saved.manualUnmatches : {}
      const restoredManualMatches = saved.manualMatches && typeof saved.manualMatches === 'object' ? saved.manualMatches : {}
      const restoredManualReceipts = saved.manualReceipts && typeof saved.manualReceipts === 'object' ? saved.manualReceipts : {}
      const restoredHistory = Array.isArray(saved.reconciliationHistory) ? saved.reconciliationHistory : []
      setFiles(restoredFiles)
      setToleranceValue(restoredValueTolerance)
      setToleranceHours(restoredHourTolerance)
      setManualUnmatches(restoredManualUnmatches)
      setManualMatches(restoredManualMatches)
      setManualReceipts(restoredManualReceipts)
      setReconciliationHistory(restoredHistory)
      setHistorySavedAt(saved.savedAt || '')
      setHistoryMessage('Última sessão restaurada. Você pode trocar qualquer relatório quando quiser.')
      if (restoredFiles.trier && (restoredFiles.pagpix || restoredFiles.cielo)) {
        try {
          setOutput(reconcile(restoredFiles, Number(restoredValueTolerance) || 0, Number(restoredHourTolerance) || 0, restoredManualUnmatches, restoredManualMatches, restoredManualReceipts))
        } catch {
          setHistoryMessage('Os relatórios foram restaurados. Execute a conciliação para atualizar o resultado.')
        }
      }
    }).finally(() => { if (active) setHistoryReady(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!historyReady || !Object.values(files).some(Boolean)) return undefined
    const timer = window.setTimeout(() => {
      saveReconciliationSession({ files, toleranceValue, toleranceHours, manualUnmatches, manualMatches, manualReceipts, reconciliationHistory })
        .then(() => {
          setHistorySavedAt(new Date().toISOString())
          setHistoryMessage('Histórico atualizado automaticamente neste navegador.')
        })
        .catch(() => setHistoryMessage('Não foi possível salvar o histórico neste navegador. Verifique se o armazenamento local está permitido.'))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [files, toleranceValue, toleranceHours, manualUnmatches, manualMatches, manualReceipts, reconciliationHistory, historyReady])

  function saveStaffMember(person) {
    setStaff((current) => current.some((item) => item.id === person.id) ? current.map((item) => item.id === person.id ? { ...item, ...person } : item) : [...current, person])
  }

  function toggleStaffActive(personId) {
    setStaff((current) => current.map((person) => person.id === personId ? { ...person, active: person.active === false } : person))
  }

  function deleteStaffMember(person) {
    if (!window.confirm(`Apagar ${person.name} da equipe? O cadastro será removido deste navegador, mas os dados dos relatórios já importados não serão apagados.`)) return false
    setStaff((current) => current.filter((item) => item.id !== person.id))
    return true
  }

  async function clearSavedHistory() {
    if (!window.confirm('Limpar os relatórios salvos neste navegador? Os arquivos importados e o resultado atual serão removidos.')) return
    try {
      await clearReconciliationSession()
      setFiles({ ...EMPTY_FILES })
      setOutput(null)
      setManualUnmatches({})
      setManualMatches({})
      setManualReceipts({})
      setReconciliationHistory([])
      setInvestigatingCase(null)
      setDiscountAudit(null)
      setError('')
      setHistorySavedAt('')
      setHistoryMessage('Histórico removido deste navegador.')
    } catch {
      setHistoryMessage('Não foi possível limpar o histórico. Tente novamente.')
    }
  }

  function saveAnalystMarker(markerKey, marker) {
    setAnalystMarkers((current) => ({ ...current, [markerKey]: marker }))
  }

  function removeAnalystMarker(markerKey) {
    setAnalystMarkers((current) => { const next = { ...current }; delete next[markerKey]; return next })
  }

  function setAnalystMarkerGroup(markerKeys, shouldMark) {
    setAnalystMarkers((current) => {
      const next = { ...current }
      if (shouldMark) {
        const markedAt = new Date().toISOString()
        markerKeys.forEach((markerKey) => { next[markerKey] = next[markerKey] || { markedAt, staffIds: [], resolvedTime: '', note: '' } })
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
      // A manual decision belongs to the exact set of imported reports. When
      // any source is replaced, start the review links from a clean state.
      setManualUnmatches({})
      setManualMatches({})
      setManualReceipts({})
      setInvestigatingCase(null)
      if (key === 'trier') setDiscountAudit(null)
      if (!lines.length) setError(`Não consegui extrair nenhum texto de “${file.name}”. Se for um PDF escaneado (imagem), será necessário OCR.`)
      else if (key !== 'fechamento' && !rows.length) setError(`Li ${lines.length} linhas de “${file.name}”, mas não reconheci registros no formato esperado. Abra “Ver linhas extraídas” para revisar o conteúdo.`)
    } catch (exception) { setError(`Não consegui ler “${file.name}”. Confira se é um PDF válido e contém texto. Detalhe: ${exception.message || exception}`) }
  }

  function runReconciliation() {
    setError('')
    try { setOutput(reconcile(files, Number(toleranceValue) || 0, Number(toleranceHours) || 0, manualUnmatches, manualMatches, manualReceipts)) }
    catch (exception) { setOutput(null); setError(exception.message) }
  }

  function appendReconciliationHistory(type, sale, receipt, description) {
    const entry = {
      id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      saleKey: sale ? reconciliationSaleKey(sale) : '',
      receiptKey: receipt ? reconciliationReceiptKey(receipt) : '',
      saleNumber: sale?.numero || '',
      description,
    }
    setReconciliationHistory((current) => [entry, ...current].slice(0, 300))
  }

  function recalculateWithOverrides(nextManualUnmatches, nextManualMatches, nextManualReceipts = manualReceipts, nextTab = tab) {
    try {
      const nextOutput = reconcile(files, Number(toleranceValue) || 0, Number(toleranceHours) || 0, nextManualUnmatches, nextManualMatches, nextManualReceipts)
      setManualUnmatches(nextManualUnmatches)
      setManualMatches(nextManualMatches)
      setManualReceipts(nextManualReceipts)
      setOutput(nextOutput)
      setTab(nextTab)
      setHistoryMessage('A decisão manual foi salva neste navegador.')
      setInvestigatingCase(null)
      return true
    } catch (exception) {
      setError(exception.message || 'Não foi possível atualizar a conciliação.')
      return false
    }
  }

  function handleUnconcile(row) {
    if (!row?.sale || !row?.recebimento) return
    const saleKey = reconciliationSaleKey(row.sale)
    const receipts = row.recebimentos?.length ? row.recebimentos : [row.recebimento]
    const receiptKeys = receipts.map(reconciliationReceiptKey).filter(Boolean)
    if (!saleKey || !receiptKeys.length) return
    const saleLabel = row.sale.numero ? `venda ${row.sale.numero}` : 'esta venda'
    if (!window.confirm(`Desconciliar ${saleLabel}? A venda voltará para “Sem recebimento” e o recebimento para “Sem venda”.`)) return
    const nextMatches = { ...manualMatches }
    delete nextMatches[saleKey]
    const nextUnmatches = { ...manualUnmatches, [saleKey]: { saleKey, receiptKey: receiptKeys[0], receiptKeys, createdAt: new Date().toISOString() } }
    if (recalculateWithOverrides(nextUnmatches, nextMatches, manualReceipts, 'pendencias')) appendReconciliationHistory('unmatch', row.sale, receipts[0], `${receipts.length} recebimento(s), somando ${formatMoney(receipts.reduce((sum, item) => sum + Number(item.valor || 0), 0))}, foram separados da venda.`)
  }

  function handleRestoreReconciliation(row) {
    const saleKey = row?.manualUnmatchSaleKey || (row?.sale ? reconciliationSaleKey(row.sale) : '')
    if (!saleKey || !manualUnmatches[saleKey]) return
    const next = { ...manualUnmatches }
    const pair = next[saleKey]
    delete next[saleKey]
    const sale = row.sale || files.trier?.rows?.find((item) => reconciliationSaleKey(item) === saleKey)
    const receipt = [...(files.pagpix?.rows ?? []).map((item) => ({ ...item, fonte: 'PaggPix' })), ...(files.cielo?.rows ?? []).map((item) => ({ ...item, fonte: 'Cielo' })), ...Object.values(manualReceipts)].find((item) => reconciliationReceiptKey(item) === pair.receiptKey)
    if (recalculateWithOverrides(next, manualMatches, manualReceipts, 'pendencias')) appendReconciliationHistory('restore', sale, receipt, 'O bloqueio manual foi removido e o cálculo automático foi executado novamente.')
  }

  function handleManualMatch(sale, receiptList) {
    const receipts = (Array.isArray(receiptList) ? receiptList : [receiptList]).filter(Boolean).map((item) => ({ ...item, fonte: item.fonte || 'Manual' }))
    if (!sale || !receipts.length) return
    const saleKey = reconciliationSaleKey(sale)
    const receiptKeys = receipts.map(reconciliationReceiptKey)
    const total = receipts.reduce((sum, item) => sum + Number(item.valor || 0), 0)
    if (!window.confirm(`Conciliar manualmente a venda ${sale.numero} com ${receipts.length} recebimento(s), totalizando ${formatMoney(total)}? Se algum recebimento já estiver ligado a outra venda, ele será reatribuído e a outra venda voltará para análise.`)) return
    const overlaps = (pair) => (pair.receiptKeys || [pair.receiptKey]).some((key) => receiptKeys.includes(key))
    const nextMatches = Object.fromEntries(Object.entries(manualMatches).filter(([, pair]) => pair.saleKey !== saleKey && !overlaps(pair)))
    nextMatches[saleKey] = { saleKey, receiptKey: receiptKeys[0], receiptKeys, createdAt: new Date().toISOString() }
    const nextUnmatches = Object.fromEntries(Object.entries(manualUnmatches).filter(([, pair]) => pair.saleKey !== saleKey && !overlaps(pair)))
    const nextManualReceipts = { ...manualReceipts }
    receipts.filter((item) => item.fonte === 'Manual').forEach((item) => { nextManualReceipts[reconciliationReceiptKey(item)] = item })
    if (recalculateWithOverrides(nextUnmatches, nextMatches, nextManualReceipts, 'pendencias')) appendReconciliationHistory('manual_match', sale, receipts[0], `${receipts.length} recebimento(s), somando ${formatMoney(total)}, foram confirmados pelo analista: ${receipts.map((item) => item.tipo || item.fonte).join(' + ')}.`)
  }

  function handleInvestigationNote(entry, note) {
    appendReconciliationHistory('note', entry.sale, entry.receipt, note)
    setHistoryMessage('Observação adicionada ao histórico deste registro.')
  }

  function runDiscountAudit() {
    const threshold = discountMode === 'value' ? Number(discountValueThreshold) : Number(discountPercentThreshold)
    if (!files.trier?.rows?.length) { setError('Importe a Relação de Vendas Trier antes de verificar os descontos.'); return }
    if (!Number.isFinite(threshold) || threshold < 0) { setError('Informe um limite de desconto válido, igual ou maior que zero.'); return }
    setError('')
    setDiscountAudit({ mode: discountMode, threshold })
  }

  const results = output?.results ?? []; const noSale = output?.semVenda ?? []; const crediarioCartao = output?.crediarioCartao ?? []; const fechamentoCrediario = output?.fechamentoCrediario ?? []
  const pendingCases = buildPendingCases(results, noSale, toleranceHours, reconciliationHistory)
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
  const tabs = [['resumo', 'Resumo'], ['pendencias', `Central de pendências (${pendingCases.length})`], ['conciliada', `Conciliadas (${counts.reconciled})`], ['divergencia', `Divergências (${counts.divergent})`], ['sem_recebimento', `Sem recebimento (${counts.missing})`], ['sem_venda', `Sem venda (${noSale.length})`], ...(fechamentoCrediario.length ? [['crediario_cartao', `Crediário cartão (${crediarioCartao.length})`]] : []), ...(counts.returns ? [['devolucao', `Devoluções (${counts.returns})`]] : [])]

  useEffect(() => {
    if (output && !tabs.some(([key]) => key === tab)) setTab('resumo')
  }, [output, tab, tabs.map(([key]) => key).join('|')])

  useEffect(() => {
    const syncWithBrowserNavigation = () => setActiveSystem(systemFromPathname(window.location.pathname))
    window.addEventListener('popstate', syncWithBrowserNavigation)
    return () => window.removeEventListener('popstate', syncWithBrowserNavigation)
  }, [])

  function navigateTo(system) {
    const path = systemPath(system)
    if (window.location.pathname !== path) window.history.pushState({ system }, '', path)
    setActiveSystem(system)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (activeSystem === 'home') return <HomeScreen onSelect={navigateTo} />
  if (activeSystem === 'cartazes') return <CartazesScreen onBack={() => navigateTo('home')} />
  if (activeSystem === 'cotacao') return <CotacaoScreen onBack={() => navigateTo('home')} />

  return <main className="app-shell"><div className="brand-glow brand-glow-one" /><div className="brand-glow brand-glow-two" /><div className="app-container">
    <header className="brand-header">
      <div className="brand-topline"><div className="brand-logo-wrap"><img className="brand-logo" src={assetPath('drogaria-center-logo.png')} alt="Drogaria Center" /></div><div className="local-chip"><span />Processamento local</div></div>
      <div className="brand-content"><button className="back-button no-print" onClick={() => navigateTo('home')}>← Todos os sistemas</button><p className="brand-kicker">Conciliação financeira</p><h1>Vendas e recebimentos,<br />lado a lado.</h1><p className="sub">Cruze os relatórios Trier, PaggPix e Cielo com rapidez e encontre diferenças antes do fechamento.</p></div>
      <div className="hero-mark" aria-hidden="true">+</div>
    </header>
    <section className="section-heading no-print"><div><span className="section-kicker">Etapa 1</span><h2>Importe os relatórios</h2><p>Comece pela Relação de Vendas e adicione pelo menos uma fonte de recebimentos.</p></div><div className="privacy-note"><span>✓</span> Seus arquivos não saem deste dispositivo</div></section>
    <StaffDirectory staff={staff} onSave={saveStaffMember} onToggleActive={toggleStaffActive} onDelete={deleteStaffMember} />
    <SavedReportsPanel files={files} savedAt={historySavedAt} restoring={!historyReady} message={historyMessage} onClear={clearSavedHistory} />
    <section className="no-print upload-grid">{Object.entries(SOURCES).map(([key, source]) => <FileSlot key={key} source={source} file={files[key]} onFile={(file) => handleFile(key, file)} />)}</section>
    {error && <div role="alert" className="error-box">{error}</div>}
    <section className="no-print controls"><div className="controls-title"><span className="section-kicker">Etapa 2</span><strong>Defina as tolerâncias</strong></div><label>Tolerância de valor (R$)<input type="number" min="0" step="0.1" value={toleranceValue} onChange={(event) => setToleranceValue(event.target.value)} /></label><label>Tolerância de horário (h)<input type="number" min="0" step="0.5" value={toleranceHours} onChange={(event) => setToleranceHours(event.target.value)} /></label><button className="primary-button" disabled={!canRun} onClick={runReconciliation}><span>Executar conciliação</span><b aria-hidden="true">→</b></button></section>
    <section className="discount-audit-controls no-print"><div className="discount-audit-heading"><span className="discount-audit-icon">%</span><div><span className="section-kicker">Auditoria da Trier</span><strong>Verificar vendas com desconto alto</strong><small>Escolha um limite por percentual ou por valor. Devoluções não entram nessa análise.</small></div></div><div className="discount-audit-form"><div className="discount-mode-toggle" role="group" aria-label="Tipo do limite de desconto"><button type="button" className={discountMode === 'percent' ? 'active' : ''} aria-pressed={discountMode === 'percent'} onClick={() => setDiscountMode('percent')}>% Percentual</button><button type="button" className={discountMode === 'value' ? 'active' : ''} aria-pressed={discountMode === 'value'} onClick={() => setDiscountMode('value')}>R$ Valor</button></div><label>{discountMode === 'percent' ? 'Desconto mínimo (%)' : 'Desconto mínimo (R$)'}<input type="number" min="0" step={discountMode === 'percent' ? '0.1' : '0.01'} value={discountMode === 'percent' ? discountPercentThreshold : discountValueThreshold} onChange={(event) => discountMode === 'percent' ? setDiscountPercentThreshold(event.target.value) : setDiscountValueThreshold(event.target.value)} /></label><button type="button" className="discount-audit-button" disabled={!files.trier} onClick={runDiscountAudit}>Verificar descontos altos <b aria-hidden="true">→</b></button></div></section>
    {discountAudit && <section className="discount-audit-results"><div className="discount-results-heading"><div><span className="section-kicker">Resultado da auditoria</span><h2>Descontos altos</h2><p>Limite aplicado: <b>{discountAudit.mode === 'percent' ? `${discountAudit.threshold.toFixed(2).replace('.', ',')}%` : formatMoney(discountAudit.threshold)}</b>. A lista está ordenada do maior desconto para o menor.</p></div><button type="button" className="discount-close no-print" onClick={() => setDiscountAudit(null)}>Fechar análise</button></div><div className="discount-kpis"><article><small>Vendas encontradas</small><strong>{highDiscountRows.length}</strong></article><article><small>Total concedido</small><strong>{formatMoney(highDiscountTotal)}</strong></article><article><small>Maior percentual</small><strong>{highDiscountMaxPercent.toFixed(2).replace('.', ',')}%</strong></article></div>{highDiscountRows.length ? <DiscountAuditTable rows={highDiscountRows} staff={staff} /> : <div className="discount-empty"><span>✓</span><div><b>Nenhuma venda ultrapassou esse limite.</b><small>Você pode reduzir o percentual ou o valor e verificar novamente.</small></div></div>}</section>}
    {output && <section className="results-section"><div className="results-heading"><span className="section-kicker">Etapa 3</span><h2>Resultado da conciliação</h2><p>Revise os indicadores e filtre cada coluna para investigar os registros.</p></div><div className="kpi-grid">{kpis.map(([label, value]) => <div className="kpi" key={label}><div>{label}</div><strong>{value}</strong></div>)}</div>
      <div className="no-print tabs"><div className="tab-list">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>{label}</button>)}</div><div className="export-list"><button onClick={() => downloadCsv(output, analystMarkers, staff)}>⇩ CSV</button><button onClick={() => downloadExcel(output, analystMarkers, staff)}>⇩ Excel</button><button onClick={() => window.print()}>⇩ PDF</button></div></div>
      {tab === 'resumo' && <div className="summary-card">Das <b>{counts.total}</b> vendas eletrônicas da Relação de Vendas, <b className="text-green">{counts.reconciled}</b> foram conciliadas, <b className="text-amber">{counts.divergent}</b> tiveram divergência de valor dentro da tolerância e <b className="text-rust">{counts.missing}</b> não encontraram recebimento correspondente.{noSale.length > 0 && <><br /><br />Também foram encontrados <b className="text-rust">{noSale.length}</b> recebimentos sem venda correspondente, sendo <b>{counts.duplicates}</b> identificados como possível duplicidade.</>}{crediarioCartao.length > 0 && <><br /><br /><b className="text-green">{crediarioCartao.length}</b> recebimento(s) da Cielo, somando <b>{formatMoney(crediarioCartao.reduce((sum, row) => sum + row.valor, 0))}</b>, foram identificados como <b>Contas Recebidas Crediário (Cartão)</b> pelo Fechamento de Caixa.</>}{counts.returns > 0 && <><br /><br /><b>{counts.returns}</b> linha(s) de devolução não entraram na conciliação, pois não representam recebimento a buscar.</>}<br /><br />Use as abas para revisar cada grupo ou exporte a tabela final em Excel, CSV ou PDF.</div>}
      {tab === 'pendencias' && <PendingCenter cases={pendingCases} history={reconciliationHistory} staff={staff} onOpen={setInvestigatingCase} />}
      {tab === 'conciliada' && <SalesTable key="conciliada" viewKey="conciliada" rows={results.filter((row) => row.status === 'CONCILIADA')} staff={staff} onUnconcile={handleUnconcile} />}{tab === 'divergencia' && <SalesTable key="divergencia" viewKey="divergencia" rows={results.filter((row) => row.status === 'DIVERGENCIA')} staff={staff} onUnconcile={handleUnconcile} />}{tab === 'sem_recebimento' && <SalesTable key="sem_recebimento" viewKey="sem_recebimento" rows={results.filter((row) => row.status === 'SEM_RECEBIMENTO')} markers={analystMarkers} onSaveMarker={saveAnalystMarker} onRemoveMarker={removeAnalystMarker} onSetMarkers={setAnalystMarkerGroup} markerKind="sem_recebimento" staff={staff} onRestore={handleRestoreReconciliation} />}{tab === 'devolucao' && <SalesTable key="devolucao" viewKey="devolucao" rows={results.filter((row) => row.status === 'DEVOLUCAO')} staff={staff} />}{tab === 'sem_venda' && <NoSaleTable key="sem_venda" viewKey="sem_venda" rows={noSale} markers={analystMarkers} onSaveMarker={saveAnalystMarker} onRemoveMarker={removeAnalystMarker} onSetMarkers={setAnalystMarkerGroup} markerKind="sem_venda" staff={staff} onRestore={handleRestoreReconciliation} />}{tab === 'crediario_cartao' && <><ClosingCreditSummary groups={fechamentoCrediario} /><NoSaleTable key="crediario_cartao" viewKey="crediario_cartao" rows={crediarioCartao} staff={staff} /></>}
    </section>}
    {investigatingCase && <InvestigationModal entry={investigatingCase} files={files} results={results} noSale={noSale} manualReceipts={manualReceipts} toleranceHours={toleranceHours} history={reconciliationHistory} staff={staff} onClose={() => setInvestigatingCase(null)} onMatch={handleManualMatch} onUnconcile={handleUnconcile} onRestore={handleRestoreReconciliation} onAddNote={handleInvestigationNote} />}
    <footer className="app-footer"><img src={assetPath('drogaria-center-logo.png')} alt="Drogaria Center" /><span>Conciliação segura, simples e local.</span></footer>
  </div></main>
}
