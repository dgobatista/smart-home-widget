'use strict';
// Smart Home Widget — servidor do dashboard.
// Serve a página e faz a ponte com a nuvem da Tuya (as credenciais nunca vão para o navegador).
// Sem config.json, sobe em modo demonstração com dispositivos simulados.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');

const ROOT = __dirname;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('config.json inválido:', e.message);
    return {};
  }
}

const config = loadConfig();
const tuyaCfg = config.tuya || {};
const DEMO = !(tuyaCfg.accessId && tuyaCfg.accessSecret);
const ENDPOINT = (tuyaCfg.endpoint || 'https://openapi.tuyaus.com').replace(/\/$/, '');
const PORT = Number(process.env.PORT || config.port || 5070);
const HOST = config.host || '0.0.0.0';
const TITLE = config.title || 'Casa';
const STATE_TTL = 4000;
const ROOMS_TTL = 30 * 60 * 1000;

// ---------------------------------------------------------------- Tuya

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', tuyaCfg.accessSecret).update(s).digest('hex').toUpperCase();

class TuyaError extends Error {
  constructor(code, msg) {
    super(`Tuya ${code}: ${msg}${hint(code)}`);
    this.code = code;
  }
}

function hint(code) {
  if (code === 1004) return ' — confira o Access Secret e o data center (endpoint) no config.json';
  if (code === 1106 || code === 28841105) return ' — vincule a conta do app Smart Life ao projeto e assine as APIs "IoT Core" e "Smart Home Basic Service"';
  return '';
}

function sortQuery(url) {
  const [p, q] = url.split('?');
  return q ? `${p}?${q.split('&').sort().join('&')}` : p;
}

