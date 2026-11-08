# ARCHITECTURE.md — reglas de codificación de FurVet

> Este archivo es la referencia de diseño del repositorio. Quien escribe, planea o califica código lo lee completo una vez por sesión y relee la sección que toca su cambio. «Los tests pasan» no sustituye ninguna regla de aquí. Las cifras marcadas «medido» se tomaron sobre `main = d421c41` (2026-11-03); lo que no se midió dice «no medido».

## 0. Qué es FurVet y qué protege

Un Worker de Cloudflare (TypeScript + Hono) que agenda consultas veterinarias por chat, cobra un depósito y el saldo por PayPal **sandbox**, transcribe la consulta, propone un borrador clínico que el veterinario aprueba, y entrega al dueño receta, explicación en lenguaje llano y reporte en PDF. Almacena dinero y estado en D1, archivos en R2, y usa Workers AI para transcribir y un modelo de lenguaje para redactar borradores.

Tres cosas no pueden fallar nunca, y todo el diseño se ordena alrededor de ellas:

1. **Dinero**: ningún asiento se confirma sin verificación del proveedor; ningún monto lo fija el modelo; el ledger no se edita.
2. **Datos clínicos y personales**: nada que escriba la IA llega al dueño sin un clic humano; el audio no persiste; los logs no llevan PII.
3. **Disponibilidad del tratamiento**: la aprobación clínica nunca espera a PayPal ni se retiene por pago.

## 1. Principios

1. **Fail-closed.** Configuración faltante ⇒ 503, nunca «modo degradado». Firma que no se puede verificar ⇒ rechazar. Estado ilegible ⇒ el bot calla.
2. **4xx nunca 5xx ante entrada del cliente.** Un 500 es un oráculo (existe/no existe, parseó/no parseó) y un gasto antes de saber quién llama. El único 500 legítimo es un defecto nuestro, y se registra con el patrón de ruta, no con la ruta concreta.
3. **El servidor es la fuente de los precios.** Los schemas de herramientas del modelo y de los cuerpos aprobados no tienen campos de dinero; una clave `precio`/`amount` extra es un 422.
4. **Append-only para todo lo que es evidencia**: cargos, eventos de pago, borradores, aprobaciones, liberaciones. Se corrige añadiendo una fila, nunca editando.
5. **Idempotencia por restricción de base de datos**, no por lógica de aplicación: `UNIQUE` + `INSERT … ON CONFLICT DO NOTHING` + comprobar filas afectadas.
6. **Menos código.** Antes de escribir, recorre la escalera de §2.1. Deletion over addition; el diff más corto que funcione; sin abstracciones no pedidas.
7. **Nada de PII en logs ni en tableros.** Ids, enums, contadores y nombres de tipo de error. Nunca cuerpos, tokens, nombres, correos ni teléfonos.
8. **Los enlaces del dueño son secretos**: token de 256 bits, sólo su SHA-256 en la base, expiran, 404 uniforme, `no-store`, `no-referrer`, `noindex`.
9. **Sandbox siempre.** El host del proveedor de pagos es una constante; la variable de entorno que lo nombra debe decir `sandbox` o toda petición responde 503. Este repositorio nunca mueve dinero real.
10. **Mide antes de citar.** Toda afirmación sobre el repo (cuántos tests, qué hace un script, qué cubre un mutante) se verifica en el árbol antes de escribirse; si no se midió, se dice «no medido».

## 2. Antes de escribir código

### 2.1 Escalera de mínimo código

Detente en el primer escalón que aplique:

1. ¿Necesita existir? Si es especulativo, no lo escribas; dilo en una línea.
2. ¿Ya existe en este repo? Búscalo (`grep`) antes de escribir. Reúsalo.
3. ¿Lo hace la librería estándar o la plataforma? Web Crypto, `URL`, `Response`, `CHECK` y `UNIQUE` en D1, CSS antes que JS.
4. ¿Lo resuelve una dependencia ya instalada? Hoy sólo hay dos en producción: Hono y Zod. No agregues una tercera por lo que hacen unas líneas.
5. ¿Cabe en una línea? Una línea.
6. Sólo entonces: el mínimo código que funcione, con su prueba.

**Nunca se simplifica** validación en un borde de confianza, manejo de pérdida de datos, seguridad ni accesibilidad: eso va completo.

### 2.2 Escalera de seguridad

Todo cambio la recorre; si toca autenticación, dinero, PII, un endpoint público, un webhook o un token, el contrato dice explícitamente cómo cumple cada peldaño:

