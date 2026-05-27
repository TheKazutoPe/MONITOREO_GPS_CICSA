-- =====================================================
-- FUNCIÓN: get_latest_positions
-- Devuelve el ÚLTIMO registro de cada brigada del día
-- (en vez de las 43,000+ filas completas del día)
-- =====================================================

CREATE OR REPLACE FUNCTION get_latest_positions()
RETURNS SETOF ubicaciones_brigadas
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (usuario_id) *
  FROM ubicaciones_brigadas
  WHERE timestamp >= (CURRENT_DATE::timestamp AT TIME ZONE 'America/Lima')
  ORDER BY usuario_id, timestamp DESC;
$$;
