export function registerPwa() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((registration) => registration.update()).catch((error) => {
      console.warn('Não foi possível registrar o modo offline.', error)
    })
  })
}
