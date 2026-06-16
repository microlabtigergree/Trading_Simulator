// 台指期 1分K 回放前端：Lightweight Charts + WebSocket
const chartEl = document.getElementById("chart");
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: "#131722" }, textColor: "#d1d4dc" },
  grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a2e39" },
  rightPriceScale: { borderColor: "#2a2e39" },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
});

// 台股慣例：紅漲綠跌
const candleSeries = chart.addCandlestickSeries({
  upColor: "#ef5350", downColor: "#26a69a",
  borderUpColor: "#ef5350", borderDownColor: "#26a69a",
  wickUpColor: "#ef5350", wickDownColor: "#26a69a",
});
const volumeSeries = chart.addHistogramSeries({
  priceFormat: { type: "volume" }, priceScaleId: "vol",
});
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

window.addEventListener("resize", () => {
  chart.resize(chartEl.clientWidth, chartEl.clientHeight);
});

// ---- DOM ----
const dateSel = document.getElementById("dateSel");
const playBtn = document.getElementById("playBtn");
const stepBtn = document.getElementById("stepBtn");
const speedDown = document.getElementById("speedDown");
const speedUp = document.getElementById("speedUp");
const speedVal = document.getElementById("speedVal");
const realBtn = document.getElementById("realBtn");
const statusEl = document.getElementById("status");
const buyBtn = document.getElementById("buyBtn");
const sellBtn = document.getElementById("sellBtn");
const flatBtn = document.getElementById("flatBtn");
const pxVal = document.getElementById("pxVal");
const posVal = document.getElementById("posVal");
const uplVal = document.getElementById("uplVal");
const rplVal = document.getElementById("rplVal");
const totVal = document.getElementById("totVal");
const ptNote = document.getElementById("ptNote");

let ws = null;
let playing = false;
let received = 0;
let total = 0;

function setStatus(t) { statusEl.textContent = t; }

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// 由 tick 即時聚合「形成中」的 1 分 K
let curBar = null;   // {time, open, high, low, close, vol}

function applyTick(t) {
  const barTime = t.time - (t.time % 60);   // 分鐘 floor
  if (!curBar || barTime !== curBar.time) {
    // 進入新的一分鐘 → 開新棒
    curBar = { time: barTime, open: t.price, high: t.price,
               low: t.price, close: t.price, vol: t.volume };
  } else {
    curBar.high = Math.max(curBar.high, t.price);
    curBar.low = Math.min(curBar.low, t.price);
    curBar.close = t.price;
    curBar.vol += t.volume;
  }
  candleSeries.update({ time: curBar.time, open: curBar.open,
    high: curBar.high, low: curBar.low, close: curBar.close });
  volumeSeries.update({ time: curBar.time, value: curBar.vol,
    color: curBar.close >= curBar.open ? "#ef535055" : "#26a69a55" });

  lastPrice = t.price;
  refreshPnl();
}

