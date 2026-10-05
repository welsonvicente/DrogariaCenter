import test from 'node:test'
import assert from 'node:assert/strict'
import { findHighDiscountSales, parseCieloLines, parseFechamentoLines, parseTrierLines, receiptsForManualReview, reconcile, reconciliationReceiptKey, reconciliationSaleKey, resolveOperator } from './reconciliation.js'

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

test('identifica Delivery pela coluna Tele entrega em PIX e cartão', () => {
  const sales = parseTrierLines([
    '286511 1 CARTAO Sim 02/10/26 17:48 65 95910 DELIVERY 15 154,99 0,00 0,00 154,99 154,99',
    '286512 1 PIX SIM 02/10/26 17:49 65 95911 DELIVERY 15 20,00 0,00 0,00 20,00 20,00',
    '286513 1 CARTAO 02/10/26 17:50 65 95912 15 30,00 0,00 0,00 30,00 30,00',
  ])
  assert.equal(sales.find((sale) => sale.numero === '286511').tele, 'Sim')
  assert.equal(sales.find((sale) => sale.numero === '286512').tele, 'Sim')
  assert.equal(sales.find((sale) => sale.numero === '286513').tele, '')
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

test('identifica PIX dentro do relatório Cielo e concilia com venda PIX da Trier', () => {
  const cielo = parseCieloLines([
    '03/10/2026 16:58 2891818657 45.595.257/0001-71 Pix Pix R$ 22,00 -R$ 0,03 R$ 21,97 Aprovada',
  ])
  assert.equal(cielo[0].forma, 'PIX')
  assert.equal(cielo[0].tipo, 'PIX')
  assert.equal(cielo[0].bandeira, 'PIX')

  const trier = parseTrierLines(['286850 1 PIX 03/10/26 16:59 65 96209 13 22,00 0,00 0,00 22,00 22,00'])
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }, 0.5, 2)
  const result = output.results.find((row) => row.sale.numero === '286850')
  assert.equal(result.status, 'CONCILIADA')
  assert.equal(result.fonte, 'Cielo')
  assert.equal(result.recebimento.forma, 'PIX')
  assert.equal(output.semVenda.length, 0)
})

test('não usa PIX da Cielo para uma venda marcada como cartão', () => {
  const trier = parseTrierLines(['286851 1 CARTAO 03/10/26 16:59 65 96210 13 22,00 0,00 0,00 22,00 22,00'])
  const cielo = parseCieloLines(['03/10/2026 16:58 2891818657 45.595.257/0001-71 Pix Pix R$ 22,00 -R$ 0,03 R$ 21,97 Aprovada'])
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }, 0.5, 2)
  assert.equal(output.results[0].status, 'SEM_RECEBIMENTO')
  assert.equal(output.semVenda.length, 1)
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

test('conciliação manual confirma um recebimento escolhido fora da tolerância automática', () => {
  const trier = parseTrierLines(['286901 1 CARTAO 02/10/26 10:00 65 95975 1 50,00 0,00 0,00 50,00 50,00'])
  const cielo = [{ data: '02/10/2026', hora: '15:30:00', status: 'APROVADA', bandeira: 'VISA', valor: 52, raw: '02/10/2026 15:30:00 APROVADA VISA 52,00' }]
  const saleKey = reconciliationSaleKey(trier[0])
  const receiptKey = reconciliationReceiptKey({ ...cielo[0], fonte: 'Cielo' })
  const files = { trier: { rows: trier }, pagpix: { rows: [] }, cielo: { rows: cielo }, fechamento: { rows: [] } }
  const output = reconcile(files, 0.5, 2, {}, { [saleKey]: { saleKey, receiptKey } })
  const result = output.results.find((row) => row.sale.numero === '286901')
  assert.equal(result.status, 'DIVERGENCIA')
  assert.equal(result.manualMatch, true)
  assert.equal(result.recebimento.valor, 52)
  assert.equal(result.motivo, 'Conciliação confirmada manualmente pelo analista')
  assert.equal(output.semVenda.length, 0)
})