async function signedFetch(method, url, body, token = '') {
  url = sortQuery(url);
  const t = Date.now().toString();
  const nonce = crypto.randomUUID();
  const payload = body ? JSON.stringify(body) : '';
  const stringToSign = [method, sha256(payload), '', url].join('\n');
  const headers = {
    client_id: tuyaCfg.accessId,
    sign: hmac(tuyaCfg.accessId + token + t + nonce + stringToSign),
    sign_method: 'HMAC-SHA256',
    t,
    nonce,
    'Content-Type': 'application/json',
  };
  if (token) headers.access_token = token;
  const res = await fetch(ENDPOINT + url, {
    method,
    headers,
    body: payload || undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  if (!json.success) throw new TuyaError(json.code, json.msg);
  return json.result;
}

let token = { value: '', expires: 0 };

async function getToken() {
  if (token.value && Date.now() < token.expires) return token.value;
  const r = await signedFetch('GET', '/v1.0/token?grant_type=1');
  token = { value: r.access_token, expires: Date.now() + (r.expire_time - 60) * 1000 };
  return token.value;
}

async function tuya(method, url, body) {
  try {
    return await signedFetch(method, url, body, await getToken());
  } catch (e) {
    // token expirado ou inválido: renova e tenta uma vez
    if (e.code !== 1010 && e.code !== 1011) throw e;
    token = { value: '', expires: 0 };
    return signedFetch(method, url, body, await getToken());
  }
}

async function listDevices() {
  const out = [];
  let key = '';
  do {
    const r = await tuya('GET', `/v1.0/iot-01/associated-users/devices?size=50${key ? `&last_row_key=${key}` : ''}`);
    out.push(...(r.devices || []));
    key = r.has_more ? r.last_row_key : '';
  } while (key);
  return out;
}

// Especificação de cada dispositivo (quais funções aceita, faixas, unidades).
// Não muda, então fica em disco para não gastar cota da API a cada reinício.
const SPEC_FILE = path.join(ROOT, '.cache', 'specs.json');
let specs = {};
try {
  specs = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
} catch {}
const specRetry = {};

function parseValues(v) {
  try {
    return typeof v === 'string' ? JSON.parse(v || '{}') : v || {};
  } catch {
    return {};
  }
}

async function loadSpecs(devices) {
  const missing = devices.filter((d) => !specs[d.id] && !(specRetry[d.id] > Date.now()));
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += 5) {
    await Promise.all(
      missing.slice(i, i + 5).map(async (d) => {
        try {
          const r = await tuya('GET', `/v1.0/iot-03/devices/${d.id}/specification`);
          const spec = {};
          for (const s of r.status || []) spec[s.code] = { type: s.type, values: parseValues(s.values), rw: false };
          for (const f of r.functions || []) spec[f.code] = { type: f.type, values: parseValues(f.values), rw: true };
          specs[d.id] = spec;
        } catch (e) {
          specRetry[d.id] = Date.now() + 10 * 60 * 1000;
          console.warn(`Sem especificação para ${d.name}: ${e.message}`);
        }
      }),
    );
  }
  fs.mkdirSync(path.dirname(SPEC_FILE), { recursive: true });
  fs.writeFileSync(SPEC_FILE, JSON.stringify(specs));
}

// Cômodos vêm das "casas" do app Smart Life. Se o projeto não tiver permissão
// para essa API, o dashboard continua funcionando, só sem a divisão por cômodo.
let rooms = { map: {}, channels: {}, expires: 0 };

async function loadRooms(devices) {
  if (Date.now() < rooms.expires) return;
  const map = {};
  try {
    const uids = [...new Set(devices.map((d) => d.uid).filter(Boolean))];
    for (const uid of uids) {
      for (const home of await tuya('GET', `/v1.0/users/${uid}/homes`)) {
        const r = await tuya('GET', `/v1.0/homes/${home.home_id}/rooms`);
        for (const room of r.rooms || []) {
          const inRoom = await tuya('GET', `/v1.0/homes/${home.home_id}/rooms/${room.room_id}/devices`);
          for (const d of inRoom || []) map[d.id] = room.name;
        }
      }
    }
  } catch (e) {
    console.warn(`Não foi possível ler os cômodos: ${e.message}`);
  }
  // nomes que o usuário deu a cada tecla dos interruptores no app
  const channels = {};
  await Promise.all(
    devices
      .filter((d) => (d.status || []).some((s) => s.code === 'switch_2'))
      .map(async (d) => {
        try {
          const names = await tuya('GET', `/v1.0/devices/${d.id}/multiple-names`);
          channels[d.id] = Object.fromEntries((names || []).filter((n) => n.name).map((n) => [n.identifier, n.name]));
        } catch (e) {
          console.warn(`Sem nomes de teclas para ${d.name}: ${e.message}`);
        }
      }),
  );
  rooms = { map, channels, expires: Date.now() + ROOMS_TTL };
}

// O ar-condicionado por infravermelho não vem com estado na listagem; a Tuya guarda
// o último comando enviado (ligado, modo, temperatura, ventilação) em outra consulta.
async function loadInfraredStatus(devices) {
  await Promise.all(
    devices
      .filter((d) => d.category === 'infrared_ac')
      .map(async (d) => {
        try {
          d.status = await tuya('GET', `/v1.0/devices/${d.id}/status`);
        } catch (e) {
          console.warn(`Sem estado para ${d.name}: ${e.message}`);
        }
      }),
  );
}

// Teclas avulsas do controle (OK, Voltar, Início…) só existem na API de infravermelho da Tuya,
// que precisa do serviço "IR Control Hub Open Service" autorizado no projeto. Sem ele, o
// dashboard segue funcionando só com liga/desliga, setas e volume.
// ATENÇÃO: este caminho foi escrito a partir da documentação e ainda não foi testado com o serviço ativo.
const IR_KEYS_RETRY = 10 * 60 * 1000;
let irKeys = { byRemote: {}, at: 0 };

async function loadIrKeys(devices) {
  const hub = devices.find((d) => d.category === 'wnykq');
  const remotes = devices.filter((d) => d.category === 'infrared_tv' && !irKeys.byRemote[d.id]);
  if (!hub || !remotes.length || Date.now() - irKeys.at < IR_KEYS_RETRY) return;
  irKeys.at = Date.now();
  await Promise.all(
    remotes.map(async (d) => {
      try {
        const r = await tuya('GET', `/v2.0/infrareds/${hub.id}/remotes/${d.id}/keys`);
        irKeys.byRemote[d.id] = { hub: hub.id, category_id: r.category_id, remote_index: r.remote_index, keys: r.key_list || [] };
      } catch (e) {
        console.warn(`Teclas extras de ${d.name} indisponíveis: ${e.message}`);
      }
    }),
  );
}

async function sendIrKey(id, key) {
  const remote = irKeys.byRemote[id];
  const k = remote?.keys.find((x) => x.key === key);
  if (!k) throw new Error('Tecla indisponível neste controle');
  await tuya('POST', `/v2.0/infrareds/${remote.hub}/remotes/${id}/raw/command`, {
    category_id: remote.category_id,
    remote_index: remote.remote_index,
    key: k.key,
    key_id: k.key_id,
  });
}

const infraredValue = (s) => (s.code === 'power' ? s.value === '1' || s.value === true : Number(s.value));

async function tuyaState() {
  const raw = await listDevices();
  await Promise.all([loadSpecs(raw), loadRooms(raw), loadInfraredStatus(raw), loadIrKeys(raw)]);
  irTvCount = raw.filter((d) => d.category === 'infrared_tv').length;
  const override = config.rooms || {};
  // controles infravermelhos ficam no mesmo cômodo do emissor (Smart IR) que os comanda
  const hubs = raw.filter((d) => d.category === 'wnykq');
  const hubRoom = hubs.length === 1 ? override[hubs[0].id] || override[hubs[0].name] || rooms.map[hubs[0].id] : '';
  return raw.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    product: d.product_name,
    online: d.online,
    room: override[d.id] || override[d.name] || rooms.map[d.id] || (d.category.startsWith('infrared_') && hubRoom) || '',
    status: Object.fromEntries((d.status || []).map((s) => [s.code, d.category === 'infrared_ac' ? infraredValue(s) : s.value])),
    spec: specs[d.id] || {},
    channels: rooms.channels[d.id] || {},
    apps: d.category === 'infrared_tv' ? tvApps(d) : undefined,
    keys: irKeys.byRemote[d.id]?.keys.map((k) => k.key),
  }));
}

