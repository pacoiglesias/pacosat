# PacoSAT — Arquitectura híbrida-local (decisión #1)

**Estado: DISEÑO EN PAPEL.** Este documento describe cómo sería PacoSAT
como plataforma comercial con el modelo híbrido-local. No se ha construido
el sistema de licencias ni ningún componente nuevo en esta ronda (1.24.0,
punto 8): lo que sigue es la propuesta para que Paco decida.

## La idea en una frase

El motor de PacoSAT y las credenciales fiscales viven **en el equipo del
cliente** — como hoy viven en el NAS de Paco — y lo único central es la
**licencia**: quién puede usarlo, hasta cuándo y con qué plan. Ningún
CFDI, ninguna e.firma y ninguna contraseña sale jamás del equipo del
cliente.

## Principios (no negociables, vienen de la casa)

1. **Las credenciales no viajan.** La e.firma (.cer/.key y su contraseña)
   y la CIEC se guardan y se usan solo en el equipo del cliente, cifradas
   en reposo con una llave de ese equipo — exactamente como hoy hace
   PacoSAT con `pacosat-secrets` y su cifrado en reposo (AES-256-GCM).
2. **Los datos no viajan.** La base de CFDI, documentos, avisos y
   respaldos es local. El respaldo cifrado del cliente es asunto del
   cliente (su NAS, su nube), nunca del centro.
3. **El centro no conoce la operación.** El servicio de licencias no
   recibe RFCs de los contribuyentes que el cliente maneja, ni volúmenes,
   ni actividad. Solo conoce la instalación y su licencia.
4. **Sin licencia válida no se castiga el expediente.** Vencer una
   licencia detiene las descargas nuevas; **nunca** bloquea consultar,
   exportar o respaldar lo ya descargado. El expediente es del cliente.

## Componentes

### En el equipo del cliente (la instalación)

| Componente | Qué es hoy / qué sería |
|---|---|
| Motor PacoSAT | El servidor actual (Node + base local + navegador del portal): descargas, vigilancia, avisos, salidas, respaldo. Es, sin cambios de fondo, el motor local. |
| Bóveda local | e.firma y CIEC cifrados en reposo con llave del equipo; el desbloqueo lo gobierna la app, como hoy. |
| Agente de licencia | Pieza pequeña y separada del motor: guarda la licencia firmada, la valida contra el centro cuando hay red y aplica la ventana de gracia sin red. No toca datos fiscales. |
| Actualizador | Descarga paquetes firmados, verifica la firma antes de aplicar, respalda antes de actualizar y puede revertir. |

### En el centro (lo mínimo)

| Componente | Qué hace |
|---|---|
| Servicio de licencias | Altas, activación, validación periódica, renovación, suspensión y revocación de licencias. Guarda: titular de la licencia, plan, vigencia, huella de instalación. Nada fiscal. |
| Repositorio de versiones | Los paquetes de actualización **firmados** y su manifiesto (versión, huella, notas). |
| Consola del licenciante | La herramienta de Paco (o de su equipo) para emitir y gestionar licencias y ver el parque de instalaciones (versión y vigencia, sin datos de operación). |

## Flujo de licenciamiento

1. **Alta.** Se crea la licencia en la consola: titular, plan, vigencia.
   Se entrega al cliente una **clave de activación** (no es una
   credencial fiscal; es un código de producto).
2. **Activación.** La instalación, ya montada en el equipo del cliente,
   presenta la clave y una **huella de instalación** (identificador
   derivado del equipo, sin datos personales ni fiscales). El centro
   devuelve la licencia firmada (titular, plan, vigencia, huella) y la
   instalación la guarda localmente.
3. **Validación periódica.** El agente comprueba la firma localmente en
   cada arranque y consulta al centro de forma periódica (p. ej. semanal)
   para recoger renovaciones o revocaciones.
4. **Sin red / centro caído.** La licencia firmada vale offline dentro de
   su vigencia, con una **ventana de gracia** tras el vencimiento
   (propuesta: 30 días) durante la cual todo sigue funcionando y la app
   avisa en llano de que hay que renovar.
5. **Vencimiento sin renovar.** Pasada la gracia: se detienen las
   corridas contra el SAT (descargas, consultas de portal) y los envíos
   automáticos; la consulta, la exportación y el respaldo del expediente
   siguen abiertos para siempre (principio 4).
