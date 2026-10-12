'use strict';

const POLL_MS = 10000;
const PENDING_MS = 4000;
const WIDGET = document.documentElement.classList.contains('widget'); // painel compacto do app de bandeja

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n, digits = 1) => n.toLocaleString('pt-BR', { maximumFractionDigits: digits });

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  light: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>'),
  plug: svg('<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>'),
  cover: svg('<path d="M3 3h18M5 3v18M19 3v18M5 3c0 7 3 10 6 11M19 3c0 7-3 10-6 11"/>'),
  climate: svg('<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/>'),
  sensor: svg('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>'),
  contact: svg('<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14.5 12h.01"/>'),
  motion: svg('<circle cx="12" cy="5" r="2"/><path d="M12 8v6l-3 6M12 14l3 6M8 11l4-2 4 2"/>'),
  alarm: svg('<path d="M12 3 2.5 20h19zM12 10v4M12 17h.01"/>'),
  camera: svg('<path d="M3 7h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM16 10.5l6-3v9l-6-3"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  garage: svg('<path d="M3 21V9l9-6 9 6v12M7 21v-8h10v8M7 17h10"/>'),
  other: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  ac: svg('<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/>'),
  tv: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  power: svg('<path d="M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0"/>'),
  chevron: svg('<path d="M6 15l6-6 6 6"/>'),
  back: svg('<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  home: svg('<path d="M3 11l9-8 9 8M5 10v10h14V10"/>'),
  more: svg('<path d="M5 12h.01M12 12h.01M19 12h.01"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
};

// Categorias da Tuya -> tipo de bloco no dashboard
const CATEGORY = {
  light: ['dj', 'dd', 'xdd', 'fwd', 'dc', 'tgq', 'tgkg', 'gyd', 'fsd', 'kg', 'tdq'],
  plug: ['cz', 'pc', 'dlq'],
  cover: ['cl', 'clkg'],
  climate: ['kt', 'ktkzq', 'wk', 'wkf', 'fs', 'kj', 'js', 'cs', 'qn'],
  ac: ['infrared_ac'],
  tv: ['infrared_tv', 'androidtv'],
  sensor: ['wsdcg', 'ldcg', 'co2bj', 'hps'],
  contact: ['mcs'],
  motion: ['pir'],
  alarm: ['ywbj', 'rqbj', 'sj', 'cobj', 'sos', 'sgbj', 'mal'],
  camera: ['sp'],
  lock: ['ms', 'jtmspro', 'jtmsbh', 'bxx', 'videolock'],
  garage: ['ckmkzq'],
};
const GROUP_OF = {
  light: 'luz', plug: 'luz', cover: 'luz',
  climate: 'clima', sensor: 'clima', ac: 'clima',
  tv: 'midia',
  contact: 'seg', motion: 'seg', alarm: 'seg', camera: 'seg', lock: 'seg', garage: 'seg',
  other: 'outros',
};
const TABS = [
  ['todos', 'Tudo'],
  ['luz', 'Luzes e tomadas'],
  ['clima', 'Clima e sensores'],
  ['seg', 'Segurança'],
  ['midia', 'TV'],
];

const SWITCH_RE = /^(switch_led|switch|switch_\d+|switch_usb\d+|power|light)$/;
const TEMP_CODES = ['va_temperature', 'temp_current', 'temp_indoor'];
const HUM_CODES = ['va_humidity', 'humidity_value', 'humidity'];
const ALARM_CODES = ['smoke_sensor_status', 'smoke_sensor_state', 'gas_sensor_status', 'gas_sensor_state', 'watersensor_state', 'co_status', 'co_state'];
const DEFAULT_SCALE = { va_temperature: 1, cur_power: 1, cur_voltage: 1 };
const AC_MODE = ['Frio', 'Quente', 'Automático', 'Ventilar', 'Seco'];
const AC_WIND = ['Automática', 'Baixa', 'Média', 'Alta'];
// o estado vem como índice; o comando correspondente vai por nome
const AC_MODE_CMD = ['cold', 'heat', 'auto', 'wind_dry', 'dehumidification'];
const AC_WIND_CMD = ['auto', 'low', 'mid', 'high'];
const HUES = [0, 30, 55, 120, 180, 220, 280, 320];

const LABEL = {
  switch_led: 'Ligada', switch: 'Ligado', power: 'Ligado', light: 'Luz',
  bright_value: 'Brilho', bright_value_v2: 'Brilho',
  temp_value: 'Tom (quente → frio)', temp_value_v2: 'Tom (quente → frio)',
  work_mode: 'Modo', colour_data: 'Cor', colour_data_v2: 'Cor',
  cur_power: 'Potência', cur_current: 'Corrente', cur_voltage: 'Tensão', add_ele: 'Energia',
  va_temperature: 'Temperatura', temp_current: 'Temperatura', temp_indoor: 'Temperatura',
  va_humidity: 'Umidade', humidity_value: 'Umidade', humidity: 'Umidade',
  battery_percentage: 'Bateria', battery_state: 'Bateria',
  temp_set: 'Temperatura alvo', mode: 'Modo', fan_speed_enum: 'Ventilação',
  doorcontact_state: 'Porta', pir: 'Movimento', closed_opened: 'Estado',
  basic_private: 'Modo privacidade', motion_switch: 'Detecção de movimento',
  switch_backlight: 'Luz de fundo das teclas',
  control: 'Controle', percent_control: 'Posição', child_lock: 'Trava infantil',
};
const ENUM_LABEL = {
  white: 'Branco', colour: 'Cor', scene: 'Cena', music: 'Música',
  cold: 'Frio', hot: 'Quente', wet: 'Desumidificar', wind: 'Ventilar', auto: 'Automático',
  open: 'Abrir', close: 'Fechar', stop: 'Parar', closed: 'Fechada',
  low: 'Baixa', middle: 'Média', high: 'Alta',
  alarm: 'Alerta', normal: 'Normal', pir: 'Detectado', none: 'Nenhum',
};
const label = (code) => LABEL[code] || (/^switch_\d+$/.test(code) ? `Canal ${code.split('_')[1]}` : code);
const enumLabel = (v) => ENUM_LABEL[v] || v;

let state = { devices: [], demo: false, error: null };
let filter = 'todos';
let detailId = null;
let dragging = false;
const pending = new Map(); // "id:code" -> { value, until }

// ---------------------------------------------------------------- Leitura do estado

function kindOf(d) {
  for (const [kind, cats] of Object.entries(CATEGORY)) if (cats.includes(d.category)) return kind;
  const codes = Object.keys(d.status);
  if (codes.includes('switch_led')) return 'light';
  if (codes.some((c) => SWITCH_RE.test(c))) return 'plug';
  if (codes.some((c) => TEMP_CODES.includes(c))) return 'sensor';
  return 'other';
}

const switches = (d) => Object.keys({ ...d.spec, ...d.status }).filter((c) => SWITCH_RE.test(c) && typeof d.status[c] === 'boolean').sort();
const isOn = (d) => switches(d).some((c) => d.status[c]);
// Interruptor com várias teclas: cada tecla é um bloco próprio no dashboard.
const channels = (d) => switches(d).filter((c) => /^switch_\d+$/.test(c));
const units = (d) => ((d.kind === 'light' || d.kind === 'plug') && channels(d).length > 1 ? channels(d) : [null]).map((code) => ({ d, code }));
const unitName = (d, code) => (code ? d.channels?.[code] || `${d.name} ${code.split('_')[1]}` : d.name);
const unitOn = ({ d, code }) => d.online && (code ? d.status[code] === true : isOn(d));
const firstCode = (d, codes) => codes.find((c) => d.status[c] != null);

function scaled(d, code) {
  const v = d.status[code];
  if (typeof v !== 'number') return null;
  return v / 10 ** (d.spec[code]?.values?.scale ?? DEFAULT_SCALE[code] ?? 0);
}

const temperature = (d) => scaled(d, firstCode(d, TEMP_CODES));
const humidity = (d) => scaled(d, firstCode(d, HUM_CODES));
const brightCode = (d) => firstCode(d, ['bright_value_v2', 'bright_value']);
const colourCode = (d) => firstCode(d, ['colour_data_v2', 'colour_data']);
const range = (d, code, min, max) => ({ min, max, step: 1, ...d.spec[code]?.values });

function colour(d) {
  try {
    const v = d.status[colourCode(d)];
    const c = typeof v === 'string' ? JSON.parse(v) : v;
    return typeof c?.h === 'number' ? c : null;
  } catch {
    return null;
  }
}

const inAlarm = (d) => ALARM_CODES.some((c) => ['alarm', '1', true].includes(d.status[c]));
const isOpen = (d) => d.status.doorcontact_state === true || d.status.closed_opened === 'open';
const lowBattery = (d) => (d.status.battery_percentage ?? 100) <= 15 || d.status.battery_state === 'low';
const needsAttention = (d) => d.online && (inAlarm(d) || ((d.kind === 'contact' || d.kind === 'garage' || d.kind === 'lock') && isOpen(d)));

// ---------------------------------------------------------------- Comandos

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 5000);
}

