/**
 * One-shot: Send Korean-language Kennedy Access immigration & labor report.
 * Usage: node scripts/send-ka-report-kr.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env
try {
  const lines = readFileSync(join(ROOT, '.env'), 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      if (!process.env[key]) process.env[key] = trimmed.slice(eqIdx + 1);
    }
  }
} catch { /* no .env */ }

const { sendEmail } = await import('../dist/email.js');

const TO = process.argv[2] || 'banking-news@kennedyaccess.com';
const subject = 'Kennedy Access 일일 브리핑 — 이민 및 노동시장 보고서 — 2026년 3월 24일';

const text = `Kennedy Access 일일 브리핑 — 2026년 3월 24일
Immigration & Labor Market Intelligence (Korean Edition)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VISA BULLETIN — 2026년 4월호 (현재 월: 3월)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

카테고리            Final Action     Dates for Filing   비고
─────────────────  ─────────────   ────────────────   ──────────────────
EB-3 World         01-JUN-2024     ★ CURRENT ★        접수 가능일 CURRENT
EB-3 China         15-JUN-2021     01-JAN-2022
EB-3 India         15-NOV-2013     15-JAN-2015        12년+ 적체
EB-3 Mexico        01-JUN-2024     ★ CURRENT ★        접수 가능일 CURRENT
EB-3 Philippines   01-AUG-2023     01-JAN-2024

Other Workers WW   01-NOV-2021     01-AUG-2022
Other Workers CN   01-FEB-2019     01-OCT-2019
Other Workers IN   15-NOV-2013     15-JAN-2015
Other Workers MX   01-NOV-2021     01-AUG-2022
Other Workers PH   01-NOV-2021     01-AUG-2022

★ 핵심 변화: EB-3 World/Mexico의 Dates for Filing이 CURRENT로 전환
  해당 국가 신청자는 priority date에 관계없이 즉시 I-485 접수 가능
  USCIS가 4월에 Dates for Filing chart 적용 확인

★ 인도 EB-3: Dates for Filing 15-JAN-2015로 전진
  여전히 12년+ 적체이나, 소폭 전진 확인

⚠ H-2B Cap 현황: FY2026 하반기(Apr-Sep) 법정 한도 도달
  최종 접수일: 2026년 3월 10일
  Supplemental 64,716 추가 비자 승인:
  • 1차 배정 (Jan-Mar): 18,490석 — 2월 6일 한도 도달
  • 2차 배정 (Apr): 27,736석 — 3월 25일 접수 개시 (returning workers만)
  • 3차 배정 (May-Sep): 추후 접수 개시, 마감 9월 15일

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

처리 시간 — PROCESSING TIMES (2026년 3월 기준)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

양식         설명                        처리 시간           동향
────────    ───────────────────────    ─────────────────  ─────
I-140       Immigrant Petition          5–22개월            →
I-485       Adjustment of Status        11–31.5개월         →
I-765       EAD (취업 허가증)             2–7개월             ↓ 개선 중
PERM        Labor Certification         ~503일 (16.5개월)   →
PWD         Prevailing Wage Det.        ~4개월              ↓ 개선 중
I-129       H-2B Petition               변동                →

• PERM 심사 현황: DOL이 2024년 10월 이전 접수 건 심사 중
  감사(audit) 대상: 2025년 6월 이전 접수 건 심사 중
  재심(reconsideration): 2025년 9월 이전 접수 건 처리 중
  2025년 12월 접수 건만 10,700건 이상 대기 중

• Premium Processing (I-140): 15영업일 / $2,965
• PERM audit 비율: 접수 건의 약 30% (3-6개월 추가 소요)
• EB-3 전체 PERM 처리: 평균 2~2.5년 소요

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

주요 뉴스 — NEWS HEADLINES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

── EB-3 및 취업 기반 이민 ──

• 4월 Visa Bulletin: EB-3 대폭 전진
  EB-3 World/Mexico의 Dates for Filing이 CURRENT로 전환.
  EB-3 Skilled Workers가 Rest of World 기준 14개월 이상 전진.
  국무부는 Trump 행정부의 40+ 국가 travel ban 및 75개국
  비자 처리 중단으로 인한 영사 발급 감소를 원인으로 설명.

• 인도 EB-2/EB-3에 큰 안도 — 날짜 대폭 전진
  EB-2 India와 EB-3 India 모두 상당한 전진. 여전히 긴 대기이나
  최근 몇 년간 가장 큰 폭의 이동.

• PERM 처리 시간 16-17개월 유지
  DOL이 3월 5일 기준 처리 시간 업데이트. Prevailing wage
  determination은 약 4개월로 개선. Audit 비율 약 30% 유지.

── H-2B 및 임시 근로자 ──

• Trump 행정부, FY2026 H-2B 한도 2배 확대 — 64,716 추가 비자
  DHS/DOL이 FY2026 H-2B supplemental 비자 64,716석 추가.
  DOL은 162,603개 포지션을 요청하는 8,759건의 신청서 접수
  — 수요가 가용 비자의 약 2.5배.

• H-2B 하반기 법정 한도 도달
  USCIS가 Apr-Sep 기간 법정 한도 도달 확인.
  계절 근로자를 필요로 하는 고용주에게 심각한 제약.

• 2차 Supplemental 배정: 3월 25일 접수 개시
  27,736석, returning workers만 대상.

• EPI, H-2B의 연중 사용(year-round jobs) 확대에 경고
  Economic Policy Institute는 H-2B를 육류 가공 등 연중 직업으로
  확대하면 임금 하락 우려 — 대신 green card 경로를 주장.
  → EB-3 전략의 정당성을 직접적으로 뒷받침하는 논거.

── 이민 정책 및 단속 ──

• ICE 인력 120% 확대 — 12,000명 신규 채용 발표
  전례 없는 규모의 채용 캠페인. 1월 체포 건수만 전년 대비 40% 증가.
  2026년 8월까지 새 현장 사무소 개설 계획.
  DHS/ICE에 2029년까지 $170 billion 추가 예산 배정.

• 건설업체 28%가 이민 단속 영향 받아
  5%는 ICE가 현장 방문, 10%는 근로자 이탈,
  20%는 하도급 업체에서 인력 손실 경험.
  인력 파견 업체의 compliance 리스크 급증.

• Ohio E-Verify 의무화: 2026년 3월 19일 시행
  모든 비주거 건설 계약자는 신규 채용 시 E-Verify 필수.
  벌금: 초범 $250 ~ 재범 $1,500+.
  적용 대상: 사무실 건물, 고속도로, 교량, 유틸리티 등.

• South Dakota, 주 전체 E-Verify 의무화 법안 추진 중
  HB 1209가 하원 49-13으로 통과. 상원 통과 및 주지사 서명 대기 중.

• 필라델피아 gig economy 위축
  ICE 단속 우려로 이민 근로자들이 gig platform 기피.
  배달비 상승, 대기 시간 증가, rideshare 기사 감소.

── 노동시장 및 인력 수요 ──

• 2월 Jobs Report: 비농업 고용 92,000명 감소
  Temp help services 6,500개 포지션 감소.
  그러나 주간 staffing 근무 시간은 연초 대비 최고치
  — 수요 격차(divergence) 시사.

• 건설업, 2026년 349,000명의 신규 인력 필요
  전년보다 감소했으나 여전히 대규모 격차.
  건설 근로자 5명 중 1명이 55세 이상 — 은퇴 물결 임박.
  이민 단속으로 인한 임금 상승 압력 가중.

• 호텔/외식업 리더 91%: "채용이 여전히 어렵다"
  Housekeepers가 가장 채우기 어려운 포지션.
  호텔, 레스토랑, 이벤트 장소가 만성적 인력 부족.

• 의료/간호 인력 부족: 연간 193,100개 공석 vs 177,400명 진입
  연간 약 16,000명의 구조적 적자 — 2032년까지 지속 전망.
  간호사 실업률 1.6%에 불과 — 사실상 완전 고용.

• H-1B $100K 수수료 면제 법안 (의료 인력 대상) 발의
  초당적 하원 법안. 외국인 의사/간호사 대상,
  특히 농촌/취약 지역 근무자에 수수료 면제.

── Staffing 업계 ──

• 미국 staffing 시장 규모: 2026년 약 $183 billion 전망
  Temp penetration rate: 1.54%로 소폭 하락
  그러나 staffing 근무 시간은 연초 대비 최고 수준

• Contract 구인 공고 전년 대비 7% 증가
  고용주들은 임시직 활용 의향은 높으나
  정규직 전환에는 더 신중한 태도

• 임시직/계약직 근로자의 AI literacy 습득률이
  LinkedIn 전체 회원 대비 46% 높음 (ASA-LinkedIn 공동 조사)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

주요 산업별 노동시장 현황 — LABOR MARKET SNAPSHOT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

산업                부족 수준      2026년 필요 인력       동향
──────────────────  ───────────  ───────────────────  ──────────────────
건설 (Construction)  높음 (HIGH)  349,000명            수요↓ 여전히 대규모
의료/간호             심각          193,100명/년 공석    구조적 적자
호텔/외식             높음          91% 채용 어려움      COVID 이후 만성화
식품 가공             높음          H-2B 논쟁 진행 중    ICE 압력 증가
농업                 중-높음       H-2A 수요 증가       계절 급증 예상
운송                 보통          CDL 부족 지속        안정적
제조                 보통          reshoring 수요       성장 중

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

단속 및 Compliance — ENFORCEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Ohio E-Verify 의무화 시행 (3월 19일)
  → 비주거 건설 현장에 인력을 배치하는 모든 고객에 영향

• ICE 체포 전년 대비 40% 증가 (1월 기준)
  → 인력 파견 업체의 I-9 compliance 점검 필수

• South Dakota, 주 전체 E-Verify 법안 추진 중
  → compliance 부담 확대 가능성

• California, 주 정부 근로자에 E-Verify 사용 의무화

• Operation Metro Surge: Minneapolis 등 대도시에서 대규모 단속
  3,000건 이상 체포, 시카고/Houston/Phoenix/Denver로 확대

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

전략적 시사점 — STRATEGIC IMPLICATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

★ EB-3 Dates for Filing이 World/Mexico에서 CURRENT 전환
  비적체 국가 고객은 priority date와 관계없이 즉시 I-485 접수 가능.
  대상 고객에게 즉시 안내 필요 — 큰 기회.

★ H-2B 하반기 한도 소진 → EB-3 수요 증가
  Apr-Sep 계절 근로자가 필요한 고용주에게 H-2B 경로 없음.
  EB-3 영주권 경로가 H-2B 불확실성의 대안으로 포지셔닝 가능.

★ ICE 단속 강화 = Compliance 시장 기회
  단속에 놀란 고용주들이 합법적 인력 조달 솔루션을 찾을 것.
  합법 EB-3 경로는 gray market staffing 대비 차별화 요소.

★ EPI의 H-2B 확대 반대 → Green Card 주장
  육류 가공 등으로의 H-2B 확대에 반대하며 green card를 대안으로 제시.
  이는 EB-3 모델을 직접적으로 지지하는 논거 — 정책 논쟁 주시 필요.

★ 건설 + 호텔/외식 인력 부족 지속 심각
  육류 가공/식품 가공 외에 이들 산업으로 파트너 확대 검토.
  건설: 349,000명 필요, 호텔/외식: 91% 채용 어려움.

★ 2차 H-2B Supplemental 3월 25일 접수 개시
  27,736석 (returning workers만). 해당 고객에 즉시 안내 필요.

★ E-Verify 의무화 확산 추세
  Ohio 시행, South Dakota 추진 — 주 단위 확산 가속화.
  인력 파견 고객의 compliance 점검 및 교육 강화 필요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

H-2B 한도 구조 — 참고 정보
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

H-2B 프로그램은 회계연도당 법정 한도 66,000석이며,
상반기(Oct-Mar) 33,000석, 하반기(Apr-Sep) 33,000석으로 균등 배분.
매년 DHS가 supplemental 비자를 승인할 수 있으며 (올해: 64,716석 추가),
수요가 공급을 초과하면 USCIS가 추첨(lottery) 실시.

FY2026 기준, 고용주들이 162,603개 포지션을 요청했으나
총 가용 비자는 약 131,000석 — 약 4건 중 1건만 선발.

Returning worker exemption (supplemental 중 46,226석)은
최근 3년간 H-2B 자격을 보유한 근로자에게 우선권 부여.

Kennedy Access 고객에게 H-2B의 만성적 초과 수요는
EB-3의 가치 제안을 강화: 매년 lottery에 의존하는 대신
green card 스폰서십으로 영구 근로자를 확보.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

출처 (Sources):
• State Dept Visa Bulletin (travel.state.gov)
• USCIS — H-2B statutory cap & supplemental visa announcements
• Tafapolsky & Smith — April 2026 Visa Bulletin analysis
• RN Law Group — PERM & PWD processing times (March 2026)
• Fragomen — April 2026 Visa Bulletin / H-2B updates
• Ballard Spahr — ICE in the workplace 2026 update
• Alston & Bird — Ohio E-Verify mandate
• Construction Dive — 2026 labor demand gap
• Staffing Industry Analysts — March 2026 US jobs report
• Economic Policy Institute — H-2B expansion analysis
• Newsweek — H-2B visa cap reached
• Philadelphia Inquirer — gig economy/ICE impact
• AHA — Healthcare workforce 2026
• Stateline — E-Verify state law pushback
• BLS — February 2026 Employment Situation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kennedy Access Group — 이민 및 노동시장 일일 인텔리전스
보고서 생성일: 2026년 3월 24일
`;

const ok = await sendEmail({
  to: TO,
  subject,
  text,
});

if (ok) {
  console.log('✅ Report sent to ' + TO);
} else {
  console.error('❌ Failed to send — check SMTP config in .env');
}
