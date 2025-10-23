// config.js
window.CONFIG = {
  // Supabase
  SUPABASE_URL: "https://fcyerlaliiiuutdzinvg.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjeWVybGFsaWlpdXV0ZHppbnZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQwMTMyMzUsImV4cCI6MjA2OTU4OTIzNX0.fgKF7aE7kiUYGpgom34taZw-1PsYJJ1wlwI5urADc6s",

  // Ruteo / Map-matching
  ROUTE_PROVIDER: "mapbox",                         // 'mapbox' | 'ors' | 'valhalla' | 'none'
  MAPBOX_TOKEN: "pk.eyJ1IjoiZGVtbzEyMyIsImEiOiJjbGg0bHR4aDcwMDMyM2RydDVqZ3Y0Z3ZvIn0._fYVZp4V5k7GfOglk2QOgQ",               // <-- pega aquí tu token 'pk.' de Mapbox
  ORS_API_KEY:    "",                               // no se usa con Mapbox
  VALHALLA_URL:   ""                                // no se usa con Mapbox
};