// `assume`: estado a mostrar na hora quando o código do comando difere do código de estado
async function send(id, commands, assume) {
  const d = state.devices.find((x) => x.id === id);
  if (!d || !d.online) return;
  const assumed = assume || Object.fromEntries(commands.map((c) => [c.code, typeof c.value === 'object' ? JSON.stringify(c.value) : c.value]));
  for (const [code, value] of Object.entries(assumed)) {
    d.status[code] = value;
    pending.set(`${id}:${code}`, { value, until: Date.now() + PENDING_MS });
  }
  render();
  try {
    const res = await fetch(`/api/devices/${id}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    setTimeout(refresh, 1500);
  } catch (e) {
    for (const code of Object.keys(assumed)) pending.delete(`${id}:${code}`);
    toast(`${d.name}: não foi possível enviar o comando. ${e.message || ''}`);
    refresh();
  }
}

// Ar-condicionado por infravermelho: comandos switch, temp, mode e fan; estado em power, temp, mode e wind.
function acSet(d, code, value) {
  if (code === 'power') return send(d.id, [{ code: 'switch', value: !d.status.power }], { power: !d.status.power });
  if (code === 'T') return send(d.id, [{ code: 'temp', value }], { temp: value });
  if (code === 'M') return send(d.id, [{ code: 'mode', value: AC_MODE_CMD[value] }], { mode: value });
  send(d.id, [{ code: 'fan', value: AC_WIND_CMD[value] }], { wind: value });
}

// A TV por infravermelho não informa estado: cada toque só dispara o comando (switch, direction, volume_control).
const tvCommand = (d, code, value) => send(d.id, [{ code, value }], {});

function toggle(d, code) {
  if (d.kind === 'ac') return acSet(d, 'power');
  const codes = code ? [code] : switches(d);
  if (!codes.length) return openDetail(d.id);
  const value = !unitOn({ d, code });
  if (d.kind === 'garage' && !confirm(`${value ? 'Abrir' : 'Fechar'} ${d.name}?`)) return;
  send(d.id, codes.map((code) => ({ code, value })));
}

function setColour(d, h) {
  const code = colourCode(d);
  const v = d.spec[code]?.values || {};
  const current = colour(d);
  const commands = [{ code, value: { h, s: v.s?.max ?? 1000, v: current?.v || v.v?.max || 1000 } }];
  if ('work_mode' in d.status) commands.unshift({ code: 'work_mode', value: 'colour' });
  send(d.id, commands);
}

// ---------------------------------------------------------------- Blocos

function describe(d) {
  if (!d.online) return 'Offline';
  const on = isOn(d);
  switch (d.kind) {
    case 'light': {
      if (!on) return 'Desligada';
      const code = brightCode(d);
      return code ? `Ligada · ${Math.round((d.status[code] / range(d, code, 10, 1000).max) * 100)}%` : 'Ligada';
    }
    case 'plug': {
      const w = scaled(d, 'cur_power');
      return on ? (w ? `Ligada · ${fmt(w, 0)} W` : 'Ligada') : 'Desligada';
    }
    case 'cover':
      return d.status.percent_control != null ? `${d.status.percent_control}% aberta` : enumLabel(d.status.control ?? '');
    case 'climate': {
      const t = temperature(d);
      const now = t != null ? `Agora ${fmt(t)}°C` : '';
      if (!switches(d).length) return now || 'Online';
      return on ? ['Ligado', now].filter(Boolean).join(' · ') : 'Desligado';
    }
    case 'ac':
      return on ? `Ligado · ${d.status.temp}°C · ${AC_MODE[d.status.mode] ?? ''}` : 'Desligado';
    case 'tv':
      if (isNetTv(d) && !d.paired) return 'Toque para parear';
      return d.status.powered == null ? 'Controle remoto' : d.status.powered ? 'Ligada' : 'Desligada';
    case 'sensor': {
      const h = humidity(d);
      return h != null ? `${fmt(h, 0)}% de umidade` : 'Online';
    }
    case 'contact':
      return isOpen(d) ? 'Aberta' : 'Fechada';
    case 'motion':
      return d.status.pir === 'pir' ? 'Movimento detectado' : 'Sem movimento';
    case 'alarm':
      return inAlarm(d) ? 'Alerta!' : 'Normal';
    case 'camera':
      return d.status.basic_private ? 'Modo privacidade' : 'Online';
    case 'lock':
      return isOpen(d) ? 'Aberta' : d.status.closed_opened ? 'Fechada' : 'Online';
    case 'garage':
      return on || isOpen(d) ? 'Aberto' : 'Fechado';
    default:
      return switches(d).length ? (on ? 'Ligado' : 'Desligado') : 'Online';
  }
}

function extras(d) {
  if (!d.online) return '';
  if (d.kind === 'light' && isOn(d) && brightCode(d)) {
    const code = brightCode(d);
    const r = range(d, code, 10, 1000);
    return `<input class="slider" type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${d.status[code]}" data-act="set" data-code="${code}" aria-label="Brilho de ${esc(d.name)}">`;
  }
  if (d.kind === 'climate' && isOn(d) && typeof d.status.temp_set === 'number') {
    const r = range(d, 'temp_set', 16, 30);
    const v = d.status.temp_set;
    const btn = (delta, sym) => `<button type="button" class="pill" data-act="cmd" data-code="temp_set" data-value="${Math.min(r.max, Math.max(r.min, v + delta))}" aria-label="${delta > 0 ? 'Aumentar' : 'Diminuir'} temperatura">${sym}</button>`;
    return `<div class="stepper">${btn(-r.step, '−')}<span>Alvo <b>${fmt(scaled(d, 'temp_set'))}°C</b></span>${btn(r.step, '+')}</div>`;
  }
  if (d.kind === 'ac') return isOn(d) ? acStepper(d) : '';
  if (d.kind === 'tv') return tvQuick(d);
  if (d.kind === 'cover' && 'control' in d.status) {
    return `<div class="pills">${['open', 'stop', 'close']
      .map((v) => `<button type="button" class="pill wide" data-act="cmd" data-code="control" data-value="${v}">${enumLabel(v)}</button>`)
      .join('')}</div>`;
  }
  return '';
}

function acStepper(d) {
  const r = range(d, 'T', 16, 30);
  const t = d.status.temp;
  const btn = (delta, sym) => `<button type="button" class="pill" data-act="ac" data-code="T" data-value="${Math.min(r.max, Math.max(r.min, t + delta))}" aria-label="${delta > 0 ? 'Aumentar' : 'Diminuir'} temperatura"${d.status.power ? '' : ' disabled'}>${sym}</button>`;
  return `<div class="stepper">${btn(-1, '−')}<span class="ac-num">${t}<small>°C</small></span>${btn(1, '+')}</div>`;
}

function acPanel(d) {
  const on = d.status.power;
  const seg = (code, labels, current) => `<div class="seg">${labels
    .filter((_, i) => i <= (d.spec[code]?.values?.max ?? labels.length - 1))
    .map((text, i) => `<button type="button" class="${on && i === current ? 'on' : ''}" data-act="ac" data-code="${code}" data-value="${i}"${on ? '' : ' disabled'}>${text}</button>`)
    .join('')}</div>`;
  return `
    <div class="panel">
      <button type="button" class="power${on ? ' on' : ''}" data-act="ac" data-code="power" aria-pressed="${!!on}">${ICON.power}<span>${on ? 'Ligado' : 'Desligado'}</span></button>
      ${acStepper(d)}
      <h3>Modo</h3>${seg('M', AC_MODE, d.status.mode)}
      <h3>Ventilação</h3>${seg('F', AC_WIND, d.status.wind)}
      <p>O estado mostrado é o último comando enviado por aqui ou pelo app; o controle físico do ar não é detectado.</p>
    </div>`;
}

// Apps que a TV aceita abrir pela rede (YouTube, Netflix…); a lista vem do servidor.
const appRow = (d) => (d.apps?.length ? `<div class="apps">${d.apps.map((a) => `<button type="button" class="app app-${esc(a.id)}" data-act="app" data-code="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>` : '');

async function openApp(d, app) {
  const name = d.apps.find((a) => a.id === app)?.name || app;
  toast(`Abrindo ${name} na TV…`);
  try {
    const res = await fetch(`/api/devices/${d.id}/app`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app }) });
    if (!res.ok) throw new Error((await res.json()).error);
  } catch (e) {
    toast(`${name}: ${e.message || 'não foi possível abrir.'}`);
  }
}