// ---------------------------------------------------------------- TVs na rede local
// TVs que se anunciam na rede aceitam pedidos para abrir apps (protocolo DIAL, o mesmo do botão
// "transmitir" do YouTube). As que são Google TV / Android TV aceitam também um controle remoto
// completo pela rede, depois de um pareamento único com código na tela.

const TV_FILE = path.join(ROOT, '.cache', 'tvs.json');
const DIAL_APPS = { YouTube: 'YouTube', Netflix: 'Netflix', AmazonInstantVideo: 'Prime Video' };
const APP_LINKS = { YouTube: 'https://www.youtube.com', Netflix: 'https://www.netflix.com/title', AmazonInstantVideo: 'https://app.primevideo.com' };
const ATV_KEYS = { Power: 26, Up: 19, Down: 20, Left: 21, Right: 22, OK: 23, Back: 4, Home: 3, VolumeUp: 24, VolumeDown: 25 };
const ATV_SHORT_PRESS = 3;
const TV_SCAN_EVERY = 5 * 60 * 1000;

let netTvs = {}; // por identificador da TV: { name, host, appUrl, apps, android, cert, seen }
try {
  netTvs = JSON.parse(fs.readFileSync(TV_FILE, 'utf8'));
} catch {}
const atv = {}; // conexões abertas com Google TVs: { remote, host, ready, powered, pairing }
let tvScanAt = 0;
let irTvCount = 0;

function saveTvs() {
  fs.mkdirSync(path.dirname(TV_FILE), { recursive: true });
  fs.writeFileSync(TV_FILE, JSON.stringify(netTvs));
}

const portOpen = (host, port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 1500 });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.on('connect', () => done(true)).on('timeout', () => done(false)).on('error', () => done(false));
  });

// Pergunta na rede local quem aceita abrir apps; devolve os endereços de descrição de quem respondeu.
function ssdpDial() {
  return new Promise((resolve) => {
    const socks = [];
    const locations = new Set();
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n');
    for (const n of Object.values(os.networkInterfaces()).flat()) {
      if (n.family !== 'IPv4' || n.internal || !isLocal(n.address)) continue;
      const s = dgram.createSocket('udp4');
      socks.push(s);
      s.on('error', () => {});
      s.on('message', (m, r) => {
        const location = /location:\s*(\S+)/i.exec(m)?.[1];
        if (location && isLocal(r.address)) locations.add(location);
      });
      s.bind(0, n.address, () => s.send(msg, 1900, '239.255.255.250'));
    }
    setTimeout(() => {
      for (const s of socks) s.close();
      resolve([...locations]);
    }, 2500);
  });
}

