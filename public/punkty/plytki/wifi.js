// Gra przez Wi‑Fi bez internetu: telefony łączą się bezpośrednio (WebRTC), a dane do połączenia
// przekazują sobie kodami QR – bez serwera. Wystarczy wspólna sieć, np. hotspot z jednego telefonu.
// Gospodarz prowadzi grę (silnik z engine.js), pozostali wysyłają ruchy i dostają widok gry.

const PREFIX = 'PLY1';
const NO_SERVERS = { iceServers: [] };
// Test na jednym komputerze (?qrtest w adresie): zamiast aparatu dwie karty przekazują sobie kody przez localStorage.
const QRTEST = new URLSearchParams(location.search).has('qrtest');
const TEST_KEY = 'plytki-qrtest';

/* ---------- Kody QR z opisem połączenia ---------- */
const b64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function squeeze(text, mode) {
  const s = new Blob([text]).stream().pipeThrough(new (mode === 'c' ? CompressionStream : DecompressionStream)('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const canZip = typeof CompressionStream === 'function';

// Opis połączenia bez zbędnych linii (mniejszy kod QR). Kandydaci TCP nie są potrzebni w sieci lokalnej.
function trim(sdp) {
  return sdp.split(/\r?\n/).filter(l => l && !/^a=(extmap-allow-mixed|msid-semantic)/.test(l) && !(l.startsWith('a=candidate') && / tcp /i.test(l))).join('\r\n') + '\r\n';
}
// Zwięzły zapis (mały kod QR): tylko to, co różni połączenia – hasła ICE, odcisk certyfikatu i adresy w sieci.
// Resztę opisu druga strona odtwarza z szablonu. Gdy opis jest nietypowy, zostaje pełny (skompresowany) tekst.
const SETUPS = ['actpass', 'active', 'passive'];
function compact(sdp) {
  const get = re => { const m = sdp.match(re); return m ? m[1] : null; };
  const ufrag = get(/a=ice-ufrag:(\S+)/), pwd = get(/a=ice-pwd:(\S+)/), fp = get(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/);
  const setup = SETUPS.indexOf(get(/a=setup:(\S+)/)), mid = get(/a=mid:(\S+)/);
  if (!ufrag || !pwd || !fp || setup < 0 || mid == null || (sdp.match(/^m=/gm) || []).length !== 1) return null;
  const out = [1, setup], str = s => { const b = new TextEncoder().encode(s); if (b.length > 255) throw 0; out.push(b.length, ...b); };
  str(mid); str(ufrag); str(pwd);
  const fpb = fp.split(':').map(h => parseInt(h, 16)); if (fpb.length !== 32) return null; out.push(...fpb);
  const cands = [];
  for (const m of sdp.matchAll(/a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gi)) cands.push([m[1], +m[2]]);
  if (!cands.length || cands.length > 12) return null;
  out.push(cands.length);
  for (const [addr, port] of cands) {
    let m;
    if ((m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/))) out.push(4, +m[1], +m[2], +m[3], +m[4]);
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i.test(addr)) out.push(16, ...addr.slice(0, 36).replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)));
    else { out.push(0); str(addr); }
    out.push(port >> 8, port & 255);
  }
  return new Uint8Array(out);
}
function expand(b) {
  let i = 0;
  const byte = () => { if (i >= b.length) throw new Error('Uszkodzony kod.'); return b[i++]; };
  const str = () => { const n = byte(); const s = new TextDecoder().decode(b.slice(i, i + n)); i += n; return s; };
  const hex = n => Array.from(b.slice(i, i += n), x => x.toString(16).padStart(2, '0'));
  if (byte() !== 1) throw new Error('Kod z innej wersji gry – odśwież stronę na obu telefonach.');
  const setup = SETUPS[byte()], mid = str(), ufrag = str(), pwd = str();
  const fp = hex(32).join(':').toUpperCase();
  const n = byte(), lines = [];
  for (let k = 0; k < n; k++) {
    const kind = byte(); let addr;
    if (kind === 4) addr = [byte(), byte(), byte(), byte()].join('.');
    else if (kind === 16) { const h = hex(16).join(''); addr = h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20) + '.local'; }
    else addr = str();
    const port = byte() << 8 | byte();
    lines.push(`a=candidate:${k + 1} 1 udp ${2113937151 - k} ${addr} ${port} typ host`);
  }
  return ['v=0', 'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE ' + mid,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', ...lines,
    'a=ice-ufrag:' + ufrag, 'a=ice-pwd:' + pwd, 'a=fingerprint:sha-256 ' + fp, 'a=setup:' + setup,
    'a=mid:' + mid, 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');
}

// kind: 'O' – zaproszenie od gospodarza, 'A' – odpowiedź gracza.
export async function pack(kind, sdp) {
  let c = null;
  try { c = compact(sdp); } catch (e) { c = null; }
  if (c) return PREFIX + kind + 'c' + b64(c);
  const t = trim(sdp);
  if (canZip) return PREFIX + kind + 'z' + b64(await squeeze(t, 'c'));
  return PREFIX + kind + 'u' + b64(new TextEncoder().encode(t));
}
export async function unpack(kind, text) {
  if (!text.startsWith(PREFIX + kind)) throw new Error(kind === 'O' ? 'To nie jest kod gospodarza gry.' : 'To nie jest kod gracza.');
  const enc = text[PREFIX.length + 1], body = unb64(text.slice(PREFIX.length + 2));
  if (enc === 'c') return expand(body);
  if (enc === 'z') return new TextDecoder().decode(await squeeze(body, 'd'));
  return new TextDecoder().decode(body);
}
export const isCode = (kind, text) => typeof text === 'string' && text.startsWith(PREFIX + kind);

