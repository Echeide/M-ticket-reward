# Arquitectura

## Flujo público

1. Rtales abre la aplicación con un `launch_code` de un solo uso.
2. El Worker intercambia el código desde servidor y crea una sesión local.
3. El navegador captura la imagen del ticket.
4. El Worker valida tipo y tamaño, calcula SHA-256, guarda en R2 y publica un trabajo OCR.
5. El consumidor OCR usa un proveedor configurable, extrae tienda, número, fecha, importe y moneda, y exige evidencia textual para los campos críticos. Si la primera lectura es incompleta o incoherente, realiza un segundo intento focalizado.
6. Solo si el comercio, los campos, su evidencia, la fecha y la duplicidad son válidos, el ticket queda pendiente de confirmación. Una lectura que no puede verificarse queda pendiente de revisión y no se clasifica como no autorizada.
7. El usuario revisa los campos reconocidos, sin poder modificarlos, y confirma; la API repite la validación para evitar carreras.
8. Si pasa la validación automática, calcula puntos y crea una outbox durable.
9. La outbox entrega el premio a Rtales con una clave idempotente.
10. El frontend recibe el resultado por consulta, muestra la confirmación y notifica al iframe padre.
11. El usuario puede consultar hasta sus 50 tickets más recientes y recuperar cualquier proceso pendiente en un lanzamiento posterior gracias a `player.subject`.

La revisión humana es posterior. No forma parte del camino crítico para conceder puntos.

## Estados

```text
OCR_QUEUED -> OCR_PROCESSING -> READY_FOR_CONFIRMATION
                                |-> NOT_A_RECEIPT

READY_FOR_CONFIRMATION -> DUPLICATE
                       -> AUTO_REJECTED
                       -> REWARD_PENDING -> REWARDED -> REVOKE_PENDING -> REVOKED
                                                    \-> REWARD_FAILED
```

`REWARDED` significa validado automáticamente y premiado. Un gestor solo puede marcar que la revisión no detectó fraude o iniciar una revocación. La revisión no concede premios. La revocación nunca borra el registro: crea auditoría y una compensación en Rtales.

## Cloudflare

- **Workers** sirve API y assets.
- **R2** es privado. Las claves usan el prefijo `receipts/{userRef}/{año}/{receiptId}/optimized.ext`; la “carpeta” es un prefijo, no un directorio real.
- **Queues** desacopla OCR y entregas/reintentos de premios.
- **Workers AI** es el adaptador OCR inicial. También existe un adaptador para APIs visuales externas compatibles con OpenAI. El dominio no depende del proveedor ni del modelo.
- **D1** conserva sesiones, tickets, comercios, tramos, outbox y auditoría.
- **Cloudflare Access** protege `/backoffice.html` y `/api/admin/*` en producción.

## Duplicados y fraude

Se aplican tres controles:

- SHA-256 de la imagen para duplicado binario;
- huella lógica `tienda + número + fecha + importe + moneda` por usuario;
- puntuación de riesgo por correcciones respecto al OCR, baja confianza, fechas anómalas e importes fuera de patrón.

Debe añadirse una huella perceptual para detectar recortes o recompresión de la misma imagen. Los casos de alto riesgo siguen pudiendo recibir puntos si la política lo decide, pero aparecen primero en el backoffice.

## Reversión de puntos

Una revocación usa `ticket:{receiptId}:revoke:v1`, referencia el resultado original y descuenta exactamente `pointsAwarded`. Rtales debe permitir saldo negativo para representar deuda si el usuario ya gastó los puntos. Los canjes continuarán bloqueados mientras el saldo sea insuficiente.

Las cartas quedan desactivadas en la primera versión. Antes de habilitarlas Rtales necesita una reversión equivalente que contemple cartas ya consumidas o transferidas.

## Privacidad

- R2 no es público; las imágenes se sirven al backoffice mediante el Worker.
- El nombre del objeto usa un identificador opaco estable entregado por Rtales, no nombre, email ni ID interno.
- El correo solo se recibe cuando la credencial tiene el scope `player:email`; se usa para búsqueda y revisión, nunca como clave de R2.
- El `playerToken` se cifra con AES-GCM antes de persistirlo.
- Se conserva auditoría de toda revisión y revocación.
- La retención y borrado de tickets debe configurarse por campaña y reflejarse en la información legal.

## Cambios necesarios en Rtales

1. Añadir un endpoint de reversión autenticado e idempotente asociado a `ExternalGameResult`.
2. Registrar la compensación en un ledger/auditoría y exponerla en el historial general de Rtales.
3. Permitir saldo negativo o una deuda separada y bloquear canjes si no existe saldo disponible.
4. Añadir el scope `rewards:revoke` a las credenciales que lo necesiten.
5. Autorizar `player:email` únicamente para servicios que necesiten identificar al usuario.
6. No habilitar cartas en esta instalación hasta implementar su revocación.
