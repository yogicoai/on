import store from '@/lib/store';

/**
 * 대시보드 월 목표 — 사람이 직접 입력한 값.
 *
 * dash 는 DB 가 없어 그동안 브라우저 localStorage 에 담았다. 그러면 입력한
 * 사람 화면에만 남고 다른 사람은 원천 기본값을 봐서, 같은 회의에서 서로 다른
 * 달성률을 보게 된다. 여기(Mongo)에 두면 누가 보든 같은 값이다.
 *
 * 인증은 export 와 같은 EXPORT_TOKEN 을 쓴다 — 서버끼리만 주고받는 값이고
 * dash 가 이미 그 토큰을 가지고 있다.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLL = ['dash', 'targets'];

function denied(request) {
  const tok = String(process.env.EXPORT_TOKEN || '').trim();
  if (!tok) return false; // 토큰 미설정이면 검사하지 않는다(로컬 개발)
  const got = String(request.headers.get('authorization') || '').trim().replace(/^Bearer\s+/i, '').trim();
  return got !== tok;
}

export async function GET(request) {
  if (denied(request)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const month = new URL(request.url).searchParams.get('month');
  try {
    const c = await store.namedCollection(...COLL);
    const doc = month ? await c.findOne({ _id: month }) : null;
    return Response.json({ ok: true, month, targets: doc ? { offline: doc.offline, online: doc.online } : null });
  } catch (err) {
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(request) {
  if (denied(request)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }

  const month = String(body?.month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return Response.json({ ok: false, error: 'month 형식은 YYYY-MM' }, { status: 400 });
  }

  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^0-9]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const offline = num(body.offline);
  const online = num(body.online);

  try {
    const c = await store.namedCollection(...COLL);
    // 둘 다 비우면 지운다 — "기본값으로 되돌리기"가 그 뜻이다
    if (offline == null && online == null) {
      await c.deleteOne({ _id: month });
      return Response.json({ ok: true, month, targets: null });
    }
    const doc = { offline, online, updatedAt: new Date().toISOString() };
    await c.updateOne({ _id: month }, { $set: doc }, { upsert: true });
    return Response.json({ ok: true, month, targets: { offline, online } });
  } catch (err) {
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