test('conciliação manual soma crédito e débito na mesma venda', () => {
  const trier = parseTrierLines(['286326 1 CARTAO 02/10/26 08:35 65 95745 8 15,00 0,00 0,00 15,00 15,00'])
  const cielo = [
    { data: '02/10/2026', hora: '08:32:00', status: 'APROVADA', tipo: 'Crédito', bandeira: 'VISA', valor: 10, raw: 'credito 10' },
    { data: '02/10/2026', hora: '08:33:00', status: 'APROVADA', tipo: 'Débito', bandeira: 'MASTERCARD', valor: 5, raw: 'debito 5' },
  ]
  const saleKey = reconciliationSaleKey(trier[0])
  const receiptKeys = cielo.map((item) => reconciliationReceiptKey({ ...item, fonte: 'Cielo' }))
  const files = { trier: { rows: trier }, pagpix: { rows: [] }, cielo: { rows: cielo }, fechamento: { rows: [] } }
  const output = reconcile(files, 0.5, 2, {}, { [saleKey]: { saleKey, receiptKey: receiptKeys[0], receiptKeys } })
  const result = output.results.find((row) => row.sale.numero === '286326')

  assert.equal(result.status, 'CONCILIADA')
  assert.equal(result.manualMatch, true)
  assert.equal(result.recebimentos.length, 2)
  assert.equal(result.recebimento.valor, 15)
  assert.equal(result.diff, 0)
  assert.equal(result.fonte, 'Cielo')
  assert.equal(output.semVenda.length, 0)
})

test('investigação manual mostra PaggPix para venda registrada como cartão, independentemente do valor', () => {
  const sale = parseTrierLines(['287020 1 CARTAO 04/10/26 11:16 65 96357 19 150,45 9,60 -14,45 136,00 136,00'])[0]
  const pagpix = [
    { data: '04/10/2026', hora: '11:15:39', tipo: 'balcao', operadorOriginal: 'SHAKIRA KESSIA SANTANA DESOUZA', status: 'PAGO', valor: 76, raw: '04/10/2026, 11:15:39 balcao SHAKIRA KESSIA SANTANA DESOUZA PAGO 76' },
    { data: '03/10/2026', hora: '11:15:39', tipo: 'balcao', status: 'PAGO', valor: 99, raw: 'outro dia' },
  ]
  const cielo = parseCieloLines(['04/10/2026 11:13 Crédito à vista Mastercard R$ 35,00 Aprovada'])
  const candidates = receiptsForManualReview({ pagpix: { rows: pagpix }, cielo: { rows: cielo } }, sale)
  const pix = candidates.find((receipt) => receipt.fonte === 'PaggPix' && receipt.valor === 76)

  assert.equal(sale.forma, 'CARTAO')
  assert.equal(pix.forma, 'PIX')
  assert.equal(pix.hora, '11:15:39')
  assert.equal(candidates.some((receipt) => receipt.valor === 99), false)
  assert.equal(candidates.some((receipt) => receipt.fonte === 'Cielo' && receipt.valor === 35), true)
})