1. **Fail-closed**: ¿qué pasa si falta la llave, el id del webhook, la credencial? Debe ser 503 o rechazo, nunca un camino alterno.
2. **Mínimo privilegio**: la identidad se deriva de la credencial verificada (HTTP Basic del veterinario, firma del proveedor, token hasheado del dueño), nunca de un campo del cuerpo.
3. **Validar + sanitizar + codificar**: schema cerrado en la entrada (`.strict()`), bytes por firma de archivo, salida con `textContent` en el navegador y texto plano en el PDF.
4. **Defensa en profundidad**: una barrera en JavaScript y otra en la base (trigger, `CHECK`, `UNIQUE`). Dos barreras que afirman el mismo hecho se prueban juntas (ver §7.3).
5. **Modelo de amenazas** de la superficie nueva: suplantación, manipulación, repudio, fuga, denegación, elevación. Seis letras, seis líneas en el contrato.
6. **Secretos y PII**: secretos sólo vía `wrangler secret put`; ningún archivo con valores versionado; PII mínima, con retención declarada en `PRIVACY.md`.
7. **Dinero**: centavos enteros, idempotencia, monto y moneda comparados contra nuestra propia fila, ledger inmutable.
8. **Resiliencia**: timeouts, reintentos sólo sobre operaciones idempotentes, fallos transitorios reintentables (5xx) sin sellar el evento.
9. **Observabilidad**: una línea estructurada por evento, sin PII, suficiente para reconstruir qué pasó.

## 3. Stack y estructura

| capa                 | qué                                               | regla                                                                         |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runtime              | Cloudflare Workers, TypeScript estricto           | Un solo Worker; sin Node APIs fuera de lo que soporta workerd                 |
| HTTP                 | Hono                                              | `secureHeaders()` global; `onError` convierte excepciones de middleware en su respuesta y todo lo demás en 500 sin ruta concreta |
| Validación           | Zod                                               | Todo cuerpo, query y salida de modelo pasa por un schema `.strict()`          |
| Base de datos        | D1 (SQLite)                                       | Dinero `INTEGER` en centavos; `CHECK` de longitud o enum en toda columna de texto nueva que llega del cliente; triggers `RAISE(ABORT)` en tablas append-only |
| Archivos             | R2                                                | Nunca público; se sirve a través del Worker, detrás de la autorización        |
| IA                   | Workers AI (transcripción) y un modelo de lenguaje | Un único módulo llama al modelo (§4.3); la salida es datos que se validan, no instrucciones |
| Pagos                | PayPal REST, sandbox                              | El Worker captura y verifica por sí mismo; el webhook es confirmación, no fuente |
| Estáticos            | Workers Assets                                    | La consola se sirve sólo detrás de la credencial del veterinario              |

Árbol de `src/` (medido):

```
src/
  index.ts  app.ts  env.ts  auth.ts  log.ts       # arranque, rutas, tipos de entorno, auth, log sin PII
  money.ts  ledger.ts  billing.ts  paypal.ts      # centavos, asientos, factura, cliente del proveedor
  agent/    claude.ts  run.ts  tools.ts           # único punto de contacto con el modelo; guardas; herramientas sin dinero
  clinical/ transcribe redact roles schema fill grounding   # audio→texto, redacción, borrador, validador sin modelo
  reports/  render.ts  pdf.ts  explain.ts         # PDF de texto plano; explicación validada
  routes/   webhook approve charges consults report sim
  prior/    hmac.ts  text.ts                      # ayudantes previos al proyecto (ver README)
  images.ts  delivery.ts  subscription.ts         # suscripción de la clínica (candado de la IA)
  routes/subscription.ts
migrations/ 0001_… 0002_… 0003_… 0004_… 0005_…     # forward-only, numeradas
scripts/    checks.sh  mutants.sh  paypal-plan.sh  # paypal-plan.sh: GATED, crea producto+plan en sandbox
test/       *.test.ts  helpers.ts  apply-migrations.ts
```

## 4. Convenciones de código

### 4.1 Nombres y archivos

- Un módulo por responsabilidad; nombre en minúsculas, sin prefijos de tipo. Las rutas van en `src/routes/<recurso>.ts` y se montan en `app.ts`.
- Dinero: toda función que recibe o devuelve un monto lleva `cents` en el nombre o en el parámetro (`centsToValue`, `valueToCents`, `formatCents`). No existe un `amount` sin unidad.
- Pruebas: `test/<módulo>.test.ts`, un `describe` por módulo, nombres que dicen el **comportamiento** y, si cubren una cláusula del contrato, su identificador (`E4: replay…`).

### 4.2 Entorno y dependencias

- `interface Env` en `env.ts` es el único lugar que declara bindings, variables y secretos. Las variables numéricas se leen con un parser que falla cerrado ante basura.
- Las dependencias externas (fetch al proveedor, reloj, modelo) entran por una `interface Deps` inyectada en el arranque, para que las pruebas las sustituyan sin mocks globales.
- Dependencias de producción fijadas sin rango en `package.json` (medido: las 2); lockfile versionado. Las de desarrollo pueden llevar rango.

### 4.3 El modelo de lenguaje

- Un **único** archivo llama al modelo; `scripts/checks.sh` lo verifica y falla si aparece otro.
- La salida del modelo se fuerza por `tool_choice` a un schema cerrado; se valida con Zod antes de usarse; lo que no valida se descarta y se registra el nombre del error.
- El modelo **nunca** ve precios ni los fija, nunca redacta nada que llegue al dueño sin un clic del veterinario, y calla (en vez de inventar) cuando una persona tiene el chat, el estado es ilegible, falta la llave o no terminó su turno.
- Texto del dueño o del paciente es **datos**, nunca instrucciones.
- Validador sin modelo para todo lo que la IA propone: cada campo cita segmento y comilla exacta; se descarta lo que no es subcadena literal, los números ausentes de la cita, los vitales fuera de rango y los ids de catálogo desconocidos.

