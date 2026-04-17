const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// 6 Rotating API Keys
const API_KEYS = [
  "8f4d4ab53ce348149ab625eee0b87e89",
  "79ac23f931784c85bf93723c61cade7e",
  "87c923ca5b204d32b42bb593dd9d6653",
  "8efcba6a8afe4507ace45d35ec551957",
  "1812221393744d7ebe92132da98c54a0",
  "24b4e2201438436895132596941b9dd6"
];
let keyIndex = 0;
function getKey() {
  const key = API_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % API_KEYS.length;
  return key;
}

const PAIRS = [
  "EUR/USD","GBP/USD","USD/JPY","XAU/USD",
  "WTI/USD","XAG/USD","AUD/USD","USD/CHF"
];

let cachedPrices = {};
let cachedCandles = {};
let signalHistory = [];
let activeSignals = {};
let lastFetch = null;

// ── Signal Engine
function calcEMA(data, period) {
  if(data.length<period)return[];
  const k=2/(period+1);
  let ema=data.slice(0,period).reduce((a,b)=>a+b,0)/period;
  const r=[ema];
  for(let i=period;i<data.length;i++){ema=data[i]*k+ema*(1-k);r.push(ema);}
  return r;
}
function calcRSI(closes,period=14){
  if(closes.length<period+1)return null;
  let g=0,l=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/period,al=l/period;
  for(let i=period+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;
  return 100-100/(1+ag/al);
}
function calcMACD(closes){
  if(closes.length<26)return null;
  const e12=calcEMA(closes,12),e26=calcEMA(closes,26);
  const off=e12.length-e26.length;
  const ml=e26.map((v,i)=>e12[i+off]-v);
  const sig=calcEMA(ml,9);
  const hist=ml.slice(ml.length-sig.length).map((v,i)=>v-sig[i]);
  return{histogram:hist[hist.length-1],prevHist:hist[hist.length-2]||0};
}
function calcBB(closes,period=20){
  if(closes.length<period)return null;
  const sl=closes.slice(-period);
  const mean=sl.reduce((a,b)=>a+b,0)/period;
  const std=Math.sqrt(sl.reduce((a,b)=>a+(b-mean)**2,0)/period);
  return{upper:mean+2*std,middle:mean,lower:mean-2*std};
}
function calcStoch(closes,highs,lows,period=14){
  if(closes.length<period)return null;
  const sc=closes.slice(-period),sh=highs.slice(-period),sl=lows.slice(-period);
  const hh=Math.max(...sh),ll=Math.min(...sl);
  if(hh===ll)return null;
  return((sc[sc.length-1]-ll)/(hh-ll))*100;
}
function calcATR(closes,highs,lows,period=14){
  if(closes.length<period+1)return null;
  const trs=[];
  for(let i=1;i<closes.length;i++){trs.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));}
  return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
}

function generateSignal(candles, pair) {
  if(!candles||candles.length<50)return null;
  const closes=candles.map(c=>c.close);
  const highs=candles.map(c=>c.high);
  const lows=candles.map(c=>c.low);
  const price=closes[closes.length-1];
  const rsi=calcRSI(closes,14);
  const ema9=calcEMA(closes,9),ema21=calcEMA(closes,21),ema50=calcEMA(closes,50);
  const e9=ema9[ema9.length-1],e21=ema21[ema21.length-1],e50=ema50[ema50.length-1];
  const macd=calcMACD(closes);
  const bb=calcBB(closes,20);
  const stoch=calcStoch(closes,highs,lows,14);
  const atr=calcATR(closes,highs,lows,14);
  if(!rsi||!macd||!bb||!atr)return null;
  let bull=0,bear=0;
  const reasons=[];
  if(rsi<30){bull+=3;reasons.push(`RSI oversold (${rsi.toFixed(1)})`);}
  else if(rsi<45){bull+=1;}
  if(rsi>70){bear+=3;reasons.push(`RSI overbought (${rsi.toFixed(1)})`);}
  else if(rsi>55){bear+=1;}
  if(e9>e21&&e21>e50){bull+=2;reasons.push("EMA bullish (9>21>50)");}
  if(e9<e21&&e21<e50){bear+=2;reasons.push("EMA bearish (9<21<50)");}
  if(price>e50)bull+=1;else bear+=1;
  if(macd.histogram>0&&macd.prevHist<=0){bull+=4;reasons.push("MACD bullish crossover ✨");}
  else if(macd.histogram>0)bull+=1;
  if(macd.histogram<0&&macd.prevHist>=0){bear+=4;reasons.push("MACD bearish crossover ✨");}
  else if(macd.histogram<0)bear+=1;
  if(price<=bb.lower){bull+=3;reasons.push("Below lower Bollinger Band");}
  if(price>=bb.upper){bear+=3;reasons.push("Above upper Bollinger Band");}
  if(stoch!==null){
    if(stoch<20){bull+=2;reasons.push(`Stoch oversold (${stoch.toFixed(1)})`);}
    if(stoch>80){bear+=2;reasons.push(`Stoch overbought (${stoch.toFixed(1)})`);}
  }
  const total=bull+bear;
  const conf=Math.round((Math.max(bull,bear)/Math.max(total,1))*100);
  if(bull<8&&bear<8)return null;
  if(Math.abs(bull-bear)<4)return null;
  if(conf<65)return null;
  const type=bull>bear?"BUY":"SELL";
  const dir=type==="BUY"?1:-1;
  const dec=pair.includes("JPY")?3:pair.includes("XAU")||pair.includes("WTI")||pair.includes("XAG")?2:5;
  const f=n=>parseFloat(n.toFixed(dec));
  return{
    type, confidence:Math.min(conf,94),
    entry:f(price),
    sl:f(price-dir*atr*1.5),
    tp1:f(price+dir*atr*1.5),
    tp2:f(price+dir*atr*3),
    tp3:f(price+dir*atr*5),
    atr:f(atr), reasons, bull, bear
  };
}

