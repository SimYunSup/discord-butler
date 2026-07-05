export interface SignalRec {
  symbol: string;
  name: string;
  sector: string;
  score: number;
}
export interface Signals {
  asof: string;
  universeSize: number;
  top: SignalRec[];
  bottom: SignalRec[];
  sectorRotation: { sector: string; score: number; rank: number }[];
  meta: { model: string; ic: number; icir: number; rankic: number };
}

const sign = (n: number): string => (n >= 0 ? `+${n.toFixed(4)}` : n.toFixed(4));
const rec = (r: SignalRec): string => `- ${r.name}(${r.symbol}·${r.sector}) ${sign(r.score)}`;

/** signals.json → 브리핑 "qlib 신호" 섹션 마크다운(순수). 지수 시황·드리프트는 봇이 얹음. */
export function renderBrief(s: Signals): string {
  const lines: string[] = [];
  lines.push(`## 📊 주간 시장 신호 (qlib) — ${s.asof}`);
  lines.push(
    `> ${s.meta.model} 상대 랭킹 신호(유니버스 ${s.universeSize}종목). **참고용** — IC=${s.meta.ic} (낮음, 예측 아님). 배분 결정의 보조 지표일 뿐.`,
  );
  lines.push('');
  lines.push('**섹터 로테이션**(모델 상대 강도순)');
  if (s.sectorRotation.length === 0) lines.push('- (신호 없음)');
  for (const r of s.sectorRotation) lines.push(`${r.rank}. ${r.sector} ${sign(r.score)}`);
  lines.push('');
  lines.push('**상대 강세 상위**');
  lines.push(...(s.top.length ? s.top.map(rec) : ['- (없음)']));
  lines.push('');
  lines.push('**상대 약세 하위**');
  lines.push(...(s.bottom.length ? s.bottom.map(rec) : ['- (없음)']));
  lines.push('');
  return lines.join('\n') + '\n';
}