async function scanTvs() {
  tvScanAt = Date.now();
  for (const location of await ssdpDial()) {
    try {
      const res = await fetch(location, { signal: AbortSignal.timeout(3000) });
      const xml = await res.text();
      const appUrl = (res.headers.get('application-url') || '').replace(/\/$/, '');
      const host = appUrl && new URL(appUrl).hostname;
      if (!host || !isLocal(host)) continue;
      const udn = /<UDN>([^<]+)/.exec(xml)?.[1] || host;
      const apps = [];
      for (const id of Object.keys(DIAL_APPS)) {
        const r = await fetch(`${appUrl}/${id}`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (r?.ok) apps.push(id);
      }
      netTvs[udn] = {
        ...netTvs[udn],
        name: /<friendlyName>([^<]+)/.exec(xml)?.[1] || 'TV',
        host,
        appUrl,
        apps: apps.length ? apps : netTvs[udn]?.apps || [],
        android: await portOpen(host, 6466),
        seen: Date.now(),
      };
      atvConnect(udn);
    } catch {}
  }
  saveTvs();
}

// A busca roda em segundo plano para não atrasar a leitura do estado quando as TVs estão desligadas.
function tvScan() {
  if (!DEMO && Date.now() - tvScanAt > TV_SCAN_EVERY) scanTvs().catch(() => {});
}

// TV sem controle próprio pela rede (só abre apps): fica ligada ao controle infravermelho da Tuya.
// Com mais de uma, o config.json diz quem é quem: "tvs": { "nome na Tuya": "nome na rede" }.
function linkedTv(d) {
  const plain = Object.values(netTvs).filter((t) => !t.android);
  const wanted = config.tvs?.[d.name];
  if (wanted) return plain.find((t) => t.name === wanted);
  return irTvCount === 1 && plain.length === 1 ? plain[0] : undefined;
}

function tvApps(d) {
  tvScan();
  return (linkedTv(d)?.apps || []).filter((id) => DIAL_APPS[id]).map((id) => ({ id, name: DIAL_APPS[id] }));
}

const atvId = (udn) => `atv_${crypto.createHash('sha1').update(udn).digest('hex').slice(0, 12)}`;
const atvUdn = (id) => Object.keys(netTvs).find((udn) => netTvs[udn].android && atvId(udn) === id);

function atvRemote(udn, cert) {
  const { AndroidRemote } = require('androidtv-remote');
  const tv = netTvs[udn];
  try {
    atv[udn]?.remote.stop();
  } catch {}
  const remote = new AndroidRemote(tv.host, { cert, service_name: 'Smart Home Widget' });
  const st = (atv[udn] = { remote, host: tv.host, ready: false, pairing: !cert });
  // a biblioteca emite 'error' sem ouvinte próprio, o que derrubaria o servidor
  st.quiet = () => {
    const m = remote.remoteManager;
    if (m && !m.listenerCount('error')) m.on('error', () => {});
  };
  remote.on('ready', () => {
    st.quiet();
    st.ready = true;
    st.pairing = false;
    tv.cert = remote.getCertificate();
    saveTvs();
  });
  remote.on('powered', (powered) => (st.powered = powered));
  remote.on('unpaired', () => {
    st.ready = false;
    delete tv.cert;
    saveTvs();
  });
  remote.on('error', () => {});
  return st;
}

function atvConnect(udn) {
  const tv = netTvs[udn];
  if (!tv?.android || !tv.cert || (atv[udn] && atv[udn].host === tv.host)) return;
  try {
    const st = atvRemote(udn, tv.cert);
    st.remote.start().catch(() => {});
    st.quiet();
  } catch (e) {
    console.warn(`Controle da ${tv.name} indisponível: ${e.message}`);
  }
}

// Pareamento em dois passos: sem código, a TV mostra um na tela; com o código, a conexão é confirmada e salva.
async function atvPair(udn, code) {
  const tv = netTvs[udn];
  if (!tv) throw new Error('TV não encontrada na rede');
  if (!code) {
    const st = atvRemote(udn);
    await new Promise((resolve, reject) => {
      st.remote.once('secret', resolve);
      st.remote.start().catch(() => {});
      setTimeout(() => reject(new Error('A TV não mostrou o código. Ela está ligada?')), 15000);
    });
    return;
  }
  const st = atv[udn];
  if (!st?.pairing) throw new Error('Peça um novo código na TV.');
  if (!/^[0-9a-f]{6}$/i.test(code) || !st.remote.sendCode(code.toUpperCase())) throw new Error('Código incorreto. Peça um novo código na TV.');
  for (let i = 0; i < 30 && !st.ready; i++) await new Promise((r) => setTimeout(r, 500));
  if (!st.ready) throw new Error('A TV aceitou o código, mas a conexão não abriu. Tente de novo.');
}

function atvKey(udn, key) {
  const st = atv[udn];
  if (!(key in ATV_KEYS)) throw new Error('Tecla desconhecida');
  if (!st?.ready) throw new Error('A TV não está conectada. Ela está ligada e no Wi‑Fi?');
  st.remote.sendKey(ATV_KEYS[key], ATV_SHORT_PRESS);
}

// Google TVs entram no painel como dispositivos próprios, sem passar pela Tuya.
function atvDevices() {
  if (DEMO) return [];
  tvScan();
  const override = config.rooms || {};
  const known = [...new Set(Object.values(rooms.map))];
  return Object.entries(netTvs)
    .filter(([, t]) => t.android)
    .map(([udn, t]) => ({
      id: atvId(udn),
      name: t.name,
      category: 'androidtv',
      product: 'Google TV',
      online: !!atv[udn]?.ready || Date.now() - t.seen < 3 * TV_SCAN_EVERY,
      room: override[t.name] || known.find((r) => t.name.toLowerCase().includes(r.toLowerCase())) || '',
      status: { powered: atv[udn]?.powered ?? null },
      spec: {},
      paired: !!t.cert,
      pairing: !!atv[udn]?.pairing,
      apps: Object.entries(DIAL_APPS).map(([id, name]) => ({ id, name })),
    }));
}

async function launchApp(deviceId, app) {
  if (!DIAL_APPS[app]) throw new Error('App desconhecido');
  const udn = atvUdn(deviceId);
  const find = () => (udn ? netTvs[udn] : linkedTv(cache.devices.find((d) => d.id === deviceId) || {}));
  if (!find()) throw new Error('TV não encontrada na rede. Ela está ligada e no Wi‑Fi?');
  if (find().apps.includes(app)) {
    const post = () => fetch(`${find().appUrl}/${app}`, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '', signal: AbortSignal.timeout(5000) }).catch(() => null);
    let res = await post();
    if (!res) {
      // a TV pode ter mudado de endereço desde a última busca
      await scanTvs().catch(() => {});
      res = await post();
    }
    if (!res) throw new Error('A TV não respondeu pela rede. Ela está ligada e no Wi‑Fi?');
    if (!res.ok) throw new Error(`A TV recusou abrir o app (${res.status}).`);
  } else if (atv[udn]?.ready) {
    atv[udn].remote.sendAppLink(APP_LINKS[app]);
  } else {
    throw new Error('Esta TV não oferece esse app pela rede.');
  }
}