function startReplay(product, date) {
  if (ws) ws.close();
  candleSeries.setData([]);
  volumeSeries.setData([]);
  received = 0; total = 0; playing = false; curBar = null;
  playBtn.textContent = "▶ 播放";

  pointValue = POINT_VALUE[product] || 200;
  ptNote.textContent = `${product}　每點 ${pointValue} 元 / 口`;
  resetTrades();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/replay/${product}/${date}`);

  ws.onopen = () => {
    setStatus("已連線，按播放開始");
    send({ cmd: "speed", value: SPEEDS[speedIdx] });   // 同步初始速度給後端
  };
  ws.onclose = () => setStatus("連線關閉");
  ws.onerror = () => setStatus("連線錯誤");
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "meta") {
      total = m.total;
      setStatus(`${m.date} ${m.product}　共 ${total.toLocaleString()} 筆 tick`);
    } else if (m.type === "tick") {
      applyTick(m.data);
      received++;
      if (received % 50 === 0 || received === total) {
        const px = m.data.price;
        setStatus(`${received.toLocaleString()} / ${total.toLocaleString()} 筆　現價 ${px}`);
      }
    } else if (m.type === "end") {
      setStatus(`回放結束（${received.toLocaleString()} 筆 tick）`);
      playing = false; playBtn.textContent = "▶ 播放";
    } else if (m.type === "error") {
      setStatus("錯誤：" + m.msg);
    }
  };
}

// ---- 控制 ----
playBtn.onclick = () => {
  playing = !playing;
  send({ cmd: playing ? "play" : "pause" });
  playBtn.textContent = playing ? "⏸ 暫停" : "▶ 播放";
};
stepBtn.onclick = () => send({ cmd: "step" });

// 速度檔位（加減按鈕在其間切換）
const SPEEDS = [1, 2, 5, 10, 20, 30, 60, 120, 240];
let speedIdx = 0;   // 預設 1x 真實

function applySpeed() {
  const v = SPEEDS[speedIdx];
  speedVal.textContent = v === 1 ? "1x 真實" : v + "x";
  send({ cmd: "speed", value: v });
}
speedDown.onclick = () => { if (speedIdx > 0) { speedIdx--; applySpeed(); } };
speedUp.onclick = () => { if (speedIdx < SPEEDS.length - 1) { speedIdx++; applySpeed(); } };
realBtn.onclick = () => { speedIdx = 0; applySpeed(); };   // 一鍵切真實時間
// ---- 模擬下單 / 損益 ----
const POINT_VALUE = { TX: 200, MTX: 50 };   // 每點新台幣 / 口（大台 200、小台 50）
let pointValue = 200;
let lastPrice = null;
let pos = { qty: 0, avg: 0 };   // qty>0 多單、<0 空單；avg 進場均價
let realized = 0;               // 已實現損益（NT$）

function resetTrades() {
  lastPrice = null;
  pos = { qty: 0, avg: 0 };
  realized = 0;
  refreshPnl();
}

// delta：帶正負號的口數（買進 +1、賣出 −1、平倉 −pos.qty）
function trade(delta) {
  if (lastPrice == null || delta === 0) return;
  const price = lastPrice;
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
    // 同方向加碼 → 重算加權均價
    const newQty = pos.qty + delta;
    pos.avg = (pos.avg * Math.abs(pos.qty) + price * Math.abs(delta)) / Math.abs(newQty);
    pos.qty = newQty;
  } else {
    // 反向 → 先就重疊部分實現損益，必要時反手
    const closeQty = Math.min(Math.abs(delta), Math.abs(pos.qty));
    realized += (price - pos.avg) * Math.sign(pos.qty) * closeQty * pointValue;
    pos.qty += delta;
    if (pos.qty === 0) pos.avg = 0;
    else if (Math.sign(pos.qty) === Math.sign(delta)) pos.avg = price;  // 反手後新均價
  }
  refreshPnl();
}

function flatten() { if (pos.qty !== 0) trade(-pos.qty); }

function fmtNT(v) {
  const s = Math.round(v).toLocaleString();
  return v > 0 ? "+" + s : s;
}
function pnlClass(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }

function refreshPnl() {
  pxVal.textContent = lastPrice == null ? "—" : lastPrice;
  if (pos.qty === 0) {
    posVal.textContent = "無"; posVal.className = "";
  } else {
    posVal.textContent = `${pos.qty > 0 ? "多" : "空"} ${Math.abs(pos.qty)} 口 @ ${Math.round(pos.avg)}`;
    posVal.className = pos.qty > 0 ? "up" : "down";
  }
  const upl = (lastPrice != null && pos.qty !== 0)
    ? (lastPrice - pos.avg) * pos.qty * pointValue : 0;
  const tot = realized + upl;
  uplVal.textContent = fmtNT(upl); uplVal.className = pnlClass(upl);
  rplVal.textContent = fmtNT(realized); rplVal.className = pnlClass(realized);
  totVal.textContent = fmtNT(tot); totVal.className = pnlClass(tot);
}

buyBtn.onclick = () => trade(+1);
sellBtn.onclick = () => trade(-1);
flatBtn.onclick = () => flatten();

// 鍵盤：B 買、S 賣、F 平倉、空白鍵 播放/暫停
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "b") trade(+1);
  else if (k === "s") trade(-1);
  else if (k === "f") flatten();
  else if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
});

dateSel.onchange = () => {
  const [product, date] = dateSel.value.split("|");
  startReplay(product, date);
};

// ---- 初始化：載入可回放交易日 ----
fetch("/api/dates").then(r => r.json()).then(list => {
  if (!list.length) { setStatus("data/bars 尚無資料，請先跑 build_bars"); return; }
  dateSel.innerHTML = "";
  for (const d of list) {
    const opt = document.createElement("option");
    opt.value = `${d.product}|${d.date}`;
    opt.textContent = `${d.product}　${d.date}`;
    dateSel.appendChild(opt);
  }
  const [product, date] = dateSel.value.split("|");
  startReplay(product, date);
});
