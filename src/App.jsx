import { useRef, useState } from 'react'
import {
  extractPdfLines, formatMoney, operatorName, parseCieloLines, parsePagPixLines,
  parsePagPixSpreadsheet, parseTrierLines, parseTrierSpreadsheet, reconcile, STATUS_LABEL,
} from './reconciliation.js'

const EMPTY_FILES = { trier: null, pagpix: null, cielo: null, fechamento: null }
const SOURCES = {
  trier: { title: 'Relação de Vendas (Trier)', hint: 'Base principal — obrigatório', color: 'bg-ink' },
  pagpix: { title: 'Relatório Detalhado PaggPix', hint: 'Recebimentos PIX', color: 'bg-teal' },
  cielo: { title: 'Relatório Detalhado Cielo', hint: 'Recebimentos cartão', color: 'bg-amber' },
  fechamento: { title: 'Fechamento de Caixa', hint: 'Opcional', color: 'bg-muted' },
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
    <div className={`h-1 ${source.color}`} />
    <div className="p-5">
      <h2>{source.title}</h2>
      <p className="hint">{isPagPix ? `${source.hint} — PDF ou XLSX` : isTrier ? `${source.hint} — PDF ou XLS` : source.hint}</p>
      <input ref={input} className="hidden" type="file" accept={acceptedFiles} onChange={(event) => onFile(event.target.files?.[0])} />
      {!file ? <button className="dropzone" onClick={() => input.current?.click()}>↑ {uploadLabel}</button> : <>
        <div className="flex items-center justify-between gap-3 text-xs">
          <b className="truncate">{file.fileName}</b><span className="text-muted whitespace-nowrap">{file.rows.length} linhas</span>
        </div>
        <button className="swap-button" onClick={() => input.current?.click()}>Trocar arquivo</button>
        <button className="review-button" onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? 'Ocultar linhas extraídas' : 'Ver linhas extraídas (revisar)'}</button>
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

export default function App() {
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

  return <main className="min-h-screen bg-paper py-8"><div className="mx-auto w-full max-w-6xl px-5 pb-16">
    <header className="mb-7 flex items-center gap-3.5"><div className="badge">CT</div><div><h1>Concilia Trier — Drogaria Center</h1><p className="sub">Relação de Vendas Trier × Recebimentos PaggPix × Recebimentos Cielo</p></div></header>
    <section className="no-print grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-4">{Object.entries(SOURCES).map(([key, source]) => <FileSlot key={key} source={source} file={files[key]} onFile={(file) => handleFile(key, file)} />)}</section>
    {error && <div role="alert" className="error-box">{error}</div>}
    <section className="no-print controls"><label>Tolerância de valor (R$)<input type="number" min="0" step="0.1" value={toleranceValue} onChange={(event) => setToleranceValue(event.target.value)} /></label><label>Tolerância de horário (h)<input type="number" min="0" step="0.5" value={toleranceHours} onChange={(event) => setToleranceHours(event.target.value)} /></label><button className="primary-button" disabled={!canRun} onClick={runReconciliation}>Executar conciliação</button></section>
    {output && <section><div className="kpi-grid">{kpis.map(([label, value]) => <div className="kpi" key={label}><div>{label}</div><strong>{value}</strong></div>)}</div>
      <div className="no-print tabs"><div className="tab-list">{tabs.map(([key, label]) => <button key={key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>{label}</button>)}</div><div className="export-list"><button onClick={() => downloadCsv(output)}>⇩ CSV</button><button onClick={() => downloadExcel(output)}>⇩ Excel</button><button onClick={() => window.print()}>⇩ PDF</button></div></div>
      {tab === 'resumo' && <div className="summary-card">Das <b>{counts.total}</b> vendas eletrônicas da Relação de Vendas, <b className="text-green">{counts.reconciled}</b> foram conciliadas, <b className="text-amber">{counts.divergent}</b> tiveram divergência de valor dentro da tolerância e <b className="text-rust">{counts.missing}</b> não encontraram recebimento correspondente.{noSale.length > 0 && <><br /><br />Também foram encontrados <b className="text-rust">{noSale.length}</b> recebimentos sem venda correspondente, sendo <b>{counts.duplicates}</b> identificados como possível duplicidade.</>}{counts.returns > 0 && <><br /><br /><b>{counts.returns}</b> linha(s) de devolução não entraram na conciliação, pois não representam recebimento a buscar.</>}<br /><br />Use as abas para revisar cada grupo ou exporte a tabela final em Excel, CSV ou PDF.</div>}
      {tab === 'conciliada' && <SalesTable rows={results.filter((row) => row.status === 'CONCILIADA')} />}{tab === 'divergencia' && <SalesTable rows={results.filter((row) => row.status === 'DIVERGENCIA')} />}{tab === 'sem_recebimento' && <SalesTable rows={results.filter((row) => row.status === 'SEM_RECEBIMENTO')} />}{tab === 'devolucao' && <SalesTable rows={results.filter((row) => row.status === 'DEVOLUCAO')} />}{tab === 'sem_venda' && <NoSaleTable rows={noSale} />}
    </section>}
  </div></main>
}
