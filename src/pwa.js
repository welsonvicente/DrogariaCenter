export function registerPwa() {
  if (!('serviceWorker' in navigator)) return

  // Um service worker instalado por uma execucao anterior do preview tambem
  // controla o servidor de desenvolvimento quando ambos usam localhost:5173.
  // Remova-o no modo dev para que o Chrome nunca continue executando um bundle
  // antigo enquanto estamos validando uma correcao local.
  if (!import.meta.env.PROD) {
    window.addEventListener('load', async () => {
      const registrations = await navigator.serviceWorker.getRegistrations()
      const controlled = Boolean(navigator.serviceWorker.controller)
      await Promise.all(registrations.map((registration) => registration.unregister()))
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.filter((key) => key.startsWith('utilitarios-dc-')).map((key) => caches.delete(key)))
      }
      if (controlled && sessionStorage.getItem('utilitarios-dc-dev-sw-cleaned') !== '1') {
        sessionStorage.setItem('utilitarios-dc-dev-sw-cleaned', '1')
        window.location.reload()
      }
    })
    return
  }

  window.addEventListener('load', () => {
    const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })
    navigator.serviceWorker.register(`${basePath}sw.js`, { scope: basePath, updateViaCache: 'none' }).then((registration) => registration.update()).catch((error) => {
      console.warn('Não foi possível registrar o modo offline.', error)
    })
  })
}
