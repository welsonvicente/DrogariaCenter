import test from 'node:test'
import assert from 'node:assert/strict'
import { autoMapColumns, calculateOrder, compareProductNames, findPriceHistoryReference, getOfferComparisonStatus, matchesProductSearch, normalizeEan, parseDcbCatalog, parsePriceHistory, productLinkId, toNumber } from './cotacao.js'

const orderItem = { id: 'pedido-1', ean: '7890000000001', nome: 'LOSARTANA POT 50MG 30CP REV', quantidadePedida: 10, fornecedorPreferido: null }

const quotations = {
  '7896004706795': { ean: '7896004706795', nome: 'LOSARTANA POTASSICA 50MG C/30 CP EMS', ofertas: [{ fornecedor: 'EMS', precoUnitario: 1.3 }] },
  '7896004708539': { ean: '7896004708539', nome: 'LOSARTANA POT.50MG 30 COM REV-GD', ofertas: [{ fornecedor: 'Germed', precoUnitario: .89 }] },
  '7897076923516': { ean: '7897076923516', nome: 'LOSARTANA+HCTZ 100MG+25MG 30CP', ofertas: [{ fornecedor: 'Ranbaxy', precoUnitario: 9.71 }] },
  '7897076907677': { ean: '7897076907677', nome: 'LOSARTANA POT 50MG 14CP REV', ofertas: [{ fornecedor: 'Ranbaxy', precoUnitario: 4 }] },
}

test('normaliza variações seguras da mesma apresentação', () => {
  assert.equal(compareProductNames(orderItem.nome, quotations['7896004706795'].nome, 'EMS').status, 'automatic')
  assert.equal(compareProductNames(orderItem.nome, quotations['7896004708539'].nome, 'Germed').status, 'automatic')
})

test('busca unificada encontra nome, parte semelhante, fornecedor e EAN', () => {
  const product = { nome: 'LOSARTANA POTASSICA 50MG C/30 CP EMS', ean: '7896004706795', fornecedor: 'EMS' }
  assert.equal(matchesProductSearch(product, 'losartana'), true)
  assert.equal(matchesProductSearch(product, 'lsoartana'), true)
  assert.equal(matchesProductSearch(product, 'losart 50mg'), true)
  assert.equal(matchesProductSearch(product, 'EMS'), true)
  assert.equal(matchesProductSearch(product, '06795'), true)
  assert.equal(matchesProductSearch(product, 'rivaroxabana'), false)
})

test('busca por losartana não retorna medicamentos sem relação', () => {
  const unrelated = [
    'C.VENLAFAXINA(C1)150MG 2BL15CAP L P-GD',
    'C.VENLAFAXINA(C1)37,5MG 3X10CAP L PRO-GD',
    'TANSULOSINA 0,4MG 30CAP',
    'DULOXETINA 30MG 30CAP',
  ]
  unrelated.forEach((nome) => {
    assert.equal(matchesProductSearch({ nome, ean: '', fornecedor: 'Germed' }, 'losartana'), false, nome)
    assert.equal(matchesProductSearch({ nome, ean: '', fornecedor: 'Germed' }, 'lsoartana'), false, nome)
  })
})

test('rejeita associação, dosagem e embalagem incompatíveis', () => {
  const hctz = compareProductNames(orderItem.nome, 'LOSARTANA POTASSICA + HCT 50MG + 12,5MG / 30 COMP.')
  const dose = compareProductNames(orderItem.nome, 'LOSARTANA POT 100MG 30CP REV')
  const pack = compareProductNames(orderItem.nome, 'LOSARTANA POT 50MG 60CP REV')
  assert.equal(hctz.status, 'conflict')
  assert.ok(hctz.conflicts.includes('associação'))
  assert.ok(dose.conflicts.includes('dosagem'))
  assert.ok(pack.conflicts.includes('embalagem'))
})

test('agrega EANs equivalentes e escolhe o menor preço', () => {
  const result = calculateOrder(quotations, [orderItem])[0]
  assert.equal(result.ofertasDisponiveis.length, 2)
  assert.equal(result.fornecedorSelecionado, 'Germed')
  assert.equal(result.eanOferta, '7896004708539')
  assert.equal(result.matchMethod, 'automatic-name')
  assert.equal(result.precoTotal, 8.9)
})