test('conciliação manual combina PaggPix e dinheiro em venda lançada como cartão', () => {
  const trier = parseTrierLines(['287020 1 CARTAO 04/10/26 11:16 65 96357 19 150,45 9,60 -14,45 136,00 136,00'])
  const pagpix = { data: '04/10/2026', hora: '11:15:39', tipo: 'balcao', operadorOriginal: 'SHAKIRA KESSIA SANTANA DESOUZA', status: 'PAGO', valor: 76, raw: 'pix 76' }
  const saleKey = reconciliationSaleKey(trier[0])
  const pixReceipt = { ...pagpix, fonte: 'PaggPix' }
  const manualReceipt = { saleKey, fonte: 'Manual', status: 'MANUAL', tipo: 'Dinheiro', data: '04/10/2026', hora: '11:16', valor: 60, raw: 'Pagamento informado manualmente dinheiro 60' }
  const receiptKeys = [reconciliationReceiptKey(pixReceipt), reconciliationReceiptKey(manualReceipt)]
  const files = { trier: { rows: trier }, pagpix: { rows: [pagpix] }, cielo: { rows: [] }, fechamento: { rows: [] } }
  const output = reconcile(files, 0.5, 2, {}, { group: { groupId: 'group', saleKey, saleKeys: [saleKey], receiptKey: receiptKeys[0], receiptKeys } }, { [receiptKeys[1]]: manualReceipt })
  const result = output.results[0]

  assert.equal(result.status, 'CONCILIADA')
  assert.equal(result.recebimentos.length, 2)
  assert.equal(result.recebimento.valor, 136)
  assert.equal(result.diff, 0)
  assert.equal(output.semVenda.length, 0)
})

test('sugere dois recebimentos próximos como pagamento dividido sem conciliar automaticamente', () => {
  const trier = parseTrierLines(['286326 1 CARTAO 02/10/26 08:34 65 95745 8 15,00 0,00 0,00 15,00 15,00'])
  const cielo = parseCieloLines([
    '02/10/2026 08:32 Crédito à vista Visa R$ 10,00 Aprovada',
    '02/10/2026 08:33 Débito à vista Mastercard R$ 5,00 Aprovada',
  ])
  const output = reconcile({ trier: { rows: trier }, pagpix: { rows: [] }, cielo: { rows: cielo }, fechamento: { rows: [] } }, 0.5, 3)
  const result = output.results.find((row) => row.sale.numero === '286326')

  assert.equal(result.status, 'SEM_RECEBIMENTO')
  assert.equal(result.splitPaymentSuggestion.receipts.length, 2)
  assert.equal(result.splitPaymentSuggestion.total, 15)
  assert.equal(result.splitPaymentSuggestion.diff, 0)
  assert.equal(result.splitPaymentSuggestion.maxTimeDifferenceMinutes, 2)
  assert.equal(output.semVenda.length, 2)
})

test('não sugere pagamento dividido quando os recebimentos estão distantes da venda', () => {
  const trier = parseTrierLines(['286327 1 CARTAO 02/10/26 10:00 65 95746 8 15,00 0,00 0,00 15,00 15,00'])
  const cielo = parseCieloLines([
    '02/10/2026 08:30 Crédito à vista Visa R$ 10,00 Aprovada',
    '02/10/2026 08:31 Débito à vista Mastercard R$ 5,00 Aprovada',
  ])
  const output = reconcile({ trier: { rows: trier }, pagpix: { rows: [] }, cielo: { rows: cielo }, fechamento: { rows: [] } }, 0.5, 3)
  assert.equal(output.results[0].status, 'SEM_RECEBIMENTO')
  assert.equal(output.results[0].splitPaymentSuggestion, undefined)
})

test('conciliação manual junta as vendas 286626 e 286633 em um recebimento maior', () => {
  const trier = parseTrierLines([
    '286626 1 CARTAO 03/10/26 09:16 65 96015 3 171,93 12,76 -21,93 150,00 150,00',
    '286633 1 CARTAO 03/10/26 09:33 65 96023 3 221,73 10,48 -23,24 198,49 198,49',
  ])
  const cielo = parseCieloLines(['03/10/2026 09:30 Crédito parcelado loja 05 Visa R$ 350,00 -R$ 29,10 R$ 320,90 Aprovada'])
  const saleKeys = trier.map(reconciliationSaleKey)
  const receiptKey = reconciliationReceiptKey({ ...cielo[0], fonte: 'Cielo' })
  const manualMatches = { group: { groupId: 'group', saleKey: saleKeys[0], saleKeys, receiptKey, receiptKeys: [receiptKey] } }
  const output = reconcile({ trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }, 0.5, 2, {}, manualMatches)
  const bySale = new Map(output.results.map((row) => [row.sale.numero, row]))

  assert.equal(bySale.get('286626').manualMatch, true)
  assert.equal(bySale.get('286633').manualMatch, true)
  assert.equal(bySale.get('286626').manualMatchGroupId, 'group')
  assert.equal(bySale.get('286626').groupSalesValue, 348.49)
  assert.equal(bySale.get('286626').groupReceivedValue, 350)
  assert.equal(bySale.get('286626').diff, -1.51)
  assert.equal(bySale.get('286633').diff, -1.51)
  assert.equal(bySale.get('286626').status, 'DIVERGENCIA')
  assert.equal(output.semVenda.length, 0)
})

