# Monitoreo GPS Brigadas – Realtime (Frontend estático)

Mapa en tiempo real con Leaflet y Supabase Realtime para visualizar las ubicaciones que envía tu app Android.

## Variables (config.js)

Edita `config.js` y coloca:

```js
window.__ENV__ = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "eyJ..."
};
```

> **Nunca** expongas la `SERVICE_ROLE_KEY` en el frontend.

## Políticas y Realtime en Supabase

1. Activa Realtime para la tabla `public.ubicaciones_brigadas` (Database → Replication → configure → marca la tabla).
2. Activa RLS (si no lo estaba): `ALTER TABLE public.ubicaciones_brigadas ENABLE ROW LEVEL SECURITY;`
3. Crea políticas para que el rol `anon` pueda **select** y **realtime** (insert lo hace tu app con la misma anon key en tu caso):
   ```sql
   create policy "anon_read"
   on public.ubicaciones_brigadas
   for select
   to anon
   using (true);

   -- Realtime usa la misma evaluación de select
   ```

> Si quieres filtrar por `usuario_id` u otras reglas, ajusta `using (...)`.

## Despliegue en Render (Static Site)

1. Sube esta carpeta a un repositorio GitHub (por ejemplo `brigadas-realtime-map`).
2. En **Render.com → New → Static Site**.
3. Conecta tu repo.
4. **Build Command**: *blank* (vacío).
5. **Publish Directory**: `/` (raíz).
6. Añade estos **Environment Variables** en Render (opcional):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`

   Si las defines, puedes reemplazar los placeholders en `config.js` en el paso de build o editarlas directo en el archivo antes de subir.
7. Deploy.

Listo: Render servirá `index.html` y el sitio escuchará cambios en tiempo real.

## Iconos

Coloca tus PNG en `assets/`:
- `carro-green.png` (online)
- `carro-orange.png` (inactivo)
- `carro-gray.png` (offline)
- `logo_cicsa.png` (logo en header)

Puedes reemplazar por los que prefieras.
