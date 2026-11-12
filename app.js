/* App de censos — Servicio de Cardiología.
   Los datos de pacientes se piden al servidor en cada sesión y viven solo en memoria:
   no se guardan en el dispositivo. Lo único que se recuerda es la sesión (12 horas). */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const $app = document.getElementById('app');
  const $capas = document.getElementById('capas');
  const LLAVE_TOKEN = 'cardio_censos_sesion';
  const DIAS_INICIALES = 45;

  const AREAS = [
    { clave: 'hospitalizacion', nombre: 'Hospitalización' },
    { clave: 'intensivos', nombre: 'Unidad de cuidados intensivos' },
    { clave: 'intermedios', nombre: 'Unidad de cuidados intermedios' },
    { clave: 'cardio_cxcv', nombre: 'Cardiología y cirugía cardiovascular' },
    { clave: 'cirugia', nombre: 'Cirugía' },
    { clave: 'hemato_onco', nombre: 'Hematología / Oncología' },
    { clave: 'emergencia', nombre: 'Emergencia' }
  ];
  const NOMBRE_AREA = {};
  AREAS.forEach(function (a, i) { NOMBRE_AREA[a.clave] = a.nombre; a.n = i; });
  const ESTUDIOS = ['Ecocardiograma', 'Monitoreo Holter', 'Interconsulta', 'Evaluación preoperatoria',
    'Prueba de esfuerzo', 'Ecocardiograma transesofágico', 'Resonancia magnética cardiaca'];
  const PRIORIDADES = ['I. Emergencia', 'II. Urgencia', 'III. A demanda'];
  const GRUPOS_EDAD = [['Menos de 20', 0, 19], ['20 – 29', 20, 29], ['30 – 39', 30, 39], ['40 – 49', 40, 49], ['50 – 59', 50, 59],
    ['60 – 69', 60, 69], ['70 – 79', 70, 79], ['80 o más', 80, 200]];
  const LETRAS_DIA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const NOMBRES_DIA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  const S = {
    token: '', usuario: null, medicos: [], motivos: [], areas: [], hoy: '', filas: new Map(), repetidas: new Set(),
    desde: '', sincronizado: '', cargando: false, errorCarga: '', ui: {}, archivos: new Map(), cupos: null, stats: null, usuarios: null
  };

  /* ============================== utilidades ============================== */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      const v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (let i = 2; i < arguments.length; i++) agregar(el, arguments[i]);
    return el;
  }
  function agregar(el, hijo) {
    if (hijo === null || hijo === undefined || hijo === false) return;
    if (Array.isArray(hijo)) hijo.forEach(function (x) { agregar(el, x); });
    else el.appendChild(hijo.nodeType ? hijo : document.createTextNode(String(hijo)));
  }
  /** <select> con opciones [valor, texto] o grupos {grupo, opciones}. */
  function selector(opciones, valor, attrs) {
    const s = h('select', attrs);
    const op = function (o) { return h('option', { value: o[0], selected: String(o[0]) === String(valor) }, o[1]); };
    opciones.forEach(function (o) {
      if (o.grupo) s.appendChild(h('optgroup', { label: o.grupo }, o.opciones.map(op))); else s.appendChild(op(o));
    });
    return s;
  }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function fechaLarga(iso) {
    const p = iso.split('-');
    const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
    return NOMBRES_DIA[(d + 6) % 7] + ' ' + Number(p[2]) + ' de ' + MESES[Number(p[1]) - 1] + ' de ' + p[0];
  }
  function fechaCorta(iso) { const p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function horaDe(fh) { return String(fh || '').slice(11, 16); }
  function fechaHora(fh) { return fh ? fechaCorta(fh) + ' ' + horaDe(fh) : ''; }
  function telefono(t) { const d = String(t || '').replace(/\D/g, ''); return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4) : d; }
  function sumarDias(iso, n) {
    const p = iso.split('-');
    const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
    return d.toISOString().slice(0, 10);
  }
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }
  function guardarToken(t) { try { if (t) localStorage.setItem(LLAVE_TOKEN, t); else localStorage.removeItem(LLAVE_TOKEN); } catch (e) { /* sin almacenamiento */ } }
  function leerToken() { try { return localStorage.getItem(LLAVE_TOKEN) || ''; } catch (e) { return ''; } }
  function esAdmin() { return S.usuario && S.usuario.rol === 'admin'; }

  async function api(action, datos) {
    if (!CFG.API_URL || /PEGAR_AQUI/.test(CFG.API_URL)) {
      const e0 = new Error('La app aún no está conectada. Falta pegar la dirección de la API en el archivo config.js.');
      e0.code = 'CONFIG';
      throw e0;
    }
    let res, j;
    try {
      res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action, token: S.token }, datos || {})) });
      j = await res.json();
    } catch (e) {
      const e1 = new Error('No hay conexión con el servidor. Revise su internet e intente de nuevo.');
      e1.code = 'RED';
      throw e1;
    }
    if (!j.ok) {
      const e2 = new Error(j.error || 'Ocurrió un error.');
      e2.code = j.code;
      if (j.code === 'SESION' && S.token) { cerrarSesion(j.error); }
      if (j.code === 'CAMBIAR_CLAVE' && S.usuario) { S.usuario.debe_cambiar = true; pintar(); }
      throw e2;
    }
    return j.data;
  }

  /* ============================== avisos y modales ============================== */
  let tostadaActual = null;
  function tostada(texto, opciones) {
    const o = opciones || {};
    if (tostadaActual) tostadaActual.remove();
    const t = h('div', { class: 'tostada' + (o.error ? ' error' : ''), role: 'status' }, h('span', null, texto),
      o.accion ? h('button', { onclick: function () { t.remove(); o.accion.fn(); } }, o.accion.texto) : null);
    document.body.appendChild(t);
    tostadaActual = t;
    setTimeout(function () { t.remove(); }, o.accion ? 8000 : 4500);
  }
  function modalesAbiertos() { return $capas.children.length > 0; }
  function abrirModal(contenido, opciones) {
    const o = opciones || {};
    const velo = h('div', { class: 'velo', role: 'dialog', 'aria-modal': 'true' });
    const cerrar = function () { velo.remove(); document.removeEventListener('keydown', tecla); if (!modalesAbiertos()) document.body.style.overflow = ''; if (o.alCerrar) o.alCerrar(); };
    const tecla = function (ev) { if (ev.key === 'Escape' && $capas.lastChild === velo && !document.querySelector('.visor')) cerrar(); };
    velo.addEventListener('mousedown', function (ev) { if (ev.target === velo) cerrar(); });
    document.addEventListener('keydown', tecla);
    velo.appendChild(typeof contenido === 'function' ? contenido(cerrar) : contenido);
    $capas.appendChild(velo);
    document.body.style.overflow = 'hidden';
    const foco = velo.querySelector('[data-foco]') || velo.querySelector('button, input, select');
    if (foco) foco.focus();
    return cerrar;
  }
  function modalChico(titulo, cuerpo) {
    return abrirModal(function (cerrar) {
      return h('div', { class: 'modal chico' },
        h('div', { class: 'modal-cab' }, h('h2', { style: 'margin:0' }, titulo), h('button', { class: 'btn chico x', onclick: cerrar, 'aria-label': 'Cerrar' }, '✕')),
        h('div', { class: 'modal-cuerpo' }, cuerpo(cerrar)));
    });
  }
  function cajaError() { return h('div', { role: 'alert' }); }
  function mostrarError(caja, e) { caja.textContent = ''; caja.appendChild(h('div', { class: 'aviso error' }, e.message || String(e))); }
  async function conBoton(btn, fn) {
    const texto = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Un momento…';
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = texto; }
  }

  /* ============================== sesión ============================== */
  function cerrarSesion(mensaje) {
    S.token = '';
    S.usuario = null;
    S.filas = new Map();
    S.archivos.forEach(function (a) { URL.revokeObjectURL(a.url); });
    S.archivos = new Map();
    S.cupos = S.stats = S.usuarios = null;
    S.sincronizado = '';
    guardarToken('');
    $capas.textContent = '';
    document.body.style.overflow = '';
    pintarAcceso(mensaje);
  }

  function pintarAcceso(mensaje) {
    $app.textContent = '';
    const err = cajaError();
    const usuario = h('input', { id: 'in-usuario', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' });
    const clave = h('input', { id: 'in-clave', type: 'password', autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn primario ancho', type: 'submit' }, 'Ingresar');
    $app.appendChild(h('div', { class: 'acceso' }, h('form', { class: 'caja', onsubmit: async function (ev) {
      ev.preventDefault();
      err.textContent = '';
      try {
        const r = await conBoton(btn, function () { return api('login', { usuario: usuario.value, clave: clave.value }); });
        S.token = r.token;
        S.usuario = r.usuario;
        guardarToken(r.token);
        await iniciar();
      } catch (e) { mostrarError(err, e); }
    } },
      h('img', { src: 'icons/icon-192.png', alt: '' }),
      h('h1', null, 'Censos de Cardiología'),
      h('p', { class: 'sub' }, 'Solicitudes de estudios cardiológicos'),
      mensaje ? h('div', { class: 'aviso alerta' }, mensaje) : null,
      h('div', { class: 'campo' }, h('label', { for: 'in-usuario' }, 'Usuario'), usuario),
      h('div', { class: 'campo' }, h('label', { for: 'in-clave' }, 'Contraseña'), clave),
      err, btn,
      h('p', { style: 'color:#51606f;font-size:12.5px;text-align:center;margin:14px 0 0' }, 'Acceso exclusivo del personal autorizado. Toda acción queda registrada.'))));
    usuario.focus();
  }

  function formularioClave(alTerminar, obligado) {
    const err = cajaError();
    const actual = h('input', { id: 'cl-actual', type: 'password', autocomplete: 'current-password' });
    const nueva = h('input', { id: 'cl-nueva', type: 'password', autocomplete: 'new-password' });
    const repite = h('input', { id: 'cl-repite', type: 'password', autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primario ancho', type: 'submit' }, 'Guardar contraseña');
    return h('form', { onsubmit: async function (ev) {
      ev.preventDefault();
      err.textContent = '';
      if (nueva.value !== repite.value) { mostrarError(err, new Error('Las contraseñas nuevas no coinciden.')); return; }
      try {
        await conBoton(btn, function () { return api('clave.cambiar', { actual: actual.value, nueva: nueva.value }); });
        S.usuario.debe_cambiar = false;
        tostada('Contraseña actualizada.');
        alTerminar();
      } catch (e) { mostrarError(err, e); }
    } },
      obligado ? h('div', { class: 'aviso info' }, 'Por seguridad, debe crear su propia contraseña antes de continuar.') : null,
      h('div', { class: 'campo' }, h('label', { for: 'cl-actual' }, obligado ? 'Contraseña temporal' : 'Contraseña actual'), actual),
      h('div', { class: 'campo' }, h('label', { for: 'cl-nueva' }, 'Contraseña nueva (mínimo 8 caracteres)'), nueva),
      h('div', { class: 'campo' }, h('label', { for: 'cl-repite' }, 'Repita la contraseña nueva'), repite),
      err, btn);
  }

  function menuCuenta() {
    modalChico(S.usuario.nombre, function (cerrar) {
      return [h('p', { style: 'margin:0 0 14px;color:#51606f' }, 'Usuario: ' + S.usuario.usuario + ' · ' + (esAdmin() ? 'Administrador' : 'Médico')),
        h('div', { style: 'display:grid;gap:10px' },
          h('button', { class: 'btn', onclick: function () { cerrar(); modalChico('Cambiar contraseña', function (c2) { return formularioClave(c2, false); }); } }, 'Cambiar contraseña'),
          h('button', { class: 'btn peligro', onclick: function () { cerrarSesion('Sesión cerrada.'); } }, 'Cerrar sesión'))];
    });
  }

  /* ============================== datos ============================== */
  function aObjeto(cols, arr) {
    const o = {};
    cols.forEach(function (c, i) { o[c] = arr[i]; });
    o.pN = PRIORIDADES.indexOf(o.prioridad) + 1 || 9;
    o.edadN = o.edad === '' ? -1 : Number(o.edad);
    o.areaN = NOMBRE_AREA[o.area] ? AREAS.filter(function (a) { return a.clave === o.area; })[0].n : 99;
    o.busca = norm(o.nombre + ' ' + o.expediente);
    return o;
  }
  function recalcularRepetidas() {
    const grupos = {};
    S.filas.forEach(function (f) {
      if (!f.expediente) return;
      const k = f.fecha + '|' + f.expediente + '|' + f.estudio;
      (grupos[k] = grupos[k] || []).push(f.id);
    });
    S.repetidas = new Set();
    Object.keys(grupos).forEach(function (k) { if (grupos[k].length > 1) grupos[k].forEach(function (id) { S.repetidas.add(id); }); });
  }
  function integrar(r) {
    r.filas.forEach(function (arr) { const o = aObjeto(r.columnas, arr); S.filas.set(o.id, o); });
    S.hoy = r.fecha;
    recalcularRepetidas();
  }
  async function aplicarInicio() {
    const r = await api('inicio');
    S.usuario = r.usuario;
    S.medicos = r.medicos;
    S.motivos = r.motivos_no;
    S.areas = r.areas;
    S.hoy = r.fecha;
    return r;
  }
  /** Trae del servidor los últimos días y todos los pendientes. Lo más antiguo ya cargado se conserva. */
  async function sincronizar(silencioso) {
    if (S.cargando || !S.token) return;
    S.cargando = true;
    if (!silencioso) pintar();
    try {
      const ventana = sumarDias(S.hoy || new Date().toISOString().slice(0, 10), -DIAS_INICIALES);
      const partes = await Promise.all([aplicarInicio(), api('solicitudes.listar', { desde: ventana, hasta: '9999-12-31', pendientes: true })]);
      const recibidos = new Set(partes[1].filas.map(function (arr) { return arr[0]; }));
      const antiguas = new Map();
      let cambioAntiguo = false;
      S.filas.forEach(function (f, id) {
        if (f.fecha >= ventana) return;
        // Un pendiente antiguo que ya no llega fue cerrado desde otro dispositivo: hay que releerlo.
        if (f.estado === 'PENDIENTE' && !recibidos.has(id)) cambioAntiguo = true;
        antiguas.set(id, f);
      });
      S.filas = antiguas;
      integrar(partes[1]);
      if (cambioAntiguo) integrar(await api('solicitudes.listar', { desde: S.desde, hasta: sumarDias(ventana, -1) }));
      if (!S.desde || ventana < S.desde) S.desde = ventana;
      S.sincronizado = partes[1].hora;
      S.errorCarga = '';
    } catch (e) {
      if (e.code !== 'SESION') S.errorCarga = e.message;
    }
    S.cargando = false;
    if (S.token && !(silencioso && (modalesAbiertos() || escribiendo()))) pintar();
  }
  function escribiendo() {
    const a = document.activeElement;
    return a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && $app.contains(a);
  }
  async function cargarAntiguos(desde) {
    if (S.desde && desde >= S.desde) return;
    const r = await api('solicitudes.listar', { desde: desde, hasta: S.desde ? sumarDias(S.desde, -1) : '9999-12-31' });
    integrar(r);
    S.desde = desde;
  }
  async function iniciar() {
    try {
      await aplicarInicio();
    } catch (e) {
      if (e.code !== 'SESION') pintarAcceso(e.message);
      return;
    }
    if (S.usuario.debe_cambiar) { pintar(); return; }
    pintar();
    await sincronizar();
  }
  function filasArr() { return Array.from(S.filas.values()); }
  function estadoArea(clave) { return S.areas.filter(function (a) { return a.clave === clave; })[0] || null; }
  function textoEstadoArea(a) {
    if (!a) return '';
    const cupos = a.cupos === null ? a.usados + ' recibidas (sin límite)' : a.usados + ' de ' + a.cupos + ' cupos usados';
    if (a.abierto && a.cupo_extra) return 'Formulario abierto con ' + plural(a.pases, 'cupo extra', 'cupos extra') + ' · ' + cupos;
    if (a.abierto) return 'Formulario abierto hasta las ' + a.hora_cierra + ' · ' + cupos;
    return 'Formulario cerrado: ' + a.motivo + ' · ' + cupos;
  }

  /* ============================== marco general ============================== */
  function barra(titulo, sub, conVolver) {
    return h('header', { class: 'barra' }, h('div', { class: 'barra-int' },
      conVolver ? h('a', { class: 'btn-barra', href: '#/' }, '‹ Inicio') : h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
      h('h1', null, titulo, sub ? h('small', null, sub) : null),
      h('button', { class: 'btn-barra no-imprimir', title: 'Actualizar datos', onclick: function () { S.cupos = S.stats = S.usuarios = null; sincronizar(); } }, '↻', h('span', { class: 'txt' }, S.cargando ? ' Actualizando…' : ' Actualizar')),
      h('button', { class: 'btn-barra no-imprimir', onclick: menuCuenta, 'aria-label': 'Mi cuenta' }, S.usuario ? S.usuario.usuario : '')));
  }
  function ruta() { return location.hash.replace(/^#\/?/, '').split('/'); }

  function pintar() {
    if (!S.token || !S.usuario) { pintarAcceso(); return; }
    const y = window.scrollY;
    const activo = document.activeElement && $app.contains(document.activeElement) ? document.activeElement : null;
    const foco = activo && activo.id ? { id: activo.id, pos: activo.tagName === 'INPUT' && /^(text|search)$/.test(activo.type) ? activo.selectionStart : null } : null;
    $app.textContent = '';
    if (S.usuario.debe_cambiar) {
      $app.appendChild(h('div', { class: 'acceso' }, h('div', { class: 'caja' }, h('h1', { style: 'margin-bottom:14px' }, 'Cree su contraseña'),
        formularioClave(function () { iniciar(); }, true))));
      return;
    }
    const r = ruta();
    const main = h('main', { class: 'contenido' });
    let titulo = 'Censos de Cardiología', sub = S.hoy ? fechaLarga(S.hoy) : '', volver = true;
    if (S.errorCarga) main.appendChild(h('div', { class: 'aviso error', role: 'alert' }, S.errorCarga));
    if (r[0] === 'hoy') { titulo = 'Todas las solicitudes de hoy'; vistaHoy(main); }
    else if (r[0] === 'area' && NOMBRE_AREA[r[1]]) { titulo = NOMBRE_AREA[r[1]]; vistaArea(main, r[1]); }
    else if (r[0] === 'censo') { titulo = 'Censo'; sub = 'Todas las áreas'; vistaCenso(main); }
    else if (r[0] === 'cupos') { titulo = 'Control de cupos'; vistaCupos(main); }
    else if (r[0] === 'estadisticas') { titulo = 'Estadísticas'; sub = ''; vistaEstadisticas(main); }
    else if (r[0] === 'admin' && esAdmin()) { titulo = 'Usuarios y médicos'; sub = ''; vistaAdmin(main); }
    else { volver = false; vistaInicio(main); }
    $app.appendChild(barra(titulo, sub, volver));
    $app.appendChild(main);
    window.scrollTo(0, y);
    if (foco) {
      const el = document.getElementById(foco.id);
      if (el) { el.focus({ preventScroll: true }); if (foco.pos !== null) { try { el.setSelectionRange(foco.pos, foco.pos); } catch (e) { /* no aplica */ } } }
    }
  }

  /* ============================== inicio ============================== */
  function vistaInicio(main) {
    const todas = filasArr();
    const deHoy = todas.filter(function (f) { return f.fecha === S.hoy; });
    const pendientes = todas.filter(function (f) { return f.estado === 'PENDIENTE'; });
    const tarjeta = function (href, clase, nombre, cifra, cifraNota, nota) {
      return h('a', { class: 'modulo ' + clase, href: href }, h('div', { class: 'nombre' }, nombre),
        cifra !== null ? h('div', { class: 'cifra' }, cifra, h('small', null, cifraNota)) : null,
        nota ? h('div', { class: 'nota' }, nota) : null);
    };
    const sinDatos = !S.sincronizado;
    agregar(main, [
      h('div', { class: 'saludo' }, h('h2', null, 'Hola, ' + S.usuario.nombre), h('span', null, S.sincronizado ? 'Actualizado a las ' + S.sincronizado : 'Cargando solicitudes…')),
      h('div', { class: 'modulos' },
        tarjeta('#/hoy', 'principal', 'Todas las solicitudes de hoy', sinDatos ? '–' : deHoy.length, 'hoy',
          sinDatos ? '' : plural(deHoy.filter(function (f) { return f.estado === 'PENDIENTE'; }).length, 'pendiente', 'pendientes') + ' de hoy · ' + pendientes.length + ' en total')),
      h('h3', { class: 'seccion-t' }, 'Áreas'),
      h('div', { class: 'modulos' }, AREAS.map(function (a) {
        const hoyA = deHoy.filter(function (f) { return f.area === a.clave; }).length;
        const pend = pendientes.filter(function (f) { return f.area === a.clave; }).length;
        const e = estadoArea(a.clave);
        return h('a', { class: 'modulo', href: '#/area/' + a.clave },
          h('div', { class: 'nombre' }, a.nombre),
          h('div', { class: 'cifra' }, sinDatos ? '–' : pend, h('small', null, pend === 1 ? 'pendiente' : 'pendientes')),
          h('div', { class: 'nota' }, e ? h('span', { class: 'punto ' + (e.abierto ? (e.cupo_extra ? 'extra' : 'abierto') : '') }) : null,
            (sinDatos ? '' : hoyA + ' hoy · ') + (e ? (e.abierto ? 'formulario abierto' : 'formulario cerrado') : '')));
      })),
      h('h3', { class: 'seccion-t' }, 'Gestión'),
      h('div', { class: 'modulos' },
        tarjeta('#/cupos', 'util', 'Control de cupos', null, '', 'Cupos por área, días, horarios y cierres de calendario'),
        tarjeta('#/censo', 'util', 'Censo', null, '', 'Todas las áreas, de principio a fin'),
        tarjeta('#/estadisticas', 'util', 'Estadísticas', null, '', 'Estudios realizados por mes, tipo, médico, edad, sexo y prioridad'),
        esAdmin() ? tarjeta('#/admin', 'util', 'Usuarios y médicos', null, '', 'Cuentas de acceso y lista de médicos') : null)
    ]);
  }

  /* ============================== listas ============================== */
  const ORDENES = {
    fecha: ['Fecha y hora', function (a, b) { return cmp(a.fecha_hora, b.fecha_hora); }],
    hora: ['Hora de solicitud', function (a, b) { return cmp(a.fecha_hora, b.fecha_hora); }],
    prioridad: ['Prioridad', function (a, b) { return a.pN - b.pN || cmp(a.fecha_hora, b.fecha_hora); }],
    nombre: ['Nombre', function (a, b) { return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }); }],
    edad: ['Edad', function (a, b) { return a.edadN - b.edadN || cmp(a.fecha_hora, b.fecha_hora); }],
    area: ['Área', function (a, b) { return a.areaN - b.areaN || a.pN - b.pN || cmp(a.fecha_hora, b.fecha_hora); }]
  };
  function ui(llave, base) { if (!S.ui[llave]) S.ui[llave] = Object.assign({ q: '', limite: 150 }, base); return S.ui[llave]; }

  function controles(u, ordenes, extra) {
    const buscar = h('input', { type: 'search', id: 'buscar', placeholder: 'Nombre o número de expediente', value: u.q,
      oninput: function (ev) { u.q = ev.target.value; u.limite = 150; clearTimeout(buscar._t); buscar._t = setTimeout(function () { repintarLista(); }, 160); } });
    return h('div', { class: 'filtros no-imprimir' },
      h('div', { class: 'campo buscar' }, h('label', { for: 'buscar' }, 'Buscar paciente'), buscar),
      extra || null,
      h('div', { class: 'campo chico' }, h('label', { for: 'orden' }, 'Ordenar por'),
        selector(ordenes.map(function (k) { return [k, ORDENES[k][0]]; }), u.orden, { id: 'orden', onchange: function (ev) { u.orden = ev.target.value; pintar(); } })),
      h('div', { class: 'campo', style: 'flex:0 0 auto' }, h('label', null, ' '),
        h('button', { class: 'btn', title: 'Invertir el orden', onclick: function () { u.dir = -u.dir; pintar(); } }, u.dir > 0 ? '↑ Ascendente' : '↓ Descendente')));
  }
  let repintarLista = function () { pintar(); };

  function aplicar(filas, u) {
    const q = norm(u.q.trim());
    let r = q ? filas.filter(function (f) { return f.busca.indexOf(q) >= 0; }) : filas.slice();
    r.sort(ORDENES[u.orden][1]);
    if (u.dir < 0) r.reverse();
    return r;
  }

  function selectorMarcado(f) {
    const actual = f.estado === 'REALIZADO' ? 'R|' + f.realizado_por : f.estado === 'NO REALIZADO' ? 'N|' + f.motivo_no : 'P|';
    const medicos = S.medicos.filter(function (m) { return m.activo || m.nombre === f.realizado_por; }).map(function (m) { return ['R|' + m.nombre, m.nombre]; });
    if (f.estado === 'REALIZADO' && !medicos.some(function (m) { return m[0] === actual; })) medicos.push([actual, f.realizado_por]);
    const s = selector([['P|', 'Pendiente'], { grupo: 'Realizado por', opciones: medicos },
      { grupo: 'No se realizó', opciones: S.motivos.map(function (m) { return ['N|' + m, m]; }) }], actual,
    { class: 'marcar ' + (f.estado === 'REALIZADO' ? 'hecho' : f.estado === 'NO REALIZADO' ? 'no' : 'pend'),
      'aria-label': 'Resultado de la solicitud de ' + f.nombre,
      onclick: function (ev) { ev.stopPropagation(); },
      onchange: function (ev) { marcar(f, ev.target.value, actual, ev.target); } });
    return s;
  }

  async function marcar(f, valor, anterior, control, esDeshacer) {
    const tipo = { R: 'REALIZADO', N: 'NO_REALIZADO', P: 'PENDIENTE' }[valor.charAt(0)];
    if (control) control.disabled = true;
    try {
      const r = await api('solicitudes.marcar', { id: f.id, tipo: tipo, valor: valor.slice(2) });
      Object.assign(f, r);
      const texto = tipo === 'REALIZADO' ? 'Realizado por ' + r.realizado_por : tipo === 'NO_REALIZADO' ? 'Cerrada: ' + r.motivo_no : 'Devuelta a pendientes';
      tostada(f.nombre + ' — ' + texto, esDeshacer ? null : { accion: { texto: 'Deshacer', fn: function () { marcar(f, anterior, valor, null, true); } } });
    } catch (e) {
      tostada(e.message, { error: true });
    }
    if (S.detalleAbierto) S.detalleAbierto(f);
    pintar();
  }

  function chipPrioridad(f) { return h('span', { class: 'chip p' + f.pN }, f.prioridad || '—'); }
  function chipEstado(f) {
    if (f.estado === 'REALIZADO') return h('span', { class: 'chip ok' }, 'Realizado');
    if (f.estado === 'NO REALIZADO') return h('span', { class: 'chip gris' }, f.motivo_no || 'No realizado');
    return h('span', { class: 'chip azul' }, 'Pendiente');
  }

  function tabla(filas, u, op) {
    const o = op || {};
    if (!filas.length) return h('div', { class: 'tabla-caja' }, h('div', { class: 'vacio' }, S.sincronizado ? (o.vacio || 'No hay solicitudes en este apartado.') : 'Cargando solicitudes…'));
    const visibles = filas.slice(0, u.limite);
    const cuerpo = h('tbody');
    visibles.forEach(function (f) {
      cuerpo.appendChild(h('tr', { class: f.estado === 'PENDIENTE' ? '' : 'cerrada', tabindex: '0',
        onclick: function () { abrirDetalle(f); },
        onkeydown: function (ev) { if (ev.key === 'Enter' && ev.target.tagName === 'TR') abrirDetalle(f); } },
      h('td', { class: 'c-marcar' }, selectorMarcado(f)),
      h('td', { class: 'nowrap', 'data-e': 'Solicitud' }, o.soloHora ? horaDe(f.fecha_hora) : fechaHora(f.fecha_hora),
        f.origen === 'CUPO EXTRA' ? h('div', { class: 'tenue' }, 'cupo extra') : null),
      h('td', null, chipPrioridad(f)),
      h('td', { class: 'c-pac pac' }, h('b', null, f.nombre), h('span', { class: 'tenue' }, 'Exp. ' + (f.expediente || 's/d')),
        S.repetidas.has(f.id) ? h('span', { class: 'chip rep', style: 'margin-left:6px', title: 'Mismo expediente y estudio solicitados más de una vez este día' }, 'Posible repetida') : null),
      h('td', { class: 'nowrap', 'data-e': 'Edad' }, f.edad ? f.edad + ' a' : '—', f.sexo ? ' · ' + f.sexo.charAt(0) : ''),
      h('td', { class: 'c-serv' }, o.conArea ? h('div', null, h('b', null, NOMBRE_AREA[f.area] || f.area)) : null,
        h('span', { class: o.conArea ? 'tenue' : '' }, f.servicio + (f.cama ? ' · cama ' + f.cama : ''))),
      h('td', { 'data-e': 'Estudio' }, f.estudio)));
    });
    const col = function (texto, k) {
      return h('th', null, k && ORDENES[k] ? h('button', { title: 'Ordenar por ' + texto.toLowerCase(), onclick: function () { if (u.orden === k) u.dir = -u.dir; else { u.orden = k; u.dir = 1; } pintar(); } },
        texto + (u.orden === k ? (u.dir > 0 ? ' ↑' : ' ↓') : '')) : texto);
    };
    const tieneOrden = function (k) { return o.ordenes.indexOf(k) >= 0 ? k : null; };
    return h('div', { class: 'tabla-caja' },
      h('div', { class: 'tabla-scroll' }, h('table', { class: 'censo' },
        h('thead', null, h('tr', null, col('Realizado por'), col(o.soloHora ? 'Hora' : 'Fecha y hora', tieneOrden('fecha') || tieneOrden('hora')), col('Prioridad', tieneOrden('prioridad')),
          col('Paciente', tieneOrden('nombre')), col('Edad · sexo', tieneOrden('edad')), col(o.conArea ? 'Área · servicio' : 'Servicio · cama', tieneOrden('area')), col('Estudio'))),
        cuerpo)),
      h('div', { class: 'pie-tabla' }, h('span', null, 'Mostrando ' + visibles.length + ' de ' + plural(filas.length, 'solicitud', 'solicitudes')),
        filas.length > visibles.length ? h('button', { class: 'btn chico', onclick: function () { u.limite += 150; pintar(); } }, 'Mostrar más') : null));
  }

  function vistaHoy(main) {
    const u = ui('hoy', { orden: 'prioridad', dir: 1 });
    const ordenes = ['area', 'hora', 'prioridad'];
    const base = filasArr().filter(function (f) { return f.fecha === S.hoy; });
    const pend = base.filter(function (f) { return f.estado === 'PENDIENTE'; }).length;
    agregar(main, [
      h('div', { class: 'cab' }, h('h2', null, plural(base.length, 'solicitud', 'solicitudes') + ' hoy'),
        h('span', { class: 'estado-form' }, pend + ' pendientes · ' + (base.length - pend) + ' cerradas')),
      controles(u, ordenes),
      tabla(aplicar(base, u), u, { conArea: true, soloHora: true, ordenes: ordenes, vacio: 'Hoy todavía no se han recibido solicitudes.' })
    ]);
  }

  function vistaArea(main, clave) {
    const u = ui('area_' + clave, { tab: 'hoy', orden: 'prioridad', dir: 1 });
    const ordenes = ['fecha', 'prioridad', 'nombre', 'edad'];
    const todas = filasArr().filter(function (f) { return f.area === clave; });
    const grupos = {
      hoy: todas.filter(function (f) { return f.fecha === S.hoy; }),
      pendientes: todas.filter(function (f) { return f.fecha < S.hoy && f.estado === 'PENDIENTE'; }),
      completados: todas.filter(function (f) { return f.estado !== 'PENDIENTE'; })
    };
    const titulos = { hoy: 'Solicitudes de hoy', pendientes: 'Pendientes de días anteriores', completados: 'Estudios completados' };
    const e = estadoArea(clave);
    const cambiar = function (t) {
      u.tab = t;
      u.limite = 150;
      if (t === 'pendientes') { u.orden = 'fecha'; u.dir = 1; } else if (t === 'completados') { u.orden = 'fecha'; u.dir = -1; } else { u.orden = 'prioridad'; u.dir = 1; }
      pintar();
    };
    agregar(main, [
      h('div', { class: 'cab' }, h('h2', null, NOMBRE_AREA[clave]),
        h('span', { class: 'estado-form' }, e ? h('span', { class: 'punto ' + (e.abierto ? (e.cupo_extra ? 'extra' : 'abierto') : '') }) : null, textoEstadoArea(e)),
        h('button', { class: 'btn primario no-imprimir', onclick: function () { nuevaSolicitud(clave); } }, '＋ Nueva solicitud')),
      h('div', { class: 'pestanas', role: 'tablist' }, Object.keys(titulos).map(function (t) {
        return h('button', { class: 'pestana', role: 'tab', 'aria-selected': String(u.tab === t), onclick: function () { cambiar(t); } }, titulos[t], h('span', { class: 'n' }, grupos[t].length));
      })),
      controles(u, ordenes),
      tabla(aplicar(grupos[u.tab], u), u, { soloHora: u.tab === 'hoy', ordenes: ordenes,
        vacio: u.tab === 'hoy' ? 'Hoy no hay solicitudes de esta área.' : u.tab === 'pendientes' ? 'No hay pendientes de días anteriores.' : 'Aún no hay estudios completados en el periodo cargado.' }),
      u.tab === 'completados' ? pieAntiguos() : null
    ]);
  }

  function pieAntiguos() {
    const btn = h('button', { class: 'btn chico' }, 'Cargar 3 meses anteriores');
    btn.addEventListener('click', async function () {
      try { await conBoton(btn, function () { return cargarAntiguos(sumarDias(S.desde, -92)); }); pintar(); } catch (e) { tostada(e.message, { error: true }); }
    });
    return h('p', { class: 'no-imprimir', style: 'color:#51606f;font-size:13.5px;display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
      'Se muestran los completados desde el ' + fechaCorta(S.desde) + '.', btn);
  }

  /* ---------- nueva solicitud / cupo extra ---------- */
  function enlaceFormulario(clave) {
    const base = String(CFG.FORM_APP_URL || '');
    if (!base || /PEGAR_AQUI/.test(base)) return '';
    return base.replace(/#.*$/, '').replace(/\/?$/, '/') + '#/a/' + clave;
  }
  function nuevaSolicitud(clave) {
    const e = estadoArea(clave);
    const url = enlaceFormulario(clave);
    modalChico('Nueva solicitud', function (cerrar) {
      const caja = h('div');
      const err = cajaError();
      const enlace = function () {
        return url ? h('a', { class: 'btn primario ancho', href: url, target: '_blank', rel: 'noopener', onclick: cerrar }, 'Abrir el formulario de ' + NOMBRE_AREA[clave])
          : h('div', { class: 'aviso alerta' }, 'Falta configurar la dirección de la app de formularios en config.js. Abra la app de formularios manualmente.');
      };
      const pintarCaja = function (estado, recienAbierto) {
        caja.textContent = '';
        if (estado && estado.abierto && !estado.cupo_extra) {
          agregar(caja, [h('p', { style: 'margin-top:0' }, 'El formulario de esta área está abierto en este momento' +
            (estado.disponibles === null ? '.' : estado.disponibles === 1 ? ' y le queda 1 cupo.' : ' y le quedan ' + estado.disponibles + ' cupos.') + ' No hace falta abrir un cupo extra.'), enlace()]);
        } else if (estado && estado.abierto && estado.cupo_extra) {
          agregar(caja, [h('div', { class: 'aviso info' }, (recienAbierto ? 'Se abrió un cupo extra. ' : 'Ya hay ' + plural(estado.pases, 'cupo extra abierto', 'cupos extra abiertos') + '. ') +
            'El formulario se cerrará solo en cuanto reciba ' + (estado.pases === 1 ? 'la solicitud.' : 'esas solicitudes.')), enlace(),
          h('button', { class: 'btn ancho', style: 'margin-top:10px', onclick: async function (ev) {
            try { const r = await conBoton(ev.target, function () { return api('pase.cancelar', { area: clave }); }); S.areas = r.areas; pintar(); cerrar(); tostada('Cupo extra cancelado.'); } catch (e2) { mostrarError(err, e2); }
          } }, 'Cancelar un cupo extra')]);
        } else {
          agregar(caja, [h('p', { style: 'margin-top:0' }, 'El formulario de ' + NOMBRE_AREA[clave] + ' está cerrado' + (estado ? ' (' + estado.motivo + ')' : '') + '.'),
            h('p', null, 'Puede abrir un cupo extra: el formulario aceptará una sola solicitud más y volverá a cerrarse.'),
            h('button', { class: 'btn primario ancho', 'data-foco': true, onclick: async function (ev) {
              try {
                const r = await conBoton(ev.target, function () { return api('pase.abrir', { area: clave }); });
                S.areas = r.areas;
                pintar();
                pintarCaja(estadoArea(clave), true);
              } catch (e2) { mostrarError(err, e2); }
            } }, 'Abrir 1 cupo extra')]);
        }
      };
      pintarCaja(e, false);
      return [caja, err];
    });
  }

  /* ============================== detalle ============================== */
  async function obtenerArchivo(id, cual) {
    const llave = id + '|' + cual;
    if (S.archivos.has(llave)) return S.archivos.get(llave);
    const d = await api('archivo', { id: id, cual: cual });
    const bin = atob(d.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const a = { url: URL.createObjectURL(new Blob([bytes], { type: d.tipo })), tipo: d.tipo, nombre: d.nombre };
    S.archivos.set(llave, a);
    if (S.archivos.size > 24) { const vieja = S.archivos.keys().next().value; URL.revokeObjectURL(S.archivos.get(vieja).url); S.archivos.delete(vieja); }
    return a;
  }
  function visor(url) {
    const img = h('img', { src: url, class: 'ajustar', alt: 'Imagen ampliada' });
    const v = h('div', { class: 'visor' }, h('button', { class: 'btn cerrar' }, '✕ Cerrar'), img);
    const cerrar = function () { v.remove(); document.removeEventListener('keydown', tecla, true); };
    const tecla = function (ev) { if (ev.key === 'Escape') { ev.stopPropagation(); cerrar(); } };
    img.addEventListener('click', function (ev) { ev.stopPropagation(); img.classList.toggle('ajustar'); v.style.cursor = img.classList.contains('ajustar') ? 'zoom-out' : 'zoom-in'; });
    v.addEventListener('click', cerrar);
    document.addEventListener('keydown', tecla, true);
    document.body.appendChild(v);
  }
  function panelArchivo(f, cual, titulo) {
    const lienzo = h('div', { class: 'lienzo' });
    const acciones = h('span');
    if (!f[cual]) {
      lienzo.textContent = 'No se cargó este archivo.';
    } else {
      lienzo.appendChild(h('div', null, h('div', { class: 'giro' }), h('div', { style: 'margin-top:8px' }, 'Cargando…')));
      obtenerArchivo(f.id, cual).then(function (a) {
        lienzo.textContent = '';
        acciones.appendChild(h('a', { class: 'btn chico', href: a.url, target: '_blank', rel: 'noopener' }, 'Abrir en otra pestaña'));
        if (a.tipo === 'application/pdf') {
          if (navigator.pdfViewerEnabled) lienzo.appendChild(h('iframe', { src: a.url, title: titulo }));
          else lienzo.textContent = 'Documento PDF. Use "Abrir en otra pestaña" para verlo.';
        } else {
          lienzo.appendChild(h('img', { src: a.url, alt: titulo, title: 'Clic para ampliar', onclick: function () { visor(a.url); } }));
        }
      }).catch(function (e) { lienzo.textContent = 'No se pudo cargar: ' + e.message; });
    }
    return h('div', { class: 'archivo' }, h('div', { class: 'tit' }, titulo, acciones), lienzo);
  }
  function dato(et, valor) { return h('div', null, h('dt', null, et), h('dd', null, valor || '—')); }

  function abrirDetalle(f) {
    const peso = Number(f.peso), alt = Number(f.altura);
    const imc = peso > 0 && alt > 0 ? (peso / Math.pow(alt / 100, 2)).toFixed(1) : '';
    const sc = peso > 0 && alt > 0 ? Math.sqrt(peso * alt / 3600).toFixed(2) + ' m²' : '';
    const resultado = h('div');
    const pintarResultado = function (x) {
      resultado.textContent = '';
      agregar(resultado, [h('div', { style: 'margin-bottom:10px' }, selectorMarcado(x)),
        h('dl', { class: 'datos' }, dato('Estado', chipEstado(x)), x.estado !== 'PENDIENTE' ? dato('Fecha de cierre', fechaHora(x.fecha_realizado)) : null,
          x.marcado_por ? dato('Marcado por', x.marcado_por) : null)]);
    };
    pintarResultado(f);
    S.detalleAbierto = pintarResultado;
    abrirModal(function (cerrar) {
      return h('div', { class: 'modal' },
        h('div', { class: 'modal-cab' },
          h('div', { style: 'min-width:0' }, h('h2', null, f.nombre),
            h('div', { class: 'meta' }, chipPrioridad(f), h('span', null, f.estudio), h('span', null, '·'), h('span', null, 'Solicitud ' + f.id),
              h('span', null, '·'), h('span', null, fechaHora(f.fecha_hora)), f.origen === 'CUPO EXTRA' ? h('span', { class: 'chip gris' }, 'Cupo extra') : null,
              S.repetidas.has(f.id) ? h('span', { class: 'chip rep' }, 'Posible repetida') : null)),
          h('button', { class: 'btn chico x', onclick: cerrar, 'aria-label': 'Cerrar' }, '✕ Cerrar')),
        h('div', { class: 'modal-cuerpo' },
          h('section', { class: 'ficha' }, h('h3', null, 'Paciente'), h('dl', { class: 'datos' },
            dato('Expediente', f.expediente), dato('Edad', f.edad ? f.edad + ' años' : ''), dato('Sexo', f.sexo), dato('Fecha de nacimiento', f.fecha_nacimiento),
            dato('Peso', f.peso ? f.peso + ' kg' : ''), dato('Altura', f.altura ? f.altura + ' cm' : ''), dato('Presión arterial', f.presion ? f.presion + ' mmHg' : ''),
            dato('IMC', imc), dato('Superficie corporal', sc))),
          h('section', { class: 'ficha' }, h('h3', null, 'Ubicación y solicitante'), h('dl', { class: 'datos' },
            dato('Área', NOMBRE_AREA[f.area] || f.area), dato('Servicio', f.servicio), dato('# de cama', f.cama), dato('Médico que solicita', f.medico),
            dato('Contacto', f.contacto ? h('a', { href: 'tel:' + f.contacto }, telefono(f.contacto)) : ''))),
          h('section', { class: 'ficha todo' }, h('h3', null, 'Información clínica'),
            h('p', { class: 'texto-largo' }, h('b', null, 'Diagnóstico'), f.diagnostico || '—'),
            h('p', { class: 'texto-largo' }, h('b', null, 'Motivo del estudio'), f.motivo || '—'),
            h('p', { class: 'texto-largo' }, h('b', null, 'Historia clínica relevante'), f.historia || '—')),
          h('section', { class: 'todo archivos' }, panelArchivo(f, 'ekg', 'EKG'), panelArchivo(f, 'rx', 'Rx de tórax')),
          h('section', { class: 'ficha todo' }, h('h3', null, 'Resultado'), resultado)));
    }, { alCerrar: function () { S.detalleAbierto = null; } });
  }

  /* ============================== censo general ============================== */
  function vistaCenso(main) {
    const u = ui('censo', { orden: 'fecha', dir: -1, area: '', estado: '', estudio: '', desde: sumarDias(S.hoy || new Date().toISOString().slice(0, 10), -30), hasta: S.hoy || '' });
    const ordenes = ['fecha', 'prioridad', 'nombre', 'edad', 'area'];
    const filas = filasArr().filter(function (f) {
      return (!u.desde || f.fecha >= u.desde) && (!u.hasta || f.fecha <= u.hasta) && (!u.area || f.area === u.area) &&
        (!u.estado || f.estado === u.estado) && (!u.estudio || f.estudio === u.estudio);
    });
    const visibles = aplicar(filas, u);
    const err = cajaError();
    const pedir = async function (desde, btn) {
      try {
        await conBoton(btn, function () { return cargarAntiguos(desde); });
        u.desde = desde === '0000-01-01' ? '' : desde;
        pintar();
      } catch (e) { mostrarError(err, e); }
    };
    const filtro = function (id, etiqueta, control) { return h('div', { class: 'campo chico' }, h('label', { for: id }, etiqueta), control); };
    const extra = [
      filtro('f-desde', 'Desde', h('input', { type: 'date', id: 'f-desde', value: u.desde, max: S.hoy, onchange: function (ev) {
        const v = ev.target.value;
        if (v && S.desde && v < S.desde) pedir(v, ev.target); else { u.desde = v; pintar(); }
      } })),
      filtro('f-hasta', 'Hasta', h('input', { type: 'date', id: 'f-hasta', value: u.hasta, max: S.hoy, onchange: function (ev) { u.hasta = ev.target.value; pintar(); } })),
      filtro('f-area', 'Área', selector([['', 'Todas']].concat(AREAS.map(function (a) { return [a.clave, a.nombre]; })), u.area, { id: 'f-area', onchange: function (ev) { u.area = ev.target.value; pintar(); } })),
      filtro('f-estado', 'Estado', selector([['', 'Todos'], ['PENDIENTE', 'Pendiente'], ['REALIZADO', 'Realizado'], ['NO REALIZADO', 'No realizado']], u.estado, { id: 'f-estado', onchange: function (ev) { u.estado = ev.target.value; pintar(); } })),
      filtro('f-estudio', 'Estudio', selector([['', 'Todos']].concat(ESTUDIOS.map(function (x) { return [x, x]; })), u.estudio, { id: 'f-estudio', onchange: function (ev) { u.estudio = ev.target.value; pintar(); } }))
    ];
    agregar(main, [
      h('div', { class: 'cab' }, h('h2', null, 'Censo de todas las áreas'),
        h('button', { class: 'btn no-imprimir', onclick: function (ev) { pedir('0000-01-01', ev.target); } }, 'Cargar todo el historial'),
        h('button', { class: 'btn oscuro no-imprimir', onclick: function () { exportarCsv(visibles); } }, 'Descargar (CSV)')),
      err,
      controles(u, ordenes, extra),
      tabla(visibles, u, { conArea: true, ordenes: ordenes, vacio: 'No hay solicitudes con estos filtros.' }),
      h('p', { class: 'no-imprimir', style: 'color:#51606f;font-size:13.5px' }, S.desde > '0000-01-01' ? 'Datos cargados desde el ' + fechaCorta(S.desde) + '. Para ver fechas anteriores, cambie "Desde" o use "Cargar todo el historial".' : 'Historial completo cargado.')
    ]);
  }

  function descargar(nombre, texto) {
    const url = URL.createObjectURL(new Blob(['﻿' + texto], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: nombre });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function celdaCsv(v) {
    let s = String(v === undefined || v === null ? '' : v);
    if (/^[=+\-@\t]/.test(s)) s = "'" + s; // evita que Excel lo interprete como fórmula
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportarCsv(filas) {
    if (!filas.length) { tostada('No hay filas para descargar.'); return; }
    if (!confirm('El archivo contendrá datos de ' + plural(filas.length, 'paciente', 'pacientes') + '. Guárdelo solo en un equipo institucional. ¿Descargar?')) return;
    const cols = [['id', 'Solicitud'], ['fecha_hora', 'Fecha y hora'], ['area', 'Área'], ['servicio', 'Servicio'], ['cama', 'Cama'], ['estudio', 'Estudio'], ['prioridad', 'Prioridad'],
      ['nombre', 'Paciente'], ['expediente', 'Expediente'], ['edad', 'Edad'], ['sexo', 'Sexo'], ['fecha_nacimiento', 'Fecha de nacimiento'], ['peso', 'Peso (kg)'], ['altura', 'Altura (cm)'],
      ['presion', 'Presión arterial'], ['diagnostico', 'Diagnóstico'], ['motivo', 'Motivo del estudio'], ['historia', 'Historia clínica relevante'], ['medico', 'Médico solicitante'],
      ['contacto', 'Contacto'], ['estado', 'Estado'], ['realizado_por', 'Realizado por'], ['motivo_no', 'Motivo de no realización'], ['fecha_realizado', 'Fecha de cierre'], ['origen', 'Origen']];
    const lineas = [cols.map(function (c) { return celdaCsv(c[1]); }).join(',')];
    filas.forEach(function (f) { lineas.push(cols.map(function (c) { return celdaCsv(c[0] === 'area' ? (NOMBRE_AREA[f.area] || f.area) : f[c[0]]); }).join(',')); });
    descargar('censo_cardiologia_' + S.hoy + '.csv', lineas.join('\r\n'));
  }

  /* ============================== control de cupos ============================== */
  function vistaCupos(main) {
    if (!S.cupos) {
      main.appendChild(h('div', { class: 'vacio' }, 'Cargando configuración…'));
      api('cupos.obtener').then(function (r) { S.cupos = r; S.areas = r.areas; if (ruta()[0] === 'cupos') pintar(); })
        .catch(function (e) { if (ruta()[0] === 'cupos') { main.textContent = ''; main.appendChild(h('div', { class: 'aviso error' }, e.message)); } });
      return;
    }
    const admin = esAdmin();
    const borrador = S.cupos.borrador || (S.cupos.borrador = S.cupos.areas.map(function (a) {
      return { clave: a.clave, cupos: a.cupos === null ? '' : String(a.cupos), dias: a.dias.slice(), hora_abre: a.hora_abre, hora_cierra: a.hora_cierra, activo: a.activo, codigo: a.codigo || '' };
    }));
    const err = cajaError();
    const lista = h('div', { class: 'cupos-lista' });
    borrador.forEach(function (b) {
      const e = S.cupos.areas.filter(function (a) { return a.clave === b.clave; })[0];
      const dias = h('div', { class: 'dias', role: 'group', 'aria-label': 'Días en que abre' });
      LETRAS_DIA.forEach(function (letra, i) {
        const n = i + 1;
        const btn = h('button', { type: 'button', class: 'dia', disabled: !admin, 'aria-pressed': String(b.dias.indexOf(n) >= 0), title: NOMBRES_DIA[i] }, letra);
        btn.addEventListener('click', function () {
          const k = b.dias.indexOf(n);
          if (k >= 0) b.dias.splice(k, 1); else b.dias.push(n);
          btn.setAttribute('aria-pressed', String(k < 0));
        });
        dias.appendChild(btn);
      });
      lista.appendChild(h('div', { class: 'cupo' },
        h('div', { class: 'nom' }, NOMBRE_AREA[b.clave],
          h('small', null, h('span', { class: 'punto ' + (e.abierto ? (e.cupo_extra ? 'extra' : 'abierto') : '') }), 'Hoy: ' + textoEstadoArea(e).replace(/^Formulario /, '')),
          h('label', { class: 'interruptor', style: 'margin-top:8px' }, h('input', { type: 'checkbox', checked: b.activo, disabled: !admin, onchange: function (ev) { b.activo = ev.target.checked; } }), 'Formulario activo')),
        h('div', null, h('label', { class: 'mini', for: 'cu-' + b.clave }, 'Cupos por día'),
          h('input', { type: 'text', inputmode: 'numeric', id: 'cu-' + b.clave, maxlength: 3, placeholder: 'Sin límite', value: b.cupos, disabled: !admin,
            oninput: function (ev) { ev.target.value = ev.target.value.replace(/\D/g, ''); b.cupos = ev.target.value; } })),
        h('div', null, h('label', { class: 'mini' }, 'Días en que abre'), dias),
        h('div', null, h('label', { class: 'mini', for: 'ab-' + b.clave }, 'Abre a las'), h('input', { type: 'time', id: 'ab-' + b.clave, value: b.hora_abre, disabled: !admin, onchange: function (ev) { b.hora_abre = ev.target.value; } })),
        h('div', null, h('label', { class: 'mini', for: 'ci-' + b.clave }, 'Cierra a las'), h('input', { type: 'time', id: 'ci-' + b.clave, value: b.hora_cierra, disabled: !admin, onchange: function (ev) { b.hora_cierra = ev.target.value; } })),
        admin ? h('div', null, h('label', { class: 'mini', for: 'co-' + b.clave }, 'Código de acceso'),
          h('input', { type: 'text', id: 'co-' + b.clave, maxlength: 20, placeholder: 'Sin código', value: b.codigo, autocomplete: 'off', oninput: function (ev) { b.codigo = ev.target.value; } })) : null));
    });

    const aplicarRespuesta = function (r, mensaje) { S.cupos = r; S.areas = r.areas; pintar(); if (mensaje) tostada(mensaje); };
    const fecha = h('input', { type: 'date', id: 'ce-fecha', min: S.hoy });
    const area = selector([['TODAS', 'Todas las áreas']].concat(AREAS.map(function (a) { return [a.clave, a.nombre]; })), 'TODAS', { id: 'ce-area' });
    const motivo = h('input', { type: 'text', id: 'ce-motivo', maxlength: 80, placeholder: 'Ej. feriado, mantenimiento del equipo' });

    agregar(main, [
      h('div', { class: 'cab' }, h('h2', null, 'Control de cupos'), h('span', { class: 'estado-form' }, 'Hora del servidor: ' + S.cupos.hora)),
      !admin ? h('div', { class: 'aviso info' }, 'Solo un administrador puede cambiar esta configuración. Usted puede consultarla.') : null,
      h('section', { class: 'panel' }, h('h3', null, 'Cupos, días y horario por área'),
        h('p', { class: 'sub' }, 'Cada formulario recibe solicitudes solo en los días y horas indicados, y hasta agotar sus cupos del día. Deje "Cupos por día" vacío para no poner límite.' +
          (admin ? ' Si escribe un código de acceso, el formulario lo pedirá antes de enviar.' : '')),
        lista, err,
        admin ? h('div', { style: 'margin-top:12px;display:flex;gap:10px;flex-wrap:wrap' },
          h('button', { class: 'btn primario', onclick: async function (ev) {
            err.textContent = '';
            try {
              const r = await conBoton(ev.target, function () { return api('cupos.guardar', { areas: borrador.map(function (b) { return Object.assign({}, b, { cupos: b.cupos === '' ? null : Number(b.cupos) }); }) }); });
              aplicarRespuesta(r, 'Configuración guardada.');
            } catch (e) { mostrarError(err, e); }
          } }, 'Guardar cambios'),
          h('button', { class: 'btn', onclick: function () { S.cupos.borrador = null; pintar(); } }, 'Descartar')) : null),
      h('section', { class: 'panel' }, h('h3', null, 'Días cerrados en el calendario'),
        h('p', { class: 'sub' }, 'Fechas en las que un formulario (o todos) no recibirá solicitudes, aunque sea un día hábil.'),
        admin ? h('form', { class: 'fila-form', onsubmit: async function (ev) {
          ev.preventDefault();
          if (!fecha.value) { tostada('Elija una fecha.', { error: true }); return; }
          try { aplicarRespuesta(await api('cerrados.agregar', { fecha: fecha.value, area: area.value, motivo: motivo.value }), 'Día cerrado agregado.'); } catch (e) { tostada(e.message, { error: true }); }
        } },
          h('div', { class: 'campo' }, h('label', { for: 'ce-fecha' }, 'Fecha'), fecha),
          h('div', { class: 'campo' }, h('label', { for: 'ce-area' }, 'Área'), area),
          h('div', { class: 'campo', style: 'flex:2 1 220px' }, h('label', { for: 'ce-motivo' }, 'Motivo (opcional)'), motivo),
          h('button', { class: 'btn oscuro', type: 'submit' }, 'Cerrar ese día')) : null,
        S.cupos.cerrados.length ? h('ul', { class: 'lista-simple', style: 'margin-top:10px' }, S.cupos.cerrados.map(function (c) {
          return h('li', null, h('span', { class: 'crece' }, h('b', null, fechaLarga(c.fecha)), ' — ' + (c.area === 'TODAS' ? 'Todas las áreas' : NOMBRE_AREA[c.area] || c.area) + (c.motivo ? ' · ' + c.motivo : '')),
            admin ? h('button', { class: 'btn chico peligro', onclick: async function () {
              try { aplicarRespuesta(await api('cerrados.eliminar', { fecha: c.fecha, area: c.area }), 'Día reabierto.'); } catch (e) { tostada(e.message, { error: true }); }
            } }, 'Quitar') : null);
        })) : h('p', { style: 'color:#51606f;margin:10px 0 0' }, 'No hay días cerrados programados.')),
      h('section', { class: 'panel' }, h('h3', null, 'Cupos extra de hoy'),
        h('p', { class: 'sub' }, 'Un cupo extra permite recibir una solicitud más aunque el formulario esté cerrado o sin cupos. Se consume con el primer envío y vence al terminar el día.'),
        h('ul', { class: 'lista-simple' }, S.cupos.areas.map(function (a) {
          return h('li', null, h('span', { class: 'crece' }, h('b', null, NOMBRE_AREA[a.clave]), ' — ' + (a.pases ? plural(a.pases, 'cupo extra abierto', 'cupos extra abiertos') : 'sin cupos extra abiertos')),
            a.pases ? h('button', { class: 'btn chico', onclick: async function () { try { aplicarRespuesta(await api('pase.cancelar', { area: a.clave }), 'Cupo extra cancelado.'); } catch (e) { tostada(e.message, { error: true }); } } }, 'Cancelar uno') : null,
            h('button', { class: 'btn chico', onclick: async function () { try { aplicarRespuesta(await api('pase.abrir', { area: a.clave }), 'Cupo extra abierto en ' + NOMBRE_AREA[a.clave] + '.'); } catch (e) { tostada(e.message, { error: true }); } } }, '＋ Abrir cupo extra'));
        })))
    ]);
  }

  /* ============================== estadísticas ============================== */
  function contar(filas, fn, orden) {
    const m = {};
    filas.forEach(function (f) { const k = fn(f) || 'Sin dato'; m[k] = (m[k] || 0) + 1; });
    let pares = Object.keys(m).map(function (k) { return [k, m[k]]; });
    if (orden) pares = orden.map(function (k) { return [k, m[k] || 0]; }).concat(pares.filter(function (p) { return orden.indexOf(p[0]) < 0; }));
    else pares.sort(function (a, b) { return b[1] - a[1]; });
    return pares;
  }
  function grupoEdad(f) {
    if (f.edad === '') return 'Sin dato';
    const n = Number(f.edad);
    const g = GRUPOS_EDAD.filter(function (x) { return n >= x[1] && n <= x[2]; })[0];
    return g ? g[0] : 'Sin dato';
  }
  function barras(pares) {
    const total = pares.reduce(function (s, p) { return s + p[1]; }, 0);
    const max = Math.max.apply(null, pares.map(function (p) { return p[1]; }).concat([1]));
    if (!total) return h('p', { style: 'color:#51606f;margin:0' }, 'Sin datos en este mes.');
    return h('div', { class: 'barras' }, pares.map(function (p) {
      return h('div', { class: 'barra-f' }, h('span', { class: 'et', title: p[0] }, p[0]),
        h('span', { class: 'pista' }, p[1] ? h('span', { class: 'relleno', style: 'display:block;width:' + (p[1] / max * 100).toFixed(1) + '%' }) : null),
        h('span', { class: 'val' }, p[1], h('small', null, Math.round(p[1] / total * 100) + '%')));
    }));
  }
  function vistaEstadisticas(main) {
    const u = ui('stats', { mes: (S.hoy || new Date().toISOString().slice(0, 10)).slice(0, 7) });
    const cab = h('div', { class: 'cab' }, h('h2', null, 'Estadísticas de ' + MESES[Number(u.mes.slice(5)) - 1] + ' de ' + u.mes.slice(0, 4)),
      h('div', { class: 'campo no-imprimir', style: 'margin:0;flex:0 0 170px' }, h('label', { for: 'mes' }, 'Mes'),
        h('input', { type: 'month', id: 'mes', value: u.mes, max: (S.hoy || '').slice(0, 7), onchange: function (ev) { if (ev.target.value) { u.mes = ev.target.value; S.stats = null; pintar(); } } })),
      h('button', { class: 'btn no-imprimir', onclick: function () { window.print(); } }, 'Imprimir'));
    main.appendChild(cab);
    if (!S.stats || S.stats.mes !== u.mes) {
      main.appendChild(h('div', { class: 'vacio' }, 'Calculando…'));
      api('estadisticas', { mes: u.mes }).then(function (r) {
        S.stats = { mes: r.mes, filas: r.filas.map(function (arr) { const o = {}; r.columnas.forEach(function (c, i) { o[c] = arr[i]; }); return o; }) };
        if (ruta()[0] === 'estadisticas') pintar();
      }).catch(function (e) { if (ruta()[0] === 'estadisticas') { main.lastChild.textContent = e.message; } });
      return;
    }
    const filas = S.stats.filas;
    const recibidas = filas.filter(function (f) { return f.fecha.slice(0, 7) === u.mes; });
    const realizados = filas.filter(function (f) { return f.estado === 'REALIZADO' && f.fecha_realizado.slice(0, 7) === u.mes; });
    const noReal = filas.filter(function (f) { return f.estado === 'NO REALIZADO' && f.fecha_realizado.slice(0, 7) === u.mes; });
    const pendientes = recibidas.filter(function (f) { return f.estado === 'PENDIENTE'; });
    const kpi = function (clase, v, t) { return h('div', { class: 'kpi ' + clase }, h('div', { class: 'v' }, v), h('div', { class: 't' }, t)); };
    const porMedico = contar(realizados, function (f) { return f.realizado_por; });
    const estudiosUsados = ESTUDIOS.filter(function (e) { return realizados.some(function (f) { return f.estudio === e; }); });
    const cruce = h('table', { class: 'cruce' },
      h('thead', null, h('tr', null, h('th', null, 'Médico'), estudiosUsados.map(function (e) { return h('th', null, e); }), h('th', { class: 'tot' }, 'Total'))),
      h('tbody', null, porMedico.map(function (p) {
        return h('tr', null, h('td', null, p[0]), estudiosUsados.map(function (e) {
          return h('td', null, realizados.filter(function (f) { return f.realizado_por === p[0] && f.estudio === e; }).length || '·');
        }), h('td', { class: 'tot' }, p[1]));
      })),
      h('tfoot', null, h('tr', null, h('td', null, 'Total'), estudiosUsados.map(function (e) { return h('td', null, realizados.filter(function (f) { return f.estudio === e; }).length); }), h('td', null, realizados.length))));
    const panel = function (titulo, contenido, clase, sub) { return h('section', { class: 'panel ' + (clase || '') }, h('h3', null, titulo), sub ? h('p', { class: 'sub' }, sub) : null, contenido); };
    agregar(main, [
      h('div', { class: 'kpis' }, kpi('a', realizados.length, 'Estudios realizados'), kpi('b', recibidas.length, 'Solicitudes recibidas'),
        kpi('c', noReal.length, 'Cerradas sin realizar'), kpi('d', pendientes.length, 'Pendientes del mes')),
      h('div', { class: 'graficas' },
        panel('Estudios realizados por tipo', barras(contar(realizados, function (f) { return f.estudio; }, ESTUDIOS))),
        panel('Estudios realizados por médico', barras(porMedico)),
        realizados.length ? panel('Médico por tipo de estudio', h('div', { class: 'tabla-scroll' }, cruce), 'todo') : null,
        panel('Por grupo etario', barras(contar(realizados, grupoEdad, GRUPOS_EDAD.map(function (g) { return g[0]; }))), '', 'Estudios realizados'),
        panel('Por prioridad', barras(contar(realizados, function (f) { return f.prioridad; }, PRIORIDADES)), '', 'Estudios realizados'),
        panel('Por sexo', barras(contar(realizados, function (f) { return f.sexo; }, ['Femenino', 'Masculino'])), '', 'Estudios realizados'),
        panel('Por área', barras(contar(realizados, function (f) { return NOMBRE_AREA[f.area] || f.area; }, AREAS.map(function (a) { return a.nombre; }))), '', 'Estudios realizados'),
        panel('Solicitudes cerradas sin realizar', barras(contar(noReal, function (f) { return f.motivo_no; }, S.motivos)), '', 'Por motivo'),
        panel('Solicitudes recibidas por tipo', barras(contar(recibidas, function (f) { return f.estudio; }, ESTUDIOS)), '', 'Todas las recibidas en el mes, se hayan realizado o no')),
      h('p', { style: 'color:#51606f;font-size:13px' }, 'Los estudios realizados se cuentan en el mes en que se marcaron como realizados; las solicitudes recibidas, en el mes en que se enviaron.')
    ]);
  }

  /* ============================== usuarios y médicos ============================== */
  function vistaAdmin(main) {
    if (!S.usuarios) {
      main.appendChild(h('div', { class: 'vacio' }, 'Cargando…'));
      api('usuarios.listar').then(function (r) { S.usuarios = r.usuarios; if (ruta()[0] === 'admin') pintar(); })
        .catch(function (e) { if (ruta()[0] === 'admin') { main.textContent = ''; main.appendChild(h('div', { class: 'aviso error' }, e.message)); } });
      return;
    }
    const guardarMedicos = async function (lista, mensaje) {
      try { const r = await api('medicos.guardar', { medicos: lista }); S.medicos = r.medicos; pintar(); tostada(mensaje); } catch (e) { tostada(e.message, { error: true }); }
    };
    const nuevoMedico = h('input', { type: 'text', id: 'nm', maxlength: 60, placeholder: 'Ej. Dra. Apellido' });
    const actualizar = async function (cambio, mensaje) {
      try { const r = await api('usuarios.actualizar', cambio); S.usuarios = r.usuarios; pintar(); tostada(mensaje); } catch (e) { tostada(e.message, { error: true }); pintar(); }
    };
    const nu = { usuario: h('input', { type: 'text', id: 'nu-u', autocapitalize: 'none', autocomplete: 'off', placeholder: 'ej. cportillo' }),
      nombre: h('input', { type: 'text', id: 'nu-n', autocomplete: 'off', placeholder: 'Nombre completo' }),
      rol: selector([['medico', 'Médico'], ['admin', 'Administrador']], 'medico', { id: 'nu-r' }),
      clave: h('input', { type: 'text', id: 'nu-c', autocomplete: 'off', placeholder: 'Mínimo 8 caracteres' }) };
    const errU = cajaError();
    agregar(main, [
      h('section', { class: 'panel' }, h('h3', null, 'Médicos que realizan estudios'),
        h('p', { class: 'sub' }, 'Esta lista aparece en el menú para marcar quién realizó cada estudio. Si un médico ya no está, desactívelo: sus estudios anteriores se conservan.'),
        h('ul', { class: 'lista-simple' }, S.medicos.map(function (m, i) {
          return h('li', null, h('span', { class: 'crece' }, h('b', null, m.nombre), m.activo ? '' : ' (inactivo)'),
            h('button', { class: 'btn chico', onclick: function () {
              guardarMedicos(S.medicos.map(function (x, j) { return { nombre: x.nombre, activo: j === i ? !x.activo : x.activo }; }), m.activo ? 'Médico desactivado.' : 'Médico activado.');
            } }, m.activo ? 'Desactivar' : 'Activar'));
        })),
        h('form', { class: 'fila-form', style: 'margin-top:10px', onsubmit: function (ev) {
          ev.preventDefault();
          if (nuevoMedico.value.trim().length < 3) { tostada('Escriba el nombre del médico.', { error: true }); return; }
          guardarMedicos(S.medicos.concat([{ nombre: nuevoMedico.value, activo: true }]), 'Médico agregado.');
        } }, h('div', { class: 'campo' }, h('label', { for: 'nm' }, 'Agregar médico'), nuevoMedico), h('button', { class: 'btn oscuro', type: 'submit' }, 'Agregar'))),
      h('section', { class: 'panel' }, h('h3', null, 'Usuarios de la app de censos'),
        h('p', { class: 'sub' }, 'Cada persona debe tener su propio usuario. Los administradores pueden cambiar cupos, usuarios y médicos; los médicos ven los censos y marcan estudios.'),
        h('ul', { class: 'lista-simple' }, S.usuarios.map(function (x) {
          const propio = x.usuario === S.usuario.usuario;
          return h('li', null, h('span', { class: 'crece' }, h('b', null, x.nombre), ' · ' + x.usuario + (x.activo ? '' : ' (inactivo)') + (x.debe_cambiar ? ' · clave temporal' : '')),
            selector([['medico', 'Médico'], ['admin', 'Administrador']], x.rol, { style: 'width:auto', disabled: propio, 'aria-label': 'Rol de ' + x.usuario,
              onchange: function (ev) { actualizar({ usuario: x.usuario, rol: ev.target.value }, 'Rol actualizado.'); } }),
            h('button', { class: 'btn chico', onclick: function () { restablecer(x); } }, 'Nueva contraseña'),
            propio ? null : h('button', { class: 'btn chico' + (x.activo ? ' peligro' : ''), onclick: function () { actualizar({ usuario: x.usuario, activo: !x.activo }, x.activo ? 'Usuario desactivado.' : 'Usuario activado.'); } }, x.activo ? 'Desactivar' : 'Activar'));
        })),
        h('h3', { style: 'margin-top:18px' }, 'Crear usuario'),
        h('form', { class: 'fila-form', onsubmit: async function (ev) {
          ev.preventDefault();
          errU.textContent = '';
          try {
            const r = await api('usuarios.crear', { usuario: nu.usuario.value, nombre: nu.nombre.value, rol: nu.rol.value, clave: nu.clave.value });
            S.usuarios = r.usuarios;
            pintar();
            tostada('Usuario creado. Entréguele su contraseña temporal en persona.');
          } catch (e) { mostrarError(errU, e); }
        } },
          h('div', { class: 'campo' }, h('label', { for: 'nu-u' }, 'Usuario'), nu.usuario),
          h('div', { class: 'campo' }, h('label', { for: 'nu-n' }, 'Nombre'), nu.nombre),
          h('div', { class: 'campo' }, h('label', { for: 'nu-r' }, 'Rol'), nu.rol),
          h('div', { class: 'campo' }, h('label', { for: 'nu-c' }, 'Contraseña temporal'), nu.clave),
          h('button', { class: 'btn oscuro', type: 'submit' }, 'Crear usuario')),
        errU)
    ]);
  }
  function restablecer(x) {
    modalChico('Nueva contraseña para ' + x.usuario, function (cerrar) {
      const err = cajaError();
      const clave = h('input', { type: 'text', id: 'rs-c', autocomplete: 'off', 'data-foco': true });
      return h('form', { onsubmit: async function (ev) {
        ev.preventDefault();
        try { const r = await api('usuarios.restablecer', { usuario: x.usuario, clave: clave.value }); S.usuarios = r.usuarios; cerrar(); pintar(); tostada('Contraseña temporal asignada.'); } catch (e) { mostrarError(err, e); }
      } }, h('p', { style: 'margin-top:0' }, 'Se le pedirá cambiarla la próxima vez que ingrese.'),
        h('div', { class: 'campo' }, h('label', { for: 'rs-c' }, 'Contraseña temporal (mínimo 8 caracteres)'), clave), err,
        h('button', { class: 'btn primario ancho', type: 'submit' }, 'Asignar'));
    });
  }

  /* ============================== arranque ============================== */
  window.addEventListener('hashchange', function () {
    if (ruta()[0] !== 'cupos') S.cupos = null;
    if (ruta()[0] !== 'admin') S.usuarios = null;
    window.scrollTo(0, 0);
    pintar();
    window.scrollTo(0, 0);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S.token && S.sincronizado) sincronizar(true); });
  setInterval(function () { if (!document.hidden && S.token && S.sincronizado && !modalesAbiertos()) sincronizar(true); }, 120000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* sin modo offline */ }); });
  }

  S.token = leerToken();
  if (S.token) { $app.textContent = ''; $app.appendChild(h('p', { class: 'cargando-inicial' }, 'Cargando…')); iniciar(); } else pintarAcceso();
})();