test('mantém EAN exato como correspondência prioritária', () => {
  const exact = { ...orderItem, ean: '7896004706795' }
  const result = calculateOrder(quotations, [exact])[0]
  const exactOffer = result.ofertasDisponiveis.find((offer) => offer.eanOferta === exact.ean)
  assert.equal(exactOffer.matchMethod, 'ean')
})

test('sinaliza descrição equivalente com EAN diferente e preço menor', () => {
  const exact = { ...orderItem, ean: '7896004706795' }
  const result = calculateOrder(quotations, [exact])[0]
  assert.equal(result.temOfertaNomeMaisBarata, true)
  assert.equal(result.melhorOfertaEanExato.precoUnitario, 1.3)
  assert.equal(result.melhorOfertaNome.eanOferta, '7896004708539')
  assert.ok(Math.abs(result.economiaNomeUnitario - .41) < .0001)
  assert.ok(Math.abs(result.economiaNomeTotal - 4.1) < .0001)
})

test('sugestão ambígua não altera preço ou total antes da confirmação', () => {
  const candidate = { ean: '7892222222222', nome: 'LOSARTANA 50MG CP', ofertas: [{ fornecedor: 'Outro', precoUnitario: .5 }] }
  const result = calculateOrder({ [candidate.ean]: candidate }, [orderItem])[0]
  assert.equal(result.status, 'revisarCorrespondencia')
  assert.equal(result.precoUnitario, null)
  assert.equal(result.precoTotal, null)
  assert.equal(result.sugestoesCorrespondencia.length, 1)
  const autoSafeResult = calculateOrder({ [candidate.ean]: candidate }, [orderItem], {}, {}, { autoAcceptSafe: true })[0]
  assert.equal(autoSafeResult.status, 'revisarCorrespondencia')
  assert.equal(autoSafeResult.precoUnitario, null)
})

test('vínculos confirmados e rejeitados controlam candidatos por nome', () => {
  const candidate = { ean: '7891111111111', nome: 'LOSARTANA 50MG', ofertas: [{ fornecedor: 'Marca', precoUnitario: .7 }] }
  const data = { [candidate.ean]: candidate }
  const initial = calculateOrder(data, [orderItem])[0]
  assert.notEqual(initial.status, 'selecionado')
  const key = productLinkId(orderItem, candidate.ean)
  const approved = calculateOrder(data, [orderItem], {}, { [key]: 'approved' })[0]
  const rejected = calculateOrder(data, [orderItem], {}, { [key]: 'rejected' })[0]
  assert.equal(approved.fornecedorSelecionado, 'Marca')
  assert.equal(approved.matchMethod, 'confirmed-name')
  assert.equal(rejected.fornecedorSelecionado, null)
})

test('ajuste manual legado por fornecedor continua válido', () => {
  const result = calculateOrder(quotations, [orderItem], { [orderItem.id]: { fornecedor: 'EMS', quantidade: 8, motivo: 'Fechar fatura' } })[0]
  assert.equal(result.fornecedorSelecionado, 'EMS')
  assert.equal(result.eanOferta, '7896004706795')
  assert.equal(result.quantidadeFinal, 8)
})

test('laboratório do pedido não trava a escolha do menor fornecedor', () => {
  const legacyOrder = { ...orderItem, fornecedorPreferido: 'EMS' }
  const result = calculateOrder(quotations, [legacyOrder])[0]
  assert.equal(result.fornecedorSelecionado, 'Germed')
  assert.equal(result.precoUnitario, .89)
})

test('preferência explícita continua disponível e usa fallback quando não há oferta', () => {
  const preferred = calculateOrder(quotations, [{ ...orderItem, fornecedorPreferido: 'EMS', preferenciaFornecedorAtiva: true }])[0]
  const unavailable = calculateOrder(quotations, [{ ...orderItem, fornecedorPreferido: 'Inexistente', preferenciaFornecedorAtiva: true }])[0]
  assert.equal(preferred.fornecedorSelecionado, 'EMS')
  assert.equal(preferred.status, 'alternativaPreferida')
  assert.equal(unavailable.fornecedorSelecionado, 'Germed')
})

