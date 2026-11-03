/** Core workflow catalog, not a popularity ranking. Vendor commands remain capability-driven. */
export const CHAT_COMMANDS = [
  { name: 'model', label: '모델 선택', description: '현재 계정에서 사용 가능한 모델', action: 'model' },
  { name: 'effort', label: '추론 강도', description: '선택 모델이 지원하는 강도 · 다음 요청부터 적용', action: 'effort' },
  { name: 'plan', label: '계획 모드', description: '읽고 계획하기 · /plan off로 일반 모드', action: 'plan' },
  { name: 'mode', label: '실행 모드', description: '일반·계획·편집 승인 방식 선택', action: 'mode' },
  { name: 'compact', label: '문맥 압축', description: 'Claude Code가 현재 대화를 압축', action: 'sdk' },
  { name: 'clear', label: '새 대화', description: '기존 대화를 남기고 새 문맥으로 시작', action: 'new' },
  { name: 'resume', label: '대화 이어가기', description: '저장된 앱 대화 목록에서 선택', action: 'resume' },
  { name: 'rename', label: '대화 이름', description: '대화 이름 바꾸기 · /rename 새 이름', action: 'rename' },
  { name: 'context', label: '문맥 사용량', description: '실제 엔진의 현재 문맥 사용량', action: 'context' },
  { name: 'cost', label: '대화 사용 내역', description: '엔진 보고 비용·토큰 · 구독 청구액과 구분', action: 'cost' },
  { name: 'usage', label: '구독 사용량', description: '엔진에서 조회한 한도·초기화 시각', action: 'usage' },
  { name: 'permissions', label: '권한 설정', description: '실행 모드와 권한 확인 방식', action: 'mode' },
  { name: 'memory', label: '기억 관리', description: 'CLI 지원 여부에 따라 채팅 또는 고급 도구', action: 'sdk' },
  { name: 'skills', label: '스킬과 명령', description: '현재 연결에서 실제 제공하는 목록', action: 'skills' },
  { name: 'mcp', label: 'MCP 연결', description: '설정된 도구 서버의 현재 연결 상태', action: 'mcp' },
  { name: 'diff', label: '변경 사항', description: 'CLI 지원 여부에 따라 채팅 또는 고급 도구', action: 'sdk' },
  { name: 'review', label: '검토 요청', description: '실제 제공되는 review/code-review 명령 실행', action: 'sdk' },
  { name: 'help', label: '명령 도움말', description: '핵심 기능과 실제 사용 가능한 명령', action: 'help' },
  { name: 'copy', label: '답변 복사', description: '마지막 답변을 Markdown 원문으로 복사 · 앱 동작', action: 'copy' },
  { name: 'rewind', label: '파일 복구', description: 'Claude Code의 파일 체크포인트 미리보기', action: 'rewind' },
  { name: 'stop', label: '작업 중지', description: '진행 중인 응답과 대기 입력 중지 · 앱 동작', action: 'stop' },
  { name: 'init', label: '프로젝트 시작', description: 'Claude Code로 CLAUDE.md 작성', action: 'sdk' },
  { name: 'doctor', label: '환경 진단', description: 'Claude Code가 제공하는 설치·환경 검사', action: 'sdk' },
  { name: 'config', label: '설정', description: '채팅 지원 여부에 따라 실행 또는 고급 도구', action: 'sdk' },
  { name: 'fast', label: '빠른 모드', description: '계정·모델이 지원할 때 엔진 명령 실행', action: 'sdk' },
  { name: 'add-dir', label: '작업 폴더 추가', description: '고급 도구에서 폴더 접근 범위 직접 설정', action: 'sdk' },
  { name: 'export', label: '대화 내보내기', description: '현재 화면의 대화를 Markdown으로 저장 · 앱 동작', action: 'export' },
  { name: 'status', label: '현재 연결', description: '모델·강도·권한 모드·연결 상태 · 앱 동작', action: 'status' },
] as const;
export function parseChatCommand(text: string) {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!.toLowerCase(), args: match[2]?.trim() ?? '' } : undefined;
}
