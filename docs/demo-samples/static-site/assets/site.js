async function boot() {
  document.querySelector('#js-status').textContent = 'loaded'

  const res = await fetch('./data/checks.json')
  const data = await res.json()
  document.querySelector('#json-status').textContent = data.status
}

boot().catch(() => {
  document.querySelector('#json-status').textContent = 'blocked'
})
