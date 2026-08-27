# Rtales Ticket Rewards

Aplicación externa para escanear tickets de comercios asociados, extraer sus datos, validarlos automáticamente, conceder puntos en Rtales y permitir una auditoría posterior con revocación antifraude.

## Componentes

- experiencia móvil embebible en Rtales;
- OCR asíncrono con revisión de datos no manipulable;
- historial de tickets por usuario, con recuperación de procesos pendientes;
- base de datos Cloudflare D1;
- imágenes privadas en Cloudflare R2, agrupadas por usuario mediante prefijos;
- outbox y Cloudflare Queue para premios y reintentos;
- backoffice filtrable y exportable a CSV, con historial de cartas y premios diarios por usuario e instalación;
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

La configuración de producción usa
`@cf/meta/llama-3.2-11b-vision-instruct` con el contrato visual `chat` y JSON Mode.
Antes de la primera ejecución en una cuenta de Cloudflare debe aceptarse una sola vez
la licencia y la política de uso de Meta mediante una petición al modelo con
`{ "prompt": "agree" }`.
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
conjunto de tickets con número o fecha/hora, además del importe, verificados. Las imágenes se
optimizan con el flujo canónico de tickets y se guardan bajo un prefijo separado
en R2; nunca participan en recompensas, duplicados ni actividad de usuarios.
Los ejemplos pueden partir de archivos nuevos o de tickets ya subidos y vinculados
al comercio. En este último caso se crea una copia independiente y el ticket del
usuario, su revisión y su recompensa permanecen sin cambios.

El gestor puede evaluar un ejemplo o el conjunto completo con el proveedor OCR
activo. Se conserva el modelo, la latencia y la coincidencia de comercio, número,
fecha, hora, total y evidencias. Esta función construye un banco de evaluación fiable;
no realiza fine-tuning ni activa automáticamente un modelo en producción.
Las fechas visibles se interpretan por defecto en orden español `DD/MM/AAAA`, se
normalizan internamente a `AAAA-MM-DD` y vuelven a mostrarse en formato español en el
backoffice. Una hora solo se conserva cuando aparece en la evidencia literal del ticket.
La evaluación utiliza el mismo catálogo de comercios activos que los tickets reales y
permite probar el perfil que se está editando como candidato, sin guardarlo ni activarlo.
Los resultados muestran los valores esperados y reconocidos, los problemas de evidencia
y si un error técnico admite reintento.

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
- configura en Rtales las instalaciones y familias disponibles para las recompensas de colección;
- activa “Compartir correo con este juego” únicamente para este proveedor.

## Política inicial

Los puntos se conceden automáticamente tras confirmar los datos de un ticket que supera las reglas automáticas. La revisión humana es posterior: el gestor solo marca el ticket como revisado sin fraude o revoca el premio ya concedido. Cada comercio puede activar opcionalmente cartas por hitos de puntos y la campaña puede premiar al líder diario de una categoría. Las entregas tienen límites globales y por usuario e instalación, son idempotentes y se revierten junto con un ticket invalidado. La identidad, los duplicados, los strikes y los bloqueos siguen siendo globales para la misma persona aunque participe desde varias instalaciones de Rtales.
