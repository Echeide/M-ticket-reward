# Rtales Ticket Rewards

Aplicación externa para escanear tickets de comercios asociados, extraer sus datos, validarlos automáticamente, conceder puntos en Rtales y permitir una auditoría posterior con revocación antifraude.

## Componentes

- experiencia móvil embebible en Rtales;
- OCR asíncrono con revisión de datos no manipulable;
- historial de tickets por usuario, con recuperación de procesos pendientes;
- base de datos Cloudflare D1;
- imágenes privadas en Cloudflare R2, agrupadas por usuario mediante prefijos;
- outbox y Cloudflare Queue para premios y reintentos;
- backoffice filtrable y exportable a CSV;
- auditoría de confirmaciones y revocaciones.

## Desarrollo

Se necesita Node.js 22 o superior.

1. Crea la base D1 y ejecuta, por orden, los SQL de `migrations-d1/`.
2. Copia `.dev.vars.example` a `.dev.vars` y completa los secretos.
3. Sustituye los IDs de D1 y los nombres de recursos en `wrangler.jsonc`.
4. Instala dependencias y arranca:

```bash
npm install
npm run dev
```

Con `OCR_MODE=mock` se puede probar el flujo sin consumir un modelo OCR.

Antes de probar una subida, añade al menos una tienda:

```sql
INSERT INTO stores (id, code, name)
VALUES ('10000000-0000-4000-8000-000000000001', 'DEMO', 'Tienda asociada');
```

## Producción

Antes de desplegar:

- configura Cloudflare Access para `/backoffice.html` y `/api/admin/*`;
- crea el bucket R2 y las colas principal/DLQ;
- crea y vincula la base D1;
- carga `RTALES_EXTERNAL_GAME_TOKEN` y `DATA_ENCRYPTION_KEY` con `wrangler secret put`;
- registra el origen HTTPS y CSP del proveedor en Rtales;
- aplica los cambios de reversión descritos en `docs/ARCHITECTURE.md`.
- activa “Compartir correo con este juego” únicamente para este proveedor.

## Política inicial

Los puntos se conceden automáticamente tras confirmar los datos de un ticket que supera las reglas automáticas. La revisión humana es posterior: el gestor solo marca el ticket como revisado sin fraude o revoca el premio ya concedido. Las cartas permanecen desactivadas hasta que su reversión sea transaccional y auditable.