// ---------------------------------------------------------------- Demonstração

const B = { type: 'Boolean', values: {}, rw: true };
const I = (min, max, scale = 0, unit = '', step = 1) => ({ type: 'Integer', values: { min, max, scale, unit, step }, rw: true });
const E = (...range) => ({ type: 'Enum', values: { range }, rw: true });
const RO = (s) => ({ ...s, rw: false });
const HSV = { type: 'Json', values: { h: { min: 0, max: 360 }, s: { min: 0, max: 1000 }, v: { min: 0, max: 1000 } }, rw: true };

const lightSpec = { switch_led: B, bright_value_v2: I(10, 1000), temp_value_v2: I(0, 1000) };
const rgbSpec = { ...lightSpec, work_mode: E('white', 'colour'), colour_data_v2: HSV };
const plugSpec = { switch_1: B, cur_power: RO(I(0, 50000, 1, 'W')), cur_voltage: RO(I(0, 5000, 1, 'V')) };
const climateSpec = { va_temperature: RO(I(-200, 600, 1, '°C')), va_humidity: RO(I(0, 100, 0, '%')), battery_percentage: RO(I(0, 100, 0, '%')) };
const battery = { battery_percentage: RO(I(0, 100, 0, '%')) };

const demo = (id, name, room, category, spec, status) => ({ id, name, room, category, product: 'Dispositivo simulado', online: true, spec, status });

