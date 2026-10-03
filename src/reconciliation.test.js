import test from 'node:test'
import assert from 'node:assert/strict'
import { findHighDiscountSales, parseCieloLines, parseFechamentoLines, parseTrierLines, reconcile, reconciliationReceiptKey, reconciliationSaleKey, resolveOperator } from './reconciliation.js'

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

test('cadastro identifica novo vendedor pelo número da Trier e pelo nome do PaggPix', () => {
  const staff = [{ id: 'joao', name: 'João Victor', trierCode: '20', pagpixAliases: ['João Victor', 'Joao V'], active: true }]
  const trier = { operador: null, raw: '268900 1 PIX 30/07/26 10:15 65 83900 20 25,00 0,00 0,00 25,00 25,00' }
  const pagpix = { operador: '13', operadorOriginal: 'Joao V', raw: '30/07/2026, 13:16 Balcao Joao V PAGO R$ 25.00' }
  assert.equal(resolveOperator(trier, 'Trier', staff)?.id, 'joao')
  assert.equal(resolveOperator(pagpix, 'PaggPix', staff)?.id, 'joao')
})

test('concilia PIX do mesmo vendedor quando Trier e PaggPix divergem entre Delivery e Balcão', () => {
  const trier = parseTrierLines([
    '286363 1 PIX Sim 02/10/26 09:57 65 95778 DELIVERY 8 41,99 16,67 -7,00 34,99 34,99',
  ])
  const pagpix = [{
    data: '02/10/2026', hora: '09:53:28', tipo: 'Balcao', operador: '8', operadorOriginal: 'KATIA REJANE DO NASCIMENTO', status: 'PAGO', valor: 34.99, raw: '02/10/2026, 09:53:28 balcao KATIA REJANE DO NASCIMENTO PAGO R$ 34,99',
  }]
  const output = reconcile({ trier: { rows: trier }, pagpix: { rows: pagpix }, cielo: { rows: [] }, fechamento: { rows: [] } }, 0.5, 3)
  const result = output.results.find((row) => row.sale.numero === '286363')
  assert.equal(result.status, 'CONCILIADA')
  assert.equal(result.recebimento.hora, '09:53:28')
  assert.equal(result.canalTrier, 'Delivery')
  assert.equal(result.canalRecebimento, 'Balcao')
  assert.equal(result.canalDivergente, true)
  assert.match(result.motivo, /Canal divergente/)
  assert.equal(output.semVenda.length, 0)
})

test('não cruza Delivery e Balcão quando os vendedores são diferentes', () => {
  const trier = parseTrierLines([
    '286363 1 PIX Sim 02/10/26 09:57 65 95778 DELIVERY 8 41,99 16,67 -7,00 34,99 34,99',
  ])
  const pagpix = [{
    data: '02/10/2026', hora: '09:53:28', tipo: 'Balcao', operador: '13', operadorOriginal: 'CLAUDIA RODRIGUES DA SILVA ARAUJO', status: 'PAGO', valor: 34.99, raw: '02/10/2026, 09:53:28 balcao CLAUDIA RODRIGUES DA SILVA ARAUJO PAGO R$ 34,99',
  }]
  const output = reconcile({ trier: { rows: trier }, pagpix: { rows: pagpix }, cielo: { rows: [] }, fechamento: { rows: [] } }, 0.5, 3)
  assert.equal(output.results.find((row) => row.sale.numero === '286363').status, 'SEM_RECEBIMENTO')
  assert.equal(output.semVenda.length, 1)
})

test('concilia a venda 286586 com a Cielo de R$ 171,90 um minuto antes', () => {
  const trier = parseTrierLines([
    '286586 1 CARTAO 02/10/26 21:25 65 95974 1 219,87 21,82 -47,97 171,90 0,00 171,90',
  ])
  const cielo = parseCieloLines([
    '02/10/2026 21:24 2891818657 45.595.257/0001-71 Crédito parcelado loja 04 Mastercard R$ 171,90 Aprovada',
  ])
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }, 0.5, 3)
  const result = output.results.find((row) => row.sale.numero === '286586')
  assert.equal(result.status, 'CONCILIADA')
  assert.equal(result.fonte, 'Cielo')
  assert.equal(result.recebimento.hora, '21:24')
  assert.equal(result.recebimento.valor, 171.90)
  assert.equal(result.diff, 0)
  assert.equal(output.semVenda.length, 0)
})

