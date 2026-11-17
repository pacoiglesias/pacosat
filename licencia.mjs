/* ===== Base comercial de PacoSAT (ronda 2.3.0, pieza 20) =====
   Fundamentos de la licencia comercial, APAGADOS por defecto: el
   servidor solo expone sus rutas cuando el entorno trae
   PACOSAT_COMERCIAL=1 (ver local-server.mjs). Nada de este módulo
   se publica ni cambia el comportamiento para Paco sin esa
   variable: es la base sobre la que la capa comercial futura
   construirá, no la capa misma.

   Dos piezas:
   (a) Huella de máquina: SHA-256 por componente. Los valores en
       claro se leen solo en el momento de calcular la huella y
       jamás se guardan ni salen del proceso: lo que viaja y lo
       que una licencia guarda son los hashes, irreversibles.
       Los componentes son inyectables para poder probar la
       tolerancia sin depender del equipo real.
   (b) Verificación de licencia: documento JSON firmado con
       Ed25519. La firma se verifica contra la clave pública que
       se pasa (la del servidor es la incrustada aquí); la máquina
       se acepta por MAYORÍA: la licencia es válida si coinciden
       MÁS DE LA MITAD de los componentes que la licencia trae,
       la firma es buena y no ha caducado. Los motivos de rechazo
       van en lenguaje llano, para enseñarlos tal cual. */
import { createHash, verify as cryptoVerify } from 'node:crypto';
import { hostname, networkInterfaces, cpus, platform, arch } from 'node:os';

/* La clave pública de firma de Paco. Hoy va VACÍA a propósito: la
   clave privada de firma no existe todavía (se generará cuando la
   capa comercial se active, y su mitad privada jamás vivirá en
   este árbol). Sin clave incrustada, ninguna licencia puede
   darse por válida — verificarLicencia lo dice en llano — y las
   pruebas inyectan su propio par de claves. */
export const CLAVE_PUBLICA_LICENCIA = '';

/* Componentes por defecto: solo lo que el proceso puede leer sin
   privilegios en cualquier equipo — nombre del equipo, las MAC
   de interfaces NO internas, el modelo de CPU y la plataforma.
   Cada componente es { id, valor }; el valor en claro no sale de
   esta función más que hacia huellaMaquina, que lo resume. */
export function componentesDeMaquina() {
  const componentes = [];
  const nombre = String(hostname() || '').trim();
  if (nombre) componentes.push({ id: 'equipo', valor: nombre });
  const macs = new Set();
  for (const lista of Object.values(networkInterfaces() || {}))
    for (const interfaz of lista || []) {
      if (interfaz?.internal) continue;
      const mac = String(interfaz?.mac || '').toLowerCase();
      if (mac && mac !== '00:00:00:00:00:00') macs.add(mac);
    }
  for (const mac of [...macs].sort()) componentes.push({ id: 'mac', valor: mac });
  const cpu = String(cpus()?.[0]?.model || '').trim();
  if (cpu) componentes.push({ id: 'cpu', valor: cpu });
  componentes.push({ id: 'plataforma', valor: platform() + '-' + arch() });
  return componentes;
}

/* La huella de UN componente: SHA-256 del par id+valor (el id
   entra en el resumen para que el mismo valor en dos componentes
   distintos no produzca el mismo hash). */
export function hashComponente(componente) {
  const id = typeof componente === 'string' ? '' : String(componente?.id || '');
  const valor = typeof componente === 'string' ? componente : String(componente?.valor ?? '');
  return createHash('sha256').update('pacosat-licencia:' + id + ':' + valor.trim(), 'utf8').digest('hex');
}

/* La huella de la máquina: un hash por componente, sin duplicados
   y en orden estable. Solo hashes: nada en claro. */
export function huellaMaquina(componentes = componentesDeMaquina()) {
  return [...new Set((componentes || []).map(hashComponente))].sort();
}

/* El texto exacto que la firma cubre: el documento sin su firma,
   con la lista de componentes ordenada — firmar y verificar
   construyen el mismo texto, así el orden en que la licencia
   liste sus hashes no cambia el veredicto. */
