// public/js/login.js
(function () {
  const btn = document.getElementById('btnLogin');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const keep = document.getElementById('keep');
  const warn = document.getElementById('warn');
  const forgot = document.getElementById('forgot');

  // El botón queda habilitado; validamos al hacer click
  btn.disabled = false;

  async function waitForEnvAndLib() {
    // Espera breve por si /env.js o supabase.min.js tardan en cargar
    for (let i = 0; i < 20; i++) {
      if (
        window.ENV &&
        window.ENV.SUPABASE_URL &&
        window.ENV.SUPABASE_ANON_KEY &&
        window.supabase
      ) return true;
      await new Promise(r => setTimeout(r, 50));
    }
    return false;
  }

  forgot.addEventListener('click', (e) => {
    e.preventDefault();
    alert('Pide el reseteo de contraseña a un administrador.');
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    warn.textContent = '';
    btn.disabled = true;

    const ready = await waitForEnvAndLib();
    if (!ready) {
      warn.textContent = 'No se pudieron cargar env.js o la librería de Supabase. R
