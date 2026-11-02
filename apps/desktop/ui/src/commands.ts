export const COMMANDS = [
  { name: '/help', description: '앱 명령어 도움말', supported: true },
  { name: '/clear', description: '같은 모드의 새 대화 시작 · 기존 대화 보존', supported: true },
  { name: '/resume', description: '저장된 세션 목록 열기', supported: true },
  { name: '/rename', description: '현재 세션 이름 변경 · /rename 새 이름', supported: true },
  { name: '/status', description: '현재 세션·응답 상태 확인', supported: true },
  { name: '/compact', description: '터미널 전용 · 현재 연결 방식에서는 실행 불가', supported: false },
  { name: '/model', description: '모델 선택 · 실행 구조 연결 필요', supported: false },
  { name: '/permissions', description: '권한 설정 · 앱의 폴더 권한에서 관리', supported: false },
  { name: '/login', description: '구독 로그인 · 공식 Claude Code에서 실행', supported: false },
  { name: '/skills', description: '터미널 스킬 목록 · 격리 정책 검토 필요', supported: false },
] as const;
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/(\w[\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: `/${match[1]!.toLowerCase()}`, args: match[2]?.trim() ?? '' } : undefined;
}
export function commandSuggestions(text: string) {
  return /^\/[\w:-]*$/.test(text) ? COMMANDS.filter(c => c.name.startsWith(text.toLowerCase())) : [];
}
export const COMMAND_HELP = COMMANDS.map(c => `${c.name} — ${c.description}`).join('\n');
