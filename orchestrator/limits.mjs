// 구독 사용량 한도 감지와 대기.
// 구독(Pro/Max)은 5시간 창 + 주간 한도가 있다. 한도에 닿으면 추가 요금 대신
// "잠시 멈춤"이 정답이므로, 메시지에서 리셋 시각을 파싱해 그때까지 기다린다.

const LIMIT_RE = /hit your (session|usage|5-hour|weekly) limit|rate limit|usage limit reached/i;

export function isLimitMessage(text) {
  return LIMIT_RE.test(text || '');
}

// "resets 11:50am" / "resets at 3pm" 형태에서 다음 리셋 시각까지의 ms를 계산.
// 파싱 실패 시 null을 반환하고, 호출 측이 기본 대기 시간을 쓴다.
export function msUntilReset(text, now = new Date()) {
  const m = /resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text || '');
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (m[3].toLowerCase() === 'pm') hour += 12;
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  if (reset <= now) reset.setDate(reset.getDate() + 1); // 이미 지난 시각이면 다음 날
  return reset.getTime() - now.getTime() + 60_000; // 여유 1분
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_WAIT_MS = 35 * 60_000; // 리셋 시각 파싱 실패 시 35분 대기
