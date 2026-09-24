const DATABASE_NAME = 'drogaria-center-local'
const DATABASE_VERSION = 1
const STORE_NAME = 'reconciliation-history'
const LATEST_SESSION_KEY = 'latest-session'

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB indisponível')); return }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Não foi possível abrir o armazenamento local.'))
  })
}

function runTransaction(mode, operation) {
  return openDatabase().then((database) => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    const request = operation(store)
    let result
    request.onsuccess = () => { result = request.result }
    request.onerror = () => { /* o erro da transação trata a falha */ }
    transaction.oncomplete = () => { database.close(); resolve(result) }
    transaction.onerror = () => { database.close(); reject(transaction.error || request.error || new Error('Não foi possível atualizar o histórico local.')) }
    transaction.onabort = () => { database.close(); reject(transaction.error || request.error || new Error('A atualização do histórico local foi cancelada.')) }
  }))
}

export async function loadReconciliationSession() {
  try {
    return await runTransaction('readonly', (store) => store.get(LATEST_SESSION_KEY))
  } catch {
    return null
  }
}

export async function saveReconciliationSession(session) {
  return runTransaction('readwrite', (store) => store.put({
    id: LATEST_SESSION_KEY,
    ...session,
    savedAt: new Date().toISOString(),
  }))
}

export async function clearReconciliationSession() {
  return runTransaction('readwrite', (store) => store.delete(LATEST_SESSION_KEY))
}