### 4.4 Logs

```ts
log("webhook_rejected", { reason: "bad_signature", status: 400 });  // ids, enums, conteos, errName(e)
```

Nunca cuerpos, tokens, nombres, correos ni teléfonos. Un error no manejado registra `routePath`, nunca la URL concreta: las rutas de enlaces del dueño llevan el secreto en el path.

## 5. Datos

### 5.1 D1

- **Dinero `INTEGER` en centavos.** Nunca `REAL`, nunca texto con punto decimal. Los valores del proveedor se parsean como texto de dos decimales exactos y se rechaza cualquier otra forma.
- **Toda columna de texto NUEVA que llega del cliente lleva `CHECK (length(...) <= N)`; todo enum, `CHECK (col IN (...))`; todo booleano, `INTEGER CHECK (col IN (0, 1))`.** Medido 2026-11-03: en `0001`–`0002` hay 13 columnas de texto libre heredadas sin `CHECK` (p. ej. `assigned_to`, `escalation_reason`, `sku`, `unit`, `provider`, `created_by`; `raw` queda acotada por el 413 del webhook). Comando base: `grep -hnE '^\s+[a-z_]+ TEXT' migrations/*.sql | grep -vE 'CHECK|PRIMARY KEY|REFERENCES'`, descartando a mano ids, fechas ISO y columnas cuyo `CHECK` está en otra línea. No se corrigen editando la migración aplicada (§5.2): se añade el `CHECK` en una migración nueva cuando la columna se toque.
- **Idempotencia por `UNIQUE`.** El id de evento del proveedor, la clave de petición y el id de cargo son únicos; el código hace `INSERT … ON CONFLICT DO NOTHING` y lee `changes()`; sólo si esta petición insertó la fila encadena los efectos (confirmar cita, enviar mensaje). Nunca «SELECT y luego INSERT».
- **Append-only por trigger.** `BEFORE UPDATE` y `BEFORE DELETE` con `RAISE(ABORT, 'append-only')` en cargos, eventos de pago, líneas de factura, borradores, aprobaciones y liberaciones. El estado «actual» es una vista sobre el historial, no una columna que se sobreescribe.
- **Un batch por efecto de negocio.** Lo que debe ser atómico (evento + cambio de estado + mensaje) va en un único `batch()`; no hay transacciones repartidas en dos peticiones.
- **Sin PII del proveedor.** Los payloads de webhook se guardan sin `payer`/`payment_source`; la API del tablero nunca devuelve payloads crudos.

### 5.2 Migraciones

- Forward-only, numeradas `NNNN_nombre.sql`, aplicadas en orden con `wrangler d1 migrations apply` (scripts `db:migrate:local` y `db:migrate:remote`). No hay «down».
- Una migración ya aplicada en remoto no se edita: se escribe la siguiente.
- Las pruebas aplican las migraciones reales sobre un D1 local (`test/apply-migrations.ts`), nunca un schema paralelo escrito a mano.
- Todo cambio de schema llega con su prueba de que la restricción muerde (p. ej. el test de inmutabilidad del ledger intenta `UPDATE` y espera el abort).

### 5.3 R2

- Nunca público, sin URL firmadas. El Worker sirve el objeto tras autorizar.
- Imágenes: se aceptan por firma de bytes (JPEG/PNG), con tope de tamaño y de cantidad por consulta; los segmentos de metadatos (EXIF, GPS, chunks de texto) se eliminan estructuralmente **antes** del `put`.
- El audio no se escribe a R2 ni a D1: vive en memoria de la petición y la retención del proveedor de transcripción se documenta en `PRIVACY.md`.

## 6. Errores y respuestas

| situación                                             | respuesta                                             |
| ----------------------------------------------------- | ----------------------------------------------------- |
| Configuración faltante (secreto, id de webhook, credencial, entorno no sandbox) | 503, antes de tocar al proveedor o parsear el cuerpo |
| Cuerpo o query que no pasa el schema                   | 400/422 con mensaje genérico, sin eco del cuerpo      |
| Firma de webhook ausente, incompleta o no verificada   | 400, 0 filas escritas                                 |
| Credencial del veterinario ausente o incorrecta         | 401 con `WWW-Authenticate`; comparación en tiempo constante |
| Enlace del dueño desconocido, vencido, de otro tipo o sin archivo | el **mismo** 404                           |
| Reporte completo con saldo no cubierto                  | 402; la receta nunca se gatea                         |
| Consentimiento faltante                                 | 409                                                   |
| Archivo demasiado grande (cabecera **y** stream)        | 413                                                   |
| Tipo de archivo no permitido                            | 415                                                   |
| Tope diario o por conversación                          | 429 (el presupuesto se reserva atómicamente antes de llamar al proveedor) |
| Fallo transitorio al capturar                           | 503 reintentable, sin sellar el id del evento         |
| Defecto nuestro                                         | 500 con `{ "error": "internal error" }` y log con el patrón de ruta |

El orden de comprobación es fijo y se prueba: configuración → autenticación → tamaño → tipo → presupuesto → cuerpo. Nunca se parsea el cuerpo antes de saber quién llama.