test('janela configurável sugere duas vendas para um recebimento sem conciliar automaticamente', () => {
  const trier = parseTrierLines([
    '286626 1 CARTAO 03/10/26 09:16 65 96015 3 171,93 12,76 -21,93 150,00 150,00',
    '286633 1 CARTAO 03/10/26 09:33 65 96023 3 221,73 10,48 -23,24 198,49 198,49',
  ])
  const cielo = parseCieloLines(['03/10/2026 09:30 Crédito parcelado loja 05 Visa R$ 350,00 -R$ 29,10 R$ 320,90 Aprovada'])
  const files = { trier: { rows: trier }, cielo: { rows: cielo }, pagpix: { rows: [] }, fechamento: { rows: [] } }
  const within15Minutes = reconcile(files, 0.5, 2, {}, {}, {}, 15)
  const within17Minutes = reconcile(files, 0.5, 2, {}, {}, {}, 17)
  const receipt = within17Minutes.semVenda[0]

  assert.equal(within15Minutes.semVenda[0].splitSalesSuggestion, undefined)
  assert.deepEqual(receipt.splitSalesSuggestion.sales.map((sale) => sale.numero), ['286626', '286633'])
  assert.equal(receipt.splitSalesSuggestion.total, 348.49)
  assert.equal(receipt.splitSalesSuggestion.diff, -1.51)
  assert.equal(receipt.splitSalesSuggestion.salesDistanceMinutes, 17)
  assert.equal(receipt.splitSalesSuggestion.windowMinutes, 17)
  assert.deepEqual(within17Minutes.results.map((row) => row.status), ['SEM_RECEBIMENTO', 'SEM_RECEBIMENTO'])
  assert.equal(within17Minutes.semVenda.length, 1)
})

test('conciliação manual aceita forma de pagamento informada pelo analista', () => {
  const trier = parseTrierLines(['286327 1 PIX 02/10/26 11:00 65 95746 8 20,00 0,00 0,00 20,00 20,00'])
  const saleKey = reconciliationSaleKey(trier[0])
  const manualReceipt = { saleKey, fonte: 'Manual', status: 'MANUAL', tipo: 'Dinheiro', data: '02/10/2026', hora: '11:00', valor: 20, raw: 'Pagamento informado manualmente teste' }
  const receiptKey = reconciliationReceiptKey(manualReceipt)
  const files = { trier: { rows: trier }, pagpix: { rows: [] }, cielo: { rows: [] }, fechamento: { rows: [] } }
  const output = reconcile(files, 0.5, 2, {}, { [saleKey]: { saleKey, receiptKey, receiptKeys: [receiptKey] } }, { [receiptKey]: manualReceipt })
  const result = output.results.find((row) => row.sale.numero === '286327')

  assert.equal(result.status, 'CONCILIADA')
  assert.equal(result.fonte, 'Manual')
  assert.equal(result.recebimento.tipo, 'Dinheiro')
  assert.match(result.motivo, /forma de pagamento informada/)
  assert.equal(output.semVenda.length, 0)
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
