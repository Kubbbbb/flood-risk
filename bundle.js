





var toastTimer;

function $(selector, root) {
  return (root || document).querySelector(selector);
}

function $$(selector, root) {
  return Array.from((root || document).querySelectorAll(selector));
}

function showToast(message) {
  var toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 4200);
}


var DEFAULT_TIMEOUT_MS = 8000;

var API_AREAS = {
  'ขอนแก่น - เมือง': { lat: 16.4419, lng: 102.8359 },
  'อยุธยา - บางบาล': { lat: 14.4631, lng: 100.4853 },
  'นครราชสีมา - พิมาย': { lat: 15.2232, lng: 102.4948 },
  'อุบลราชธานี - วารินชำราบ': { lat: 15.1931, lng: 104.8628 }
};

function getConfiguredBaseUrl() {
  var meta = document.querySelector('meta[name="floodsense-api-base"]');
  var value = window.FLOODSENSE_API_BASE_URL || (meta ? meta.content : '') || 'http://127.0.0.1:8000';
  return value.trim().replace(/\/+$/, '');
}

function fetchJson(url, options) {
  var controller = new AbortController();
  var timeout = window.setTimeout(function () { controller.abort(); }, (options && options.timeoutMs) || DEFAULT_TIMEOUT_MS);

  return fetch(url, {
    headers: Object.assign({ Accept: 'application/json' }, (options && options.headers) || {}),
    signal: controller.signal
  }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).finally(function () {
    window.clearTimeout(timeout);
  });
}

function normalizeForecast(data, hour) {
  if (!data) return null;
  var risk = Number(data.risk != null ? data.risk : data.riskScore != null ? data.riskScore : data.score);
  var waterLevel = data.waterLevel != null ? data.waterLevel : data.level != null ? data.level : data.predictedWaterLevel;
  var rainfall = data.rainfall != null ? data.rainfall : data.rain != null ? data.rain : data.precipitation;

  return Object.fromEntries(Object.entries({
    risk: Number.isFinite(risk) ? Math.round(risk) : undefined,
    level: typeof waterLevel === 'number' ? waterLevel.toFixed(2) + ' ม.' : waterLevel,
    rain: typeof rainfall === 'number' ? Math.round(rainfall) + ' มม.' : rainfall,
    title: data.title || (risk >= 80 ? 'เปิดแผนอพยพเต็มรูปแบบ' : risk >= 70 ? 'น้ำจะถึงพื้นที่ใน 4 ชม.' : 'น้ำจะถึงพื้นที่ใน 6 ชม.'),
    text: data.text || data.description || ('ข้อมูลพยากรณ์จาก API สำหรับช่วง ' + hour + ' ชั่วโมง'),
    badge: data.badge || data.severity || (risk >= 75 ? 'วิกฤต' : 'เสี่ยงสูง')
  }).filter(function (entry) {
    return entry[1] !== undefined && entry[1] !== null && entry[1] !== '';
  }));
}

function fetchBackendForecast(area, hour) {
  var baseUrl = getConfiguredBaseUrl();
  if (!baseUrl) return Promise.resolve(null);

  var params = new URLSearchParams({ area: area, hour: String(hour) });
  return fetchJson(baseUrl + '/forecast?' + params.toString()).then(function (data) {
    return normalizeForecast(data, hour);
  });
}