## 7. Pruebas

### 7.1 Qué se prueba y dónde

- Vitest con el pool de Workers: las pruebas corren **dentro** de workerd con D1 local real y las migraciones aplicadas. Nada se simula de la plataforma.
- `npm test` = `scripts/checks.sh` **y luego** la suite. Los checks estáticos fallan antes de correr un solo test.
- Un test por cláusula del contrato de aceptación; el nombre del test lleva el identificador de la cláusula.
- Medido (feat/auto-draft, 2026-11-07): 21 archivos de prueba; 73 mutantes en `scripts/mutants.sh`.

### 7.2 Checks estáticos (`scripts/checks.sh`)

- Un único archivo habla con el modelo.
- El host del proveedor de pagos es el de sandbox y sólo ese.
- Ningún `catch` vacío.
- Ningún término de proyectos privados ni de datos internos en `src`, `public`, `migrations`, `test`, `seed.sql`, `wrangler.toml`. Los términos viven en el script sólo como huellas SHA-256 de palabras, pares de palabras y prefijos numéricos con puntos, en minúsculas (el repo es público); la lista se amplía, nunca se acorta, y el guardia se autoprueba en cada corrida con un token aleatorio plantado fuera del repo. Parte identificadores camelCase y fronteras letra/dígito, pero no ve un término pegado en minúsculas dentro de otra palabra ni un prefijo numérico dentro de un número más largo: eso lo cubre la calificadora con su barrido de formas hostiles antes de cada publicación. La historia de git anterior a este guardia conserva los términos en claro; limpiarla es una decisión aparte del dueño del repo.

### 7.3 Control de mutantes (`scripts/mutants.sh`)

Todo código **behavior-critical** (dinero, firma, idempotencia, consentimiento, validadores de la IA, gate de reporte, metadatos de imagen) trae su par **rojo/verde**: la suite pasa sin el defecto y falla con él. El script:

1. Exige árbol limpio y corre la suite base: si la base no pasa, ningún «rojo» vale.
2. Por cada mutante inyecta el defecto con `sed`, corre el archivo de prueba correspondiente y exige **fail**; distingue `broken` (la suite no corrió) de `fail`, y `broken` nunca cuenta como mutante muerto.
3. Restaura el árbol.

Cuando dos barreras afirman el mismo hecho (comprobación en JavaScript + guarda «este batch insertó el evento»), cada una sola es un mutante equivalente: el control quita **ambas** y debe seguir en rojo.

### 7.4 Sondas contra el sandbox (contrato E1–E7)

Las seis sondas de R122 (§13.16) son: firma inválida, replay, monto alterado, moneda distinta, doble pago concurrente y fallo transitorio. Existen como pruebas locales con el proveedor sustituido y se repiten como **smoke** contra el Worker desplegado y el sandbox del proveedor después de cada deploy. Estado medido: las cinco primeras del lado del webhook en `test/webhook.test.ts` (que además cubre «sin id de webhook ⇒ 503», E2); la concurrencia en `test/report.test.ts` (dos entregas concurrentes del mismo evento liquidan una vez) y `test/approve.test.ts` (dos «Generar cobro» concurrentes ⇒ un cargo); smoke en sandbox vivo pendiente de ejecución (no medido).

## 8. Secretos y configuración

- Secretos sólo con `wrangler secret put <NOMBRE>`; nunca en `wrangler.toml`, nunca en el repo. `.env*` y `.dev.vars*` están en `.gitignore`.
- `wrangler.toml` lleva únicamente bindings y variables **no secretas** con valores de demo (entorno sandbox, moneda, topes). Cambiar un tope es un commit, no un secreto.
- Antes de publicar o de hacer público el repositorio: `gitleaks git --redact .` y `scripts/checks.sh` con salida limpia. Hoy no hay CI en el repositorio (medido: sin `.github/`); los gates corren en local y son obligatorios en el ciclo de §10.
- Las credenciales del veterinario son un secreto más; vacías ⇒ 503 en toda ruta protegida, aunque llegue un header válido.
- Rotación: un secreto que se sospecha filtrado se rota en el proveedor y en Wrangler el mismo día; la fecha y el nombre del secreto (no el valor) se anotan en el commit.

## 9. Dinero y ledger