test('mapeia laboratório separado do fornecedor preferido e preço líquido da Ranbaxy', () => {
  const orderHeaders = ['Cod Reduzido', 'Descricao', 'Quantidade', 'EAN Principal', 'Laboratorio']
  const orderMapping = autoMapColumns(orderHeaders, [[52476, 'ACICLOVIR 400MG 30CP', 2, 7899547511338, 'PRATI DONADUZZI']])
  const ranbaxyHeaders = ['Cód', 'EAN', 'Produto/Apresentação', 'Desconto', 'Liq. S/ ST']
  const ranbaxyMapping = autoMapColumns(ranbaxyHeaders, [[931, 7897076909312, 'ACECLOFENACO 100 MG C/12', .86, 15.3]])
  assert.equal(orderMapping.laboratorio, 4)
  assert.equal(orderMapping.fornecedor, undefined)
  assert.equal(ranbaxyMapping.precoUnit, 4)
})

test('corrige o caractere G usado como dígito 9 em EAN e preço', () => {
  assert.equal(normalizeEan('78G6422505741'), '7896422505741')
  assert.equal(toNumber('G,87'), 9.87)
  assert.equal(toNumber('1,4G'), 1.49)
})

test('mapeia e importa o histórico de custo do relatório Trier rel_0014', () => {
  const headers = ['', 'Cód. Barras', 'Descrição', '', '', 'Laboratório', 'Grupo', 'Curva/Padrão', 'Estoq. Mín.', 'Qtd. Dem.', 'Qtd. Crit.', '', 'Acim. Dem/Cri', '', 'Estq.', 'P. Custo', 'P Venda']
  const rows = [
    ['', '7896004817477', 'A SAUDE DA MULHER LIQ 150ML', '', '', 'EMS', 5, 'D / Q', 0, 0, 0, '', 2, '', 2, 14.23, 23.64],
    ['', '7896331702583', 'ABC 10MG/ML SPR DERM 30ML', '', '', 'KLEY HERTZ', 5, 'D / Q', 0, 0, 0, '', 1, '', 1, 17.97, 33.99],
  ]
  const mapping = autoMapColumns(headers, rows)
  const parsed = parsePriceHistory(rows, { eanIndex: mapping.ean, nameIndex: mapping.nome, costIndex: mapping.precoCusto, laboratoryIndex: mapping.laboratorio })
  assert.deepEqual(mapping, { ean: 1, nome: 2, quantidade: 9, precoCusto: 15, laboratorio: 5 })
  assert.equal(parsed.history['7896004817477'].precoCusto, 14.23)
  assert.equal(parsed.history['7896331702583'].laboratorio, 'KLEY HERTZ')
})

test('histórico usa o EAN real da oferta quando o EAN do pedido é diferente', () => {
  const history = {
    '7896004708539': { ean: '7896004708539', nome: 'LOSARTANA POT.50MG 30 COM REV-GD', laboratorio: 'GERMED', precoCusto: .95 },
  }
  const reference = findPriceHistoryReference({ ean: '7890000000001', eanOferta: '7896004708539' }, history)
  assert.equal(reference.precoCusto, .95)
  assert.equal(reference.referenceMethod, 'offer-ean')
})

test('histórico mantém prioridade para o EAN original do pedido', () => {
  const history = {
    '7890000000001': { ean: '7890000000001', precoCusto: 1.2 },
    '7896004708539': { ean: '7896004708539', precoCusto: .95 },
  }
  const reference = findPriceHistoryReference({ ean: '7890000000001', eanOferta: '7896004708539' }, history)
  assert.equal(reference.precoCusto, 1.2)
  assert.equal(reference.referenceMethod, 'order-ean')
})

