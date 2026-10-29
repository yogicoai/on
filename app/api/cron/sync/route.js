/**
 * 예약 수집 — Vercel Cron 이 부른다.
 *
 * 지금까지 자사몰·스마트스토어 수집은 사람이 화면에서 "동기화"를 눌러야만 돌았다.
 * 그래서 아무도 안 본 시간대에는 금액이 그대로 멈춰 있었고, 아침에 처음 연 사람이
 * 낡은 숫자를 봤다. 보는 사람과 상관없이 도는 게 맞다.
 *
 * 여기서는 판단만 하고 실제 수집은 기존 엔드포인트를 그대로 부른다 —
 * 수집 로직을 두 벌로 만들지 않기 위해서다.
 *
 * ⚠ 일정은 vercel.json 에 있고 지금은 하루 한 번(KST 08시)이다.
 *   Vercel 무료(Hobby) 요금제가 크론을 하루 1회로 제한하기 때문이지, 그게
 *   충분해서가 아니다. 낮 동안의 최신화는 dash 가 페이지를 열 때 부르는
 *   /api/auto-sync 가 맡는다. 이 크론은 아무도 안 보는 밤사이에 밀린 것을
 *   아침 전에 따라잡는 역할이다 — 특히 스마트스토어는 한 번 밀리면
 *   조용히 0원으로 보이므로 이게 필요하다.
 *
 *   10분 간격이 필요해지면 두 가지 길이 있다.
 *     · Vercel Pro 로 올리고 schedule 을 "*​/10 * * * *" 로
 *     · 또는 바깥 스케줄러(GitHub Actions 등)로 이 주소를 때리기
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const todayKST = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const hourKST = () =>
  Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }));

async function hit(origin, path, ms) {
  const started = Date.now();
  try {
    const res = await fetch(new URL(path, origin), {
      cache: 'no-store',
      signal: AbortSignal.timeout(ms),
    });
    return { path, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { path, ok: false, error: String(err?.message || err), ms: Date.now() - started };
  }
}

export async function GET(request) {
  // Vercel Cron 은 CRON_SECRET 이 설정돼 있으면 Bearer 로 보낸다.
  // 설정 전에도 동작하도록, 값이 있을 때만 검사한다.
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: '인증 필요' }, { status: 401 });
  }

  const origin = new URL(request.url).origin;
  const hour = hourKST();
  const ran = [];

  // 자사몰 — 당일 매출이 계속 쌓이므로 매번.
  // 새벽에는 주문이 거의 없어 건너뛴다(불필요한 API 호출과 비용을 줄인다).
  if (hour >= 7 && hour <= 23) {
    ran.push(await hit(origin, '/api/refresh-today', 55_000));
  }

  // 스마트스토어 — 반영이 뒤처졌을 때만. 이미 오늘까지 들어와 있으면 돌릴 이유가 없다.
  let smartstore = { path: '/api/smartstore/sync-week', skipped: '이미 최신' };
  try {
    const res = await fetch(new URL('/api/smartstore/status', origin), {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const status = await res.json();
    const to = status?.meta?.to || null;
    if (!to || to < todayKST()) {
      smartstore = await hit(origin, '/api/smartstore/sync-week', 55_000);
    }
  } catch (err) {
    // 상태를 못 읽으면 판단할 수 없다 — 돌리지 않고 다음 차례에 다시 본다
    smartstore = { path: '/api/smartstore/status', ok: false, error: String(err?.message || err) };
  }
  ran.push(smartstore);

  return Response.json(
    { ok: true, at: new Date().toISOString(), hourKST: hour, ran },
    { headers: { 'cache-control': 'no-store' } },
  );
}
