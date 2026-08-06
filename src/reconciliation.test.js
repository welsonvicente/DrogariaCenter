import test from 'node:test'
import assert from 'node:assert/strict'
import { findHighDiscountSales, parseCieloLines, parseFechamentoLines, parseTrierLines, reconcile } from './reconciliation.js'

const sampleLines = [
  '268648 1 CARTAO 30/07/26 07:20 65 83509 8 49,99 10,00 -5,00 44,99 44,99',
  '268669 1 PIX 30/07/26 08:37 65 83519 8 51,95 34,55 -17,95 34,00 34,00',
  '268711 1 CARTAO 30/07/26 09:41 65 83539 8 303,17 18,23 -55,26 247,91 247,91',
  '268696 1 CARTAO * Dev Sim 30/07/26 09:20 55 DELIVERY 4 16 -14,00 14,29 2,00 -12,00 -12,00',
]

test('extrai valor bruto, percentual e valor do desconto da Trier', () => {
  const sales = parseTrierLines(sampleLines)
  const sale = sales.find((item) => item.numero === '268711')
  assert.equal(sale.valorBruto, 303.17)
  assert.equal(sale.descontoPercentual, 18.23)
  assert.equal(sale.descontoValor, 55.26)
  assert.equal(sale.valorLiquido, 247.91)
  assert.equal(sale.valor, 247.91)
  assert.equal(sale.operador, '8')
})

test('filtra desconto alto por percentual ou valor e ignora devoluções', () => {
  const sales = parseTrierLines(sampleLines)
  const byPercent = findHighDiscountSales(sales, 'percent', 30)
  const byValue = findHighDiscountSales(sales, 'value', 50)
  assert.deepEqual(byPercent.map((sale) => sale.numero), ['268669'])
  assert.deepEqual(byValue.map((sale) => sale.numero), ['268711'])
  assert.equal(byPercent.some((sale) => sale.isDev), false)
  assert.equal(byValue.some((sale) => sale.isDev), false)
})

test('limite zero mostra somente vendas que realmente tiveram desconto', () => {
  const sales = parseTrierLines([...sampleLines, '268649 1 CARTAO 30/07/26 07:19 65 83508 8 22,99 0,00 0,00 22,99 22,99'])
  const discounted = findHighDiscountSales(sales, 'percent', 0)
  assert.deepEqual(discounted.map((sale) => sale.numero), ['268669', '268711', '268648'])
})

test('extrai contas recebidas crediário no cartão do fechamento', () => {
  const rows = parseFechamentoLines([
    'Período: 30/07/2026 à 30/07/2026',
    'ENTRADA VENDAS DINHEIRO TELE DE OUTRO CAIXA.: 0,00 (+) CONTAS RECEBIDAS CREDIÁRIO(Cartão): 216,00 (+)',
  ])
  assert.deepEqual(rows, [{
    data: '30/07/2026',
    hora: '',
    valor: 216,
    tipo: 'Crediário (Cartão)',
    status: 'INFORMADO',
    raw: 'ENTRADA VENDAS DINHEIRO TELE DE OUTRO CAIXA.: 0,00 (+) CONTAS RECEBIDAS CREDIÁRIO(Cartão): 216,00 (+)',
  }])
})

test('reserva na Cielo o conjunto que fecha o crediário cartão e refaz a conciliação', () => {
  const trier = parseTrierLines([
    '1001 1 CARTAO 30/07/26 10:00 65 83509 8 5,00 0,00 0,00 5,00 5,00',
    '1002 1 CARTAO 30/07/26 10:10 65 83510 8 8,00 0,00 0,00 8,00 8,00',
  ])
  const cielo = parseCieloLines([
    '30/07/2026 18:14 Débito à vista Mastercard R$ 150,00 Aprovada',
    '30/07/2026 14:45 Crédito à vista Mastercard R$ 43,00 Aprovada',
    '30/07/2026 10:35 Débito à vista Mastercard R$ 18,00 Aprovada',
    '30/07/2026 10:02 Crédito à vista Visa R$ 5,00 Aprovada',
    '30/07/2026 10:11 Crédito à vista Visa R$ 8,00 Aprovada',
  ])
  const fechamento = parseFechamentoLines([
    'Período: 30/07/2026 à 30/07/2026',
    'CONTAS RECEBIDAS CREDIÁRIO(Cartão): 216,00 (+)',
  ])
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: fechamento } }, 0.5, 2)
  assert.equal(output.crediarioCartao.length, 4)
  assert.equal(output.crediarioCartao.reduce((sum, row) => sum + row.valor, 0), 216)
  assert.deepEqual(output.crediarioCartao.map((row) => row.valor).sort((a, b) => a - b), [5, 18, 43, 150])
  assert.equal(output.fechamentoCrediario[0].conciliado, true)
  assert.equal(output.fechamentoCrediario[0].diff, 0)
  assert.equal(output.results.find((row) => row.sale.numero === '1001').status, 'SEM_RECEBIMENTO')
  assert.equal(output.results.find((row) => row.sale.numero === '1002').status, 'CONCILIADA')
  assert.equal(output.semVenda.length, 0)
})