function fetchOpenMeteoForecast(area, hour) {
  var coords = API_AREAS[area] || API_AREAS['ขอนแก่น - เมือง'];
  var params = new URLSearchParams({
    latitude: String(coords.lat),
    longitude: String(coords.lng),
    hourly: 'precipitation,rain',
    forecast_days: '2',
    timezone: 'Asia/Bangkok'
  });

  return fetchJson('/api/forecast?area=' + encodeURIComponent(area) + '&hour=' + encodeURIComponent(hour)).then(function (data) {
    var length = data.hourly && data.hourly.time ? data.hourly.time.length : 1;
    var index = Math.min(Math.max(Number(hour) || 6, 1), length - 1);
    var rainWindow = ((data.hourly && data.hourly.rain) || []).slice(0, index + 1);
    var precipitationWindow = ((data.hourly && data.hourly.precipitation) || []).slice(0, index + 1);
    var rain = rainWindow.reduce(function (sum, value) { return sum + (Number(value) || 0); }, 0);
    var precipitation = precipitationWindow.reduce(function (sum, value) { return sum + (Number(value) || 0); }, 0);
    var risk = Math.min(95, Math.round(54 + precipitation * 7 + (hour >= 24 ? 10 : hour >= 12 ? 6 : 0)));

    return {
      risk: risk,
      level: (2.85 + precipitation * 0.05 + hour * 0.015).toFixed(2) + ' ม.',
      rain: Math.round(rain || precipitation) + ' มม.',
      title: risk >= 80 ? 'เปิดแผนอพยพเต็มรูปแบบ' : risk >= 70 ? 'น้ำจะถึงพื้นที่ใน 4 ชม.' : 'น้ำจะถึงพื้นที่ใน 6 ชม.',
      text: 'ข้อมูลฝนสะสมจาก Open-Meteo สำหรับ ' + area + ' ในช่วง ' + hour + ' ชั่วโมงล่าสุด ระบบประเมินความเสี่ยงจากฝนและช่วงเวลาพยากรณ์',
      badge: risk >= 75 ? 'วิกฤต' : 'เสี่ยงสูง'
    };
  });
}

function fetchForecast(area, hour) {
  return fetchBackendForecast(area, hour);
}

window.FloodSenseAPI = {
  fetchJson: fetchJson,
  fetchForecast: fetchForecast
};


function initNavigation() {
  var path = window.location.pathname;
  var file = path.substring(path.lastIndexOf('/') + 1) || 'index.html';
  $$('.nav a').forEach(function (link) {
    var href = link.getAttribute('href');
    if (href === file || (file === '' && href === 'index.html')) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}


var dataByHour = {
  6:  { risk: 68, level: '3.62 ม.', rain: '94 มม.',  title: 'น้ำจะถึงพื้นที่ใน 6 ชม.',       text: 'เฝ้าระวังพื้นที่ริมคลองและจุดต่ำ ระบบแนะนำให้เตรียมกระเป๋าฉุกเฉินและตรวจเส้นทางไปศูนย์พักพิง', badge: 'เสี่ยงสูง' },
  12: { risk: 76, level: '3.84 ม.', rain: '112 มม.', title: 'น้ำจะถึงพื้นที่ใน 4 ชม.',       text: 'แนะนำให้ผู้สูงอายุ เด็ก และผู้ป่วยเริ่มอพยพไปยังศูนย์พักพิง A ผ่านถนนเลี่ยงเมือง',        badge: 'วิกฤต'   },
  24: { risk: 88, level: '4.28 ม.', rain: '148 มม.', title: 'เปิดแผนอพยพเต็มรูปแบบ',         text: 'คาดว่าพื้นที่ชุมชนชั้นในได้รับผลกระทบหลายจุด ควรปิดถนนเสี่ยงและเพิ่มทีมกู้ภัยในโซน C-D', badge: 'วิกฤต'   }
};

function renderForecast(hour, detail) {
  var h = Number(hour);
  var d = detail;
  if (!d) return;
  var riskMap = $('#riskMap');       if (riskMap)      riskMap.setAttribute('data-hour', h);
  var riskScore = $('#riskScore');   if (riskScore)    riskScore.textContent = d.risk;
  var waterLevel = $('#waterLevel'); if (waterLevel)   waterLevel.textContent = d.level;
  var rainfall = $('#rainfall');     if (rainfall)     rainfall.textContent = d.rain;
  var alertTitle = $('#alertTitle'); if (alertTitle)   alertTitle.textContent = d.title;
  var alertText = $('#alertText');   if (alertText)    alertText.textContent = d.text;
  var alertBadge = $('#alertBadge'); if (alertBadge)   alertBadge.textContent = d.badge;
  $$('.time-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-hour') === String(h));
  });
}