test('usa separadamente os dois pagamentos Cielo de R$ 10,00 e mantém os R$ 171,90', () => {
  const trier = parseTrierLines([
    '286311 1 CARTAO Sim 02/10/26 08:00 65 95730 DELIVERY 4 11,99 16,60 -1,99 10,00 10,00',
    '286359 1 CARTAO Sim 02/10/26 09:50 65 95777 DELIVERY 3 9,99 0,00 0,00 9,99 9,99',
    '286586 1 CARTAO 02/10/26 21:25 65 95974 1 219,87 21,82 -47,97 171,90 0,00 171,90',
  ])
  const cielo = parseCieloLines([
    '02/10/2026 08:00 Débito à vista Visa R$ 10,00 Aprovada',
    '02/10/2026 08:32 Débito à vista Mastercard R$ 10,00 Aprovada',
    '02/10/2026 21:24 Crédito parcelado loja 04 Mastercard R$ 171,90 Aprovada',
  ])
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }, 0.5, 2)
  const bySale = new Map(output.results.map((row) => [row.sale.numero, row]))

  assert.equal(bySale.get('286311').status, 'CONCILIADA')
  assert.equal(bySale.get('286311').recebimento.hora, '08:00')
  assert.equal(bySale.get('286311').recebimento.bandeira, 'VISA')
  assert.equal(bySale.get('286359').status, 'DIVERGENCIA')
  assert.equal(bySale.get('286359').recebimento.hora, '08:32')
  assert.equal(bySale.get('286359').recebimento.bandeira, 'MASTERCARD')
  assert.equal(bySale.get('286586').status, 'CONCILIADA')
  assert.equal(bySale.get('286586').recebimento.hora, '21:24')
  assert.equal(output.semVenda.length, 0)
})

test('prioriza globalmente o recebimento exato mesmo com tolerância ampla', () => {
  const trier = parseTrierLines([
    '286500 1 CARTAO 02/10/26 18:00 65 95900 1 171,50 0,00 0,00 171,50 171,50',
    '286586 1 CARTAO 02/10/26 21:25 65 95974 1 219,87 21,82 -47,97 171,90 0,00 171,90',
  ])
  const cielo = parseCieloLines([
    '02/10/2026 21:24 Crédito parcelado loja 04 Mastercard R$ 171,90 Aprovada',
  ])
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }, 0.5, 4)
  const bySale = new Map(output.results.map((row) => [row.sale.numero, row]))

  assert.equal(bySale.get('286586').status, 'CONCILIADA')
  assert.equal(bySale.get('286586').recebimento.hora, '21:24')
  assert.equal(bySale.get('286500').status, 'SEM_RECEBIMENTO')
})

test('desconciliação manual devolve a venda e o recebimento para as pendências', () => {
  const trier = parseTrierLines(['286900 1 CARTAO 02/10/26 10:00 65 95974 1 50,00 0,00 0,00 50,00 50,00'])
  const cielo = [{ data: '02/10/2026', hora: '09:58:00', status: 'APROVADA', bandeira: 'VISA', valor: 50, raw: '02/10/2026 09:58:00 APROVADA VISA 50,00' }]
  const saleKey = reconciliationSaleKey(trier[0])
  const receipt = cielo[0]
  const receiptKey = reconciliationReceiptKey({ ...receipt, fonte: 'Cielo' })
  const files = { trier: { rows: trier }, pagpix: { rows: [] }, cielo: { rows: cielo }, fechamento: { rows: [] } }
  const output = reconcile(files, 0.5, 2, { [saleKey]: { saleKey, receiptKey } })
  const result = output.results.find((row) => row.sale.numero === '286900')
  assert.equal(result.status, 'SEM_RECEBIMENTO')
  assert.equal(result.manualUnmatch, true)
  assert.equal(result.motivo, 'Desconciliado manualmente pelo analista')
  assert.equal(output.semVenda.length, 1)
  assert.equal(output.semVenda[0].manualUnmatch, true)
  assert.equal(output.semVenda[0].manualUnmatchSaleKey, saleKey)
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