const demoDevices = [
  demo('d01', 'Luz do teto', 'Sala', 'dj', rgbSpec, { switch_led: true, bright_value_v2: 800, temp_value_v2: 400, work_mode: 'white', colour_data_v2: '{"h":30,"s":1000,"v":1000}' }),
  demo('d02', 'Fita LED', 'Sala', 'dd', rgbSpec, { switch_led: true, bright_value_v2: 600, temp_value_v2: 0, work_mode: 'colour', colour_data_v2: '{"h":280,"s":1000,"v":1000}' }),
  demo('d03', 'Tomada da TV', 'Sala', 'cz', plugSpec, { switch_1: true, cur_power: 870, cur_voltage: 1268 }),
  demo('d04', 'Ar-condicionado', 'Sala', 'kt', { switch: B, temp_set: I(16, 30, 0, '°C'), temp_current: RO(I(0, 50, 0, '°C')), mode: E('cold', 'hot', 'wet', 'wind', 'auto') }, { switch: true, temp_set: 23, temp_current: 25, mode: 'cold' }),
  demo('d05', 'Sensor de clima', 'Sala', 'wsdcg', climateSpec, { va_temperature: 248, va_humidity: 61, battery_percentage: 88 }),
  demo('d06', 'Luz da cozinha', 'Cozinha', 'dj', lightSpec, { switch_led: false, bright_value_v2: 1000, temp_value_v2: 700 }),
  demo('d07', 'Cafeteira', 'Cozinha', 'cz', plugSpec, { switch_1: false, cur_power: 0, cur_voltage: 1270 }),
  demo('d08', 'Sensor de fumaça', 'Cozinha', 'ywbj', { smoke_sensor_status: RO(E('alarm', 'normal')), ...battery }, { smoke_sensor_status: 'normal', battery_percentage: 95 }),
  demo('d09', 'Abajur', 'Quarto', 'dj', rgbSpec, { switch_led: false, bright_value_v2: 300, temp_value_v2: 100, work_mode: 'white', colour_data_v2: '{"h":0,"s":1000,"v":1000}' }),
  demo('d10', 'Interruptor do quarto', 'Quarto', 'kg', { switch_1: B, switch_2: B }, { switch_1: true, switch_2: false }),
  demo('d11', 'Cortina', 'Quarto', 'cl', { control: E('open', 'stop', 'close'), percent_control: I(0, 100, 0, '%') }, { control: 'stop', percent_control: 40 }),
  demo('d12', 'Sensor de clima', 'Quarto', 'wsdcg', climateSpec, { va_temperature: 231, va_humidity: 57, battery_percentage: 14 }),
  demo('d13', 'Porta da frente', 'Entrada', 'mcs', { doorcontact_state: RO(B), ...battery }, { doorcontact_state: false, battery_percentage: 72 }),
  demo('d14', 'Sensor de movimento', 'Entrada', 'pir', { pir: RO(E('pir', 'none')), ...battery }, { pir: 'none', battery_percentage: 64 }),
  demo('d15', 'Câmera da entrada', 'Entrada', 'sp', { basic_private: B, motion_switch: B }, { basic_private: false, motion_switch: true }),
  demo('d16', 'Fechadura', 'Entrada', 'ms', { closed_opened: RO(E('closed', 'open')), ...battery }, { closed_opened: 'closed', battery_percentage: 81 }),
  demo('d17', 'Portão da garagem', 'Garagem', 'ckmkzq', { switch_1: B, doorcontact_state: RO(B) }, { switch_1: false, doorcontact_state: false }),
  { ...demo('d18', 'Luz da garagem', 'Garagem', 'dj', lightSpec, { switch_led: false, bright_value_v2: 1000, temp_value_v2: 500 }), online: false },
];

function demoCommand(id, commands) {
  const d = demoDevices.find((x) => x.id === id);
  if (!d) throw new Error('Dispositivo não encontrado');
  for (const c of commands) {
    d.status[c.code] = typeof c.value === 'object' ? JSON.stringify(c.value) : c.value;
    if (d.category === 'ckmkzq' && c.code === 'switch_1') d.status.doorcontact_state = c.value;
    if (d.category === 'cl' && c.code === 'control' && c.value !== 'stop') d.status.percent_control = c.value === 'open' ? 100 : 0;
  }
}