export function payloadCanonicoLicencia(documento) {
  const doc = documento || {};
  return JSON.stringify({
    titular: String(doc.titular || ''),
    rfcMax: Number(doc.rfcMax) || 0,
    maquina: [...(Array.isArray(doc.maquina) ? doc.maquina.map(String) : [])].sort(),
    expedicion: String(doc.expedicion || ''),
    caducidad: String(doc.caducidad || '')
  });
}

/* Verificar una licencia contra la máquina actual.
   documento: { titular, rfcMax, maquina: [hashes], expedicion,
     caducidad, firma } — fechas como 'AAAA-MM-DD' (o ISO) y la
     firma en base64 sobre payloadCanonicoLicencia(documento).
   componentesActuales: los componentes de ESTA máquina (por
     defecto, los reales); clavePublica: PEM de Ed25519 (por
     defecto, la incrustada). ahora: instante de la comprobación
     (inyectable para pruebas).
   Devuelve { valida, motivo, ... } con el motivo en llano. */
export function verificarLicencia(documento, componentesActuales = componentesDeMaquina(),
  clavePublica = CLAVE_PUBLICA_LICENCIA, ahora = Date.now()) {
  const rechazo = motivo => ({ valida: false, motivo,
    titular: String(documento?.titular || ''), rfcMax: Number(documento?.rfcMax) || 0,
    caducidad: String(documento?.caducidad || ''), coincidencias: 0,
    componentesLicencia: Array.isArray(documento?.maquina) ? documento.maquina.length : 0 });
  if (!documento || typeof documento !== 'object')
    return rechazo('No hay ningún documento de licencia que comprobar.');
  if (!String(documento.titular || '').trim())
    return rechazo('La licencia no trae el nombre de su titular.');
  const hashesLicencia = Array.isArray(documento.maquina) ? documento.maquina.map(String) : [];
  if (!hashesLicencia.length)
    return rechazo('La licencia no trae la huella de ningún equipo: no se puede comprobar que es para esta máquina.');
  if (!String(clavePublica || '').trim())
    return rechazo('Todavía no hay una clave de firma configurada en esta copia: la licencia no se puede comprobar.');
  if (!String(documento.firma || '').trim())
    return rechazo('La licencia no trae firma: no se puede comprobar que es auténtica.');
  let firmaBuena = false;
  try {
    firmaBuena = cryptoVerify(null, Buffer.from(payloadCanonicoLicencia(documento), 'utf8'),
      String(clavePublica), Buffer.from(String(documento.firma), 'base64'));
  } catch { firmaBuena = false; }
  if (!firmaBuena)
    return rechazo('La firma de la licencia no es válida: el documento no es auténtico o fue cambiado.');
  const caducidad = String(documento.caducidad || '');
  const caducaMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(caducidad) ? caducidad + 'T23:59:59Z' : caducidad);
  if (!Number.isFinite(caducaMs))
    return rechazo('La licencia no trae una fecha de caducidad que se pueda leer.');
  if (ahora > caducaMs)
    return { ...rechazo('La licencia caducó el ' + caducidad + ': hay que renovarla para seguir usándola en modo comercial.'),
      caducidad };
  const actuales = new Set(huellaMaquina(componentesActuales));
  const coincidencias = hashesLicencia.filter(hash => actuales.has(hash)).length;
  if (!(coincidencias > hashesLicencia.length / 2))
    return { valida: false,
      motivo: 'Esta licencia es de otro equipo: solo coinciden ' + coincidencias + ' de los ' +
        hashesLicencia.length + ' componentes de su huella, y hace falta que coincida más de la mitad.',
      titular: String(documento.titular), rfcMax: Number(documento.rfcMax) || 0,
      caducidad, coincidencias, componentesLicencia: hashesLicencia.length };
  return { valida: true, motivo: 'Licencia válida para este equipo.',
    titular: String(documento.titular), rfcMax: Number(documento.rfcMax) || 0,
    caducidad, coincidencias, componentesLicencia: hashesLicencia.length };
}
