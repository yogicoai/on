'use strict';

// 의존성 없는 최소 .env 로더. 프로젝트 루트의 .env 를 한 번만 읽어 process.env 에 주입.
const fs = require('fs');
const path = require('path');

let _loaded = false;

function loadEnv() {
  if (_loaded) return;
  _loaded = true;
  const file = path.join(__dirname, '..', '.env');
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // dotenv-expand(Next.js) 호환: 이스케이프된 \$ 를 리터럴 $ 로 되돌린다.
    // (bcrypt salt 같은 $ 포함 값을 Next.js가 변수 확장으로 깨뜨리지 않게 .env 에선 \$ 로 저장)
    val = val.replace(/\\\$/g, '$');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

module.exports = { loadEnv };