// ── Check if active signals hit TP or SL
function checkActiveSignals() {
  for(const [id, signal] of Object.entries(activeSignals)) {
    const currentPrice = cachedPrices[signal.pair];
    if(!currentPrice) continue;
    const p = parseFloat(currentPrice);
    const isBuy = signal.type === "BUY";
    let status = "running";
    let closedAt = null;
    let pips = 0;
    const pipSize = signal.pair.includes("JPY") ? 0.01 : signal.pair.includes("XAU") || signal.pair.includes("WTI") ? 0.1 : 0.0001;

    if(isBuy) {
      if(p <= signal.sl) { status="stopped"; closedAt=p; pips=Math.round((p-signal.entry)/pipSize); }
      else if(p >= signal.tp3) { status="tp3_hit"; closedAt=p; pips=Math.round((p-signal.entry)/pipSize); }
      else if(p >= signal.tp2) { status="tp2_hit"; closedAt=p; pips=Math.round((p-signal.entry)/pipSize); }
      else if(p >= signal.tp1) { status="tp1_hit"; }
    } else {
      if(p >= signal.sl) { status="stopped"; closedAt=p; pips=Math.round((signal.entry-p)/pipSize); }
      else if(p <= signal.tp3) { status="tp3_hit"; closedAt=p; pips=Math.round((signal.entry-p)/pipSize); }
      else if(p <= signal.tp2) { status="tp2_hit"; closedAt=p; pips=Math.round((signal.entry-p)/pipSize); }
      else if(p <= signal.tp1) { status="tp1_hit"; }
    }

    // Update signal status
    activeSignals[id].status = status;
    activeSignals[id].currentPrice = p;
    activeSignals[id].pips = isBuy ? Math.round((p-signal.entry)/pipSize) : Math.round((signal.entry-p)/pipSize);

    // If closed, move to history
    if(status === "stopped" || status === "tp3_hit" || status === "tp2_hit") {
      activeSignals[id].closedAt = closedAt;
      activeSignals[id].closedTime = new Date().toISOString();
      signalHistory.unshift({ ...activeSignals[id] });
      if(signalHistory.length > 50) signalHistory = signalHistory.slice(0, 50);
      delete activeSignals[id];
    }
  }
}

// ── Main data fetch and signal generation
async function fetchAllData() {
  try {
    const fetch = (await import("node-fetch")).default;

    // Fetch live prices
    const syms = PAIRS.join(",");
    const priceRes = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(syms)}&apikey=${getKey()}`);
    const priceData = await priceRes.json();
    for(const pair of PAIRS) {
      if(priceData[pair]?.price) cachedPrices[pair] = parseFloat(priceData[pair].price);
    }

    // Fetch candles for each pair
    for(const pair of PAIRS) {
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=1h&outputsize=100&apikey=${getKey()}`;
      const res = await fetch(url);
      const data = await res.json();
      if(data.values) {
        cachedCandles[pair] = data.values.reverse().map(v=>({
          open:parseFloat(v.open), high:parseFloat(v.high),
          low:parseFloat(v.low), close:parseFloat(v.close),
          datetime:v.datetime
        }));
      }
      await new Promise(r=>setTimeout(r,300));
    }

    lastFetch = new Date().toISOString();

    // Generate signals automatically
    for(const pair of PAIRS) {
      const candles = cachedCandles[pair];
      if(!candles||candles.length<50) continue;
      const sig = generateSignal(candles, pair);
      if(sig) {
        const id = `${pair}-${Date.now()}`;
        // Only add if no active signal for this pair
        const hasActive = Object.values(activeSignals).some(s=>s.pair===pair);
        if(!hasActive) {
          activeSignals[id] = {
            id, pair, ...sig,
            status: "running",
            openTime: new Date().toISOString(),
            currentPrice: cachedPrices[pair] || sig.entry,
            pips: 0
          };
          console.log(`New signal: ${pair} ${sig.type} @ ${sig.entry}`);
        }
      }
    }

    // Check active signals for TP/SL hits
    checkActiveSignals();

    console.log(`Fetched at ${lastFetch} | Active: ${Object.keys(activeSignals).length} | History: ${signalHistory.length}`);
  } catch(e) {
    console.error("Fetch error:", e.message);
  }
}

// Fetch every 5 minutes
fetchAllData();
setInterval(fetchAllData, 5 * 60 * 1000);

// ── API Endpoints
app.get("/prices", (req,res) => res.json({ prices:cachedPrices, lastFetch }));
app.get("/candles/:pair", (req,res) => res.json({ candles:cachedCandles[decodeURIComponent(req.params.pair)]||[], lastFetch }));
app.get("/signals", (req,res) => res.json({ active:Object.values(activeSignals), history:signalHistory, lastFetch }));
app.get("/health", (req,res) => res.json({ status:"ok", lastFetch, prices:Object.keys(cachedPrices).length, active:Object.keys(activeSignals).length, history:signalHistory.length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));