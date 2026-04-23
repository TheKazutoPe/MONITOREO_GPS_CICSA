// config.js
window.CONFIG = {
  // Supabase Auth y Sitios (Original)
  SUPABASE_AUTH_URL: "https://fcyerlaliiiuutdzinvg.supabase.co",
  SUPABASE_AUTH_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjeWVybGFsaWlpdXV0ZHppbnZnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQwMTMyMzUsImV4cCI6MjA2OTU4OTIzNX0.fgKF7aE7kiUYGpgom34taZw-1PsYJJ1wlwI5urADc6s",

  // Supabase Telemetría GPS (Nueva)
  SUPABASE_GPS_URL: "https://hhjqzkmrslumoykpgnhc.supabase.co",
  SUPABASE_GPS_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoanF6a21yc2x1bW95a3BnbmhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5ODE3MTEsImV4cCI6MjA5MjU1NzcxMX0.8_64VWX2BPuuI5Fw1nPHe6ubDmM6CbnHK4Ovwj5MsaI",

  // Ruteo / Map-matching
  ROUTE_PROVIDER: "mapbox",                         // 'mapbox' | 'ors' | 'valhalla' | 'none'
  MAPBOX_TOKEN:   "sk.eyJ1IjoidGhla2F6dXRvcGUiLCJhIjoiY21pbDJsZmJ0MWtqcTNmcHZycXQ3ZnVxYSJ9.lYQ9hZ0XyYAQtSCa1bd4hg",               // <-- pega aquí tu token 'pk.' de Mapbox
  ORS_API_KEY:    "",                               // no se usa con Mapbox
  VALHALLA_URL:   ""                                // no se usa con Mapbox
};