test('cápsula versus comprimido exige revisão e entra no cálculo após confirmação', () => {
  const tramadolOrder = { id: 'tramadol-pedido', ean: '7896112121145', nome: 'TRAMADOL 50MG 10CAP', quantidadePedida: 8, laboratorio: 'TEUTO' }
  const candidate = { ean: '7896004711768', nome: 'TRAMADOL 50MG C/10 COMP', ofertas: [{ fornecedor: 'Germed', precoUnitario: 4.75 }] }
  const comparison = compareProductNames(tramadolOrder.nome, candidate.nome, 'Germed')
  const initial = calculateOrder({ [candidate.ean]: candidate }, [tramadolOrder])[0]
  const confirmed = calculateOrder({ [candidate.ean]: candidate }, [tramadolOrder], {}, { [productLinkId(tramadolOrder, candidate.ean)]: 'approved' })[0]
  assert.equal(comparison.status, 'suggestion')
  assert.deepEqual(comparison.reviewReasons, ['cápsula versus comprimido'])
  assert.equal(initial.status, 'revisarCorrespondencia')
  assert.equal(confirmed.fornecedorSelecionado, 'Germed')
  assert.equal(confirmed.precoUnitario, 4.75)
  assert.equal(confirmed.precoTotal, 38)
})

test('cápsula versus comprimido não libera apresentação de liberação prolongada', () => {
  const comparison = compareProductNames('TRAMADOL 50MG 10CAP', 'TRAMADOL RETARD 50MG C/10 COMP')
  assert.equal(comparison.status, 'conflict')
  assert.ok(comparison.conflicts.includes('liberação'))
})

test('aceitação automática segura usa cápsula versus comprimido sem perguntar', () => {
  const tramadolOrder = { id: 'tramadol-auto', ean: '7896112121145', nome: 'TRAMADOL 50MG 10CAP', quantidadePedida: 8 }
  const candidate = { ean: '7896004711768', nome: 'TRAMADOL 50MG C/10 COMP', ofertas: [{ fornecedor: 'Germed', precoUnitario: 4.75 }] }
  const result = calculateOrder({ [candidate.ean]: candidate }, [tramadolOrder], {}, {}, { autoAcceptSafe: true })[0]
  assert.equal(result.fornecedorSelecionado, 'Germed')
  assert.equal(result.matchMethod, 'auto-reviewed-name')
  assert.equal(result.precoTotal, 38)
  assert.equal(result.sugestoesCorrespondencia.length, 0)
})

test('DCB agrupa EANs e descrições diferentes e escolhe o menor preço', () => {
  const dipironaOrder = { id: 'dipirona', ean: '7891000000001', nome: 'DIPIRONA 500MG 30 COM', quantidadePedida: 10 }
  const data = {
    '7891000000001': { ean: '7891000000001', nome: 'DIPIRONA 500MG 30 COM', ofertas: [{ fornecedor: 'Fornecedor A', precoUnitario: 7 }] },
    '7891000000002': { ean: '7891000000002', nome: 'NOVALGINA 500MG 30 DRAGEAS', ofertas: [{ fornecedor: 'Fornecedor B', precoUnitario: 4.75 }] },
    '7891000000003': { ean: '7891000000003', nome: 'DIPIRONA 1G 10 COM', ofertas: [{ fornecedor: 'Fornecedor C', precoUnitario: 2 }] },
    '7891000000004': { ean: '7891000000004', nome: 'DIPIRONA 500MG 30 COM', ofertas: [{ fornecedor: 'Sem preço', precoUnitario: 0 }] },
  }
  const catalog = {
    '7891000000001': { key: 'DIPIRONA500MGCAPS/COMP/DRAG30', label: 'DIPIRONA 500MG CAPS/COMP/DRAG 30' },
    '7891000000002': { key: 'DIPIRONA500MGCAPS/COMP/DRAG30', label: 'DIPIRONA 500MG CAPS/COMP/DRAG 30' },
    '7891000000003': { key: 'DIPIRONA1GCAPS/COMP/DRAG10', label: 'DIPIRONA 1G CAPS/COMP/DRAG 10' },
    '7891000000004': { key: 'DIPIRONA500MGCAPS/COMP/DRAG30', label: 'DIPIRONA 500MG CAPS/COMP/DRAG 30' },
  }
  const result = calculateOrder(data, [dipironaOrder], {}, {}, {}, catalog)[0]
  assert.equal(result.ofertasDisponiveis.length, 2)
  assert.equal(result.fornecedorSelecionado, 'Fornecedor B')
  assert.equal(result.eanOferta, '7891000000002')
  assert.equal(result.matchMethod, 'dcb')
  assert.equal(result.precoTotal, 47.5)
  assert.equal(result.dcb, 'DIPIRONA 500MG CAPS/COMP/DRAG 30')
})

