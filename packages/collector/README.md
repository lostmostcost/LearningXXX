# @learningxxx/collector (WBS-007)

사용자가 앱에서 수집을 실행하면 host가 호출하는 Mac 내부 LMS 수집 모듈입니다(CR-001, ADR-002). 지금은 한 과목과 주차(Canvas module)만 읽어 `Course`, `Week` 계약으로 정규화합니다. 자료·공지·과제는 WBS-008입니다.

```ts
const client = new CanvasClient({ getAuthHeaders });
const { course, weeks } = await discoverCourse({ client, accountKey, sourceCourseId: "95899" });
```

## 규칙
- **읽기 전용:** 클라이언트는 GET만 보낼 수 있습니다.
- **인증 정보:** 호출 때 host가 `getAuthHeaders`로 넘겨주며 저장하거나 로그로 남기지 않습니다. 리다이렉트를 따라가지 않고, 다른 주소의 페이지 링크도 거부합니다.
- **ID:** 계정·학기·과목으로 만든 고정 UUID라서 다시 수집해도 중복이 생기지 않습니다.
- **기존 코드:** archive 코드와 recorder skill은 참고하지 않고 공개된 Canvas REST API 형식으로 새로 작성했습니다.

## 오류

| 상황 | 코드 | 재시도 |
|---|---|---|
| 401, 로그인으로 리다이렉트 | `AUTH_REQUIRED` | 다시 로그인 후 실행 |
| 429, 제한을 뜻하는 403 | `RATE_LIMITED` | 가능 |
| 5xx, 연결 실패 | `DOWNLOAD_FAILED` | 가능 |
| 응답 형식 변경, 404, 다른 주소 링크 | `SOURCE_CHANGED` | 불가 |

200으로 온 로그인 HTML은 만료와 구분할 수 없어 `SOURCE_CHANGED`로 처리하고 로그인 확인을 안내합니다.

## 미검증
- **실제 경희대 LMS로 실행하지 않았습니다.** fixture는 공개된 Canvas 형식을 바탕으로 만든 합성 데이터입니다. 실제 응답, 세션 방식, 만료 동작은 실제 로그인으로 확인해야 합니다.
- 로그인 화면과 인증 정보 저장은 이 패키지 범위가 아닙니다. host 작업에서 만듭니다.

## 실행
`docker compose run --rm tools`
