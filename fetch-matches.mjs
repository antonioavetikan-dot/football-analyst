/**
 * fetch-matches.mjs
 * Раз в день тянет матчи дня с football-data.org, считает прогнозы
 * тем же движком, что и на сайте, и пишет ../data/matches.json.
 *
 * Запуск локально:   FOOTBALL_API_KEY=ваш_ключ node scripts/fetch-matches.mjs
 * В GitHub Actions ключ берётся из секрета FOOTBALL_API_KEY (см. workflow).
 *
 * Нужен Node 18+ (есть встроенный fetch). Бесплатный ключ: https://www.football-data.org/client/register
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../data/matches.json');
const KEY = process.env.FOOTBALL_API_KEY;

/* Лиги бесплатного тарифа football-data.org -> русские названия + флаг */
const COMP = {
  PL:  { name: 'Премьер-лига',     country: '🏴' },
  PD:  { name: 'Ла Лига',          country: '🇪🇸' },
  BL1: { name: 'Бундеслига',       country: '🇩🇪' },
  SA:  { name: 'Серия А',          country: '🇮🇹' },
  FL1: { name: 'Лига 1',           country: '🇫🇷' },
  CL:  { name: 'Лига чемпионов',   country: '⭐' },
  DED: { name: 'Эредивизи',        country: '🇳🇱' },
  PPL: { name: 'Примейра',         country: '🇵🇹' },
  ELC: { name: 'Чемпионшип',       country: '🏴' },
  BSA: { name: 'Серия А (Бразилия)', country: '🇧🇷' },
};

/* ---------- ДВИЖОК (держать в синхроне с index.html) ---------- */
function formPoints(f){ if(!f||!f.length) return .5; const m={W:3,D:1,L:0};
  return f.reduce((s,r)=>s+(m[r]??1),0)/(f.length*3); }
function analyze(t){
  const HOME_ADV=1.08, AWAY_PEN=0.94;
  const xgH=+(((t.home.gf+t.away.ga)/2)*HOME_ADV).toFixed(2);
  const xgA=+(((t.away.gf+t.home.ga)/2)*AWAY_PEN).toFixed(2);
  const fH=formPoints(t.home.form), fA=formPoints(t.away.form);
  const h=t.h2h||{played:0,homeWins:0,draws:0,awayWins:0};
  const h2hLean=h.played?(h.homeWins-h.awayWins)/h.played:0;
  const edge=(xgH-xgA)+(fH-fA)*0.9+h2hLean*0.5;
  const a=Math.abs(edge);
  let result = edge>0.45?'П1 (победа хозяев)':edge<-0.45?'П2 (победа гостей)':'Двойной шанс / ничья';
  const rConf=Math.round(Math.min(82,50+a*26));
  const total=xgH+xgA; let tg,tgConf;
  if(total>=3.0){tg='Тотал больше 2.5';tgConf=Math.round(Math.min(80,55+(total-3.0)*22));}
  else if(total<=2.1){tg='Тотал меньше 2.5';tgConf=Math.round(Math.min(80,55+(2.1-total)*30));}
  else if(total<=1.6){tg='Тотал меньше 1.5';tgConf=Math.round(Math.min(82,60+(1.6-total)*28));}
  else{tg=total>=2.55?'Тотал больше 2.5':'Тотал меньше 3.5';tgConf=Math.round(52+Math.abs(total-2.5)*16);}
  const bttsYes=(xgH>=1.05&&xgA>=1.05);
  const btts=bttsYes?'Обе забьют: Да':'Обе забьют: Нет';
  const bConf=Math.round(bttsYes?Math.min(80,52+(Math.min(xgH,xgA)-1.0)*40):Math.min(80,52+(1.05-Math.min(xgH,xgA))*45));
  const corners=(t.home.corners+t.away.corners)*0.96;
  const cLine=Math.floor(corners)-0.5;
  const cPick=`Угловые больше ${cLine.toFixed(1)}`;
  const cConf=Math.round(Math.min(78,54+Math.max(0,(corners-cLine-1))*9));
  const best=Math.max(rConf,tgConf,bConf,cConf);
  const risk=best>=70?'low':best>=60?'medium':'high';
  return {result,rConf,tg,tgConf,btts,bConf,corners:cPick,cConf,risk,confidence:best,xgH,xgA};
}

/* ---------- Хелперы запросов ---------- */
const BASE='https://api.football-data.org/v4';
async function api(path){
  const r=await fetch(BASE+path,{headers:{'X-Auth-Token':KEY}});
  if(!r.ok) throw new Error(`API ${r.status} на ${path}`);
  return r.json();
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); // free tier: 10 запросов/мин

/** последние 5 результатов команды (W/D/L) с её точки зрения */
async function lastForm(teamId){
  try{
    const d=await api(`/teams/${teamId}/matches?status=FINISHED&limit=5`);
    return (d.matches||[]).map(m=>{
      const home=m.homeTeam.id===teamId;
      const gf=home?m.score.fullTime.home:m.score.fullTime.away;
      const ga=home?m.score.fullTime.away:m.score.fullTime.home;
      return gf>ga?'W':gf<ga?'L':'D';
    }).reverse();
  }catch{ return ['D','D','D','D','D']; }
}

async function main(){
  if(!KEY){ console.error('Нет FOOTBALL_API_KEY — пишу демо-набор.'); return fallback(); }
  const today=new Date().toISOString().slice(0,10);
  const codes=Object.keys(COMP).join(',');
  let data;
  try{
    data=await api(`/matches?competitions=${codes}&dateFrom=${today}&dateTo=${today}`);
  }catch(e){ console.error(e.message); return fallback(); }

  const out=[];
  for(const m of (data.matches||[])){
    const c=COMP[m.competition.code]||{name:m.competition.name,country:'⚽'};
    await sleep(7000); const fH=await lastForm(m.homeTeam.id);
    await sleep(7000); const fA=await lastForm(m.awayTeam.id);
    // средние голы/угловые бесплатный тариф не отдаёт детально -> оцениваем из формы (заглушка)
    const est=f=>1.0+formPoints(f)*1.4;
    const t={
      id:m.id,
      league:c.name, country:c.country, code:m.competition.code,
      kickoff:new Date(m.utcDate).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}),
      home:{name:m.homeTeam.shortName||m.homeTeam.name, form:fH, gf:+est(fH).toFixed(2), ga:+(2.4-est(fH)).toFixed(2), corners:5.2},
      away:{name:m.awayTeam.shortName||m.awayTeam.name, form:fA, gf:+est(fA).toFixed(2), ga:+(2.4-est(fA)).toFixed(2), corners:4.8},
      h2h:{played:0,homeWins:0,draws:0,awayWins:0}
    };
    t.analysis=analyze(t);
    out.push(t);
  }

  await save(out, `football-data.org · ${today}`);
}

async function save(matches, source){
  await mkdir(dirname(OUT),{recursive:true});
  const payload={updated:new Date().toLocaleString('ru-RU'),source,matches};
  await writeFile(OUT, JSON.stringify(payload,null,2),'utf8');
  console.log(`Записано ${matches.length} матчей -> ${OUT}`);
}

function fallback(){
  // если ключа нет / API недоступен — сайт сам подхватит встроенный демо-набор
  return save([], 'demo (fallback)');
}

main().catch(e=>{console.error(e);process.exit(1);});