test('base DCB descarta EAN conflitante e mantém chave canônica', () => {
  const rows = [
    ['7891000000001', 'DIPIRONA 500MG CAPS/COMP/DRAG 30'],
    ['7891000000002', 'DIPIRONA 500MG CAPS/COMP/DRAG 30'],
    ['7891000000002', 'DIPIRONA 1G CAPS/COMP/DRAG 10'],
  ]
  const parsed = parseDcbCatalog(rows, { eanIndex: 0, dcbIndex: 1 })
  assert.equal(parsed.catalog['7891000000001'].key, 'DIPIRONA500MGCAPS/COMP/DRAG30')
  assert.equal(parsed.catalog['7891000000002'], undefined)
  assert.equal(parsed.conflicts, 1)
})

test('compara metoprolol 25mg de Biossintética e Medley pela mesma apresentação', () => {
  const order = { id: 'metoprolol', ean: '7898947385693', nome: 'METOPROLOL 25MG 30CP REV L.P', quantidadePedida: 5 }
  const data = {
    '7896658053498': { ean: '7896658053498', nome: 'SUC METOPROLOL 25MG COM LIB PROL BLX30', ofertas: [{ fornecedor: 'Biossintética', precoUnitario: 16.21573154996066 }] },
    '7891058000950': { ean: '7891058000950', nome: 'SUCCINATO METOPROLOL COMP REV 25MG C/30', ofertas: [{ fornecedor: 'Medley', precoUnitario: 17.2 }] },
  }
  const result = calculateOrder(data, [order], {}, {}, { autoAcceptSafe: true })[0]
  assert.equal(result.ofertasDisponiveis.length, 2)
  assert.equal(result.fornecedorSelecionado, 'Biossintética')
  assert.equal(result.eanOferta, '7896658053498')
  assert.equal(getOfferComparisonStatus([result], 'Biossintética', '7896658053498'), 'winner')
  assert.equal(getOfferComparisonStatus([result], 'Medley', '7891058000950'), 'compared')
})

test('compara clopidogrel mensal de EMS, Medley e Germed mesmo entre caixas de 28 e 30', () => {
  const order = { id: 'clopidogrel', ean: '7896112103394', nome: 'CLOPIDOGREL 75MG 30CP REV', quantidadePedida: 3 }
  const data = {
    '7896004738406': { ean: '7896004738406', nome: 'BISSUL CLOPIDOGREL 75MG 28CP EMS', ofertas: [{ fornecedor: 'EMS', precoUnitario: 18.727748 }] },
    '7896422516112': { ean: '7896422516112', nome: 'Bissulf Clopidogrel 75mg c/28', ofertas: [{ fornecedor: 'Medley', precoUnitario: 35.39 }] },
    '7896004738413': { ean: '7896004738413', nome: 'CLOPIDOGREL75MG C/28 COMP', ofertas: [{ fornecedor: 'Germed', precoUnitario: 15.58 }] },
  }
  const result = calculateOrder(data, [order], {}, {}, { autoAcceptSafe: true })[0]
  assert.equal(result.ofertasDisponiveis.length, 3)
  assert.deepEqual(result.ofertasDisponiveis.map((offer) => offer.fornecedor), ['Germed', 'EMS', 'Medley'])
  assert.equal(result.fornecedorSelecionado, 'Germed')
  assert.equal(result.matchMethod, 'auto-reviewed-name')
  assert.equal(getOfferComparisonStatus([result], 'Germed', '7896004738413'), 'winner')
  assert.equal(getOfferComparisonStatus([result], 'EMS', '7896004738406'), 'compared')
  assert.equal(getOfferComparisonStatus([result], 'Medley', '7896422516112'), 'compared')
})