function setForecastHour(hour, options) {
  var h = Number(hour);
  var fallback = dataByHour[h];
  if (!fallback) return Promise.resolve();
  var areaSelect = $('#areaSelect');
  var area = areaSelect ? areaSelect.value : 'ขอนแก่น - เมือง';

  if (!options || !options.silent) {
    showToast('กำลังดึงข้อมูลพยากรณ์ ' + area + ' ล่วงหน้า ' + h + ' ชั่วโมง...');
  }

  return fetchForecast(area, h).then(function (detail) {
    renderForecast(h, Object.assign({}, fallback, detail));
    if (!options || !options.silent) showToast('อัปเดตข้อมูลจาก API สำหรับ ' + area + ' เรียบร้อย');
  }).catch(function (error) {
    renderForecast(h, fallback);
    if (!options || !options.silent) showToast('ดึงข้อมูล API ไม่สำเร็จ ใช้ข้อมูลสำรองแทน (' + error.message + ')');
  });
}

function initForecastMap() {
  $$('.time-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { setForecastHour(btn.getAttribute('data-hour')); });
  });
  var toggleRoute = $('#toggleRoute');
  if (toggleRoute) {
    toggleRoute.addEventListener('click', function () {
      var route = $('.route-line');
      if (!route) return;
      var hidden = route.style.display === 'none';
      route.style.display = hidden ? 'block' : 'none';
      showToast(hidden ? 'เปิดเส้นทางปลอดภัยบนแผนที่แล้ว' : 'ซ่อนเส้นทางปลอดภัยแล้ว');
    });
  }
  setForecastHour(6, { silent: true });
}


function initAlerts() {
  var sim = $('#simulateAlert');
  if (sim) sim.addEventListener('click', function () {
    setForecastHour(12);
    showToast('Geofencing Alert: ผู้ใช้อยู่ในโซน C โปรดเตรียมอพยพภายใน 4 ชั่วโมง');
  });
  var sel = $('#areaSelect');
  if (sel) sel.addEventListener('change', function (e) {
    var area = e.target.value;
    showToast('กำลังโหลดข้อมูลพื้นที่ ' + area + '...');
    var alertArea = $('#alertArea');
    if (alertArea) alertArea.textContent = area.includes('อยุธยา') ? 'โซน A' : area.includes('อุบล') ? 'โซน D' : 'โซน C';
    var active = $('.time-btn.active');
    setForecastHour(active ? active.getAttribute('data-hour') : 6);
  });
  var search = $('#areaSearch');
  if (search) search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') showToast('ค้นหาพื้นที่ "' + (e.target.value || 'ตำแหน่งปัจจุบัน') + '" และซูมไปยังแผนที่แล้ว');
  });
}


function initRouting() {
  var form = $('#routeForm');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var origin = ($('#origin') || {}).value || 'ตำแหน่งปัจจุบัน';
    var dest   = ($('#destination') || {}).value || 'ศูนย์พักพิงที่ใกล้ที่สุด';
    var result = $('#routeResult');
    if (result) result.innerHTML = '<strong>เส้นทางแนะนำ: 7.8 กม. / 18 นาที</strong><span>จาก ' + origin + ' ไป ' + dest + ': ถนนเลี่ยงเมือง &gt; สะพานเหนือ &gt; ถนนเทศบาล 4 หลีกเลี่ยงจุดน้ำลึก 60 ซม.</span>';
    showToast('คำนวณเส้นทางใหม่ด้วยข้อมูลถนนล่าสุดแล้ว');
  });
}