1. **Centavos `INTEGER`** de extremo a extremo. La conversión a texto de dos decimales ocurre sólo en el borde con el proveedor y se prueba con un parser estricto en ambos sentidos.
2. **Nosotros capturamos.** La orden se crea con una clave de petición determinista igual al id de nuestro cargo; al confirmar, comparamos monto **y** moneda contra nuestra propia fila. Un desajuste se registra como `amount_mismatch` y no confirma nada.
3. **Webhook fail-closed**: cuerpo crudo leído una vez → tope de tamaño → las cinco cabeceras del proveedor presentes → verificación remota de la firma debe responder éxito (cualquier error = rechazo) → sólo entonces parsear.
4. **Idempotencia**: id de evento `UNIQUE`; replay ⇒ 200 sin efecto. Fallo transitorio al capturar ⇒ 503 **sin** sellar el id, para que el reintento del proveedor con el mismo cuerpo capture.
5. **Ledger append-only**; `balance = SUM` sobre el historial; la vista «actual» se deriva, nunca se guarda.
6. **El tratamiento no espera al pago.** Aprobar escribe la factura y envía las instrucciones urgentes en un batch, sin llamar al proveedor; la cuenta (ticket de 32 columnas, chat y PDF desde la misma función) viaja UNA vez: con la liga de pago, o al aprobar si el anticipo cubrió todo; la receta la imprime y firma el médico desde la consola y nunca viaja al dueño (una receta digital se reimprime); el enlace de pago se genera después, idempotente (un cargo de saldo por consulta), y llega al chat sólo cuando **esta** petición creó el cargo.
7. **Precios desde el servidor**: el cuerpo aprobado lleva ids de catálogo y cantidades; los precios unitarios se copian del catálogo a líneas append-only; total − depósito capturado = saldo. Un catálogo sin precio se rehúsa a cobrar y `/health` lo reporta.
8. Una orden de pago no es un comprobante fiscal; los precios son montos con impuestos incluidos fijados por la clínica.
9. **La clínica paga la IA con una suscripción** (PayPal Subscriptions, `subscriptions`/`subscription_events` append-only + vista `subscription_current`). El `plan_id` y el precio (`SUBSCRIPTION_PRICE_CENTS`) viven en el servidor; el body de `/subscription/start` es `.strict()` vacío. Sólo un webhook verificado cuyo `subscription id` sea el nuestro, cuyo `plan_id` sea el configurado y cuyo monto **y** moneda igualen el precio pasa a `active` (ACTIVATED con su `last_payment`, o el primer `PAYMENT.SALE.COMPLETED` desde `approval_pending`); un desajuste es `amount_mismatch` y no activa. `POST /consults/:id/fill` responde 402 `subscription_required` sin suscripción activa y 503 si no puede leerla; `SUBSCRIPTION_REQUIRED` sólo apaga el candado con el texto exacto `"false"`.

## 10. Ciclo de trabajo

Tres roles, nunca la misma ventana para dos:

1. **Constructora**: recibe el encargo, abre un worktree desde `main`, escribe el **contrato de aceptación** (cláusulas gradeables E1…En, sección «ARCHITECTURE.md» con las secciones aplicadas y la escalera de §2.2 recorrida si la superficie es sensible), construye código + pruebas + mutantes, deja **commit sin push** y avisa.
2. **Calificadora**: en contexto fresco, califica contrato y diff deny-by-default contra este documento: corre `npm test` y `scripts/mutants.sh`, busca lo que el contrato prometió y el diff no cumple, y emite PASS o NO PASS con hallazgos por severidad. No construye ni arregla.
3. **Quien integra** mergea en `main` local sólo con PASS; el **push** y cualquier escritura remota (deploy, migración remota, secretos) son del dueño del repositorio y están **gated** por su confirmación explícita.

Reglas del ciclo:

- Cada hallazgo de calificación se promueve a regla, check o mutante (ratchet); no se parcha una sola vez.
- `skipped` no es evidencia. Una suite que no corrió es `broken`, no verde.
- Lo que no se midió se declara «no medido». Cifras sin comando que las reproduzca no entran al contrato.
- No se toca el worktree de otro rol.

## 11. Front-end mínimo (consola y enlaces del dueño)

- La consola del veterinario es una página estática servida **por el Worker** sólo tras la autenticación; CSP `default-src 'self'`; todo texto de transcripción se pinta con `textContent`.
- Páginas del dueño (`/r/<token>`, `/t/<token>`): `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`; nada cacheable, nada indexable.
- Los PDF son texto plano generado por el Worker (fuentes estándar, imágenes embebidas tal cual, sin decodificar) para caber en el presupuesto de CPU del plan gratuito; cualquier librería que decodifique imágenes está fuera.

## 12. Despliegue

- `wrangler deploy` al subdominio de Workers; la consola pasa por el Worker antes que por los assets (`run_worker_first`).
- Los logs de invocación están apagados; el Worker emite sus propias líneas sin PII.
- El rate limit por IP del webhook y de los enlaces del dueño se configura en el borde (reglas WAF), no en código; la app aplica el tope diario y por conversación.
- Después de cada deploy: `/health` y las sondas de §7.4.

## 13. Reglas duras

Cada regla tiene dueño único: vive aquí y en ningún otro archivo. Si otro documento la necesita, la enlaza. Las R1–R20 son de este repositorio; las R118–R122 conservan la numeración del documento del que derivan (ver pie) para que las referencias cruzadas sigan valiendo.

