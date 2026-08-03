import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateOrder, compareProductNames, productLinkId } from './cotacao.js'

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
