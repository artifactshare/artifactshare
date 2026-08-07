async function boot() {
  document.querySelector('#js-status').textContent = 'loaded'

  const response = await fetch('./checks.json')
  const data = await response.json()
  document.querySelector('#json-status').textContent = data.status
}

boot().catch(() => {
  document.querySelector('#json-status').textContent = 'blocked'
})