// Tecla de controle remoto enviada pelo servidor: Google TV, ou as teclas extras do infravermelho (OK, Voltar, Início).
async function pressKey(d, key) {
  try {
    const res = await fetch(`/api/devices/${d.id}/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    if (!res.ok) throw new Error((await res.json()).error);
  } catch (e) {
    toast(`${d.name}: ${e.message || 'tecla não enviada.'}`);
  }
}

// Cada botão do controle sai por um de dois caminhos: comando da Tuya (data-act="key") para a TV por
// infravermelho, ou tecla enviada pelo servidor (data-act="press") para Google TV e teclas extras.
const TV_CMD = { Power: ['switch', true], Up: ['direction', 'up'], Down: ['direction', 'down'], Left: ['direction', 'left'], Right: ['direction', 'right'], VolumeUp: ['volume_control', 1], VolumeDown: ['volume_control', -1] };
const isNetTv = (d) => d.category === 'androidtv';

function tvBtn(d, key, body, cls, name) {
  if (isNetTv(d) || d.keys?.includes(key)) return `<button type="button" class="${cls}" data-act="press" data-code="${key}" aria-label="${name}">${body}</button>`;
  const cmd = TV_CMD[key];
  return cmd ? `<button type="button" class="${cls}" data-act="key" data-code="${cmd[0]}" data-value="${cmd[1]}" aria-label="${name}">${body}</button>` : '';
}

const APP_GLYPH = { YouTube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7l9 5-9 5z" fill="currentColor" stroke="none"/></svg>', Netflix: 'N', AmazonInstantVideo: 'prime' };

// Atalhos da TV que ficam na própria linha do bloco: apps, volume e liga/desliga.
function tvQuick(d) {
  if (isNetTv(d) && !d.paired) return '<div class="quick"><button type="button" class="pill" data-act="detail">Parear</button></div>';
  const apps = (d.apps || []).map((a) => `<button type="button" class="mini app-${esc(a.id)}" data-act="app" data-code="${esc(a.id)}" aria-label="Abrir ${esc(a.name)}" title="${esc(a.name)}">${APP_GLYPH[a.id] || esc(a.name[0])}</button>`).join('');
  return `<div class="quick">${apps}${apps ? '<span class="sep"></span>' : ''}${tvBtn(d, 'VolumeDown', '−', 'mini', 'Diminuir volume')}${tvBtn(d, 'VolumeUp', '+', 'mini', 'Aumentar volume')}${tvBtn(d, 'Power', ICON.power, 'mini power-key', 'Ligar ou desligar a TV')}</div>`;
}

// Google TV ainda não pareada: um toque faz a TV mostrar um código, que é digitado aqui.
function pairPanel(d) {
  if (!d.pairing) return `<div class="panel"><button type="button" class="power" data-act="pair">Parear com a TV</button><p>A TV precisa estar ligada. Ela vai mostrar um código de 6 caracteres na tela.</p></div>`;
  return `<div class="panel"><p>Digite o código que apareceu na tela da TV.</p><div class="pair"><input type="text" maxlength="6" autocomplete="off" spellcheck="false" placeholder="Código" aria-label="Código de pareamento"><button type="button" class="power" data-act="paircode">Confirmar</button></div><button type="button" class="pill" data-act="pair">Pedir novo código</button></div>`;
}

async function pair(d, code) {
  toast(code ? 'Confirmando o código…' : 'Pedindo o código à TV…');
  try {
    const res = await fetch(`/api/devices/${d.id}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (!res.ok) throw new Error((await res.json()).error);
    toast(code ? `${d.name} pareada.` : 'Veja o código na tela da TV.');
  } catch (e) {
    toast(`${d.name}: ${e.message || 'não foi possível parear.'}`);
  }
  document.activeElement?.blur();
  refresh();
}

// Controle remoto completo (nos detalhes): apps em cima, direcional no centro, volume à direita.
function tvPanel(d) {
  if (isNetTv(d) && !d.paired) return pairPanel(d);
  const complete = isNetTv(d) || d.keys?.length;
  return `
    <div class="panel tv-remote">
      ${tvBtn(d, 'Power', `${ICON.power}<span>Ligar / desligar</span>`, 'power power-key', 'Ligar ou desligar a TV')}
      ${appRow(d)}
      <div class="remote">
        <div class="side">${complete ? tvBtn(d, 'Back', `${ICON.back}<span>Voltar</span>`, 'side-key', 'Voltar') + tvBtn(d, 'Home', `${ICON.home}<span>Início</span>`, 'side-key', 'Início') : ''}</div>
        <div class="pad">
          ${tvBtn(d, 'Up', ICON.chevron, 'arrow up', 'Cima')}
          ${tvBtn(d, 'Left', ICON.chevron, 'arrow left', 'Esquerda')}
          ${complete ? tvBtn(d, 'OK', 'OK', 'ok', 'OK') : ''}
          ${tvBtn(d, 'Right', ICON.chevron, 'arrow right', 'Direita')}
          ${tvBtn(d, 'Down', ICON.chevron, 'arrow down', 'Baixo')}
        </div>
        <div class="rocker">${tvBtn(d, 'VolumeUp', '+', '', 'Aumentar volume')}<span>Vol</span>${tvBtn(d, 'VolumeDown', '−', '', 'Diminuir volume')}</div>
      </div>
      ${complete ? '' : '<p class="hint">OK, Voltar e Início aparecem aqui depois de ativar o serviço de infravermelho na Tuya.</p>'}
    </div>`;
}

function tile({ d, code }) {
  const on = unitOn({ d, code });
  const alert = needsAttention(d);
  const canToggle = d.online && (code || switches(d).length > 0);
  const text = !code ? describe(d) : !d.online ? 'Offline' : on ? 'Ligada' : 'Desligada';
  const c = d.kind === 'light' && on && d.status.work_mode === 'colour' ? colour(d) : null;
  const t = d.kind === 'sensor' ? temperature(d) : null;
  const wide = ['ac', 'tv', 'climate', 'cover'].includes(d.kind);
  const act = canToggle ? 'toggle' : 'detail';
  const cls = ['tile', wide && 'wide', on && 'is-on', alert && 'is-alert', !d.online && 'is-offline'].filter(Boolean).join(' ');
  const main = t != null && d.online ? `<span class="big">${fmt(t)}<small>°C</small></span>` : `<span class="ico">${ICON[d.kind]}</span>`;
  return `
    <article class="${cls}" data-id="${esc(d.id)}" data-code="${code || ''}"${c ? ` style="--glow:hsl(${c.h} 85% 62%)"` : ''}>
      <button type="button" class="tile-main" data-act="${act}"${canToggle ? ` aria-pressed="${on}"` : ''}>
        ${main}
        <span class="name">${esc(unitName(d, code))}</span>
        <span class="state">${esc(text)}${d.online && lowBattery(d) ? ' · <span class="warn">bateria fraca</span>' : ''}</span>
      </button>
      <button type="button" class="more" data-act="detail" aria-label="Detalhes de ${esc(d.name)}">${ICON.more}</button>
      ${code ? '' : extras(d)}
    </article>`;
}

// ---------------------------------------------------------------- Página

function renderSummary() {
  const ds = state.devices;
  const lights = ds.filter((d) => d.kind === 'light').flatMap(units);
  const temps = ds.filter((d) => d.online && GROUP_OF[d.kind] === 'clima').map(temperature).filter((t) => t != null);
  const alerts = ds.filter(needsAttention);
  const offline = ds.filter((d) => !d.online);
  if (WIDGET) {
    const on = lights.filter(unitOn).length;
    $('#clock').textContent = [on ? `${on} ${on === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Tudo apagado', alerts.length && `${alerts.length} alerta(s)`].filter(Boolean).join(' · ');
  }
  const stat = (value, text, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${text}</span></div>`;
  $('#summary').innerHTML = [
    stat(`${lights.filter(unitOn).length}<small> de ${lights.length}</small>`, 'luzes acesas'),
    temps.length ? stat(`${fmt(temps.reduce((a, b) => a + b, 0) / temps.length)}<small>°C</small>`, 'temperatura média') : '',
    stat(alerts.length, alerts.length ? esc(alerts.map((d) => d.name).join(', ')) : 'nenhum alerta de segurança', alerts.length ? 'alert' : ''),
    stat(offline.length, offline.length ? `offline: ${esc(offline.map((d) => d.name).join(', '))}` : 'todos os dispositivos online', offline.length ? 'muted' : ''),
  ].join('');
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([id, text]) => {
    const n = state.devices.filter((d) => id === 'todos' || GROUP_OF[d.kind] === id).flatMap(units).length;
    if (!n && id !== 'todos') return '';
    return `<button type="button" class="tab${filter === id ? ' active' : ''}" data-tab="${id}" aria-pressed="${filter === id}">${text} <small>${n}</small></button>`;
  }).join('');
}

function renderRooms() {
  const visible = state.devices.filter((d) => filter === 'todos' || GROUP_OF[d.kind] === filter);
  if (!visible.length) {
    $('#rooms').innerHTML = `<p class="empty">${state.devices.length ? 'Nenhum dispositivo nesta categoria.' : 'Nenhum dispositivo encontrado.'}</p>`;
    return;
  }
  const byRoom = new Map();
  for (const d of visible) {
    const room = d.room || 'Sem cômodo';
    byRoom.set(room, [...(byRoom.get(room) || []), d]);
  }
  // cômodos só de luzes primeiro; os que têm ar ou TV (blocos grandes) ficam por último, com as luzes no topo
  const big = (d) => (d.kind === 'tv' ? 2 : d.kind === 'ac' ? 1 : 0);
  const weight = (room) => Math.max(...byRoom.get(room).map(big));
  for (const list of byRoom.values()) list.sort((a, b) => big(a) - big(b));
  const names = [...byRoom.keys()].sort((a, b) => (a === 'Sem cômodo') - (b === 'Sem cômodo') || weight(a) - weight(b) || a.localeCompare(b, 'pt-BR'));
  $('#rooms').innerHTML = names
    .map((room) => {
      const list = byRoom.get(room);
      const t = list.filter((d) => d.online && GROUP_OF[d.kind] === 'clima').map(temperature).find((x) => x != null);
      return `<section class="room"><h2>${esc(room)}${t != null ? ` <small>${fmt(t)}°C</small>` : ''}</h2><div class="grid">${list.flatMap(units).map(tile).join('')}</div></section>`;
    })
    .join('');
}

function control(d, rawCode) {
  const spec = d.spec[rawCode] || {};
  const v = d.status[rawCode];
  const code = esc(rawCode); // vai para atributos HTML; os nomes de função vêm do dispositivo
  const rw = spec.rw && d.online;
  const type = spec.type || (typeof v === 'boolean' ? 'Boolean' : typeof v === 'number' ? 'Integer' : 'String');
  let body;
  if (rawCode === colourCode(d) && rw) {
    const current = d.status.work_mode !== 'white' ? colour(d) : null;
    body = `<div class="swatches">${HUES.map((h) => `<button type="button" class="swatch${current?.h === h ? ' on' : ''}" style="background:hsl(${h} 85% 58%)" data-act="colour" data-value="${h}" aria-label="Cor ${h}°"></button>`).join('')}</div>`;
  } else if (type === 'Boolean') {
    body = rw
      ? `<button type="button" class="switch${v ? ' on' : ''}" role="switch" aria-checked="${!!v}" data-act="cmd" data-code="${code}" data-value="${!v}" aria-label="${esc(label(rawCode))}"></button>`
      : `<span>${code === 'doorcontact_state' ? (v ? 'Aberta' : 'Fechada') : v ? 'Sim' : 'Não'}</span>`;
  } else if (type === 'Integer' && typeof v === 'number') {
    const text = esc(`${fmt(scaled(d, rawCode))} ${spec.values?.unit || ''}`.trim());
    const r = range(d, rawCode, 0, 100);
    body = rw
      ? `<span class="num">${text}</span><input class="slider" type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}" data-act="set" data-code="${code}" aria-label="${esc(label(rawCode))}">`
      : `<span>${text}</span>`;
  } else if (type === 'Enum' && rw && spec.values?.range) {
    body = `<select data-act="set" data-code="${code}" aria-label="${esc(label(rawCode))}">${spec.values.range.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(enumLabel(o))}</option>`).join('')}</select>`;
  } else {
    body = `<span>${esc(v == null ? '—' : type === 'Enum' ? enumLabel(v) : String(v).slice(0, 40))}</span>`;
  }
  return `<div class="row${type === 'Integer' && rw ? ' stack' : ''}"><label>${esc((/^switch_\d+$/.test(rawCode) && d.channels?.[rawCode]) || label(rawCode))}</label>${body}</div>`;
}

function renderDetail() {
  const d = state.devices.find((x) => x.id === detailId);
  const dlg = $('#detail');
  if (!d) return dlg.open && dlg.close();
  const codes = Object.keys({ ...d.spec, ...d.status });
  const writable = codes.filter((c) => d.spec[c]?.rw);
  const readonly = codes.filter((c) => !d.spec[c]?.rw);
  dlg.dataset.id = d.id;
  dlg.innerHTML = `
    <header>
      <span class="ico">${ICON[d.kind]}</span>
      <div><h2 id="detail-title">${esc(d.name)}</h2><p>${esc([d.room, { ac: 'Ar-condicionado', tv: isNetTv(d) ? 'Google TV' : 'Controle remoto' }[d.kind] || d.product, d.online ? 'Online' : 'Offline'].filter(Boolean).join(' · '))}</p></div>
      <button type="button" class="more" data-act="close" aria-label="Fechar">${ICON.close}</button>
    </header>
    ${d.kind === 'ac' ? acPanel(d) : d.kind === 'tv' ? tvPanel(d) : [...writable, ...readonly].map((c) => control(d, c)).join('') || '<p class="empty">Este dispositivo não informou nenhum dado.</p>'}`;
}

function openDetail(id) {
  detailId = id;
  renderDetail();
  $('#detail').showModal();
}

function render() {
  const busy = dragging || document.activeElement?.matches('select, input:not([type=range])');
  if (busy) return;
  if (state.title) $('h1').textContent = document.title = state.title;
  renderSummary();
  renderTabs();
  renderRooms();
  if ($('#detail').open) renderDetail();
  const banner = $('#banner');
  banner.hidden = !(state.error || state.demo);
  banner.className = `banner${state.error ? ' error' : ''}`;
  banner.textContent = state.error
    ? `Sem resposta da Tuya — mostrando o último estado conhecido. ${state.error}`
    : 'Modo demonstração: estes dispositivos são simulados. Preencha o config.json para conectar sua casa.';
}

async function refresh() {
  try {
    const next = await (await fetch('/api/state')).json();
    next.devices = next.devices.filter((d) => d.category !== 'wnykq'); // o emissor infravermelho em si não tem o que controlar
    for (const d of next.devices) d.kind = kindOf(d);
    // a nuvem leva um instante para refletir um comando; até lá vale o que o usuário pediu
    for (const [key, p] of pending) {
      const i = key.indexOf(':');
      const d = next.devices.find((x) => x.id === key.slice(0, i));
      const code = key.slice(i + 1);
      if (!d || p.until <= Date.now() || d.status[code] === p.value) pending.delete(key);
      else d.status[code] = p.value;
    }
    state = next;
  } catch {
    state = { ...state, error: 'O servidor do dashboard não respondeu.' };
  }
  render();
}

// ---------------------------------------------------------------- Eventos

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw !== '' && !isNaN(raw) ? Number(raw) : raw;
}

function deviceOf(el) {
  const id = el.closest('[data-id]')?.dataset.id;
  return state.devices.find((d) => d.id === id);
}

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    filter = tab.dataset.tab;
    return render();
  }
  if (e.target === $('#detail')) {
    // clique fora da caixa (no fundo escurecido) fecha os detalhes
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close();
    return;
  }
  const el = e.target.closest('button[data-act]');
  if (!el) return;
  const d = deviceOf(el);
  const { act, code, value } = el.dataset;
  if (act === 'close') return $('#detail').close();
  if (!d) return;
  if (act === 'toggle') toggle(d, el.closest('[data-id]').dataset.code);
  else if (act === 'detail') openDetail(d.id);
  else if (act === 'colour') setColour(d, Number(value));
  else if (act === 'ac') acSet(d, code, Number(value));
  else if (act === 'key') tvCommand(d, code, parseValue(value));
  else if (act === 'press') pressKey(d, code);
  else if (act === 'app') openApp(d, code);
  else if (act === 'pair') pair(d);
  else if (act === 'paircode') pair(d, el.previousElementSibling.value.trim());
  else if (act === 'cmd') send(d.id, [{ code, value: parseValue(value) }]);
});

// botão direito em qualquer bloco abre os detalhes (no widget, os blocos pequenos não têm o ⋯)
document.addEventListener('contextmenu', (e) => {
  const d = e.target.closest?.('.tile') && deviceOf(e.target);
  if (!d) return;
  e.preventDefault();
  openDetail(d.id);
});

document.addEventListener('pointerdown', (e) => {
  if (e.target.matches?.('input[type=range]')) dragging = true;
});
document.addEventListener('pointerup', () => setTimeout(() => (dragging = false)));

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act="set"]');
  const d = el && deviceOf(el);
  if (!d) return;
  dragging = false;
  el.blur();
  send(d.id, [{ code: el.dataset.code, value: parseValue(el.value) }]);
});

$('#detail').addEventListener('close', () => (detailId = null));

$('#all-off').addEventListener('click', () => {
  const on = state.devices.filter((d) => d.kind === 'light' && d.online && isOn(d));
  if (!on.length) return toast('Todas as luzes já estão apagadas.');
  for (const d of on) send(d.id, switches(d).map((code) => ({ code, value: false })));
});

function tick() {
  if (WIDGET) return;
  $('#clock').textContent = new Date().toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

tick();
setInterval(tick, 15000);
refresh();
setInterval(() => document.visibilityState === 'visible' && refresh(), POLL_MS);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
