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

### Proveedor OCR

El OCR se selecciona mediante variables, sin cambiar el flujo de tickets:

- `OCR_PROVIDER=workers-ai` usa el binding AI de Cloudflare;
- `OCR_PROVIDER=openai-compatible` usa una API visual externa compatible con
  `POST /chat/completions`;
- `OCR_MODEL` contiene el identificador del modelo;
- `OCR_WORKERS_AI_FORMAT=chat` usa el contrato visual de modelos conversacionales;
  `moondream` conserva el contrato específico de ese modelo;
- `OCR_TIMEOUT_MS` limita cada intento (45 segundos por defecto);
- para un proveedor externo, configura `OCR_API_BASE_URL` y guarda `OCR_API_KEY`
  como secreto con `wrangler secret put OCR_API_KEY`.

La configuración inicial de producción usa
`@cf/moondream/moondream3.1-9B-A2B`; Gemma queda disponible como alternativa
de mayor capacidad para evaluaciones controladas.
El OCR hace un segundo intento focalizado
cuando faltan datos o no coinciden con sus líneas de evidencia. Un resultado que
sigue siendo incoherente queda pendiente de revisión y nunca se rechaza
automáticamente como ticket no autorizado.

La extracción no contiene nombres, CIF ni posiciones propias de un comercio. Los
comercios y sus alias se leen de la gestión del backoffice, y los intentos
focalizados usan zonas relativas y solapadas del ticket. Esto permite procesar
formatos distintos; aun así, antes de ampliar el uso debe validarse con una muestra
representativa de tickets de cada comercio y conservar como pendiente de revisión
cualquier formato que no aporte evidencias suficientes.

### Entrenamiento y evaluación por comercio

La edición de cada comercio incluye una pestaña `Entrenamiento` para mantener un
conjunto de tickets con número, fecha e importe verificados. Las imágenes se
optimizan con el flujo canónico de tickets y se guardan bajo un prefijo separado
en R2; nunca participan en recompensas, duplicados ni actividad de usuarios.

El gestor puede evaluar un ejemplo o el conjunto completo con el proveedor OCR
activo. Se conserva el modelo, la latencia y la coincidencia de comercio, número,
fecha, total y evidencias. Esta función construye un banco de evaluación fiable;
no realiza fine-tuning ni activa automáticamente un modelo en producción.

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