// ---------------------------------------------------------------- Estado e HTTP

let cache = { devices: [], at: 0, error: null };
let inflight = null;

async function getState() {
  if (DEMO) return { title: TITLE, demo: true, devices: demoDevices, error: null };
  if (Date.now() - cache.at > STATE_TTL) {
    inflight ||= tuyaState()
      .then((devices) => (cache = { devices, at: Date.now(), error: null }))
      .catch((e) => {
        console.error(e.message);
        cache = { ...cache, at: Date.now(), error: e.message };
      })
      .finally(() => (inflight = null));
    await inflight;
  }
  return { title: TITLE, demo: false, devices: [...cache.devices, ...atvDevices()], error: cache.error };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) reject(new Error('Requisição grande demais'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

// O dashboard não tem login: só atende o próprio computador e a rede local.
function isLocal(addr = '') {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd]|fe80)/i.test(a);
}

// Sem login, a defesa é só aceitar pedidos feitos pela própria página, de dentro da rede:
// - o Host tem de ser localhost ou um IP local (barra DNS rebinding);
// - escritas exigem JSON, o que obriga o navegador a pedir permissão antes (preflight) quando
//   o pedido parte de outro site, e a Origin, se vier, tem de ser a da própria página.
function trusted(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && !isLocal(host)) return false;
  if (req.method === 'GET') return true;
  const { origin } = req.headers;
  if (origin && !(URL.canParse(origin) && new URL(origin).host === req.headers.host)) return false;
  return /^application\/json\b/i.test(req.headers['content-type'] || '');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!isLocal(req.socket.remoteAddress) || !trusted(req)) return json(res, 403, { error: 'Acesso permitido só pela rede local' });
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, file)).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, await getState());
    }
    const keyMatch = url.pathname.match(/^\/api\/devices\/(\w+)\/key$/);
    if (req.method === 'POST' && keyMatch) {
      const { key } = await readBody(req);
      if (atvUdn(keyMatch[1])) atvKey(atvUdn(keyMatch[1]), key);
      else await sendIrKey(keyMatch[1], key);
      return json(res, 200, { ok: true });
    }
    const appMatch = url.pathname.match(/^\/api\/devices\/(\w+)\/app$/);
    if (req.method === 'POST' && appMatch) {
      await launchApp(appMatch[1], (await readBody(req)).app);
      return json(res, 200, { ok: true });
    }
    const pairMatch = url.pathname.match(/^\/api\/devices\/(\w+)\/pair$/);
    if (req.method === 'POST' && pairMatch) {
      await atvPair(atvUdn(pairMatch[1]), (await readBody(req)).code);
      return json(res, 200, { ok: true });
    }
    const m = url.pathname.match(/^\/api\/devices\/(\w+)\/commands$/);
    if (req.method === 'POST' && m) {
      const { commands } = await readBody(req);
      if (!Array.isArray(commands) || !commands.length || commands.some((c) => typeof c?.code !== 'string' || !('value' in c))) {
        return json(res, 400, { error: 'Comando inválido' });
      }
      if (DEMO) demoCommand(m[1], commands);
      else {
        // controles infravermelhos só obedecem ao conjunto de instruções da API v1.0
        const infrared = cache.devices.find((d) => d.id === m[1])?.category.startsWith('infrared_');
        await tuya('POST', `${infrared ? '/v1.0' : '/v1.0/iot-03'}/devices/${m[1]}/commands`, { commands });
        cache.at = 0;
      }
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Não encontrado' });
  } catch (e) {
    console.error(e.message);
    json(res, 502, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.log(`A porta ${PORT} já está em uso — o servidor provavelmente já está rodando.`);
});

server.listen(PORT, HOST, () => {
  console.log(`${TITLE} ${DEMO ? '(modo demonstração — crie o config.json para conectar à Tuya)' : `conectado a ${ENDPOINT}`}`);
  console.log(`  Neste computador:  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list) if (n.family === 'IPv4' && !n.internal && isLocal(n.address)) console.log(`  Na rede de casa:   http://${n.address}:${PORT}`);
    }
  }
});

module.exports = { PORT, TITLE };