- **R1** — Dinero en `INTEGER` centavos en D1 y en TypeScript; texto de dos decimales sólo en el borde con el proveedor, con parser estricto. 🔴 enforced: test de `money.ts` + mutante.
- **R2** — Cargos, eventos de pago, líneas de factura, borradores, aprobaciones y liberaciones son append-only con trigger `RAISE(ABORT)`. 🔴 enforced: test de inmutabilidad del ledger.
- **R3** — Idempotencia por `UNIQUE` + `ON CONFLICT DO NOTHING` + `changes()`; nunca «SELECT y luego INSERT». 🔴 enforced: mutante «insert sin guarda».
- **R4** — El webhook de pago es fail-closed: cuerpo una vez, tope, cabeceras completas, verificación remota con éxito explícito, y sólo entonces parsear. Sin id de webhook ⇒ 503. 🔴 enforced: tests E1–E4 + mutante «verify acepta todo menos FAILURE».
- **R5** — Monto **y** moneda se comparan contra nuestra fila en **todos** los caminos de confirmación; desajuste ⇒ `amount_mismatch`, nunca `captured`. 🔴 enforced: mutantes por camino.
- **R6** — El modelo nunca ve ni fija precios; schemas de herramientas y de cuerpos aprobados son `.strict()` sin campos de dinero. 🔴 enforced: mutante «schema acepta clave extra».
- **R7** — Un único módulo llama al modelo. 🔴 enforced: `scripts/checks.sh`.
- **R8** — El host del proveedor de pagos es constante y sandbox; `PAYPAL_ENV !== "sandbox"` ⇒ 503 global. 🔴 enforced: `checks.sh` + test de app.
- **R9** — Nada escrito por la IA llega al dueño sin un clic humano separado; la liberación es una fila append-only con PK = consulta y el mensaje se encadena a `changes() = 1`. 🔴 enforced: mutante «segundo clic envía de nuevo».
- **R10** — Todo lo que la IA propone pasa por un validador sin modelo: subcadena literal, números presentes en la cita, rangos, ids conocidos. 🔴 enforced: mutantes de grounding y explicación.
- **R11** — Logs sin PII: ids, enums, conteos, `errName`. 🔴 enforced: `pii_guard.test.ts`. Que los errores no manejados registren `routePath` y no la URL concreta es 🟡 review-gate: ninguna prueba toca `onError` (medido).
- **R12** — Tokens del dueño: 256 bits, sólo SHA-256 en D1, expiran, 404 uniforme, `no-store` / `no-referrer` / `noindex`; nunca en logs. 🔴 enforced: tests de `report`.
- **R13** — La receta nunca se gatea por pago; el reporte completo lee el ledger (`charges_current`), no un flag. 🔴 enforced: mutante «gate acepta cualquier status».
- **R14** — Aprobar nunca llama al proveedor de pagos; el enlace de pago se crea después, idempotente, y se envía sólo si esta petición creó el cargo. 🔴 enforced: mutante «pay-link sin guarda».
- **R15** — Audio: orden fijo 503 → 409 → 413 (header y stream) → 415 → 429, presupuesto reservado atómicamente, bytes sólo en memoria. 🔴 enforced: `audio.test.ts`.
- **R16** — Imágenes por firma de bytes, con topes, metadatos eliminados antes del `put`; R2 nunca público. 🔴 enforced: mutante «jpeg metadata kept».
- **R17** — Credencial del veterinario vacía ⇒ 503 en toda ruta protegida; comparación en tiempo constante. 🔴 enforced: `console_auth.test.ts`.
- **R18** — Migraciones forward-only numeradas; las pruebas aplican las migraciones reales; una migración aplicada no se edita. 🟡 review-gate.
- **R19** — Secretos sólo por `wrangler secret put`; `.env*`/`.dev.vars*` ignorados; `gitleaks` y `checks.sh` limpios antes de publicar. 🔴 enforced: gitleaks local (sin CI, medido).
- **R20** — Todo código behavior-critical trae su mutante rojo/verde en `scripts/mutants.sh`; `broken` nunca cuenta como muerto; dos barreras del mismo hecho se quitan juntas. 🟡 review-gate.

Leyenda: 🔴 mecánico (un test, script o restricción lo hace fallar) · 🟡 review-gate (lo verifica la calificadora, documentado aquí) · 🟢 informativo.

### 13.16 Diseño para pruebas duras

> Una app sobrevive un pentest, una auditoría o un red team porque se **diseñó** para pasar cada prueba, no porque se parchó después de fallarla. Cada prueba de la tabla es un **sensor** y a su lado está la **regla constructiva** que hace que el código nazca pasándola. Lo que ya cubre una regla existente se referencia; sólo se numera lo que faltaba. Medido 2026-11-03 sobre `main = d421c41`; re-mide antes de citar.

#### (a) Tabla prueba → regla de diseño

**Nivel 1 — sin tocar nada desplegado** (corren en local; no hay CI en el repo, medido)