6. **Renovación.** Se paga, la consola extiende la vigencia y la
   siguiente validación recoge la licencia renovada. Sin reinstalación.
7. **Cambio de equipo.** La consola libera la huella y la instalación se
   activa en el equipo nuevo; la bóveda y la base se mueven con el
   respaldo cifrado del propio cliente.

## Aislamiento por cliente

- **Una instalación = un equipo = un cliente.** No hay multi-inquilino:
  ningún proceso comparte base ni bóveda entre clientes. Es la misma
  separación que hoy existe entre el NAS de Paco y cualquier otro equipo.
- Dentro de una instalación, el aislamiento por contribuyente (RFC) es el
  que PacoSAT ya aplica: pantallas, correos, respaldos y alcances por
  RFC, con el modo invitado limitado por alcance.
- El centro no puede cruzar datos entre instalaciones porque **no los
  tiene**: su base contiene licencias y huellas, no operación.

## Actualizaciones

- Cada versión se publica como paquete con **manifiesto firmado** por el
  centro (llave de firma fuera del paquete y fuera de las instalaciones).
- La instalación verifica la firma y la huella antes de aplicar; si algo
  no cuadra, no aplica y lo dice.
- Antes de aplicar: respaldo automático del estado; si la actualización
  falla, se revierte a la versión anterior sin tocar la base.
- El cliente elige su ventana (nunca en mitad de una corrida del SAT ni
  de un cierre); el centro puede marcar una versión como «recomendada»
  pero no forzarla, salvo corrección de seguridad declarada como tal.

## Seguridad

- La llave de firma de licencias y de paquetes vive solo en el centro,
  separada del repositorio público de código.
- La clave de activación no da acceso a nada más que a activar; robarla
  no abre ninguna instalación (la licencia queda ligada a la huella).
- La bóveda local mantiene su regla actual: la e.firma y la CIEC no
  salen del equipo ni siquiera para el soporte (ver D4).

## PUNTOS DE DECISIÓN DE PACO (sin decidir = no se construye)

- **D1 · Modelo comercial.** ¿La licencia se vende por instalación, por
  número de RFC contribuyentes, por usuario, o por una combinación?
  Define qué cuenta la licencia y qué enseña la consola.
- **D2 · Dureza al vencer.** Ventana de gracia (propuesta: 30 días) y
  qué se detiene exactamente al agotarla (propuesta: solo las corridas
  contra el SAT y los envíos automáticos; nunca el expediente).
- **D3 · Dónde vive el centro.** Infraestructura propia de Paco (su NAS /
  un VPS suyo) frente a un servicio de terceros. Afecta a coste,
  disponibilidad y a quién custodia la llave de firma.
- **D4 · Soporte remoto.** ¿Habrá alguna vía de soporte con acceso al
  equipo del cliente? Propuesta: **ninguna por defecto**; si un día la
  hay, que sea sesión iniciada y cortada por el cliente, con su gesto,
  y jamás incluyendo credenciales fiscales.
- **D5 · Invitados en el producto.** El modo invitado con alcance por
  RFC (hoy: la familia / el despacho ven lo suyo) ¿entra en el producto
  comercial tal cual, se limita, o queda como función de la instalación
  de Paco?
- **D6 · Telemetría.** Propuesta: ninguna. Si un día se quiere saber qué
  versiones corren, la validación de licencia ya lo dice (versión y
  vigencia); cualquier dato más exigiría consentimiento expreso del
  cliente.

## Qué se reutiliza y qué falta

- **Ya existe y sirve tal cual:** el motor completo (es la instalación),
  la bóveda cifrada, el respaldo cifrado por conjuntos con su ensayo de
  restauración, el aislamiento por RFC y el invitado por alcance, el
  login propio de administrador (convive con la puerta actual desde la
  1.24.0).
- **Falta por construir cuando D1–D3 estén decididos:** el servicio de
  licencias y su consola, el agente de licencia en la instalación, el
  canal de actualizaciones firmadas y el instalador para equipos de
  cliente (hoy el despliegue es a medida del NAS de Paco).

*Documento de la ronda 1.24.0 (punto 8). Decisión #1 de Paco: pendiente.*
