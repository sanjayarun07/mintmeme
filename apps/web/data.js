// ILLUSTRATIVE DATA ONLY. Nothing here is a real token, price, wallet or channel.
// Sample tokens carry no contract address on purpose, and cannot be traded.
// Only the four "Practice network" tokens (served by the local simulator) are tradable.
const CHAINS={
  practice:{name:'Practice network',color:'#2fcb73'},
  solana:{name:'Solana',color:'#9b7bff'},
  ethereum:{name:'Ethereum',color:'#8d9bd6'},
  base:{name:'Base',color:'#8fb4ff'},
  bnb:{name:'BNB',color:'#e9ae45'},
};
const LAUNCHPADS={
  'sample-curve':{name:'Sample bonding-curve pad',graduation:true,rule:'Graduates to a DEX pool when the curve is fully sold. The rule is public on-chain.'},
  'sample-fair':{name:'Sample fair-launch pad',graduation:true,rule:'Graduates after a fixed raise target is met.'},
  'pump-fun':{name:'Pump.fun',graduation:true,rule:'When the curve completes, liquidity moves to PumpSwap and the LP tokens are burned. The market-cap threshold is not published, so no progress bar is shown.'},
  'four-meme':{name:'Four.meme',graduation:true,rule:'At 100% of the raise target, liquidity is paired on PancakeSwap. Read from the official Four.meme contract.'},
  'sample-open':{name:'Sample open pad',graduation:false,rule:'No verifiable graduation mechanism, so it is never shown under Approaching migration.'},
};
const F=(lvl,text,ago)=>({lvl,text,ago});
const SAMPLE_TOKENS=[
  {id:'s-nova',name:'Nova Cat',sym:'NOVA',chain:'solana',pad:'sample-curve',col:'new',tokenAge:2,poolAge:2,price:.00041,chg:86.4,liq:142e3,vol:398e3,mcap:410e3,fdv:410e3,act:310,color:'#8fb4ff',owner:'active',
    findings:[F('warn','Mint authority is still active',1)],tax:null},
  {id:'s-pepo',name:'Pepo Frog',sym:'PEPO',chain:'ethereum',pad:'sample-open',col:'new',tokenAge:4,poolAge:4,price:.0000021,chg:22.7,liq:1.28e6,vol:3.41e6,mcap:2.1e6,fdv:2.1e6,act:520,color:'#7bd88f',owner:'renounced',
    findings:[F('ok','Test buy and sell both worked',3)],tax:{buy:0,sell:0,ago:3}},
  {id:'s-orb',name:'Orbit',sym:'ORBT',chain:'base',pad:'sample-open',col:'new',tokenAge:6,poolAge:6,price:.0031,chg:-18.9,liq:267e3,vol:620e3,mcap:880e3,fdv:3.1e6,act:88,color:'#9aa6ff',owner:'unknown',
    findings:[F('warn','Price swung more than 15% in the last hour',1)],tax:{buy:2,sell:2,ago:6}},
  {id:'s-mogu',name:'Mogu',sym:'MOGU',chain:'solana',pad:'sample-curve',col:'near',tokenAge:18,poolAge:null,price:.00092,chg:41.2,liq:2.47e6,vol:9.83e6,mcap:9.1e6,fdv:9.1e6,act:880,color:'#f1a65a',owner:'active',migration:{pct:94},
    findings:[F('info','Curve is 94% sold. Graduation happens at 100%.',1)],tax:null},
  {id:'s-mochi',name:'Mochi',sym:'MOCHI',chain:'base',pad:'sample-fair',col:'near',tokenAge:23,poolAge:23,price:.008103,chg:67.3,liq:3.91e6,vol:12.7e6,mcap:8.1e6,fdv:8.1e6,act:1204,color:'#f3c6d4',owner:'pause',migration:{pct:81},
    findings:[F('warn','Owner can pause transfers',4)],tax:{buy:0,sell:0,ago:4}},
  {id:'s-wisp',name:'Wisp',sym:'WISP',chain:'ethereum',pad:'sample-fair',col:'near',tokenAge:27,poolAge:27,price:.0152,chg:12.6,liq:768e3,vol:2.18e6,mcap:3.4e6,fdv:5.6e6,act:140,color:'#b49bff',owner:'renounced',migration:{pct:63},
    findings:[F('ok','Measured tax 0% buy, 0% sell',9)],tax:{buy:0,sell:0,ago:9}},
  {id:'s-froge',name:'Froge Two',sym:'FROGE',chain:'bnb',pad:'sample-open',col:'active',tokenAge:180,poolAge:180,price:.0000074,chg:5.4,liq:8.21e6,vol:24.6e6,mcap:12e6,fdv:12e6,act:2300,color:'#6ccf6c',owner:'renounced',
    findings:[F('ok','Ownership renounced',30)],tax:{buy:0,sell:0,ago:30}},
  {id:'s-bonky',name:'Bonky',sym:'BONKY',chain:'solana',pad:'sample-curve',col:'active',tokenAge:360,poolAge:360,price:.0000189,chg:-3.1,liq:12.9e6,vol:38.1e6,mcap:25e6,fdv:25e6,act:3100,color:'#f0b25e',owner:'renounced',
    findings:[F('ok','Ownership renounced',12)],tax:{buy:0,sell:0,ago:12}},
  {id:'s-wifi',name:'Wiffle',sym:'WFL',chain:'ethereum',pad:'sample-open',col:'active',tokenAge:540,poolAge:540,price:.9,chg:2.9,liq:15.8e6,vol:41.2e6,mcap:900e6,fdv:900e6,act:1800,color:'#d98f8f',owner:'renounced',
    findings:[F('ok','No transfer tax measured',20)],tax:{buy:0,sell:0,ago:20}},
];
// Real practice tokens get their data from the simulator; these fields describe how to show them.
const PRACTICE_META={'0xMEME':{col:'active',color:'#2fcb73'},'0xTAX':{col:'active',color:'#e9ae45'},'0xHONEY':{col:'active',color:'#f0675f'},'0xFRESH':{col:'new',color:'#8fb4ff'}};
const SAMPLE_SOURCES=[
  {id:'src1',name:'Sample alpha channel',kind:'Telegram channel',mode:'preview',preset:'Contracts only',last:'2 min ago'},
  {id:'src2',name:'Sample launch alerts',kind:'Telegram channel',mode:'preview',preset:'New launches',last:'11 min ago'},
  {id:'src3',name:'Sample whale watch',kind:'Telegram group',mode:'preview',preset:'Large buys',last:'1 h ago'},
];
const SAMPLE_SNIPES=[
  {id:'sn1',col:'scheduled',name:'Launch watch A',wallets:['Main wallet'],max:20000,liq:'Pool at least 50,000',sim:null,exit:'Take profit +100%, stop loss -30%',event:null},
  {id:'sn2',col:'watching',name:'Launch watch B',wallets:['Main wallet','Second wallet'],max:10000,liq:'Pool at least 25,000',sim:'Checked 4 min ago',exit:'Stop loss -25%',event:null},
  {id:'sn3',col:'ready',name:'Launch watch C',wallets:['Second wallet'],max:5000,liq:'Pool at least 10,000',sim:'Checked 40 s ago',exit:'None set',event:'detected'},
  {id:'sn4',col:'submitted',name:'Launch watch D',wallets:['Main wallet'],max:5000,liq:'Pool at least 10,000',sim:'Checked 2 min ago',exit:'Trailing stop 20%',event:'submitted'},
  {id:'sn5',col:'completed',name:'Launch watch E',wallets:['Main wallet'],max:5000,liq:'Pool at least 10,000',sim:'Checked 1 h ago',exit:'Take profit +50%',event:'confirmed'},
  {id:'sn6',col:'failed',name:'Launch watch F',wallets:['Second wallet'],max:5000,liq:'Pool at least 10,000',sim:'Checked 3 h ago',exit:'None set',event:'failed',why:'Stopped before sending: the simulated sale was blocked by the token. Nothing was spent.'},
];