| prueba                        | qué hay hoy en el repo (medido)                                                                                                          | regla que la hace pasar por diseño                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Mutación                      | `scripts/mutants.sh`: 45 mutantes rojo/verde con baseline y estado `broken` separado                                                      | R20; §7.3                                               |
| Escaneo de secretos           | `gitleaks` local antes de publicar; `.gitignore` cubre `.env*` y `.dev.vars*`; `checks.sh` veta términos de proyectos privados             | R19; §8                                                 |
| SAST                          | No existe (ni Semgrep ni CodeQL). Mitigación de diseño: sinks concentrados (un módulo para el modelo, uno para el proveedor de pagos)      | §4.3, R7; **R118**                                      |
| SCA (dependencias)            | Lockfile versionado; 2 dependencias de producción fijadas sin rango; sin gate automático de CVE                                           | §4.2; **R118**                                          |
| Fuzzing de endpoints          | No existe. Diseño: 26 usos de `.strict()` (medido), orden fijo de comprobación (§6), `onError` sin eco                                     | §6; **R119**                                            |
| Propiedades (dinero y ledger) | No existe (sin librería de propiedades instalada); los invariantes se prueban por ejemplos y mutantes                                      | §9, R1–R5; **R120**                                     |
| BOLA / IDOR                   | Un solo rol autenticado (veterinario) y enlaces del dueño por token hasheado con 404 uniforme; tests de `console_auth` y `report`           | R12, R17; **R121**                                      |
| STRIDE por endpoint           | Exigido en el contrato de aceptación (§2.2-5, §10); sin gate mecánico                                                                      | §2.2                                                    |
| Auditoría de PII              | `PRIVACY.md`, `pii_guard.test.ts`, `clinical/redact.ts`; payloads sin `payer`                                                             | R11, §5.1                                               |

**Nivel 2 — contra el Worker desplegado, con topes** (sandbox del proveedor; nunca datos reales)

| prueba                                           | qué hay hoy en el repo (medido)                                                                                   | regla que la hace pasar por diseño |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| DAST pasivo                                      | No existe. Diseño: `secureHeaders()` global, CSP `'self'` en la consola, cabeceras `no-store`/`no-referrer`/`noindex` en enlaces del dueño | §11; R12                           |
| Lógica de dinero (replay, firma, monto, carrera) | Proveedor sustituido: firma inválida, replay, monto alterado, moneda distinta y fallo transitorio en `test/webhook.test.ts`; doble pago concurrente en `test/report.test.ts` y `test/approve.test.ts`; smoke en sandbox vivo pendiente (no medido) | R4, R5, R3; **R122**               |
| Cabeceras / TLS                                  | TLS lo da la plataforma; cabeceras por `secureHeaders()`; sin veredicto automatizado                              | §11                                |

**Nivel 3 — pesadas, de organización** (no las pasa el código solo; el repo produce la evidencia)

| prueba                     | qué hay hoy en el repo (medido)                                                                     | lo que el diseño aporta                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Carga y caos               | No hay. Topes diarios y por conversación en la app; rate limit por IP en el borde                   | §12; R15; reintentos sólo sobre operaciones idempotentes (R3, R4-fallo transitorio) |
| Revisión criptográfica     | No hay. Web Crypto para tokens y hashes; comparación en tiempo constante; sin «llave de desarrollo» | R12, R17; §2.2-1                                                                  |
| Pentest externo / red team | No hay. Insumo: los veredictos de calificación                                                      | §10: cada hallazgo se promueve a regla, check o mutante, nunca se parcha una vez   |
| Auditoría formal (SOC 2 u otra) | No hay. `PRIVACY.md` y este documento                                                           | Toda evidencia es un artefacto versionado o la salida de un script, nunca una captura a mano |

#### (b) Reglas duras

- **R118** — **Toda dependencia o runtime nuevo entra en el MISMO commit con lockfile y con el escaneo que le aplique (SAST, SCA, imagen) cuando exista en el repo; si no existe, el contrato lo declara «no medido» y la calificadora lo trata como hallazgo abierto, no como aprobado.** Un componente sin lockfile ni gate de CVE no es «experimental»: es inauditable. Medido 2026-11-03: lockfile presente, 0 escaneos automatizados. **Enforced by**: review-gate 🟡 (candidato mecánico: un paso de `checks.sh` que exija lockfile actualizado y un escaneo SCA cuando se instale).
- **R119** — **Todo endpoint público valida con schema CERRADO (`.strict()`) y contesta 4xx, nunca 5xx, a cualquier entrada; la autenticación y la configuración se comprueban ANTES de parsear el cuerpo.** Un fuzz que produce un 500 es defecto de la app, no ruido: cada 500 es un oráculo y un consumo de recursos antes de saber quién llama. Medido: 26 schemas `.strict()`, orden fijo en §6. **Enforced by**: review-gate 🟡 (candidato: un test que envíe cuerpos basura a cada ruta y exija 0 × 500).
- **R120** — **Los invariantes de dinero y ledger (redondeo único, idempotencia, atomicidad, balance = SUM, total − depósito = saldo ≥ 0) se prueban por PROPIEDADES, no sólo por ejemplos.** Un generador de montos y secuencias afirma que el invariante se sostiene para cualquier entrada, incluidos los bordes que un ejemplo a mano no escribe (centavo impar, moneda distinta, replay fuera de orden). Medido: 0 tests por propiedades; cubierto parcialmente por ejemplos y mutantes (R20). **Enforced by**: review-gate 🟡; complementa R20.
- **R121** — **Toda ruta que recibe un id o token de recurso tiene su test «credencial de A sobre el recurso de B ⇒ 403/404 y 0 filas», y toda acción con efectos (aprobar, cobrar, enviar, liberar) exige la credencial explícita en el handler.** Que la ruta esté detrás de una autenticación global no autoriza sobre el recurso concreto. Hoy el repo tiene un solo rol autenticado; la regla aplica desde el momento en que exista un segundo (otro veterinario, recepción) o un id de consulta llegue del cliente. **Enforced by**: review-gate 🟡; extiende R12, R17.
- **R122** — **Todo webhook que mueve dinero trae, antes del primer deploy, su batería de seis sondas en el sandbox del proveedor, y las repite como smoke tras cada deploy; nunca contra producción real.** Las seis: firma inválida ⇒ 4xx y 0 filas; replay del mismo evento ⇒ 1 captura, 1 evento; monto alterado ⇒ nunca `captured`; moneda distinta ⇒ nunca `captured`; doble pago concurrente ⇒ 1 cargo; fallo transitorio al capturar ⇒ 5xx reintentable sin sellar el id del evento. Operacionaliza R3–R5 contra una instancia viva, que es donde fallan la configuración de llaves, la URL pública y el registro del webhook, cosas que ningún test local ve. Medido: sondas locales repartidas como dice §7.4 (`webhook`, `report`, `approve`); smoke en sandbox pendiente. **Enforced by**: review-gate 🟡.