function initSos() {
  var modal = $('#sosModal');
  if (!modal) return;
  var open = $('#openSos');   if (open)  open.addEventListener('click',  function () { modal.classList.add('show'); });
  var close = $('#closeSos'); if (close) close.addEventListener('click', function () { modal.classList.remove('show'); });
  modal.addEventListener('click', function (e) { if (e.target === modal) modal.classList.remove('show'); });
  var form = $('#sosForm');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var detail   = ($('#sosDetail')   || {}).value || 'ขอความช่วยเหลือเร่งด่วน';
    var location = ($('#sosLocation') || {}).value || 'พิกัดปัจจุบัน';
    var item = document.createElement('article');
    item.className = 'sos-row';
    item.innerHTML = '<div class="sos-main"><strong>' + detail.slice(0, 36) + '</strong><span class="badge critical">P1</span></div><p>' + location + ' ส่งเข้าคิวหน่วยกู้ภัยแล้ว</p>';
    var queue = $('#sosQueue'); if (queue) queue.prepend(item);
    var cnt = $('#sosCount');   if (cnt)   cnt.textContent = Number(cnt.textContent) + 1;
    modal.classList.remove('show');
    e.target.reset();
    var loc = $('#sosLocation'); if (loc) loc.value = 'โซน C ซอยริมคลอง 4';
    showToast('ส่ง SOS สำเร็จ หน่วยกู้ภัยได้รับพิกัดและรายละเอียดแล้ว');
  });
}


var chatReplies = [
  { keys: ['โซน c','อพยพ','ต้อง'],            text: 'โซน C อยู่ระดับเสี่ยงสูง ควรเริ่มอพยพกลุ่มเปราะบางทันที และใช้เส้นทางถนนเลี่ยงเมืองไปศูนย์พักพิง A' },
  { keys: ['เส้นทาง','ศูนย์','ทาง'],           text: 'เส้นทางที่ปลอดภัยที่สุดคือถนนเลี่ยงเมือง > สะพานเหนือ > ถนนเทศบาล 4 ใช้เวลาประมาณ 18 นาที' },
  { keys: ['ฝน','ระดับน้ำ','น้ำ'],             text: 'LSTM คาดว่าระดับน้ำใน 12 ชั่วโมงจะอยู่ที่ 3.84 เมตร และมีโอกาสเพิ่มขึ้นหากฝนสะสมเกิน 120 มม.' },
  { keys: ['เตรียม','กระเป๋า','ทำอย่างไร'],   text: 'เตรียมเอกสารสำคัญ ยาประจำตัว น้ำดื่ม อาหารแห้ง ไฟฉาย แบตเตอรี่สำรอง และแจ้งญาติถึงจุดอพยพ' }
];

function addChatMessage(text, type) {
  var msgs = $('#messages');
  if (!msgs) return;
  var b = document.createElement('div');
  b.className = 'bubble ' + type;
  b.textContent = text;
  msgs.appendChild(b);
  msgs.scrollTop = msgs.scrollHeight;
}

function initChatbot() {
  var form = $('#chatForm');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#chatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    addChatMessage(text, 'user');
    input.value = '';
    var norm = text.toLowerCase();
    var found = null;
    for (var i = 0; i < chatReplies.length; i++) {
      for (var j = 0; j < chatReplies[i].keys.length; j++) {
        if (norm.includes(chatReplies[i].keys[j])) { found = chatReplies[i]; break; }
      }
      if (found) break;
    }
    setTimeout(function () {
      addChatMessage(found ? found.text : 'ฉันพบว่าพื้นที่นี้ควรติดตามประกาศทุก 15 นาที หากต้องเดินทางให้เปิด Dynamic Routing และหลีกเลี่ยงถนนที่มีน้ำเกิน 30 ซม.', 'bot');
      showToast('AI Chatbot ตอบคำถามแล้ว');
    }, 320);
  });
}


function initRealtimeClock() {
  function tick() {
    var el = $('#liveTime');
    if (el) el.textContent = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  }
  tick();
  setInterval(tick, 30000);
}


document.addEventListener('DOMContentLoaded', function () {
  initNavigation();
  initForecastMap();
  initAlerts();
  initRouting();
  initSos();
  initChatbot();
  initRealtimeClock();
});