let qrLib = null;
export function loadScript(src, global) {
  if (window[global]) return Promise.resolve(window[global]);
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = () => ok(window[global]); s.onerror = no; document.head.appendChild(s); });
}
export async function drawQr(box, text) {
  qrLib = qrLib || loadScript('../vendor/qrcode.min.js', 'qrcode');
  const qrcode = await qrLib;
  const q = qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
  box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  box.dataset.version = q.getModuleCount();
  if (QRTEST) try { localStorage.setItem(TEST_KEY, text); } catch (e) { /* brak */ }
}

/* ---------- Aparat i skanowanie ---------- */
let stream = null;
export async function startCamera(video) {
  if (QRTEST) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Ta przeglądarka nie daje dostępu do aparatu.');
  stopCamera(video);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    throw new Error('Bez aparatu nie zeskanujesz kodu. Zezwól na dostęp do aparatu dla tej strony i spróbuj jeszcze raz.');
  }
  video.srcObject = stream; video.setAttribute('playsinline', ''); video.muted = true;
  try { await video.play(); } catch (e) { /* Safari czasem odtwarza dopiero po chwili */ }
}
export function stopCamera(video) {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (video) video.srcObject = null;
}

// Czeka, aż w kadrze pojawi się kod spełniający warunek accept; alive() = false przerywa skanowanie.
export async function scanQr(video, accept, alive) {
  if (QRTEST) {
    while (alive()) {
      await new Promise(r => setTimeout(r, 200));
      const t = localStorage.getItem(TEST_KEY);
      if (t && accept(t)) { localStorage.removeItem(TEST_KEY); return t; }
    }
    return null;
  }
  let detector = null;
  if ('BarcodeDetector' in window) {
    try { const f = await window.BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { /* brak */ }
  }
  const jsQR = detector ? null : await loadScript('../vendor/jsqr.min.js', 'jsQR');
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  while (alive()) {
    await new Promise(r => setTimeout(r, 150));
    if (!video.videoWidth) continue;
    let text = null;
    try {
      if (detector) { const c = await detector.detect(video); text = c.length ? c[0].rawValue : null; }
      else {
        const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        text = r ? r.data : null;
      }
    } catch (e) { text = null; }
    if (!text) continue;
    if (accept(text)) return text;
  }
  return null;
}

/* ---------- Połączenie ---------- */
// Czeka na zebranie adresów sieciowych (bez serwerów to trwa chwilę).
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(ok => {
    const done = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); } };
    const t = setTimeout(ok, 3000);
    pc.addEventListener('icegatheringstatechange', done);
  });
}
function opened(dc, ms) {
  if (dc.readyState === 'open') return Promise.resolve(dc);
  return new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('timeout')), ms);
    dc.addEventListener('open', () => { clearTimeout(t); ok(dc); });
  });
}
const hasCandidate = sdp => /a=candidate/.test(sdp);
export const NET_HELP = 'Nie udało się połączyć. Sprawdź, czy oba telefony są w tej samej sieci Wi‑Fi (np. hotspot z jednego telefonu) i spróbuj jeszcze raz.';

// Gospodarz: tworzy zaproszenie dla jednego gracza.
export async function hostOffer() {
  const pc = new RTCPeerConnection(NO_SERVERS);
  const dc = pc.createDataChannel('plytki', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  if (!hasCandidate(pc.localDescription.sdp)) { pc.close(); throw new Error('Telefon nie jest w żadnej sieci. Włącz Wi‑Fi albo hotspot i spróbuj jeszcze raz.'); }
  return { pc, dc, code: await pack('O', pc.localDescription.sdp) };
}
// Gospodarz: odpowiedź gracza → połączenie gotowe.
export async function hostAccept(pc, dc, answerCode) {
  await pc.setRemoteDescription({ type: 'answer', sdp: await unpack('A', answerCode) });
  try { await opened(dc, 20000); } catch (e) { throw new Error(NET_HELP); }
  return dc;
}
// Gracz: zaproszenie gospodarza → odpowiedź do pokazania gospodarzowi i obietnica otwartego kanału.
export async function guestAnswer(offerCode) {
  const pc = new RTCPeerConnection(NO_SERVERS);
  const channel = new Promise(ok => { pc.ondatachannel = e => ok(e.channel); });
  await pc.setRemoteDescription({ type: 'offer', sdp: await unpack('O', offerCode) });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  if (!hasCandidate(pc.localDescription.sdp)) { pc.close(); throw new Error('Telefon nie jest w żadnej sieci. Połącz się z tym samym Wi‑Fi co gospodarz.'); }
  const ready = channel.then(dc => opened(dc, 120000));
  return { pc, code: await pack('A', pc.localDescription.sdp), ready };
}

// Wiadomości JSON w kanale; onClose wołane raz, gdy połączenie padnie.
export function wire(pc, dc, onMsg, onClose) {
  let closed = false;
  const close = () => { if (closed) return; closed = true; onClose(); };
  dc.onmessage = e => { let m = null; try { m = JSON.parse(e.data); } catch (err) { return; } onMsg(m); };
  dc.onclose = close;
  pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState)) close(); });
  return {
    send(m) { if (dc.readyState === 'open') try { dc.send(JSON.stringify(m)); } catch (e) { /* zamknięty */ } },
    get open() { return !closed && dc.readyState === 'open'; },
    close() { try { dc.close(); pc.close(); } catch (e) { /* już zamknięte */ } close(); },
  };
}