#### (c) Checklist

Una línea por prueba en el Apéndice A («Pruebas duras»).

---

## Apéndice A — Checklist rápido antes de pedir calificación

- [ ] ¿Leí este documento y la sección de §13 que toca mi cambio?
- [ ] ¿Busqué en `src/` antes de escribir algo que quizá ya existe? (§2.1-2)
- [ ] ¿Tabla o columna nueva? → `CHECK` de longitud/enum, `UNIQUE` de idempotencia, trigger append-only si es evidencia, migración `NNNN_` nueva (§5)
- [ ] ¿Monto nuevo? → `INTEGER` centavos, nombre con `cents`, comparado contra nuestra fila (§9)
- [ ] ¿Endpoint nuevo? → schema `.strict()`, orden configuración → auth → tamaño → tipo → presupuesto → cuerpo, 4xx nunca 5xx (§6)
- [ ] ¿Secreto nuevo? → `wrangler secret put`, declarado en `Env`, 503 si falta (§8)
- [ ] ¿Toca al modelo? → sigue en un solo módulo; salida validada sin modelo; nada al dueño sin clic (§4.3)
- [ ] ¿Log nuevo? → ids, enums, conteos, `errName`; nunca PII ni rutas concretas con token (§4.4)
- [ ] Gates locales: `npm run typecheck`, `npm test` (checks + suite), `bash scripts/mutants.sh`. `skipped` o `broken` no es evidencia.
- [ ] Contrato con sección «ARCHITECTURE.md»: secciones aplicadas y, si la superficie es sensible, la escalera de §2.2 recorrida.

Pruebas duras (§13.16), una línea por prueba:

- [ ] Mutación: ¿código behavior-critical? → mutante rojo con el defecto, verde sin él (R20, §7.3)
- [ ] Secretos: `gitleaks git --redact .` limpio; ningún `.env*`/`.dev.vars*` versionado (R19)
- [ ] SAST: sinks concentrados (un módulo para el modelo, uno para pagos); sin `catch` vacío (R7, `checks.sh`)
- [ ] SCA: ¿dependencia nueva? → versión fija, lockfile actualizado, escaneo si existe o «no medido» explícito (R118)
- [ ] Fuzzing: ¿endpoint público nuevo? → schema cerrado, auth antes del cuerpo, 0 × 500 con entrada basura (R119)
- [ ] Propiedades: ¿toca montos o asientos? → test por propiedades de los invariantes de §9 (R120)
- [ ] BOLA/IDOR: ¿ruta con id o token? → test «A sobre B = 403/404 y 0 filas»; ¿acción con efectos? → credencial explícita en el handler (R121)
- [ ] STRIDE: ¿superficie sensible nueva? → las seis letras recorridas en el contrato (§2.2-5)
- [ ] PII: ¿dato personal nuevo? → línea en `PRIVACY.md` con retención; fuera de logs y payloads (R11)
- [ ] Cabeceras: ¿página o enlace nuevo? → `secureHeaders()` activo; `no-store`/`no-referrer`/`noindex` si lleva token (§11)
- [ ] Dinero desplegado: ¿webhook de pago tocado? → seis sondas en sandbox + smoke tras el deploy (R122)
- [ ] Carga/caos, pentest, cripto, auditoría: ¿evidencia pedida? → artefacto versionado o salida de script, nunca captura a mano (§13.16 nivel 3)

---

## Apéndice B — Cómo re-medir cada cifra

| cifra                                | comando                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Archivos de prueba                   | `ls test/*.test.ts \| wc -l`                                            |
| Mutantes                             | `grep -c 'run_mutant "' scripts/mutants.sh`                             |
| Schemas cerrados                     | `grep -rn "\.strict()" src \| wc -l`                                    |
| Triggers append-only                 | `grep -c "RAISE(ABORT" migrations/*.sql`                                |
| Dependencias de producción           | `node -e "console.log(Object.keys(require('./package.json').dependencies).length)"` |
| Término privado filtrado             | `bash scripts/checks.sh` (sección de términos vetados)                  |
| Secretos en el historial             | `gitleaks git --redact .`                                               |

---

_Derivado de las reglas de codificación de un monorepo privado; sin datos de clientes._
