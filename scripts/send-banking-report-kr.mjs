/**
 * One-shot: Send Korean-language banking industry report via email.
 * Usage: node scripts/send-banking-report-kr.mjs
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
const subject = '은행업계 일일 브리핑 — Banking Industry Daily — 2026년 3월 24일';

const text = `은행업계 일일 브리핑 — 2026년 3월 24일
Banking Industry Daily Intelligence (Korean Edition)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

금리 및 시장 현황 — RATES & MARKETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

지표                  현재 수치         비고
─────────────────    ──────────────    ──────────────────
Federal Funds Rate   3.50–3.75%       3월 18일 동결 (11-1 투표)
10Y Treasury Yield   4.39%            전일 대비 +3bp
Community Bank NIM   3.39%            2019년 이후 최고 수준
FDIC Problem Banks   ~60개            전분기 대비 안정적
2026 은행 부도        1건 (YTD)        작년 동기 대비 감소

★ Fed 전망: 2026년 중 1회 금리 인하 예상 (dot plot 기준)
  이란 분쟁에 따른 유가 상승 및 인플레이션 경직이 주요 변수
  Powell 의장: Jeanine Pirro 조사 종료 시까지 재임 의사 표명

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Basel III Endgame 재제안 — 자본 규제 완화
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

3월 19일, 연방 규제기관들이 Basel III Endgame 재제안을 발표했습니다.
이는 은행업계에 매우 긍정적인 소식입니다.

핵심 변경 사항:

• 2023년 원안: 대형 은행 자본 요건 16% 인상 제안
  → 2026년 재제안: CET1 요건 약 2.4% 감소로 전환
  → 약 $175 billion 규모의 자본 여력 확보 예상

• G-SIB surcharge 개편: 50bp 단위 → 10bp 단위로 세분화
  대형 은행에 대한 surcharge 소폭 인하 효과

• 소형 은행일수록 더 큰 자본 요건 감소 혜택
  Community bank에 특히 유리한 구조

시장 반응:
  Morgan Stanley +2.4%, Goldman Sachs +1.4%, Wells Fargo +1.4%
  은행주 전반 상승 (S&P 500은 하락한 날)

⚠ 의미: 소규모 은행의 자본 부담 완화 → 대출 여력 확대
  Kennedy Access 파트너 은행들에 긍정적 영향 예상

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

De Novo Bank 동향 — 신규 은행 설립
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• FDIC 기록상 현재 18개 de novo 은행 그룹이 설립 진행 중
• 2025년 OCC에 14건의 신규 charter 신청 접수
  (다수가 fintech 및 digital asset 기업)

• FDIC Acting Chairman Travis Hill:
  "혁신적 비즈니스 모델을 포함한 de novo 은행 설립을 지원할 것"

• Erebor Bank: OCC 예비 승인 완료
  가상화폐 활용 tech 기업 및 ultra-high-net-worth 개인 대상
  2026년 정식 charter 취득 예상

• FDIC, 2009년 부실은행 인수 제한 정책 폐지 (2026년 3월)
  → 비은행 기관의 부실은행 입찰 참여 장벽 제거

⚠ 의미: De novo 설립 환경이 10년 만에 가장 우호적
  Fintech-bank hybrid 모델 급증 예상

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GENIUS Act — Stablecoin 규제 시행
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

미국 최초의 연방 stablecoin 법률이 시행 단계에 진입했습니다.

경과:
• 2025년 6월: 상원 통과 (68-30)
• 2025년 7월: 하원 통과 (307-122), 대통령 서명
• 2026년 2월: OCC가 376페이지 시행규칙안(NPRM) 발표
• 의견 수렴 마감: 2026년 5월 1일
• 최종 규칙 시행 목표: 2026년 7월 18일

주요 내용:
• 모든 stablecoin 발행사: 1:1 준비금 의무화
• 발행사의 이자 지급(yield) 금지
• Stablecoin은 증권(securities)으로 분류되지 않음
• Bank Secrecy Act에 따른 AML 의무 적용

⚠ 은행 기회: Cross-border 결제, remittance 시장에서
  stablecoin 기반 서비스 제공 가능
  Community bank도 stablecoin custodian 역할 참여 가능

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

비시민권자 은행 계좌 제한 논의
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Trump 행정부가 은행 고객의 시민권 확인 의무화를 검토 중입니다.

현재 상황:
• 현행법상 은행은 고객 시민권 정보 수집 의무 없음
• 비시민권자도 제한 없이 계좌 개설 가능

검토 중인 내용:
• 여권(passport) 등 시민권 증명 서류 수집 의무화
• 신규 고객뿐 아니라 기존 고객에게도 소급 적용 검토
• REAL ID는 시민권 증명으로 인정하지 않을 가능성

• SBA: 비시민권자에 대한 7(a) loan 프로그램 접근 차단 시행

업계 반응:
• "모든 은행 고객의 시민권을 확인하는 것은 실행 불가능"
• Executive order만으로는 시행 불가, 의회 입법 또는 APA 절차 필요
• 백악관: "근거 없는 추측" 이라고 일축

⚠ 리스크: 실행될 경우 remittance 및 immigrant banking 시장에
  큰 영향. Kennedy Access 고객층에 직접적 영향 가능.
  현재로서는 시행 가능성 낮지만 모니터링 필요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Neobank 경쟁 현황 — Fintech 위협
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

주요 Neobank 동향      고객 수 / 규모         비고
─────────────────     ──────────────────    ──────────────────
Chime                  2,000만+ 고객         2025년 6월 IPO ($864M)
PicPay                 Nasdaq 상장           2026년 1월 IPO ($434M)
DNERO                  3월 24일 출시          Latino 시장 타겟
Nubank                 미국 시장 진출 중      LatAm 최대 neobank

• DNERO: 히스패닉/라틴계 커뮤니티 대상 디지털 뱅킹 플랫폼
  미국-라틴아메리카 간 remittance, 결제, 재무관리 통합
  기존 수수료 기반 모델 대비 투명한 가격 구조 제시

• Fintech → bank charter 취득 경쟁 가속화
  자동차 업체까지 bank charter 신청 (대출 사업 확장 목적)

• AI 투자: 금융기관의 61%가 GenAI를 최우선 투자 항목으로 선정
  Cybersecurity/fraud 분야에서 80%+ 기관이 pilot 또는 실사용 중

⚠ Community bank 전략: Digital channel 강화 필수
  Online (96%), mobile (95%) 채널 투자 가속
  AI chatbot/virtual assistant 도입 확대 중

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

전략적 시사점 — STRATEGIC IMPLICATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

★ Basel III 재제안은 community bank에 가장 큰 혜택
  자본 여력 확대 → 대출 확대 → EB-3 employer 파트너십에 유리
  규제 부담 감소로 신규 은행 파트너 발굴 용이

★ De novo bank 설립 환경이 10년 만에 최고
  Fintech 기업의 bank charter 취득 증가
  새로운 niche bank 파트너 기회 (immigrant banking 등)

★ GENIUS Act로 cross-border 결제 혁신 가능
  Stablecoin 기반 remittance는 Kennedy Access 고객의
  해외 송금 비용을 획기적으로 줄일 수 있는 기회

★ 비시민권자 은행 접근 제한은 현재 실현 가능성 낮으나
  실행 시 immigrant staffing 업계에 심각한 영향
  대안 금융 서비스(alternative banking) 수요 증가 가능

★ Neobank 경쟁 심화: DNERO 등 Latino 시장 타겟 neobank 출현
  Community bank는 digital 역량 강화 없이는 고객 이탈 위험
  AI 도입은 선택이 아닌 필수

★ NIM 3.39%로 수익성 회복세 지속
  Fed 금리 동결 + 수익률 곡선 정상화로 은행 수익 구조 개선

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

출처 (Sources):
• Federal Reserve — FOMC Statement (March 18, 2026)
• CNBC — Fed interest rate decision March 2026
• ABA Banking Journal — Basel III re-proposal
• Sullivan & Cromwell — Fed Basel III/G-SIB preview
• American Banker — De novo bank charter trends
• FDIC — Failed bank acquisition policy rescission
• OCC — GENIUS Act NPRM (Bulletin 2026-3)
• Morgan Lewis — GENIUS Act analysis
• Axios — Trump bank citizenship requirements
• Fintech Futures — DNERO neobank launch
• KPMG — 2026 Banking Trends
• S&P Global — US Banks Outlook 2026

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Kennedy Access Group — 은행업계 일일 인텔리전스
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
