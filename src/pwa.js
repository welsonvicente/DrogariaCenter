export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    const basePath = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
    navigator.serviceWorker.register(`${basePath}sw.js`, { scope: basePath }).then((registration) => registration.update()).catch((error) => {
      console.warn('Não foi possível registrar o modo offline.', error)
    })
  })
}
